# Grok Bot 开源替代：OpenMausBot / Rakazo 源码调研

日期：2026-10-15。性质：研究结论和接入建议，不替代产品决策或当前路线图。

同日评审补充：本文件保留源码研究依据；后续设计选择及代码现状澄清以
[第一轮实现方案（评审收敛稿）](agent-system-first-slice-proposal.md) 为准。

2026-10-22 补充：两仓库一周增量与新增 OpenClaw 对照见
[第二轮调研](open-agent-reference-study-2026-10-22.md)；本文件的快照结论不再是最新状态。

## 范围与证据

本次将两个公开仓库浅克隆到独立临时目录，只读检查实现、相关测试代码和许可证：
没有安装它们的依赖、运行它们的服务/测试，也没有接入真实账号或用户数据。
“源码具备某机制”不等于已经验证其稳定性、安全性或在本机可用。

- OpenMausBot：`de63346e9347abb51048ae74ef3121d125fd11d2`。
- Rakazo：`39a676e205f3c0cd6e288bae05ca914ea059f0d5`。
- 本项目对照的是当前未提交工作树，既有改动完整保留。
- 注意：OpenMausBot 旧 delegation-mailbox 设计文档描述 JSON 队列，
  当前实现已迁移到统一 Runtime 和 SQLite，不能照旧文档判断现状。

## 核心结论

两者都不是几个 prompt 的集合，而是“持久身份 + 会话 + 执行生命周期 + 结果投递”。
OpenMausBot 更贴近既有 CLI 复用、主协调者与群聊；Rakazo 更适合参考数据关系、
后台工作恢复和幂等结果回传。不建议仅凭这轮调研整仓替换本项目。

### 1. OpenMausBot：已有主协调者，而非只有平级 Bot

`chief-of-staff.ts` 为 Chief 构造职责和可达成员名单：
能自行回答，也能通过 `coordinate_bots` 派发具体工作/咨询；派发立即返回，
要求结束当前回合而非轮询，结果回来后再继续。提示词还区分“已分派”和“已完成”，
要求核查结果、必要时返工，不能把咨询当成执行证据。

这不是仅靠提示词：Runtime 中有持久 Assignment、事件、结果 inbox 和恢复逻辑。
Assignment 记录来源、委派者、接收者、目标 thread、完成条件、结果和实际执行证据。
状态区分 queued / running / needs_input / waiting / resume / completed / failed / cancelled。

源码：
[Chief](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/chief-of-staff.ts)、
[协议与状态](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/runtime/types.ts)、
[SQLite store](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/runtime/store.ts)、
[协调器接线](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/runtime-coordinator.ts)。

### 2. 非阻塞的关键：结束当前执行回合，不结束这件事

OpenMausBot 的调度以 thread 为互斥边界：同一会话的运行回合不重叠；
父委派等待子结果时变为 waiting，不再占一个 running 回合。
子结果持久进入 inbox，调度器再安排后续回合。不同 thread 可以独立推进，
但仍受执行引擎和资源准入限制，不能理解为无限并发。

重启时也不是统一无脑重跑：源码会检查已交出的子工作、已观测到的外部动作、
此前是否重跑过等，再选择等待、有限恢复或报告中断。
这仍依赖它对外部动作的观测完整性，不能推导出所有副作用恰好执行一次。

源码：[Runtime](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/runtime/runtime.ts)；
已阅读但未执行：[生命周期测试](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/runtime/runtime.test.ts)。

对我们的启发：保持主聊天单一提交主线；后台委派生命周期独立。
“前台快”减少短回合等待，“异步委派”解除长任务占用，两者互补。

### 3. CLI 会话不是产品 Agent 的身份

OpenMausBot 用 provider registry 管引擎，用 thread 的恢复信息关联原生会话；
Codex driver 对接 app-server 的 thread/start、thread/resume 等协议，
Claude driver 管理原生进程与 session 恢复。引擎不可用时保留配置并标记不可用，
而不是把某个 CLI 进程是否存活等同于 Bot 是否存在。

源码：
[Registry](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/harness/registry.ts)、
[Codex driver](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/drivers/codex.ts)、
[Claude driver](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/drivers/claude.ts)。

