# 前台模型 FrontBrain（Stage 1.2b / 1.2c 切片）

快速主 Agent Runtime 的低延迟前台模型边界。本切片落地：接口与实现、确定性上下文
组装、能力探测脚本、不假定缓存的遥测，以及**仅用户消息事件**的 runtime 领取/完成
接线。Dogfood Alpha Slice 1 另在其上提供私有本地 Web 聊天；仍**不含**任务/记忆写入、后台循环、
自动委派或领域事件处理。

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
  用户明示的背景可用于回答对用户的了解；“认识（Claim）”指持久记录，不代表普通对话中
  不能使用这些事实。历史 assistant 关于自身看不到背景的自述不能覆盖当前可见事实。
- 前台 Runtime 在非空 checkpoint、已有 assistant 历史且末条为 user 时，开启本轮背景核对
  提醒：在最终 user 消息前插入一条短 system 消息。提醒不包含个人事实、不写入历史，不改变
  用户与 assistant 原文及其相对顺序；当前用户纠正优先，空模板不构成已知事实，纠错也不能
  编造“之前没有传来”等原因。开头稳定前缀保持不变，但每轮尾部提醒位置会变化，因此不承诺
  整段历史均能续接缓存；代价是每轮少量额外输入以及尾部的缓存分叉。

本切片仍**不具备**任务或记忆工具调用/写入、自动委派、领域事件处理、子 Agent，或并行前台
推理；也不改变 Runtime 的原子持久化和失败恢复语义。

## Dogfood Alpha Slice 1：私有本地 Web 主聊天

```bash
npm run main:web -- --data-dir /private/path/to/main-chat --port 31415
# 或：agent main-web --data-dir /private/path/to/main-chat --port 31415
```

- Web 服务只绑定 `127.0.0.1`，`--port` 只接受一次、范围为 1–65535 的十进制整数；没有 host
  覆盖参数，也绝不监听公网地址。远程机器上的浏览器可使用 Tailscale Serve 的 Tailnet 私有 HTTPS
  入口（不启用 Funnel），或使用 SSH 端口转发，例如：

  ```bash
  ssh -N -L 31415:127.0.0.1:31415 user@server
  ```

  Web 使用单用户密码登录。首次部署时，启动终端输出一次性 `#setup_token=…` 初始化链接；远程
  使用时保留该 fragment，替换为自己的 Tailscale HTTPS 地址或本机 SSH 转发地址，在页面设置
  密码。初始化凭据在设置完成前临时保留在当前浏览器标签页中，支持刷新；已设置密码后会清除。
  未携带初始化链接时，页面提供手动填写初始化凭据的入口。初始化凭据失效后不能再设置密码；
  未持有该凭据的人不能抢先初始化。
  设置完成后只需打开固定根地址，登录状态通过 HttpOnly、SameSite=Strict Cookie 保存 30 天，
  HTTPS 下启用 Secure；刷新和服务重启后仍然有效。退出登录会撤销对应会话。
  密码的加盐哈希及会话令牌的哈希保存在同一私有数据目录的 `web-auth.json`（Linux: `0600`），
  不保存明文密码或会话令牌。旧 `#access_token` 链接与请求头鉴权已退役；聊天读写和 SSE 都要求
  登录。登录、初始化和其他写入端点校验同源 Origin。页面在会话失效时返回登录界面。
- 页面只提供持久聊天历史、消息输入、排队/发送/回复状态、错误提示和实时 SSE 回复；刷新会从同一
  SQLite 对话读取耐久历史。每条网页消息仍先同步进入 durable inbox，随后由同一个
  `MainAgentForegroundHost` 单飞处理，因此模型请求在飞行时后续输入仍能入库。启动仍只做 scoped
  `recoverClaimedUserMessageEvents()` 恢复。
  聊天区独立滚动，输入区保持在视口底部；多行输入自动增高。桌面 Enter 发送、Shift+Enter
  换行，中文输入法确认不触发发送；触屏设备用发送按钮提交。等待模型回复时仍可继续发送。
  用户翻阅历史时新消息不抢滚动，可通过“回到最新”返回；背景编辑、能力说明与退出登录默认
  收在设置中。回复失败与消息发送未确认分开呈现，后者保留原幂等标识供明确重试，发送响应
  迟到不得清空新草稿。正文仍以安全纯文本呈现，不假装模型正在逐字流式输出。
  2026-10-15 使用 Chromium、真实 HTTP/SSE 和合成消息完成桌面与触屏模拟验收，覆盖多行输入、
  合成输入法事件、防重复提交、迟到响应、发送未确认时的同键重试、阅读位置/视口缩放、刷新、
  登录切换及安全错误原因。未使用真实用户数据，未代替实体 Mac/iPhone 输入法和软键盘实测。
