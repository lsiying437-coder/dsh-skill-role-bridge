/**
 * dsh-role-bridge —— 把 user role 注入的两类内容搬到 system prompt。
 *
 * ## 问题
 *
 * DSH 用 `createUserMessage()` 注入两类「本应不可协商」的内容：
 *
 *   · **skill 目录**（`dsh-tool-skill`）—— `source.kind = "skill-catalog"`
 *   · **工作区指令 AGENTS.md**（`dsh-agent-instructions`）—— `source.kind = "agent-instructions"`
 *
 * 两者都落盘为 `user/message` 事件，role = user。工作区指令的内容是
 * 「These instructions are ACTIVE and MANDATORY for the stated scope」——放在与用户
 * 闲聊同级、可被后续输入覆盖的 user 层，与它自己的措辞相矛盾。
 *
 * ## 做法
 *
 * 两个钩子，覆盖两类内容：
 *
 *   ① `system-prompt/assemble`（**异步**）—— 取数并渲染成 system prompt 段：
 *      · skill 目录：查 `ctx.skills.snapshot()`（异步），滤除后仍可自取，无依赖
 *      · 工作区指令：从会话事件读原文（同步），零改写
 *   ② `agent/pre-step`（**prepend**）—— 把 **skill 目录**的 user 消息在落盘前滤掉。
 *      工作区指令不滤：它的 system 段从会话事件读，滤掉就切断了自己的数据源。
 *
 * ## 为什么不能用 `ctx.systemPrompt.section()`
 *
 * 段文本函数是**同步**调用的：
 *
 *   text: typeof section.text === "function" ? section.text(context) : section.text
 *
 * 而 `ctx.skills.snapshot()` 和 `loadBaselineInstructions()` 都是 async，没有同步版本。
 * 退而求其次从 `session.snapshotEvents()` 同步读已落盘的消息也能work，但那要求消息
 * **先落盘** —— 与钩子②互斥（一滤，唯一的数据源就没了，段永远是空的）。
 *
 * `system-prompt/assemble` 的 waterfall 是 await 的，钩子可以自由异步取数，且就在
 * 组装过程中生效，没有时序问题。
 *
 * ## 为什么 pre-step 要 `prepend`
 *
 * cordis 的 waterfall 是 outermost-first，而这两个官方插件在启动时已注册同名钩子。
 * 只有 `prepend: true` 才能站在它们之外层，拿到它们 append 好的消息再过滤。
 *
 * ## 已知边界
 *
 * 滤除只覆盖「本步新投递」（`inbox.claim()` 的结果）。若会话历史里已经存在这两类事件
 * （例如插件启用前就已产生的），那条摘不掉 —— 历史由 session 的 surface 决定，插件
 * 无法通过 pre-step 的返回值删除。
 */
export const name = 'skill-role-bridge';

/** `systemPrompt` 用于注册段，`skills` 用于取目录数据。 */
export const inject = ['systemPrompt', 'skills'];

/** 两类被搬移的 source.kind。 */
export const SKILL_SOURCE_KIND = 'skill-catalog';
export const INSTRUCTION_SOURCE_KIND = 'agent-instructions';

/** 两个段名。 */
export const SKILL_SECTION_NAME = 'bridge:skill-catalog';
export const INSTRUCTION_SECTION_NAME = 'bridge:workspace-instructions';

/** 描述截断上限，与 `dsh-tool-skill` 的 `catalogDescriptionMaxLength` 保持一致。 */
const DESCRIPTION_MAX_LENGTH = 500;

/** 上一次成功组装的文本，供快照不完整/读取失败时沿用。 */
let lastGoodCatalog = '';

