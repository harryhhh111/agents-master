# AGENTS.md

这是一个由用户定义、长期存在的通用个人 Agent 项目。产品始终由主 Agent 作为自然、持续的
对话入口；它逐渐理解用户、维护任务和上下文、在后台协调工作。首批领域是人际关系、工作项目
和长期目标。

现有 Codex/Kimi 双 CLI 传话系统不是产品本体，而是第一个持久子 Agent——**工作项目 Agent**
的可调用执行能力。它负责与两个 Coding CLI 协作；工作项目 Agent 则负责该领域的长期上下文、
任务、判断与群聊。不要让现有单项目 TUI、Markdown memory 或双 CLI 工作流反向定义主 Agent
的产品体验。

产品与路线图的权威来源：

- 产品原则、界面和认知模型：`docs/product-discovery-v0.md`
- 当前阶段与实现顺序：`docs/roadmap.md`
- 已实现的双 CLI 传话基线及其历史决策：`docs/discussion-summary-2026-08-12.md`
- 真实传话需求规格：`docs/handoff-analysis/findings-2026-08-12.md`

## 开发行为规范

- **先感知当前机器环境再动手**：每次会话开始（尤其跨机器、新对话）主动确认两个 CLI、网络、
  ckrunner、DeepSeek 配置、会话记录与目标工作区状态。机器事实各自成立；实测的新事实追加记录，
  不用它推翻另一台机器的结论。
- **应用代码由两个独立 CLI 协作完成**：协调 Agent 对 `src/` 和测试只做只读核实；实现、技术
  验收和返工交由 Codex 与 Kimi Code 完成并保留原始产物。Kimi 不可用或额度不足时，可由 Claude
  Code（使用用户已配置的模型）替代其规划、审查或实现角色。被协调 Agent 明确委派、且收到具体
  文件范围的 Coding CLI 是实现者：它可直接编辑该范围、运行测试并报告，不得递归委派实现工作。
  用户已确认的产品文档、路线图与本文件可直接更新。
- **保留用户的产品决策权**：协调 Agent 可做核实性标注、时效性说明、研究结论、路由建议与风险
  提醒；优先级裁决、范围砍削、产品方案确认、外部动作及 push 始终由用户决定。
- **从真实使用学习，不把假设写死**：对话、任务、记忆和策略的改变应符合“原始证据 → 认识
  （Claim）→ 行为策略 → 当前上下文”模型。明确事实、合理推断和未知状态必须区分；纠正、忘记、
  删除及其依赖影响必须可追溯。
- **安全与隐私**：不将 API key、token 或个人原始数据写入 git、文档或 CLI prompt；传给模型服务的
  仅是完成当前任务所需的最小上下文。外部联络、承诺、发布、消费、删除或改变外部系统必须获得
  用户的具体授权。

## 当前机器环境（vinci 云服务器，2026-09-12 实测）

- `codex` 0.153.0（`/home/vinci/.local/bin/codex`）。
- `kimi` 0.39.1（`/home/vinci/.kimi-code/bin/kimi`）。
- `claude` 2.1.195（`/home/vinci/.nvm/versions/node/v22.22.2/bin/claude`）；可通过 `-p` 非交互
  调用。当前 Kimi 额度不足，技术切片期间以 Claude Code 作为第二个独立 CLI。
- Node v22.22.2、Python3 可用；到 `api.deepseek.com` 网络可达。
- 项目 `.env` 存在且可用；不要输出其内容或把密钥复制到任何持久位置。
- `ckrunner` 位于 `/home/vinci/projects/ckrunner`；如复用其代码，先确认版本和边界。
- Codex 会话记录：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`；Kimi 会话记录：
  `~/.kimi-code/sessions/wd_<项目>_<hash>/session_*/agents/main/wire.jsonl`。
- `~/projects/stock_data` 存在，两个 CLI 共用同一 repo 与远端，可能并发写入；派活前必须检查
  git 状态并协调写入范围。