- 前台模型请求设置 30 秒完整调用期限，超时中止请求，禁用 SDK 自动重试。失败后保留原消息，
  由用户明确重试。登录后的状态接口和页面轮询提供处理中、空闲、失败待重试状态，避免刷新或
  SSE 重连后丢失失败提示。服务日志只记录白名单错误分类及数字 HTTP 状态，不记录原始 SDK
  错误、密钥或对话内容。此限制只用于快速前台，不改变旧双 CLI 传话系统的模型请求设置。
- 首次从 Web 启动时，在所选私有数据目录创建 `owner-context.md`（Linux: 当前用户拥有、`0600`）。
  数据目录必须在 Git worktree 之外，避免私有内容进入 git；文件初始内容是通用、非个人化模板，
  已有文件绝不覆盖。页面可查看并**明确保存**它，保存后立即重新加载为
  **未来**前台回合的稳定 checkpoint。每条用户消息在进入 durable inbox 时都会带上一个受长度限制的
  checkpoint 快照；已开始、排队、失败后显式恢复、以及重启后恢复的消息都使用自己的原始快照，
  不会被后来保存的主人上下文改写。它不是自动记忆、Claim、任务或外部动作授权；文件内容不写入 git、
  服务器日志或错误输出，只会在该用户的后续对话需要时作为模型上下文发送。
- 背景使用的验收必须覆盖已有错误历史下的自然提问。2026-10-15 在同一模型、同一背景的
  对照中，保留反复否认背景的历史时失败，去掉历史时成功；仅加强开头提示仍失败，在最终
  用户问题前加入本轮提醒后成功。这是本机观测，不是普遍保证。随后用私有历史副本和真实模型
  完成 HTTP 登录、自然问答、刷新读回、服务对象重建后的会话/历史恢复和连续追问；未改写
  用户正式历史、密码或会话。`scripts/smoke-owner-context.ts` 使用合成资料；其中结构化断言
  通过不能代替自然回答的人工核验，更不能直接宣称正式环境已验收。
  同轮真实模型补测确认当前用户纠正覆盖旧背景、未提供的事实及空模板保持未知；正式服务已
  重启并通过本机 HTTP 健康检查，原密码/会话文件和背景文件内容未变。HTTP 对话验收使用的是
  私有副本，未代替用户从 Mac 浏览器进行端到端复核；验收副本已清理。

背景使用的真实模型探测命令：`node --import tsx scripts/smoke-owner-context.ts`。它使用当前
模型配置发出四个付费请求，覆盖新会话、错误历史、反复错误历史的结构化提问和自然提问。
退出码 `1` 表示自动检查或调用失败，`2` 表示自动检查通过但自然回答仍需人工核验；脚本不会
自行宣布自然回答已验收。核验须确认具体事实、纠正旧回答且不编造原因；另外检查用户当前
纠正优先以及空模板不产生个人事实。不得用关键词出现或单元测试通过替代语义检查。
- `/api/history` 返回历史和事件 cursor；浏览器随后带 cursor 订阅 SSE。服务重放该 snapshot 之后、
  订阅之前发生的有限事件，每条至多一次；若客户端 cursor 已超出有界重放窗口，页面重新获取历史。
  这避免了“历史读取和 SSE 建连之间”丢失即时状态更新的竞态。
- 私有数据目录的 Git 防护完全由文件系统祖先检查完成：任一祖先的 `.git` 目录或 linked-worktree
  `.git` 文件都会在创建 owner context 或 SQLite 前被拒绝。检查本身不能完成时失败关闭，不依赖
  `git` 可执行文件是否存在。

Dogfood Alpha Slice 1 的明确非目标是任务 UI、任务/记忆/Claim 创建、自动学习、反馈/复盘、工作项目
委派、子 Agent、多 Agent 协作和任何外部动作。主 Agent 的稳定 instructions 也明确这些限制，不能
声称已经完成它们。

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