这些 driver 不是适合立即复制的轻量组件：涉及特定 CLI 版本、权限协议、恢复、
原生进程复用等大量配套代码。本机 Node 22，仓库声明 Node >=24；
这轮未验证其 CLI 兼容性。不升级本机或替换我们已能运行的 backend。

### 4. Rakazo：明确分开持久 Bot 与临时 subagent

数据库将 Bot、Thread、Task、Run 分开：
Bot 保存身份、指令、模型和所属空间；Thread 保存会话顺序及压缩游标；
Run 保存执行状态、lease owner、过期时间、fence 和结果回传标记。
当前 schema 中 Bot 的主 Thread 是一对一关系。

`spawn_bot` 创建长期 Bot；`run_subagent` 是当前执行里的短期 helper，
并不拥有用户可见的独立长期 thread。后者在 Pi runtime 中 await 子执行结果，
不能拿它替代主入口所需的异步委派。

源码：
[数据模型](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/packages/db/prisma/schema.prisma)、
[工具定义](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/packages/adapters/src/builtin-tools.ts)、
[临时子执行](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/packages/adapters/src/pi-runtime.ts)。

我们的“工作项目 Agent”对应持久 Bot；它调用的一次 Codex/Claude 执行对应 Run，
不是每次运行都创建一个新的领域 Agent。

### 5. Rakazo 的可靠回传比“发起后台 Promise”多了一层

`messageBot` 在事务中写入发送方回显、接收方消息、Task、Run 与事件，
并使用 delivery key 防重复。事务提交后才通知实时客户端、入后台队列。
即使入队失败，已持久化的 queued run 仍可由 reconciler 补投。

终态通过 `returnBotMessageOutcome` 返回原委派者：
区分 request/question 与 status/result，避免把普通状态误当完成，
也防止结果之间互相自动回应形成循环。回传标记用于补偿遗漏。
worker 默认使用 Graphile Worker；Run 的领取和更新使用租约及 fence。

源码：
[异步投递与返回](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/packages/adapters/src/bot-messages.ts)、
[补偿扫描](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/packages/adapters/src/job-reconciler.ts)、
[执行器](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/packages/adapters/src/executor.ts)、
[Worker](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/apps/worker/src/index.ts)。

应借鉴的是“持久记录是真相、通知只是唤醒”的语义；当前单机 SQLite
不必为此直接迁移到 PostgreSQL / Graphile Worker。

### 6. 独立上下文仍需要预算、检索和压缩

OpenMausBot 默认每个 Bot 有自己的 Markdown memory：
核心笔记有加载预算，主题笔记按需读取/召回；文档还描述了修订日志及撤销。
其 prompt-split 实现区分稳定/变化部分，用指纹判断是否需要在后续回合携带更新。
这是一种缓存友好的构造方式，不是缓存命中保证。

Rakazo 有 bot/user 两类记忆及版本；上下文加载有字节预算。
历史压缩按消息 seq 推进，使用摘要时会验证摘要游标之后的消息连续性，
不满足时退回旧窗口，避免静默留下上下文缺口。

源码：
[OpenMausBot memory 说明](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/docs/memory.md)、
[稳定/动态 prompt](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/server/drivers/prompt-split.ts)、
[Rakazo 记忆加载](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/packages/adapters/src/memory-context.ts)、
[历史压缩](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/packages/adapters/src/history-compaction.ts)。

这些机制不能直接替代我们已经定义的 Source → Claim → Policy 模型，
尤其不能把自由文本修订等同于来源、纠正、忘记和级联删除语义。

## 与本项目现状的对照

| 能力 | 当前源码事实 | 缺口 |
| --- | --- | --- |
| 持久主聊天 | main/inbox.ts + foreground.ts + runtime.ts | 已有基础，不需更换入口 |
| 快速前台模型 | frontbrain/types.ts 仅文本 completion | 尚无结构化工具调用/委派决策协议 |
| 领域工具循环 | agent/loop.ts + tools.ts 已有 11 个工具、串行回合及完成通知 | 缺持久 context、question、Run 与受限工具面，不是缺一套 harness |
| 后台 CLI | AgentBackend.runDetached、Codex/Kimi/Claude backends | 能启动执行，不等于持久领域 Agent |
| 运行记录 | state/runs.ts 的 RunRegistry 是进程内 Map | 重启后不能仅靠它恢复执行归属与回传 |
| 任务/认知控制面 | personal store、main/service.ts | main-web/main-chat 未实例化 personal store；不是已有现成连接 |
| 后台消息 | inbox 类型已有 domain-update/timer | 当前专用领取/恢复只处理 user-message，已避免误领；遗留类型无消费者 |
| 会话读取 | SessionReader 有持久 offset、截断检测，工具/解析层有部分 origin 标注 | 可复用增量读取；内容匹配得到的 origin 不能作为授权依据 |
| 子 Agent 产品状态 | 尚无持久领域身份、群聊及执行绑定闭环 | 需要小型协调层，不是只补一句 prompt |