/** 与 `dsh-tool-skill` 的 escapeText 一致：目录正文不得开合框架标签。 */
export function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 与 `dsh-tool-skill` 的 catalogDescription 一致：折叠空白并按上限截断。 */
export function catalogDescription(value, maxLength = DESCRIPTION_MAX_LENGTH) {
  const normalized = String(value).replaceAll(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

/** 渲染 skill 目录段，措辞与 `dsh-tool-skill` 的 renderCatalogMessage 保持一致。 */
export function renderCatalog(entries) {
  return [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    ...entries.map((entry) => `- \`${entry.name}\`: ${escapeText(catalogDescription(entry.description))}`),
    '</available_skills>',
    '',
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    '</system-reminder>',
  ].join('\n');
}

/**
 * 是否为需要摘除的 user 消息。
 *
 * 只摘 skill 目录，**不摘工作区指令**：后者的 system 段是从会话事件读的，
 * 摘掉就等于切断了自己的数据源。指令是一次性注入（不会每步重复），
 * 保留 user 层那份的代价只有一份文本。
 */
export function isBridgedMessage(message) {
  return message?.source?.kind === SKILL_SOURCE_KIND;
}

/** 滤掉需要搬移的消息；无变化时返回原数组（便于调用方判等跳过）。 */
export function filterBridgedMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const kept = messages.filter((message) => !isBridgedMessage(message));
  return kept.length === messages.length ? messages : kept;
}

/**
 * 查 skills 快照并渲染目录；发现未完成或出错时沿用上一次的文本。
 * @param ctx - 插件上下文（需 `skills` 服务）。
 * @param context - assemble 上下文，含 agent / scope / signal。
 * @returns 目录正文，或空串（此时段会被组装流程丢弃）。
 */
export async function buildCatalogText(ctx, context) {
  const agent = context?.agent;
  if (agent === undefined) return lastGoodCatalog;
  try {
    const snapshot = await ctx.skills.snapshot({
      cwd: agent.session?.header?.cwd,
      signal: context.signal,
      scope: agent,
    });
    if (snapshot?.complete !== true) return lastGoodCatalog;
    const entries = (snapshot.skills ?? [])
      .filter((skill) => skill?.invocation?.modelInvocable === true)
      .map((skill) => ({ name: skill.name, description: skill.description ?? '' }));
    lastGoodCatalog = entries.length === 0 ? '' : renderCatalog(entries);
    return lastGoodCatalog;
  } catch {
    return lastGoodCatalog;
  }
}

/**
 * 从会话事件里取最后一条工作区指令消息的**原文**。
 *
 * 不能改用 `loadBaselineInstructions({cwd})`：那个 API 只扫 cwd 的**祖先链**
 * （向上找项目根、再向下收集到 cwd），而 AGENTS.md 常常在 cwd 的**子目录**里
 * （本机实测：cwd 是 `dsh/test`，指令在 `work/src-auto/AGENTS.md`）。
 * DSH 自己靠 `touchedPaths` 机制按需发现——工具访问该目录时才触发注入，
 * 那个机制没有对外暴露，无法从插件侧复现。
 *
 * 从事件读则是零改写：拿到的就是 DSH 渲染好、模型实际看到的那一份
 * （含 scope、字节预算、变更说明）。
 *
 * 代价是延迟一步——指令先作为 user 消息落盘，下一步的 assemble 才能读到。
 * 首步模型仍能从 user 层看到指令，不会丢。
 */
export function latestInstructionText(agent) {
  const session = agent?.session;
  if (session === undefined || typeof session.snapshotEvents !== 'function') return '';
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return '';
  }
  if (!Array.isArray(events)) return '';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'user/message') continue;
    const source = event?.data?.source ?? event?.data?.message?.source;
    if (source?.kind !== INSTRUCTION_SOURCE_KIND) continue;
    const text = messageText(event?.data?.message ?? event?.data);
    if (text.trim() !== '') return text;
  }
  return '';
}

/** 从消息的 content 数组里取出全部文本块。 */
function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** 供测试与观测：读上一次成功组装的目录文本。 */
export function currentText() {
  return { catalog: lastGoodCatalog };
}

/** 供测试与观测：重置缓存。 */
export function resetText() {
  lastGoodCatalog = '';
}

export function apply(ctx) {
  // ① 两类内容的唯一来源：在组装过程中异步取数并追加为 system 段。
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next();
    const extra = [];
    const catalog = await buildCatalogText(ctx, context);
    if (catalog !== '') extra.push({ name: SKILL_SECTION_NAME, text: catalog });
    const instructions = latestInstructionText(context?.agent);
    if (instructions !== '') extra.push({ name: INSTRUCTION_SECTION_NAME, text: instructions });
    if (extra.length === 0) return assembled;
    return { ...assembled, sections: [...assembled.sections, ...extra] };
  }, { prepend: true });

  // ② 抑制 user 层的这两类消息：必须在它们落盘之前拦下（落盘后即成为历史，摘不掉）。
  ctx.on('agent/pre-step', async ({ signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    signal?.throwIfAborted?.();
    const kept = filterBridgedMessages(decision.messages);
    if (kept === decision.messages) return decision;
    return { ...decision, messages: kept };
  }, { prepend: true });
}
