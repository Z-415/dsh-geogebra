/**
 * 契约测试（不需要网络、不需要 Edge、不需要真 DSH）
 *
 * 盯的是"装机之后才会炸"的那类问题：
 *   ① 输出 schema 是 `additionalProperties: false`，`execute()` 多返回一个字段就被宿主整条拒收。
 *      2026-10-24 真实踩过：`"value.dpi" is not a declared property` —— 图已经生成成功，
 *      调用方却只看到一句 invalid output，极容易误判成渲染坏了。
 *   ② defineTool 严格校验 schema，注册阶段抛错会让**后面的工具静默消失**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, prepareCopy, bootPlugin } from './helpers.mjs';

test('package.json 与 cordis.patch.yml 的清单契约', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-geogebra');
  assert.ok(pkg.dsh?.bundle?.patch, 'package.json 必须声明 dsh.bundle.patch');
  assert.ok(pkg.engines?.node, 'package.json 必须声明 engines.node');
  assert.ok(pkg.engines?.dsh, 'package.json 必须声明 engines.dsh');
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.files?.includes('cordis.patch.yml'), 'files 必须带上 cordis.patch.yml');
  assert.ok(pkg.files?.includes('lib/render.mjs'), 'files 必须带上 lib/render.mjs');

  const patch = await fs.readFile(path.join(repoRoot, 'cordis.patch.yml'), 'utf8');
  // 挂载名必须是**包名**：写相对路径只在校验期的软链下成立，正规安装会 failed to import
  assert.match(patch, /name:\s*'dsh-geogebra'/, 'cordis.patch.yml 的 name 必须是包名 dsh-geogebra');
  assert.doesNotMatch(patch, /name:\s*['"]?\.\//, 'name 不能是相对路径');
});

test('apply() 注册两个工具，各自带 execute / render / 严格 schema', async () => {
  const { work, entry } = await prepareCopy();
  try {
    const { registered, dispose } = await bootPlugin(entry);
    assert.deepEqual(registered.map((t) => t.name).sort(), ['ggb_draw', 'ggb_eval']);
    for (const spec of registered) {
      assert.equal(typeof spec.execute, 'function', `${spec.name} 缺少 execute`);
      assert.equal(typeof spec.output?.render, 'function', `${spec.name} 缺少 output.render`);
      assert.equal(spec.output?.schema?.additionalProperties, false, `${spec.name} 的输出 schema 必须禁止额外字段`);
      assert.ok(spec.parameters?.commands?.required, `${spec.name} 的 commands 必须必填`);
    }
    assert.equal(typeof dispose, 'function', 'apply 必须返回可释放的 dispose');
    dispose();
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('输出字段白名单与 schema 声明完全一致（防"多一个字段整条被拒"）', async () => {
  const { work, entry } = await prepareCopy();
  try {
    const { mod, registered, dispose } = await bootPlugin(entry);
    const expects = { ggb_draw: mod.DRAW_OUTPUT_KEYS, ggb_eval: mod.EVAL_OUTPUT_KEYS };
    for (const spec of registered) {
      const declared = Object.keys(spec.output.schema.properties ?? {}).sort();
      const whitelist = [...(expects[spec.name] ?? [])].sort();
      assert.ok(whitelist.length > 0, `${spec.name} 没导出输出字段白名单`);
      const schemaOnly = declared.filter((k) => !whitelist.includes(k));
      const listOnly = whitelist.filter((k) => !declared.includes(k));
      assert.deepEqual([schemaOnly, listOnly], [[], []],
        `${spec.name} 白名单与 schema 不一致：schema 多 ${schemaOnly}，白名单多 ${listOnly}`);
      assert.ok(declared.includes('ok'), `${spec.name} 的输出 schema 必须包含 ok`);
    }
    dispose();
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('参数错误时返回 ok:false，且字段不越界（不联网、不出图）', async () => {
  const { work, entry } = await prepareCopy();
  try {
    const { tools, dispose } = await bootPlugin(entry);
    const draw = tools.get('ggb_draw');
    const declared = Object.keys(draw.output.schema.properties ?? {});

    const cases = [
      { args: { commands: [], out: 'C:\\tmp\\x.png' }, why: '空命令数组' },
      { args: { commands: ['f(x)=x^3-3x'] }, why: '缺 out' },
      { args: { commands: ['f(x)=x^3-3x'], out: 'C:\\tmp\\x.txt' }, why: 'out 扩展名不支持' },
      { args: { commands: ['f(x)=x^3-3x'], out: 'C:\\tmp\\x.png', ggb: 'C:\\tmp\\x.zip' }, why: 'ggb 扩展名不支持' },
      { args: { commands: ['   '], out: 'C:\\tmp\\x.png' }, why: '空字符串命令' },
    ];

    for (const { args, why } of cases) {
      const value = await draw.execute(args);
      assert.equal(value.ok, false, `${why}：应当失败`);
      assert.ok(value.error, `${why}：应当带上错误说明`);
      const extra = Object.keys(value).filter((k) => !declared.includes(k));
      assert.deepEqual(extra, [], `${why}：返回了 schema 未声明的字段 ${extra.join(', ')}`);
      const text = draw.output.render(args, value).map((p) => p.text).join('');
      assert.match(text, /失败/, `${why}：render 应当输出失败文案`);
    }
    dispose();
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});
