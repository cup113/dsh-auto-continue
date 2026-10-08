# dsh-auto-continue

中文 · [English](README.en.md)

当 provider 用一个「重发同一个请求也救不回来」的理由拒绝模型请求时（默认只认 `INVALID_REQUEST`），
在 15s / 60s / 240s 后自动开一轮新 turn 续跑，最多 3 次；预算用完就把决定权交回人类。

它做的事就是人手动敲一句 "continue" 所做的事，只不过由插件代劳、有预算、并且以自己 durable 的消息来源记账
（`source.kind = 'auto-continue'`，界面里显示成一行 notice，不是冒充你说的话）。

## 为什么不是 request 重试

| 事实 | 出处 |
| --- | --- |
| 400 被分类为 `INVALID_REQUEST`，重试插件在可重试集合里找不到它就 `next()` 放行，整轮立即终结 | `packages/llm/llm-pi-ai/src/stream.ts:48-49`、`packages/llm/llm/src/retry-policy.ts:18-24`、`packages/llm/llm-retry/src/index.ts:215-217` |
| 把它塞进 `retryableCodes` 试过：同一个 `retryId`、10 次退避、130 秒，全部 400 | 会话日志 seq 630–660，`policyKey=["normal",10,[...,"INVALID_REQUEST",...],500,10000,0.1]` |
| 而失效之后的新 turn（带一条新 user 消息）能恢复：69 次失败事件里 44 次随后成功，间隔 12–53s | 292 个会话日志全量扫描 |
| 观测点只能是 `turn/end` 的 `reason.error`：`llm-deepseek` 对 HTTP 4xx 是 throw，根本不进 `agent/request-error` 瀑布；只有 pi-ai 走 in-band finish | `packages/llm/llm-deepseek/src/adapter.ts:133-144`、`packages/core/agent-loop/src/agent.ts:375-385` |

结论：**同 body 的请求重试是死路，能救回来的是"新的一轮"**，所以这个插件在 turn 级别工作，而不是 request 级别。

## 行为规范

状态按 agent 记账（进程内）：`{ 连续次数, 待发预约, 定时器 }`。最后一条 `turn/end` 说了算。

1. `turn/end` 且 `reason.kind === 'error'`、`reason.error.code` ∈ `codes`、且该会话有存活的注册 agent → 记一个预约。
2. 以下任一情形不记：`reason.kind` 是 `aborted` / `max-tokens` / `completed`；`code` 不在集合里；次数已达 `maxContinues`；会话有 **active** goal（`skipActiveGoal`）。
3. 只在 `agent/status` 变成 `idle` 时才起定时器，延迟 = `delaysMs[min(次数, len-1)]`。
4. 等待期间出现任何**非本插件来源**的 `user/message`（人类、或 tool-jobs 那类通知）、或 `turn/start`、或 agent 转入 `running` → 取消本次预约。
5. 定时器到点后复查：插件未卸载、agent 仍注册且 `status === 'idle'`、预约仍是当前那一个 → 才投递；随后 `次数 += 1` 并 `agent.followup(...)`。
6. 任何 `assistant/message`（模型真的产出了）或任何非本插件来源的 `user/message` → 次数归零。
7. 投递本身抛错 → 回滚次数、记一条 warn（一次失败的投递不该吃掉预算）。
8. agent 被 dispose、或插件被卸载 → 清定时器与状态。

模型看到的正文（写死，改它等于改行为）：

```
Your previous request was rejected by the provider before it produced any output. Continue the task from the current state. (automatic recovery {n} of {N})
```

你看到的一行：`auto-continue {n}/{N} — {code}`。

## 配置

```yaml
- id: auto-continue
  name: dsh-auto-continue
  config:
    enabled: true
    codes: [INVALID_REQUEST]        # 可加 PI_AI_ERROR / UNKNOWN，但先想清楚它们的语义
    maxContinues: 3
    delaysMs: [15000, 60000, 240000] # 长度可以短于 maxContinues，此时重复最后一个值
    skipActiveGoal: true
```

