/**
 * dsh-geogebra —— 让模型用一条 GeoGebra 命令列表画出真正的 GeoGebra 图形。
 *
 * 两个工具：
 *   ggb_draw  命令数组 → PNG 文件（无窗口、不抢鼠标键盘、不动前台窗口）
 *   ggb_eval  命令数组 → 只回每条命令的结果文本（模型自查数学对不对，不出图）
 *
 * 为什么是「宿主插件 + 无头 Edge」而不是内嵌页签 / 驱动桌面版 / 键鼠自动化：
 * 任务书 §3 已逐条排除，结论是不必再试。桌面版从 shell 启动会立刻退出（退出码 0），
 * Electron 忽略后台输入必须抢前台，两者都违反"不抢占鼠标键盘"的硬约束。
 *
 * 启动自证：apply() 把「工具是否注册成功」写进 <包目录>/.boot-status.json。
 * 原因：defineTool 会严格校验 schema，任一环节抛错会让**后面的注册静默消失**；
 * 有这个文件就能一眼区分"插件没加载"和"工具注册失败"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { renderToPng } from './lib/render.mjs';

export const name = 'dsh-geogebra';
export const inject = ['tools'];

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = path.join(PACKAGE_DIR, '.boot-status.json');

function writeStatus(patch) {
  let base = {};
  try { base = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { /* 首次或损坏都从空开始 */ }
  const next = { ...base, ...patch, at: new Date().toISOString() };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2), 'utf8'); } catch { /* 自证失败不能影响插件 */ }
  return next;
}

/** 把渲染结果收敛成 schema 允许的形状（null 一律转成空串，避免校验器挑刺）。 */
function normalizeCommands(results) {
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    command: String(r?.command ?? ''),
    ok: r?.ok === true,
    value: r?.value == null ? '' : String(r.value),
    error: r?.error == null ? '' : String(r.error),
  }));
}

const commandResultSchema = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string' },
    ok: { type: 'boolean' },
    value: { type: 'string' },
    error: { type: 'string' },
  },
});

/**
 * 只保留 schema 里声明过的字段。
 *
 * 起因（2026-10-24 装机后首次真实调用）：`renderToPng` 返回了 `dpi`，而 ggb_draw 的输出 schema
 * 是 `additionalProperties: false` 且没声明它，宿主直接拒收：
 *   `tool "ggb_draw" returned invalid output: "value.dpi" is not a declared property`
 * 症状很迷惑 —— 工具注册成功、图也生成了，但调用方只看到一句 invalid output。
 * 与其每改一次 lib/render.mjs 就手工同步一次 schema，不如在出口按白名单收敛：
 * schema 声明什么就出去什么，多出来的字段一律丢掉。
 */
