/**
 * dsh-geogebra · 渲染核心
 *
 * 一条 GeoGebra 命令列表进 → 一个 PNG 文件出。全程无窗口、不碰鼠标键盘、不改前台窗口。
 *
 * 流程：
 *   ① 临时目录里写一页 HTML（lib/template.mjs）
 *   ② 起无头 Edge：--headless=new --remote-debugging-port=0 --user-data-dir=<隔离目录>
 *   ③ 用 CDP 强制视口尺寸与 devicePixelRatio（= dpi/96），再 navigate 到那一页
 *   ④ 页面自己执行命令并把 window.__ggb.status 置成 ok/err，宿主轮询等它
 *   ⑤ 等两帧让画布提交上屏 → 取图形区矩形 → Page.captureScreenshot 精确裁剪
 *   ⑥ base64 → PNG 写盘 → 删临时文件、杀 Edge
 *
 * 为什么不用任务书 §5.5 的 `--dump-dom` + `--virtual-time-budget` 路线：
 *   实测（2026-10-24，Edge 无头，GeoGebra 5.4.920.0）虚拟时间会饿死帧生产：
 *   命令执行成功、getValueString 也对，但 canvas 内容永不提交，截图里只有空坐标系；
 *   同时 `getPNGBase64` 抛 `Unable to parse base64 string.`、
 *   `getScreenshotBase64` 抛 `Index: 22, Size: 7`，两条导出 API 都不可用。
 *   换成实时 CDP 之后曲线、切线、点全部正确落图（见 验证\out\do-test.png）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, sleep } from './cdp.mjs';
import { buildHtml } from './template.mjs';
import { whiteToTransparent } from './png.mjs';

/** Edge 的可执行文件位置，按可用性排序。 */
export const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

/** 持久化配置目录：把 GeoGebra 的 ~30MB 运行资源缓存下来，第二次调用就快。 */
const CACHE_DIR = path.join(os.tmpdir(), 'dsh-geogebra-edge-profile');

const DEFAULT_DPI = 150;
const DEFAULT_TIMEOUT_MS = 75000;
const MIN_TIMEOUT_MS = 30000;

