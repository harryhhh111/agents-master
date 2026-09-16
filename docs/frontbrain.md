# 前台模型 FrontBrain（Stage 1.2b / 1.2c 切片）

快速主 Agent Runtime 的低延迟前台模型边界。本切片落地：接口与实现、确定性上下文
组装、能力探测脚本、不假定缓存的遥测，以及**仅用户消息事件**的 runtime 领取/完成
接线。**不含** UI、任务/记忆写入、后台循环、自动委派或领域事件处理。

## 用法

```ts
import { SQLiteMainInboxStore } from '../src/main/index.js'
import { composeFrontBrainContext, createFrontBrain } from '../src/frontbrain/index.js'

const brain = createFrontBrain(config) // 模型取 config.toml 的 [llm]，key 只走 DEEPSEEK_API_KEY
const store = new SQLiteMainInboxStore(mainAgentDbPath)
const messages = composeFrontBrainContext({
  instructions: '你是主 Agent 的前台……',
  checkpoint: '检查点 v1：……', // 可选
  messages: store.readRecentContext(20),
})
const response = await brain.complete({ messages, maxOutputTokens: 1024 })
// response: { text, finishReason?, latencyMs, usage: { inputTokens?, ..., cachedInputTokens? } }
```

- `composeFrontBrainContext` 是纯函数：稳定前缀（instructions，可选 checkpoint）原样
  输出、永不改写，其后按存储提供的 durable append order 追加持久化主对话消息。`createdAt`
  是可回填的描述性时间，不参与上下文排序；历史追加不会改变前缀字节。
- `SQLiteMainInboxStore` 是唯一的运行时主对话所有者和
  `main_conversation_messages` DDL/migration 路径：它与 inbox event 共用一个连接，因而可将
  assistant 回复和 event 状态原子写入。已不再提供独立的 SQLite conversation store。
- 实现（`DeepSeekFrontBrain`，OpenAI 兼容接口）每次调用都显式发送
  `thinking: { type: 'disabled' }`、非流式、`max_tokens` 上限（1–8192，越界抛错），
  保证前台输出有界。
- `latencyMs` 由调用前后 `performance.now()` 测得；usage/cache 字段只如实转述
  provider 上报的值。

## 用户消息事件接线（同切片，仅 user-message）

`MainAgentRuntime` 新增可选 `FrontBrain` 依赖（构造第二参数或
`createMainAgentRuntime` 的 `frontBrain` 选项；不接时旧接口照常可用）。一个异步
前台回合：

```ts
const result = await runtime.processNextUserMessageEvent({
  instructions: '你是主 Agent 的前台……',
  checkpoint: '检查点 v1：……', // 可选
  maxOutputTokens: 1024,
  contextMessageLimit: 20, // 可选，默认 20
})
// result: { event, message, response } | undefined（无 pending 用户消息时）
```

- 只领取下一个可领取的 **pending `user-message` 事件**（interrupt 用户消息优先），
  绝不领取或改动 `timer` / `domain-update` 事件；旧领取/完成接口行为不变。
- 请求 = 不可变 instructions + 可选 checkpoint（稳定前缀，原样输出）+
  持久化主对话（含本条用户消息）按 durable append order 追加，由 `composeFrontBrainContext`
  组装。领取前会校验 instructions 为非空字符串、checkpoint（如提供）为字符串、
  maxOutputTokens 为 1–8192 的安全整数，以及 contextMessageLimit（如提供）为
  1–100 的安全整数；任一不合法时事件保持 pending。成功领取后，调用失败或空回复时
  **不写任何内容**，事件保持 claimed，由调用方显式
  `recoverClaimedUserMessageEvents()` 后重试再生。前台恢复路径**只允许使用**
  `recoverClaimedUserMessageEvents()`（runtime 同名接口）：它只把 claimed 的
  `user-message` 事件退回 pending，**绝不重置** claimed 的 `timer` /
  `domain-update` 事件——那些事件可能属于其他消费者，claim 必须原样保留。
  旧的 `recoverClaimedEvents()` 保留为 legacy 语义：它重置**所有** claimed
  事件，前台路径不得调用。
- assistant 回复插入与事件 `processed` 状态在**同一个 SQLite 事务**内提交；
  状态迁移以 `status = 'claimed'` 为条件，事务提交后事件不再可领取——崩溃恢复
  与重试永远不会写出重复的 assistant 消息。provider 原始错误只抛出给调用方，
  绝不落入存储的对话。

## 能力探测（显式选择，花真钱）

```bash
npm run probe:frontbrain
```

使用固定的合成测量 fixture（12 段重复的虚构项目检查点，非产品 prompt、无真实用户数据），
拼在 instructions + 可选 checkpoint 后形成稳定前缀。目标是 provider 实际上报的输入达到
512 token；字符数/词数不是 token 数，不能代替实测。每次输出上限仍为 16 token。

按顺序串行调用五次：

1. `warmup-initial`：稳定前缀 + 尾部 A，不假定冷缓存。
2. `warmup-repeat`：完全相同的请求再次预热。
3. `warmup-prefix-detection`：相同稳定前缀 + 不同尾部 B，给 provider 识别公共前缀的机会。
4. 等待默认 2000ms 后，`measurement-continuation` 原样保留第二次请求及其 assistant 回复，
   追加一个用户轮，测量真实 continuation。
