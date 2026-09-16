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

对 provider 发三次受控调用，各限 16 输出 token，按阶段打印延迟与 usage/cache 值：

1. `baseline`：共用前缀（instructions + checkpoint）+ 尾部 A，冷启动参考。
2. `continuation`：原样保留上一次完整请求记录（含 assistant 回复）再追加新用户轮，
   观察 provider 是否对完整上文报告缓存。
3. `common-prefix`：两轮分叉请求之后，复用同一前缀 + 新尾部 C，观察前缀字节是否仍被缓存。

单元测试只使用 fake 客户端，绝不发起付费调用。

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
`uncachedInputTokens` 保持 `undefined`；探测的三个阶段只如实转述上报值，不据此
断言命中/未命中，也不推断 continuation / prefix cache 的存在、TTL 或取消语义。
任何缓存结论都必须是后续实测的结果。

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

本机三阶段 API probe 当日仅观测到 `cache hit=0`：baseline 输入 49 token、约 571ms；
continuation 输入 65 token、约 603ms；common-prefix 输入 50 token、约 487ms。它只是这一次
调用的 telemetry，**不能**推广为 provider 对 continuation / prefix cache、TTL、取消语义或未来
请求的任何保证。