/** 渲染串行化：两个 Edge 共用一个配置目录会互相接管，所以排队。 */
let queue = Promise.resolve();
function withLock(task) {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

/** 读 PNG 的 IHDR 拿真实像素尺寸（前 8 字节签名 + 4 长度 + 'IHDR'，然后 2×4 字节）。 */
function pngSize(buffer) {
  try {
    if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 };
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 等页面把状态报上来。返回 'ok' | 'err' | null（超时）。 */
async function waitReady(session, deadline) {
  while (Date.now() < deadline) {
    let value;
    try {
      value = await session.evaluate('window.__ggb ? window.__ggb.status : null');
    } catch { /* 页面还在加载/导航中 */ }
    if (value === 'ok' || value === 'err') return value;
    await sleep(150);
  }
  return null;
}

/**
 * 渲染一组 GeoGebra 命令。
 *
 * @param {object} args
 * @param {string[]} args.commands
 * @param {string} [args.out]         PNG 绝对路径（evalOnly 时可省略）
 * @param {number} [args.width]       画布宽（CSS px），默认 1000
 * @param {number} [args.height]      画布高（CSS px），默认 700
 * @param {number} [args.dpi]         输出分辨率，默认 150（dpi/96 = 设备像素比）
 * @param {boolean} [args.transparent] 透明背景
 * @param {boolean} [args.axes]
 * @param {boolean} [args.grid]
 * @param {number} [args.timeoutMs]
 * @param {boolean} [args.evalOnly]   只回命令结果，不出图
 */
export async function renderToPng(args) {
  const commands = Array.isArray(args?.commands) ? args.commands.map((c) => String(c)) : [];
  if (!commands.length) {
    return { ok: false, error: 'commands 不能为空：至少给一条 GeoGebra 命令，例如 ["f(x)=x^3-3x"]' };
  }
  const blank = commands.findIndex((c) => !c.trim());
  if (blank >= 0) return { ok: false, error: `第 ${blank + 1} 条命令是空字符串` };

  const edgePath = findEdge();
  if (!edgePath) {
    return {
      ok: false,
      error: '找不到 Microsoft Edge，已探测：\n' + EDGE_CANDIDATES.filter(Boolean).join('\n')
        + '\n请把 msedge.exe 加到标准路径，或改 lib/render.mjs 的 EDGE_CANDIDATES。',
    };
  }

  const evalOnly = Boolean(args?.evalOnly);
  const width = Math.min(Math.max(Math.round(Number(args?.width) || 1000), 200), 4000);
  const height = Math.min(Math.max(Math.round(Number(args?.height) || 700), 200), 4000);
  const dpi = Math.min(Math.max(Number(args?.dpi) || DEFAULT_DPI, 72), 600);
  const dpr = Math.min(Math.max(dpi / 96, 1), 4);
  const timeoutMs = Math.max(Number(args?.timeoutMs) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS);

  const outPath = args?.out ? path.resolve(String(args.out)) : '';
  if (!evalOnly && !outPath) return { ok: false, error: '必须提供 out（输出路径，.png 或 .ggb）' };
  if (!evalOnly && !/\.(png|ggb)$/i.test(outPath)) {
    return { ok: false, error: 'out 必须以 .png 或 .ggb 结尾：' + outPath };
  }

  // 主产物是 .ggb 时，PNG 自动落在旁边（同名换扩展名），
  // 这样"能用 GeoGebra 打开"和"能插进讲义"两件事一次给齐。
  const outExt = path.extname(outPath).toLowerCase();
  const pngPath = evalOnly ? '' : (outExt === '.png' ? outPath : outPath.slice(0, -outExt.length) + '.png');
  const ggbPath = evalOnly ? '' : (args?.ggb
    ? path.resolve(String(args.ggb))
    : (outExt === '.ggb' ? outPath : ''));
  if (ggbPath && !/\.ggb$/i.test(ggbPath)) return { ok: false, error: 'ggb 必须以 .ggb 结尾：' + ggbPath };

  return withLock(async () => {
    const startedAt = Date.now();
    let workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ggb-'));
    let app = null;

    try {
      const htmlPath = path.join(workDir, 'app.html');
      await fsp.writeFile(htmlPath, buildHtml({
        commands,
        width,
        height,
        transparent: Boolean(args?.transparent),
        axes: args?.axes !== false,
        grid: args?.grid !== false,
        evalOnly,
        needGgb: Boolean(ggbPath),
      }), 'utf8');

      // 优先用持久缓存目录；不可用就退回临时目录
      let profileDir = CACHE_DIR;
      try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        await fsp.access(CACHE_DIR, fs.constants.W_OK);
      } catch {
        profileDir = path.join(workDir, 'profile');
        await fsp.mkdir(profileDir, { recursive: true });
      }

      const extraArgs = [
        // 用启动参数定像素比（而不是 CDP 的 Emulation.setDeviceMetricsOverride）：
        // 后者要求在 GeoGebra 初始化之前就位，跟页面加载抢跑，实测经常被丢掉，
        // 结果是画布按 1x 渲染、dpi 白写。
        '--force-device-scale-factor=' + dpr,
      ];
      // 注意：不要用 --default-background-color=... 这个启动参数 ——
      // 实测它会让整页脚本不再执行（CDP 里 Runtime.evaluate 永远拿不到值）。
      // 透明背景改用 CDP 的 Emulation.setDefaultBackgroundColorOverride。

      app = await launch(edgePath, {
        url: pathToFileURL(htmlPath).href,
        width,
        height,
        profileDir,
        timeoutMs,
        extraArgs,
      });

      const { session } = app;

      if (args?.transparent) {
        try {
          await session.send('Emulation.setDefaultBackgroundColorOverride', {
            color: { r: 0, g: 0, b: 0, a: 0 },
          }, 10000);
        } catch { /* 老版本没有这条命令就退回白底 */ }
      }

      const status = await waitReady(session, startedAt + timeoutMs);
      if (!status) {
        return {
          ok: false,
          error: `等待 GeoGebra 就绪超时（${Math.round((Date.now() - startedAt) / 1000)} 秒）。`
            + '首次调用要从 geogebra.org 下载约 30MB 资源，请联网重试，或把 timeoutMs 提到 120000。',
          elapsedMs: Date.now() - startedAt,
        };
      }

      const results = await session.evaluate('window.__ggb.results') ?? [];
      const values = results.filter((r) => r?.value != null).map((r) => String(r.value));

      if (status === 'err') {
        const error = await session.evaluate('window.__ggb.error') ?? 'GeoGebra 报告错误（无详细信息）';
        return { ok: false, error: String(error), commands: results, values, elapsedMs: Date.now() - startedAt };
      }

      if (evalOnly) {
        return { ok: true, values, commands: results, bytes: 0, elapsedMs: Date.now() - startedAt };
      }

      // 让画布把这一帧真正提交上屏（否则截图拿到的是命令执行前的画面）
      try {
        await session.evaluate('new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(1); }); }); })', 15000);
      } catch { /* 不是致命问题，下面还会等一小段 */ }
      await sleep(250);

      const rect = await session.evaluate('window.__ggb.viewRect()');
      if (!rect || !(rect.width > 20) || !(rect.height > 20)) {
        return {
          ok: false,
          error: '找不到图形区画布（GeoGebra 没有渲染出视图）。请把这条命令组合连同页面截图作为问题反馈。',
          commands: results,
          values,
          elapsedMs: Date.now() - startedAt,
        };
      }

      // 让输出像素尺寸正好等于 width*dpr × height*dpr：抵消掉面板那 1–2px 的边框。
      // clip.scale 是叠加在 devicePixelRatio 之上再乘一次的，所以要除掉页面真实 dpr。
      const pageDpr = Number(await session.evaluate('window.devicePixelRatio')) || 1;
      const scale = (width * dpr) / (rect.width * pageDpr);
      const shot = await session.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale },
      }, 30000);

      const shotBuffer = Buffer.from(shot.data, 'base64');
      if (shotBuffer.length < 512) throw new Error(`截图为空（${shotBuffer.length} 字节）`);

      // GeoGebra 的画布自己填白底，CDP 的背景覆盖管不到 canvas 像素。
      // 所以 transparent 在宿主端再补一步：白底 → alpha（抗锯齿灰边会被反预乘保留下来）。
      let buffer = shotBuffer;
      let notes = '';
      if (args?.transparent) {
        const converted = whiteToTransparent(shotBuffer);
        if (converted) buffer = converted;
        else notes = '透明背景转换失败（PNG 编码不受支持），已保留白底图';
      }

      await fsp.mkdir(path.dirname(pngPath), { recursive: true });
      await fsp.writeFile(pngPath, buffer);

      // .ggb：GeoGebra 自己给的 ZIP base64，原样解码落盘即可被 GeoGebra 打开。
      let ggbBytes = 0;
      let ggbNote = '';
      if (ggbPath) {
        let b64 = null;
        try { b64 = await session.evaluate('window.__ggb.ggbBase64'); } catch { /* 取不到就走下面的报错 */ }
        if (typeof b64 === 'string' && b64.length > 16) {
          const ggbBuffer = Buffer.from(b64, 'base64');
          // .ggb 必须是 ZIP（PK\x03\x04）；不是就说明拿到的不是构造文件，宁可不写
          if (ggbBuffer.length > 64 && ggbBuffer[0] === 0x50 && ggbBuffer[1] === 0x4b) {
            await fsp.mkdir(path.dirname(ggbPath), { recursive: true });
            await fsp.writeFile(ggbPath, ggbBuffer);
            ggbBytes = ggbBuffer.length;
          } else {
            ggbNote = '.ggb 数据不是合法 ZIP，已跳过（只输出了 PNG）';
          }
        } else {
          const pageError = await session.evaluate('window.__ggb.ggbError').catch(() => null);
          ggbNote = String(pageError ?? '.ggb 导出失败（getBase64 没有返回数据），只输出了 PNG');
        }
      }

      // 如实报尺寸：直接读 PNG 的 IHDR，而不是拿请求值糊弄调用方
      const size = pngSize(buffer);
      const allNotes = [notes, ggbNote].filter(Boolean).join('；');
      return {
        ok: true,
        path: pngPath,
        ggbPath: ggbBytes ? ggbPath : undefined,
        ggbBytes: ggbBytes || undefined,
        bytes: buffer.length,
        width: size.width,
        height: size.height,
        dpi,
        values,
        commands: results,
        elapsedMs: Date.now() - startedAt,
        ...(allNotes ? { notes: allNotes } : {}),
      };
    } catch (error) {
      const message = String(error?.message ?? error);
      const hint = /连不上 Edge 的调试端口|DevToolsActivePort/.test(message)
        ? '\n（临时配置目录被占用或 Edge 启动失败：等一下重试即可；若反复出现，删掉 %TEMP%\\dsh-geogebra-edge-profile）'
        : '';
      return { ok: false, error: message + hint, elapsedMs: Date.now() - startedAt };
    } finally {
      if (app) { try { await app.close(); } catch { /* ignore */ } }
      try { await fsp.rm(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

export default { renderToPng, findEdge, EDGE_CANDIDATES };
