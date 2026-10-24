/** 测试公用：把插件复制到临时目录并塞入 `@deepseek-ai/dsh-tools` 的 stub。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 复制仓库到临时目录，并写一个最小 `@deepseek-ai/dsh-tools`：
 * 真实的 defineTool 就是"校验 schema 后原样返回 spec"，stub 按这个最小契约来。
 */
export async function prepareCopy() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ggb-test-'));
  const copy = path.join(work, 'dsh-geogebra');
  await fs.cp(repoRoot, copy, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(repoRoot, src);
      if (!rel) return true;
      return !rel.startsWith('.git') && !rel.startsWith('test') && !rel.split(path.sep).includes('node_modules');
    },
  });

  const stubDir = path.join(copy, 'node_modules', '@deepseek-ai', 'dsh-tools');
  await fs.mkdir(stubDir, { recursive: true });
  await fs.writeFile(path.join(stubDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools',
    version: '0.0.0-stub',
    type: 'module',
    main: 'index.js',
    exports: './index.js',
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(stubDir, 'index.js'),
    'export const defineTool = (spec) => spec;\nexport default { defineTool };\n', 'utf8');

  return { work, copy, entry: path.join(copy, 'index.js') };
}

/** 起插件：假的 ctx.tools.register 把 spec 收集起来。 */
export async function bootPlugin(entry) {
  const mod = await import(pathToFileURL(entry).href);
  const registered = [];
  const fakeCtx = { tools: { register: (spec) => { registered.push(spec); return () => {}; } } };
  const dispose = mod.apply(fakeCtx);
  return { mod, registered, dispose, tools: new Map(registered.map((t) => [t.name, t])) };
}

/** 失败重试：CI 上首次要联网拉约 30MB GeoGebra 资源，偶发超时不该判红。 */
export async function retry(fn, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await fn();
      if (value?.ok) return value;
      last = value;
    } catch (error) {
      last = { ok: false, error: String(error?.message ?? error) };
    }
  }
  return last;
}

/** 读 PNG 的 IHDR 尺寸。 */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
