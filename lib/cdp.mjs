/**
 * dsh-geogebra · 极简 CDP 客户端（不需要任何依赖）
 *
 * 为什么不用 `--dump-dom` + `--virtual-time-budget` 那一套（任务书 §5.5 的原始方案）：
 *   实测 2026-10-24 / Edge 无头 / GeoGebra 5.4.920.0：
 *   虚拟时间会把真实帧生产饿死 —— HTML 文字（代数区）照常合成，
 *   但 canvas 的内容永远提交不上屏，于是「命令执行成功、截图里却只有空坐标系」。
 *   同时这个版本的 `getPNGBase64` 直接抛 `Unable to parse base64 string.`，
 *   `getScreenshotBase64` 抛 `Index: 22, Size: 7`，两条导出 API 都不可用。
 *
 * 所以改成：起一个带 --remote-debugging-port 的无头 Edge，用 CDP 实时等待页面自己报到，
 * 再 `Page.captureScreenshot` 精确截取图形区的矩形。全程无窗口、不碰鼠标键盘。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const sleepImpl = (ms) => sleep(ms).catch(() => undefined);

/** 等一个文件出现（Edge 启动后会写 DevToolsActivePort）。 */
async function waitForFile(file, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      if (text.trim()) return text;
    } catch { /* 还没写出来 */ }
    await sleepImpl(intervalMs);
  }
  return null;
}

/** 极简 JSON-RPC over WebSocket（Node ≥ 22 自带 WebSocket）。 */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    ws.addEventListener('close', () => {
      for (const [, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        reject(new Error('CDP 连接已关闭'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  /** 在页面里跑一段表达式，返回它的值（requires returnByValue）。 */
  async evaluate(expression, timeoutMs = 30000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, timeoutMs);
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? '页面脚本异常';
      throw new Error(text);
    }
    return result?.result?.value;
  }
}

/**
 * 起来一个无头 Edge 并连上它的页面。
 * @returns {Promise<{session: CdpSession, child: import('node:child_process').ChildProcess, close: () => Promise<void>}>}
 */
export async function launch(edgePath, {
  url,
  width = 1000,
  height = 700,
  profileDir,
  timeoutMs = 75000,
  extraArgs = [],
}) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-breakpad',
    '--mute-audio',
    '--hide-scrollbars',
    '--noerrdialogs',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--window-size=' + width + ',' + height,
    ...extraArgs,
    url,
  ];

  // 同一配置目录复用（缓存 GeoGebra 资源）时，上一次的 DevToolsActivePort 会残留，
  // 不清掉就会读到旧端口、连到已经死掉的浏览器上。
  try { fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true }); } catch { /* ignore */ }

  const child = spawn(edgePath, args, { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    setTimeout(() => resolve(), 6000);
  });
  const close = async () => {
    // 先要它自己优雅退出，退出不干净再整棵进程树强杀 ——
    // 只杀 browser 进程会把 renderer/GPU 子进程留下，配置目录被占住，下一次启动就会挂住。
    try { child.kill(); } catch { /* ignore */ }
    const settled = await Promise.race([exited.then(() => true), sleepImpl(1500).then(() => false)]);
    if (!settled && process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch { /* ignore */ }
    }
    await exited;
  };

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const portText = await waitForFile(portFile, Math.min(timeoutMs, 30000));
  if (!portText) {
    await close();
    throw new Error('Edge 没有生成 DevToolsActivePort：可能被已运行的浏览器实例接管（同一 --user-data-dir），' +
      '或 Edge 启动失败。请确认 msedge.exe 可执行且没有别的进程占用该临时配置目录。');
  }
  const port = Number(String(portText).split(/\r?\n/)[0].trim());
  if (!Number.isFinite(port) || port <= 0) {
    await close();
    throw new Error('DevToolsActivePort 内容异常：' + String(portText).slice(0, 120));
  }

  // 等页面 target 出现
  let target = null;
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = (list ?? []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        ?? (list ?? []).find((t) => t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 端口还没就绪 */ }
    await sleepImpl(120);
  }
  if (!target) {
    await close();
    throw new Error('连不上 Edge 的调试端口（/json/list 没有 page target）');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket 连接失败：' + String(event?.message ?? 'unknown')));
    });
  });

  const session = new CdpSession(ws);
  try { await session.send('Runtime.enable', {}, 15000); } catch { /* 非致命 */ }
  try { await session.send('Page.enable', {}, 15000); } catch { /* 非致命 */ }

  return {
    session,
    child,
    close: async () => {
      // 让浏览器自己退出（干净，缓存才写得下去）
      try { await session.send('Browser.close', {}, 1500); } catch { /* 老版本可能没有 */ }
      try { ws.close(); } catch { /* ignore */ }
      await close();
    },
  };
}

export { sleepImpl as sleep };
