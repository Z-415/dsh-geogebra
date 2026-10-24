/**
 * 端到端测试（需要 Windows + Microsoft Edge + 能访问 geogebra.org）
 *
 * 走的是**工具层**而不是渲染核心：这样连带 `pick()` 输出白名单、schema 校验一起被覆盖，
 * 正是 2026-10-24 那次 `dpi` 字段事故的现场。
 *
 * 判据（对应任务书 §1.3 的 DoD）：
 *   - 数学正确性：`f(x)=x^3-3x` + `T=Tangent(1,f)` 的切线必须是水平线 y = -2
 *   - 输出的 PNG 尺寸 = width×height × dpi/96
 *   - out 写 .ggb 时产出合法 ZIP，且里面确有 geogebra.xml，同时附一张同名 .png
 *   - 命令写错必须报错，且**不留下文件**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { findEdge } from '../lib/render.mjs';
import { prepareCopy, bootPlugin, retry, pngSize } from './helpers.mjs';

const TIMEOUT = 300_000;
const edgeMissing = !findEdge();

/** 从 ZIP 里按名字取出条目内容（只处理 deflate / store，够用于 .ggb）。 */
function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66_000; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const total = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32BE(cd) !== 0x504b0102) break;
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOffset = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    if (name === wanted) {
      const lh = localOffset;
      const lnameLen = buf.readUInt16LE(lh + 26);
      const lextraLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + lnameLen + lextraLen;
      const raw = buf.subarray(start, start + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

test('端到端：数学判据 + PNG + .ggb + 错误回传', { timeout: TIMEOUT, skip: edgeMissing ? '本机没有 Microsoft Edge，跳过端到端' : false }, async () => {
  const { work, entry } = await prepareCopy();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ggb-e2e-out-'));
  try {
    const { tools, dispose } = await bootPlugin(entry);
    const draw = tools.get('ggb_draw');
    const evalTool = tools.get('ggb_eval');
    const declared = Object.keys(draw.output.schema.properties ?? {});
    const ggbTarget = path.join(outDir, '单元.ggb');
    const width = 900;
    const height = 620;
    const dpi = 150;

    // ---- 1. 正常出图 + .ggb ----
    const value = await retry(() => draw.execute({
      commands: ['f(x)=x^3-3x', 'T=Tangent(1,f)', 'A=(1,-2)'],
      out: ggbTarget,
      width,
      height,
      dpi,
      timeoutMs: 120_000,
    }));

    assert.equal(value.ok, true, `渲染失败：${value.error}`);
    const extra = Object.keys(value).filter((k) => !declared.includes(k));
    assert.deepEqual(extra, [], `返回了 schema 未声明的字段 ${extra.join(', ')}`);

    // 数学判据
    assert.ok((value.values ?? []).includes('T: y = -2'),
      `切线必须是水平线 y = -2，实际读回 ${JSON.stringify(value.values)}`);

    // PNG 尺寸
    const pngPath = ggbTarget.replace(/\.ggb$/i, '.png');
    const png = await fs.readFile(pngPath);
    const size = pngSize(png);
    const expectW = Math.round(width * dpi / 96);
    const expectH = Math.round(height * dpi / 96);
    assert.ok(Math.abs(size.width - expectW) <= 2, `PNG 宽应为 ${expectW}，实际 ${size.width}`);
    assert.ok(Math.abs(size.height - expectH) <= 2, `PNG 高应为 ${expectH}，实际 ${size.height}`);

    // .ggb：是 ZIP、含 geogebra.xml、xml 里确有对象
    assert.equal(value.ggbPath, ggbTarget, `ggbPath 应指向 ${ggbTarget}`);
    const ggb = await fs.readFile(ggbTarget);
    assert.equal(ggb.subarray(0, 2).toString('latin1'), 'PK', '.ggb 必须是 ZIP');
    const xml = unzipEntry(ggb, 'geogebra.xml');
    assert.ok(xml && xml.length > 100, '.ggb 里必须有 geogebra.xml');
    assert.match(xml.toString('utf8'), /Tangent/i, 'geogebra.xml 里应当有切线对象');
    assert.ok(value.ggbBytes > 500, `ggbBytes 太小：${value.ggbBytes}`);

    // render 文案要把两份产物都说出来
    const text = draw.output.render({}, value).map((p) => p.text).join('\n');
    assert.match(text, /可编辑构造文件/, 'render 文案应当说明 .ggb 路径');

    // ---- 2. 错误命令：报错且不落文件 ----
    const badTarget = path.join(outDir, '错误.ggb');
    const bad = await draw.execute({ commands: ['T=Tangent(f,1)'], out: badTarget, timeoutMs: 120_000 });
    assert.equal(bad.ok, false, '错误命令必须失败');
    assert.match(String(bad.error), /Tangent\(f,1\)/, '错误信息应当点名那条命令');
    await assert.rejects(fs.access(path.join(outDir, '错误.png')), '错误命令不该留下 PNG');
    await assert.rejects(fs.access(badTarget), '错误命令不该留下 .ggb');

    // ---- 3. ggb_eval：只回结果，不出图 ----
    const evaluated = await retry(() => evalTool.execute({
      commands: ['f(x)=x^3-3x', 'T=Tangent(1,f)'],
      timeoutMs: 120_000,
    }));
    assert.equal(evaluated.ok, true, `ggb_eval 失败：${evaluated.error}`);
    assert.ok((evaluated.values ?? []).includes('T: y = -2'), 'ggb_eval 也要读回切线');
    assert.equal(evaluated.ggbPath, undefined, 'ggb_eval 不该产出文件');

    dispose();
  } finally {
    await fs.rm(work, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