5. `measurement-common-prefix`：仅复用稳定前缀 + 新尾部 C，测量公共前缀分支。

等待仅发生在全部预热和测量之间，可显式覆盖（0 表示不等待）：

```bash
npm run probe:frontbrain -- --settle-ms 2000
```

`--settle-ms` 只接受十进制非负整数，范围 0–30000ms；拒绝小数、负数、指数、缺值、
重复或未知参数。两秒不是持久化完成保证，脚本不自动重试或扩大付费调用。
每阶段打印 latency、实际 in/out/total、cache hit/miss、finish 与短回复。
输入诊断为 `below target` / `at target (or above)`；未上报时为 `unknown`，绝不补造计数。
单元测试使用 fake 客户端和注入的 sleeper，既不联网也不真实等待。

## 本地冒烟（显式选择，花真钱）

```bash
npm run smoke:user-message
```

用临时目录里的全新 SQLite 数据库（`os.tmpdir()` 下随机目录，结束即删除）和
`config.toml` 配置的 FrontBrain，跑一条合成用户消息的完整前台闭环（收件 → 领取 →
上下文组装 → 前台模型 → 单事务持久化回复与 processed 状态）。只打印响应元数据与
文本（model、latency、usage/cache、finishReason、reply），不打印任何配置、密钥或
数据库内容。失败时事件保持 claimed、临时目录照常清理，脚本以非零退出。

## 不假定缓存行为

本切片只测量、不假定：provider 未上报 cache 字段时，`cachedInputTokens` /
`uncachedInputTokens` 保持 `undefined`；探测的所有阶段只如实转述上报值，不据此
断言命中/未命中，也不推断 continuation / prefix cache 的存在、TTL 或取消语义。
真实结果也只是该次条件下的观测，不是 provider 保证；最近一次升级方法的本机观测记录在下方。

[当前官方缓存指南](https://api-docs.deepseek.com/guides/kv_cache/)说明缓存默认开启、尽力而为，
只有完全匹配已持久化的前缀单元才能命中，构建可能需要数秒；分叉请求可触发公共前缀识别。
[历史官方公告](https://api-docs.deepseek.com/zh-cn/news/news0802/)曾说明存储单元为 64 tokens，
不足 64 tokens 不缓存。这是历史说明；当前指南没有承诺固定的 token cutoff，不能将 64
或本探测的 512 目标当作当前服务的命中保证。

## Stage 1.2c：持久化主 Agent 终端入口

Stage 1.2c 已把上述 Runtime 接成最小可用的持续终端对话入口：

```bash
npm run main:chat -- --data-dir /private/path/to/main-chat
# 或：agent main --data-dir /private/path/to/main-chat
```

- `--data-dir` 省略时默认使用 `~/.local/share/agents-master/main-chat`。目录和 SQLite
  文件仍只由 `createMainAgentRuntime` 创建并在 Linux 上校验为当前用户拥有的 `0700` /
  `0600`；store 本身不承担建目录职责。
- `MainAgentForegroundHost` 将每条输入先同步持久化，再启动一个单飞、串行的 drain；模型
  调用在飞行期间，readline 仍可继续接受并持久化后续行。实际领取仍由 Runtime 的
  user-message inbox 优先级与 durable admission order 决定，普通 `timer` /
  `domain-update` 事件不被前台领取。
- 启动和 `/recover` 只调用 scoped 的 `recoverClaimedUserMessageEvents()`。前台失败后事件
  保持 claimed、host 停止自动 drain 并清楚提示；新输入仍可入库，只有用户明确执行
  `/recover` 才会重试。`/help`、`/recover`、`/exit` 是当前唯一的终端命令。
- 稳定 system instructions 固定在 `src/main/foreground.ts`，要求主 Agent 自然理解、简短
  回答、信息不足时澄清，并明确当前没有任务/记忆写入或外部动作能力，不能假装已经执行。

本切片仍**不具备**任务或记忆工具调用/写入、自动委派、领域事件处理、Web UI、子 Agent，或
并行前台推理；也不改变 Runtime 的原子持久化和失败恢复语义。

### 2026-09-16 本机探测记录（非 provider 保证）

旧版短 prompt 探测的输入仅 49 / 65 / 50 token，报告 `cache hit=0`。这是**prompt 太小、
方法不足的观测**，不是缓存能力判决；总输入达到 65 也不代表有足够长且已持久化的共享前缀。
该轮没有充分预热和持久化等待，不能据此推断 provider 不支持缓存、continuation 或 prefix cache，
也不能判断 TTL、取消语义或未来请求行为。

2026-09-17 使用升级后的五阶段探测（`deepseek-flash`、本机、默认 2000ms settle）时，provider
实际输入为 1074 / 1074 / 1076 / 1090 / 1075 token，均达到 512 token 目标。首次预热上报
`cache hit=0, miss=1074`；重复预热、分叉预热、continuation、common-prefix 依次上报
`cache hit=896`（miss 为 178 / 180 / 194 / 179）。对应延迟约为 516 / 478 / 601 / 508 / 622ms。
这说明该**一次本机调用形状**在预热后获得了 provider 报告的共享前缀命中；它不证明命中阈值、
缓存 TTL、跨会话行为、稳定延迟收益或 provider 的任何 SLA。
