# 个人 Agent 项目讨论纪要（2026-08-12）

> 用途：跨对话交接。读者是下一次对话中的 AI 助手和用户本人。
> 下一步行动：用户会在**另一台机器**上重启对话，用那台机器上 Codex / Kimi Code 的真实传话会话记录作为 v1 的需求参照（见文末"待办"）。

## 1. 项目目标

做一个属于用户自己的 agent（**必须引入 LLM**，不是纯代码编排器），驱动 codex-cli 和 Kimi Code 两个 CLI 协作：

- 在两个 CLI 之间传递信息（替代目前手工复制粘贴 plan / diff / 测试日志 / 返工意见）；
- 传话时给出 agent 自己的看法，且传话方式**不死板**（这正是需要 LLM 而非固定模板的原因）；
- 后续演进目标：能独立于 codex / kimi 排查问题；随使用积累实现"自进化"。

## 2. 已有资产：ckrunner

位置：`~/Documents/GitHub/harryhhh111/ckrunner`（本机路径；远端机器上位置待确认）。

TypeScript CLI（`ckflow`），Phase 1–3 已完成并合并 main，真实 smoke 通过。已验证的关键事实：

- Kimi Code 非交互调用：`kimi --prompt ... --output-format stream-json` 可用；session id 从 `role=meta, type=session.resume_hint` 提取；`--session <id>` 可恢复。**注意：`--prompt` 与 `--yolo` 不兼容**，自治执行依赖配置文件。
- Codex 非交互调用：`codex exec --json --sandbox read-only -` 可用；`codex exec resume --json -c 'sandbox_mode="read-only"' <id> -` 可恢复；`--output-schema` 可输出结构化 Review JSON；依赖本地代理（如 `127.0.0.1:7897`）。
- 设计原则：Runner 控制状态机（不让模型决定流程）、文件系统是真实状态（`.ckflow/` 全落盘）、角色与 agent 解耦（planner/executor/reviewer/verifier，`canPassPlan` 门控）。
- 已知脆弱点：`CodexBackend.extractLastMessageFromJsonl` 靠猜多个候选字段，上游 JSONL 格式变动会静默降级，需要显式告警。

ckrunner 的定位：**确定性执行层 / artifact 来源**。新 agent 的判断层架在它之上，或直接复用其 backend 代码。

## 3. 已敲定的技术决策

1. **LLM 必须独立**：agent 的大脑直接走 API，不能建立在 codex / kimi CLI 之上（否则对方挂了就无法诊断）。
2. **模型选型已定：DeepSeek V4 Flash**（`deepseek-v4-flash`，284B 总参 / 13B 激活，OpenAI 兼容 API，支持 tool calls；2026-07 更新专门增强了 function calling 准确率）。不考虑 Claude Agent SDK。
   - 硬性要求：`base_url` 和 model 名走配置，loop 只依赖 OpenAI 兼容接口，模型可随时换。
   - 已提示的风险：小模型在"诊断失败原因"这类重推理任务上可能不足；届时可做分层（日常用 flash，重推理 escalate 到更强模型），不加路由框架，loop 里一个 if 即可。
   - 待做实测：用 `.ckflow/` 里 10 个历史失败现场考验 flash 的诊断准确率。
3. **分层架构**：agent（LLM 决策层）→ 工具层（ckflow 命令 / 两个 CLI 的 backend / 文件读写）→ ckrunner 确定性核心。LLM 不接管状态机。
4. **大内容不走 LLM 上下文**：diff、测试日志永远落盘（`.ckflow/`），agent 只持有路径 + 自己读的摘要；给 codex/kimi 的 prompt 里也引用路径让它们自己读。
5. **记忆 / 自进化的边界**：
   - 可行：纯 markdown 的 `memory/` 目录（经验沉淀，启动时读、任务后追加）；不急着上 mem0/Letta 这类框架。
   - 有条件可行：prompt 自改进必须**人审 + changelog**（没有可靠奖励信号，自动改 prompt 会漂移）。
   - 不做：agent 自改编排代码。

## 4. v1 范围（已收敛）

**定位：会读上下文、会取舍、会核实的"传话人"**，而非全功能编排器。LLM 的三个价值点：

1. **选择性传递**：从 5000 行测试日志里挑 3 个失败用例和相关堆栈带给对方，而不是全量复制。
2. **角色间翻译**：同一份内容，给 Codex 组织成 review 请求（附验收标准），给 Kimi 组织成带优先级的返工指令。
3. **传递前核实**：例如 Codex 提的 issue，agent 先看 diff 确认是否已修复，过时意见直接标注——过滤 review 噪音，省返工轮次。

最小工具集草案（5 个）：

- `run_kimi(prompt)` / `run_codex(prompt)`（复用 ckrunner backend 代码）
- `read_artifact(path)`、`list_artifacts(feature)`
- `ask_user(question)`（拿不准时问人）

## 5. 重要发现：两个 CLI 的对话历史都可以直接读

- **Codex**：`~/.codex/sessions/YYYY/MM/DD/rollout-<时间戳>-<uuid>.jsonl`，完整会话流水（用户输入、回复、命令及输出）。
- **Kimi Code**：`~/.kimi-code/sessions/wd_<项目名>_<hash>/session_<uuid>/agents/main/wire.jsonl`，同目录有 `state.json` 和 `logs/`。