function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    const value = source?.[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** ggb_draw 的输出字段（必须与下面的 schema 声明保持一致）。 */
export const DRAW_OUTPUT_KEYS = ['ok', 'path', 'ggbPath', 'ggbBytes', 'bytes', 'width', 'height', 'dpi', 'values', 'commands', 'error', 'notes', 'elapsedMs'];
/** ggb_eval 的输出字段（同上）。 */
export const EVAL_OUTPUT_KEYS = ['ok', 'bytes', 'values', 'commands', 'error', 'elapsedMs'];

const commonParams = {
  commands: {
    type: 'array',
    items: { type: 'string' },
    required: true,
    description: '按顺序执行的 GeoGebra 命令，例如 ["f(x)=x^3-3x", "T=Tangent(1,f)"]。'
      + '注意 GeoGebra 的参数顺序：切线用 Tangent(横坐标,函数)，写成 Tangent(f,1) 会被拒绝。',
  },
  width: { type: 'integer', description: '画布宽（px），默认 1000' },
  height: { type: 'integer', description: '画布高（px），默认 700' },
  axes: { type: 'boolean', description: '是否显示坐标轴，默认 true' },
  grid: { type: 'boolean', description: '是否显示网格，默认 true' },
  timeoutMs: { type: 'integer', description: '等待上限（ms），默认 75000，最低 30000。首次冷启动要联网下载约 30MB 资源' },
};

export function apply(ctx, config = {}) {
  const disposers = [];
  writeStatus({ boot: 'started', draw: null, eval: null, error: null, name });

  // ---------- ggb_draw：命令 → PNG ----------
  try {
    const tools = ctx.tools;
    if (!tools || typeof tools.register !== 'function') throw new Error('tools service is missing despite inject');
    disposers.push(tools.register(defineTool({
      name: 'ggb_draw',
      description:
        '把一组 GeoGebra 命令渲染成图片并保存（无窗口、不抢鼠标键盘、不改变前台窗口）。'
        + '传命令数组，例如 ["f(x)=x^3-3x", "T=Tangent(1,f)", "A=(1,-2)"]，会按顺序执行后导出。'
        + '想拿到**能用 GeoGebra 打开、可继续拖动编辑的构造文件**，就把 out 写成 .ggb'
        + '（同时会在旁边生成同名 .png 供插入讲义/Word）；只要插图的就写 .png。'
        + '导出的 PNG 只有坐标系与图形，不含代数区/工具栏/输入栏。'
        + '命令写错会返回具体哪条被拒绝，而不是给你一张空白图。'
        + '首次调用需联网下载约 30MB GeoGebra 资源（20–40 秒），之后走缓存通常 2–4 秒。',
      parameters: {
        ...commonParams,
        out: {
          type: 'string',
          required: true,
          description: '输出路径的绝对路径，以 .png（图片）或 .ggb（GeoGebra 可打开的构造文件）结尾。'
            + '写 .ggb 时会同时生成同名 .png。例：C:\\Users\\<你>\\Desktop\\图.ggb（父目录会自动创建）',
        },
        ggb: {
          type: 'string',
          description: '可选：out 是 .png 时，额外再存一份 .ggb 到这个路径（想要"图片 + 可编辑构造"两份就用它）',
        },
        transparent: { type: 'boolean', description: '透明背景，默认 false（白底会在导出后还原成 alpha）' },
        dpi: { type: 'integer', description: '输出分辨率，默认 150；讲义插图建议 200–300，纯屏显 96 即可' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string' },
            ggbPath: { type: 'string' },
            ggbBytes: { type: 'integer' },
            bytes: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            values: { type: 'array', items: { type: 'string' } },
            commands: { type: 'array', items: commandResultSchema() },
            error: { type: 'string' },
            notes: { type: 'string' },
            dpi: { type: 'integer' },
            elapsedMs: { type: 'integer' },
          },
        },
        render: (args, value) => {
          if (!value?.ok) {
            return [{
              type: 'text',
              text: `渲染失败：${value?.error ?? '未知原因'}`,
            }];
          }
          const lines = [
            `已生成 GeoGebra 图：${value.path}（${((value.bytes ?? 0) / 1024).toFixed(1)} KB，`
              + `${value.width}x${value.height}，耗时 ${((value.elapsedMs ?? 0) / 1000).toFixed(1)} 秒）`,
          ];
          if (value.ggbPath) {
            lines.push(`可编辑构造文件：${value.ggbPath}（${((value.ggbBytes ?? 0) / 1024).toFixed(1)} KB，`
              + 'GeoGebra 里「打开」即可继续拖动/改参数）');
          }
          if (value.notes) lines.push(`注意：${value.notes}`);
          const named = (value.commands ?? []).filter((c) => c.value);
          if (named.length) {
            lines.push('读回的值（用它自查数学是否正确，再看图）：');
            for (const c of named) lines.push(`- ${c.command} → ${c.value}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const result = await renderToPng({ ...args });
        return pick({ ...result, commands: normalizeCommands(result.commands) }, DRAW_OUTPUT_KEYS);
      },
    })));
    writeStatus({ draw: 'ok' });
  } catch (error) {
    writeStatus({ draw: 'FAILED: ' + String(error?.stack ?? error?.message ?? error) });
  }

  // ---------- ggb_eval：只回命令结果，不出图（模型自查用） ----------
  try {
    const tools = ctx.tools;
    disposers.push(tools.register(defineTool({
      name: 'ggb_eval',
      description:
        '只执行 GeoGebra 命令并把每条命令的结果值读回来，不生成图片。'
        + '用于画图前自查：例如令 T=Tangent(1,f) 后读 T 是否为 "y = -2"。'
        + '画图请用 ggb_draw。',
      parameters: { ...commonParams },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            bytes: { type: 'integer' },
            values: { type: 'array', items: { type: 'string' } },
            commands: { type: 'array', items: commandResultSchema() },
            error: { type: 'string' },
            elapsedMs: { type: 'integer' },
          },
        },
        render: (_args, value) => {
          if (!value?.ok) return [{ type: 'text', text: `执行失败：${value?.error ?? '未知原因'}` }];
          const rows = (value.commands ?? []).map((c) => `- ${c.command}${c.value ? ' → ' + c.value : ''}`);
          return [{ type: 'text', text: `命令全部执行成功：\n${rows.join('\n')}` }];
        },
      },
      async execute(args) {
        const result = await renderToPng({ ...args, evalOnly: true });
        return pick({ ...result, commands: normalizeCommands(result.commands) }, EVAL_OUTPUT_KEYS);
      },
    })));
    writeStatus({ eval: 'ok' });
  } catch (error) {
    writeStatus({ eval: 'FAILED: ' + String(error?.stack ?? error?.message ?? error) });
  }

  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
  };
}

export default { name, inject, apply };