因此缺口主要是把已有部件接起来，并补上生命周期与交付保证。FrontBrain 的文本接口
不能用于推断配置模型不支持工具；已有 AgentCore 工具循环也不能替代当前接入组合的实测。
复用子 Agent harness 不等于完全不需要我们的协调层；
协调层管理谁做什么、何时回来、何时请示，而不重写 CLI 内部工具循环。

## 建议的下一实现切片（待用户确认）

目标：用户从现有主聊天托付一个工作项目请求，工作项目 Agent 后台处理；
主聊天继续可用；结果和问题可追踪地回来。第一轮建议用真实但只读的项目检查验收，
不自动扩大到修改、commit 或 push。

最小链路：

1. 建立一个持久工作项目 Agent 和对应群聊，记录身份、职责及工作区绑定；
   将产品 agentId、conversationId、runId、CLI sessionId 分开。
2. 主 Agent 通过受校验的结构化工具请求委派，不从自然语言回复里猜“是否开工”。
   服务端校验职责、范围和授权；原子提交委派记录与群聊派工消息后才确认已接收。
3. 后台调度独立领取执行；使用现有 CLI backend，持久保存 session/产物/状态。
   “任务”可以只是内部委派记录，不要求先做完整任务 Tab。
4. 子 Agent 的结果、问题、失败先进入领域群聊及持久回传队列；
   主入口在安全回合消费，不直接改写一个正在调用模型的 context。
   后续评审已收敛为独立 outbox，经统一前台调度消费，不复用遗留 domain-update/timer。
5. 保存终态和待投递回执；界面通知与模型转述可重试并去重。
   重启发现执行状态不明时如实报告/对账，不自动重放可能有副作用的命令。

同一工作项目 Agent 初版串行执行、主入口独立接收；
不用引入子 Agent 间直接交流、自动建团队、多层递归、云桌面或多进程分布式队列。
这是建议，不是本轮已执行的范围变更。

建议验收：

- 派工后继续谈别的话题，不等待后台 CLI 结束；群聊能看到真实派工。
- 第二次同领域请求沿用同一个领域身份和明确的上下文，不能只有名字相同。
- 同一派工请求重试不重复启动；失败/需输入不被报成完成。
- 刷新及服务重启后，已提交委派仍可查，未回传结果能补投且不重复展示。
- 取消后迟到结果不把取消状态改成成功；执行中断不伪装成没有发生外部效果。
- 私有领域内容不整段复制到主聊天；子执行报告是待核查证据，不是新授权。
- 修改文件、联络、发布和消费等继续受用户明确授权约束。

## 复用边界与下一步

优先借鉴 OpenMausBot 的 Chief + Assignment + inbox 及稳定/动态 context 分层；
借鉴 Rakazo 的 Bot/Thread/Run 分离、幂等投递与补偿扫描。
暂不整仓迁移，不加入生产依赖，不安装第二套长期运行服务。

OpenMausBot 核心 Apache-2.0，但 enterprise/ 为单独许可；
Rakazo 根许可证为 Apache-2.0。实际复制任何代码前还需逐文件检查许可、
第三方声明和依赖，并保留归属。这轮没有复制应用实现代码。

来源：[OpenMausBot 许可边界](https://github.com/milind-soni/OpenMausBot/blob/de63346e9347abb51048ae74ef3121d125fd11d2/LICENSING.md)、
[Rakazo LICENSE](https://github.com/elie222/rakazo/blob/39a676e205f3c0cd6e288bae05ca914ea059f0d5/LICENSE)。

后续评审将模型工具协议及执行权限预检前置，具体顺序见实现方案第 7 节。
按 AGENTS.md 由两个独立 Coding CLI 承担应用实现与技术验收，协调者仅核实，
不把本次静态源码阅读说成运行验收。
