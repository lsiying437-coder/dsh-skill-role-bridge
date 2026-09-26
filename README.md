# dsh-skill-role-bridge

DeepSeek Harness 插件：把 **两类以 user role 注入的内容搬到 system prompt 段**，不改写内容，只换注入通道。

| 内容 | 注入方 | `source.kind` |
|---|---|---|
| skill 目录 | `dsh-tool-skill` | `skill-catalog` |
| 工作区指令 AGENTS.md | `dsh-agent-instructions` | `agent-instructions` |

## 问题

DSH 用 `createUserMessage()` 注入两类本应不可协商的内容，落盘为 `user/message` 事件：

```
seq=11   user/message  role=user  source.kind=skill-catalog        len=13687
seq=66   user/message  role=user  source.kind=agent-instructions   len=33615
```

其中工作区指令自己的措辞是「These instructions are **ACTIVE and MANDATORY** for the stated scope」——
而它落在与用户闲聊同级、可被后续输入覆盖的 user 层，与自己的措辞相矛盾。

放在 user 层意味着：

- 权威层级与用户闲聊同级，长对话中会被后续内容稀释；
- 形式上可被后续 user 输入覆盖，而 system 不可协商；
- `<system-reminder>` 标签被用在 user 角色内容上，模型无法从 role 区分「系统说的」与「用户说的」。

## 做法

两个钩子，覆盖两类内容：

1. **`system-prompt/assemble` 钩子（异步）** —— 取数并渲染成 system prompt 段：
   - skill 目录：查 `ctx.skills.snapshot()`，措辞/转义/500 字符截断都与 `dsh-tool-skill`
     的 `renderCatalogMessage` 对齐，只有 `modelInvocable: true` 的技能进目录；
   - 工作区指令：从会话事件读最后一条 `agent-instructions` 消息的**原文**（零改写）。
2. **`agent/pre-step` 钩子（prepend）** —— 把 **skill 目录**的 user 消息在落盘之前滤掉。

**工作区指令不滤。** 它的 system 段从会话事件读，滤掉就等于切断自己的数据源。指令是一次性
注入（不像目录会随文件系统变化反复重发），保留 user 层那份的代价只有一份文本。

### 两条走过的弯路

**一、`loadBaselineInstructions` 覆盖不到子目录。** 最初想用它（DSH 导出的官方 API）来零改写
地取指令，但那个 API 只扫 cwd 的**祖先链**——向上找项目根，再向下收集到 cwd。而 AGENTS.md
常常在 cwd 的**子目录**里（本机实测：cwd 是 `dsh/test`，指令在 `work/src-auto/AGENTS.md`）。
DSH 自己靠 `touchedPaths` 机制按需发现（工具访问该目录时才触发注入），那机制没有对外暴露，
插件侧复现不了。结果就是重启后 `system/message` 里 `available_skills=True` 而 `AGENTS=False`。

**二、它返回的不是字符串。** 那个 API 的 JSDoc 写作 "returns rendered baseline context"，
实际返回 `{ text, omitted, truncated }`，正文在 `.text`。直接当字符串用会静默拿到一个对象。
（现在已经不用这个 API 了，但这个坑值得记。）

### 为什么不能用 `ctx.systemPrompt.section()`

段文本函数是**同步**调用的：

```js
text: typeof section.text === "function" ? section.text(context) : section.text   // 无 await
```

而 `ctx.skills` 的读取 API（`snapshot` / `list` / `get`）**全是 async**，没有同步版本，
所以段函数拿不到 skill 数据。退而求其次的两条路都有硬伤，实测都踩过：

- **从 `session.snapshotEvents()` 同步读已落盘的目录消息** —— 那就不能滤掉 user 消息：
  一滤，唯一的数据源就没了，段永远是空的，**新会话完全看不到 skill 列表**（实测：
  子代理会话的 system prompt 停在 90376 字节，`available_skills=False`）。
- **在 pre-step 里更新缓存** —— `preStep` 里 `assemble` 先于 waterfall 执行：

  ```js
  const assembly = await this.loopCtx.systemPrompt.assemble(...);          // 先组装
  const decision = await this.dispatch.waterfall("agent/pre-step", ...);   // 后跑钩子
  ```

  缓存对本步无效，要等下一步，首步缺目录。

`system-prompt/assemble` 的 waterfall 是 `await` 的，钩子可以自由异步取数，且就在组装过程中
生效，没有时序问题。

### 为什么 pre-step 要 `prepend`

cordis 的 waterfall 是 outermost-first，而 `dsh-tool-skill` 在启动时已注册同名钩子。
只有 `prepend: true` 才能站在它之外层，拿到它 append 好的消息再过滤。

## 实测结果

**第一版（section 读 session，不滤 user 消息）** —— 已实测有效：

```
system/message  seq=723  role=system  len=104065  含 available_skills=True
                （注入前 len=90376，增量 13689 = 目录原文 13687 + 2）
段 == 原文: True   段长 13687 == 原文 13687   skill 条目数 49 == 49
```

代价是目录在 user 层与 system 层各一份（历史那条摘不掉）。

**第二版（assemble 钩子 + 滤 user 消息，当前代码）** —— 本地 16 项断言全通过，
宿主实测段注入正常：

```
段序: deployment:persona-prefix → deployment:persona-suffix → bridge:skill-catalog
```

段追加在 sections 末尾（不参与 `order` 排序，因为它是组装之后追加的）。

## 已知限制

**已经写进历史的 user 目录摘不掉。** `agent/pre-step` 收到的 `messages` 是 `inbox.claim()`
的结果，只含本步新投递的消息，不含历史；历史由 session 的 surface 决定，插件无法通过
pre-step 的返回值删除。

- 新会话：新发布的目录在落盘前被拦下，**完全无重复**；
- 既有会话：历史里那一条会与 system 段并存。两份内容逐字节一致，不冲突。

彻底去重需要 surface 级操作（`dsh-agent-loop` 的 `inbox.project()` / `surfaceOp`），
插件层没有公开入口。

## 安装

```bash
# 从本地目录（开发时）
dsh plugin --profile web add link:$PWD

# 或从 GitHub
dsh plugin --profile web add "github:lsiying437-coder/dsh-skill-role-bridge"
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: skill-role-bridge
      name: dsh-skill-role-bridge
```

**需要重启一次 `dsh web` 才生效。** 热重载（`patchReload: live`）对**已经加载过的**插件更新
有效，但长驻进程的 ESM 模块缓存会让新插件的首次加载拿不到最新代码 —— 实测必须重启。

## 回滚

删掉 `cordis.patch.yml` 里的 insert 块，并：

```bash
dsh plugin --profile web remove dsh-skill-role-bridge
```

## 验证

```bash
node test/verify.mjs      # 真实 cordis + dsh-system-prompt 宿主，10 项断言
```