推论：agent 了解"另一边说了什么"不一定要靠用户复制，可以直接读对方的 session JSONL。这可能是传话成本最低的形态，v1 设计时应认真考虑。

## 6. 开放问题（讨论未完成处）

- **v1 的对话形态**：A) 用户主动发起每一轮（"把这个 plan 给 Kimi 跑，结果给 Codex 审"）；B) agent 拿到 plan 后自动跑完一轮再汇报。当前倾向 A 起步——agent 的判断暴露在用户眼皮底下，便于校准传话质量。
- v1 是否复用 ckrunner 状态机，还是只做轻量 relay + 直接读 session 历史。

## 6.5 后续追加的决策（2026-08-12 云服务器对话）

- **对话形态细化**：用户要的是一个**终端 TUI 对话框**（一等产品，不是附属壳），
  坐在对话框前实时控制两个 CLI、看 agent 的汇报和待决清单并拍板。
  - **原文可见性是硬需求**：agent 默认给转述+标注，但两边的原始消息/报告原文必须
    能在对话框里直接翻看——目标是 agent 足够好时用户完全不用回 tmux 看原文。
  - **CLI 介入权永远保留**：agent 默认接管驱动两个 CLI，但用户可随时在 tmux 里亲自
    下场；session JSONL 是唯一事实来源，agent 必须能区分"自己代发的指令"与"用户
    亲手输入"，后者按最高优先级吸收（派活前先增量读 session 防冲突）。
- **运行模型（已确认）**：用户下目标 → agent 自动跑完整条传话循环（派活→交付→
  送审→退回→再审），只在**决策点**停下找用户；中间用户可随时插话。
  - **放权等级是设计变量**：v1 默认每个决策点都等用户；随信任积累可放宽到"一个
    feature 只在完成时报告，除非出现与规划的重大偏差"。放权粒度以后调，架构上
    决策点清单要可配置。
  - **决策点清单（2026-08-12 用户批准）**：
    - 硬决策点（任何放权等级都等用户）：① push 批准；② 范围/优先级裁决；
      ③ 阶段（Gate/Phase）推进与关闭；④ 方案批准后开工；⑤ 双方结论冲突或
      agent 拿不准（ask_user）；⑥ 与既定规划出现重大偏差。
    - 软决策点（v1 默认等用户，放权后降级为只报告）：⑦ 交付报告到达→送审；
      ⑧ 验收不通过→退回返工；⑨ 核实发现矛盾→退回产出方要解释；
      ⑩ 长任务进度（不问不打扰，异常主动报）。
    - 全程自动：增量读 session、原文归档可查、传话台账、memory 追加（人审生效）。
- **语言定为 TypeScript 全栈**：Ink 做 TUI；agent loop 与 ckrunner backend（TS）同语言
  可直接复用；extract.py 的 session 取舍逻辑移植为 TS（量很小）。
  （曾考虑 Python：agent 框架生态好、extract.py 现成；被 TUI 需求否掉。）
- **传话需求规格已定**：见 `docs/handoff-analysis/findings-2026-08-12.md`（真实会话
  实录分析，含消息分类、保真度规则、agent 职责边界）。
- **v1 带上轻量 `memory/`**：启动时读、任务后追加、改动人审——接替用户手工向两个
  CLI 同步项目约定的动作。
- **机器环境感知写入 `AGENTS.md` 行为规范**：环境事实按机器各自成立，每次会话先实测。
- ckrunner 已 clone 到云服务器 `~/projects/ckrunner`；DeepSeek key 放
  `agents-master/.env`（`DEEPSEEK_API_KEY`，已 gitignore，用户自行填写）。

## 7. 待办（用户下一步）

用户 SSH 到另一台机器，那里保存着最有参考价值的 Codex ↔ Kimi 手工传话实例。新对话的第一步：

1. 找到一对真实会话（`~/.codex/sessions/...` 的 rollout jsonl + `~/.kimi-code/sessions/...` 的 wire.jsonl）；
2. 对照分析用户手工传话时：**选了什么传过去、省掉了什么、自己加了什么判断**；
3. 这些取舍就是 v1 的真实需求规格，据此再定 v1 对话形态并进入实现规划。

## 8. 参考资料（2026-08 核实过时效性）

- GLM 教程《Coding Agent 工作原理》：https://docs.bigmodel.cn/cn/coding-plan/learning-resources/how-coding-agent-works （agentic loop、模型+工具、上下文压缩、项目级配置文件——概念地图，质量认可）
- smolagents（HF，约 1000 行核心，读最小 agent loop 的最佳材料，仍在维护）
- Anthropic《Building effective agents》（workflow vs agent 的分层范式，经典不过期）
- Voyager 论文（arXiv:2305.16291，技能库式自进化范式参考）
- 多 CLI 编排器同类：vibe-kanban 已于 2026-04 停止商业运营转社区维护；活跃替代为 Superset / Parallel Code / Conductor；automagik forge 的 provider/agent 两层设计可参考。**趋势注意：各 CLI 原生支持 worktree 和并行 subagent，纯编排层空间被挤压——本项目的差异化在 review/rework 质量闭环 + 记忆。**
- 记忆框架横评（mem0 / Letta / Zep，2026 年已成熟，但本项目规模用纯 markdown 即可）
- DeepSeek API docs：https://api-docs.deepseek.com/updates （v4-flash / v4-pro 均支持 tool calls）
