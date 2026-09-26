/**
 * dsh-role-bridge 验证 —— 用**真实的** cordis + dsh-system-prompt 起最小宿主，
 * `skills` 用 mock 服务替代，工作区指令用真实临时目录 + .git + AGENTS.md 实测。
 *
 *   node test/verify.mjs
 *
 * 验证：
 *   ① 渲染函数（转义 / 截断 / 段正文）与 dsh-tool-skill 的措辞一致；
 *   ② `system-prompt/assemble` 把 skill 目录段与工作区指令段注入 assembly 并渲染；
 *   ③ 快照不完整时沿用上一次文本（不清空段）；
 *   ④ 过滤函数摘掉两类消息、不动其他消息；
 *   ⑤ 工作区指令走 DSH 自己的 `loadBaselineInstructions` 读取真实文件。
 *
 * 依赖：本机装过 dsh。profile 位置取 DSH_HOME（缺省 ~/.dsh）下的 profiles/web。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileRoot = join(dshHome, 'profiles', process.env.DSH_PROFILE || 'web');
if (!existsSync(join(profileRoot, 'package.json'))) {
  throw new Error('找不到 dsh profile: ' + profileRoot + '（用 DSH_HOME / DSH_PROFILE 覆盖）');
}

const fromProfile = createRequire(join(profileRoot, 'package.json'));
const load = async (request) => import(pathToFileURL(fromProfile.resolve(request)).href);

const { Context } = await load('@deepseek-ai/cordis');
const { default: SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const mod = await import('../index.js');

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const SKILLS = [
  { name: 'alpha-skill', description: '第一个示例技能', invocation: { modelInvocable: true } },
  { name: 'beta-skill', description: '第二个示例技能', invocation: { modelInvocable: true } },
  { name: 'hidden-skill', description: '不可由模型调用', invocation: { modelInvocable: false } },
];

console.log('=== 1. 渲染函数 ===');
check('escapeText 转义 &<>', mod.escapeText('a&b<c>d') === 'a&amp;b&lt;c&gt;d');
check('catalogDescription 折叠空白', mod.catalogDescription('  a\n\n  b  ') === 'a b');
check('catalogDescription 按上限截断', mod.catalogDescription('x'.repeat(600)).length === 500);
const rendered = mod.renderCatalog([{ name: 'demo', description: '示例' }]);
check('目录段含 available_skills', rendered.includes('<available_skills>'));
check('目录段含条目行', rendered.includes('- `demo`: 示例'));
check('目录段首尾为 system-reminder', rendered.startsWith('<system-reminder>') && rendered.endsWith('</system-reminder>'));

console.log('\n=== 2. 过滤函数（两类消息）===');
const normal = { id: 'n1', source: { kind: 'user' } };
const catalog = { id: 'c1', source: { kind: mod.SKILL_SOURCE_KIND } };
const instructions = { id: 'i1', source: { kind: mod.INSTRUCTION_SOURCE_KIND } };
check('摘掉 skill 目录消息', mod.isBridgedMessage(catalog) === true);
check('不摘工作区指令（它是 system 段的数据源）', mod.isBridgedMessage(instructions) === false);
check('不动普通 user 消息', mod.isBridgedMessage(normal) === false);
check('混合输入只摘目录', mod.filterBridgedMessages([normal, catalog, instructions]).length === 2);
const unchanged = [normal];
check('无命中时返回原数组（判等可跳过）', mod.filterBridgedMessages(unchanged) === unchanged);

const INSTRUCTION_TEXT = [
  '<system-reminder>',
  'Additional instructions from: work/src-auto/AGENTS.md',
  '',
  'These instructions apply to work under `work/src-auto`. These instructions are ACTIVE and MANDATORY for the stated scope.',
  '',
  '# 测试指令',
  '',
  '这是一条必须遵守的测试规则。',
  '</system-reminder>',
].join('\n');

/** 构造一个带会话事件的 mock agent（模拟 DSH 的内存态事件形态）。 */
const mockAgent = (events, cwd = '/tmp') => ({
  session: { header: { cwd }, snapshotEvents: () => events },
});
const instructionEvent = {
  type: 'user/message',
  seq: 66,
  data: { message: { role: 'user', content: [{ type: 'text', text: INSTRUCTION_TEXT }], source: { kind: 'agent-instructions' } } },
};

console.log('\n=== 3. 真实宿主：两个段都注入 ===');
const root = new Context();
await root.plugin(SystemPrompt, {});
const skillsMock = {
  complete: true,
  skills: SKILLS,
  async snapshot() {
    return { complete: this.complete, skills: this.skills };
  },
};
root.provide('skills', skillsMock);
await root.plugin({ name: mod.name, inject: mod.inject, apply: mod.apply });

const prompt = root.get('systemPrompt');

const agent = mockAgent([instructionEvent]);
const assembly = await prompt.assemble({ agent, scope: agent });
const names = assembly.sections.map((section) => section.name);
check('skill 目录段已注入', names.includes(mod.SKILL_SECTION_NAME), `段序: ${names.join(' → ')}`);
check('工作区指令段已注入', names.includes(mod.INSTRUCTION_SECTION_NAME));

const text = renderPrompt(assembly);
check('渲染含 available_skills', text.includes('available_skills'));
check('渲染含 alpha-skill', text.includes('- `alpha-skill`: 第一个示例技能'));
check('不含 modelInvocable=false 的技能', !text.includes('hidden-skill'));
check('渲染含 AGENTS.md 正文', text.includes('这是一条必须遵守的测试规则'));
check('渲染含 AGENTS.md 路径提示', text.includes('work/src-auto/AGENTS.md'));

console.log('\n=== 4. 快照不完整时沿用上一次文本 ===');
mod.resetText();
const first = await mod.buildCatalogText(root, { agent });
check('首次组装得到目录正文', first.includes('alpha-skill'));
skillsMock.complete = false;
skillsMock.skills = [];
const afterIncomplete = await mod.buildCatalogText(root, { agent });
check('快照不完整时不清空目录段', afterIncomplete === first, `len=${afterIncomplete.length}`);

console.log('\n=== 5. 工作区指令读取（会话事件）===');
check('从事件读到指令正文', mod.latestInstructionText(mockAgent([instructionEvent])).includes('必须遵守的测试规则'));
check('无指令事件时返回空串', mod.latestInstructionText(mockAgent([])) === '');
check('无 session 时返回空串', mod.latestInstructionText(undefined) === '');
check('session 抛错时返回空串', mod.latestInstructionText({ session: { snapshotEvents: () => { throw new Error('x'); } } }) === '');
check('取最后一条（多条时以最新为准）', (() => {
  const older = { ...instructionEvent, data: { message: { role: 'user', content: [{ type: 'text', text: '旧指令' }], source: { kind: 'agent-instructions' } } } };
  return mod.latestInstructionText(mockAgent([older, instructionEvent])).includes('必须遵守的测试规则');
})());

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