非法值（未知键、0 或负数延迟、非整数上限、空的 `codes`）在**加载时直接抛错**，不静默降级。

## 安装

```powershell
cd <path-to>\dsh-auto-continue
npm install            # 只为一件事：@deepseek-ai/dsh-llm 的 createUserMessage / boundContextSummary
```

profile（`~/.dsh/profiles/<name>/package.json`）：

```json
"dependencies": { "dsh-auto-continue": "link:<path-to>/dsh-auto-continue" },
"dsh": { "profile": { "bundles": [ "...", "dsh-auto-continue" ] } }
```

然后 `pnpm install`（若报 lockfile 冲突：`$env:CI='true'` + `--no-frozen-lockfile`），再**重启 `dsh web`**——
`patchReload: live` 只覆盖 cordis 配置，不覆盖 node 侧的插件代码。

依赖约定（照 `dsh-tool-bridge` 的既有布局）：`@deepseek-ai/dsh-llm` 同时出现在 `peerDependencies` 与
`devDependencies`，因为 `link:` 安装下 Node 从插件的 realpath 解析，profile 的 `node_modules` 不是它的祖先。
升级 dsh 之后要把两处版本一起改（`npm install @deepseek-ai/dsh-llm@<新版本>`）。

> 若出现"重复核心包"症状（每一次工具调用都报 `Cannot read properties of undefined (reading 'prepare')`），
> 把 `index.js` 里那行 import 换成 6 行等价手写即可消除这条依赖边：
> `deepFreeze(structuredClone({ id: randomUUID(), role: 'user', content, source }))`
> —— 与 `createUserMessage` 语义相同（`packages/llm/llm/src/message.ts:246-253`），代价是与上游构造函数脱钩。

## 验收

```powershell
npm test                                     # 状态机单测（假 ctx，无 DSH 运行时）
node scripts/mock-gateway.mjs                # 终端 1：首个 POST /responses 回 400，其余转发真网关
dsh web --patch scripts/acceptance.overlay.yml   # 终端 2：只改 command-code 的 baseURL
npm run stats                                # 从会话日志量救回率（安装前后都能跑）
```

mock 端到端要看三件事：失败行出现；`auto-continue 1/3 — INVALID_REQUEST` 的 notice 行出现；
15 秒后第二次请求成功、任务继续做完。

`npm run stats` 输出示例（基线：还没装这个插件时 `automatic continuations: 0`）：

```
INVALID_REQUEST turns:    69
automatic continuations:  0
```

## 已知代价与风险

- **确定性变体救不回来。** 网关的三种 400 里，`unknown field "summary"`（9 次）和
  `reasoning_text must be passed back`（4 次）是请求体本身的问题，新 turn 同样会失败——那 3 次预算就是净损耗。
  根治要么网关侧修，要么关掉对应的 reasoning 字段。
- **它会在你不在场时替你发言**（含子代理）。这是它被放在树外、且默认只在 `INVALID_REQUEST` 上生效的原因。
- **goal 会话被跳过。** goal-round-driver 在 `agent/error` 上会 disarm，把自动工作交还人类 resume；
  这个插件不该绕过那道栅栏。要允许它续 goal 会话，把 `skipActiveGoal` 设为 false（代价：继续发生在 goal 轮次计数之外）。
- **子代理也续。** 依据：7 个子代理会话命中过同一错误，不接住会直接污染父代理的 `send_message` 结果。
- **进程内计数。** 重启后归零——重启后不存在"刚失败的 idle agent"，所以不需要持久化。

## 不做什么

不做 request 级降级重发（关 reasoning、降 effort）；不把 provider 的 trace_id 塞进模型上下文；
不加界面按钮或斜杠命令；不在 goal 会话上抢续跑权；不跨进程持久计数。

## 协议

[MIT](LICENSE)
