# agents-master v1 实现计划

## 目标

在 `~/projects/agents-master` 实现个人传话 agent 的 v1：一个终端 TUI 对话框，
用户坐在里面用自然语言驱动 codex-cli 和 Kimi Code 协作，agent 替代用户完成
传话/核实/追踪，决策点停下来等用户拍板。需求规格见
`docs/handoff-analysis/findings-2026-08-12.md`，决策见
`docs/discussion-summary-2026-08-12.md` §6.5（含已批准的决策点清单）。

## 架构

UI 无关的 agent 核心 + Ink TUI 外壳，核心通过事件接口与 UI 通信（保证核心可
脱离 TUI 被脚本化测试）：

```
TUI (Ink)  ←→  Agent Core (loop + tools + system prompt)
                   │
        ┌──────────┼───────────────┐
   Backends    SessionReader    State
   (驱动 CLI)  (增量读 session)  (台账/偏移/memory)
```

- **语言/工具链**：TypeScript ESM、pnpm、tsx 运行、vitest 测试（与 ckrunner 一致）。
- **LLM**：`openai` npm 包，`baseURL`/model 走配置（默认 `deepseek-v4-flash`），
  key 只从环境变量 `DEEPSEEK_API_KEY` 读（`.env` + dotenv，已 gitignore）。
- **ckrunner 的处理**：不把 ckrunner 当依赖。其 backend 层总共约 300 行
  （`KimiBackend.ts` 74 行、`CodexBackend.ts` 175 行、`runCommand.ts` 56 行），
  但有三处必须改：codex 沙箱被硬编码 `read-only`（执行方需要写权限）、
  `CodexBackend` 里有 macOS 专用路径、同步等待不支持小时级长任务。
  因此**移植并改造**进本仓库，ckrunner 留作参考。

## 仓库骨架

```
agents-master/
├── package.json / tsconfig.json        # 依赖：openai, execa, ink, react, zod, dotenv; dev: tsx, typescript, vitest, @types/*
├── .env                                # DEEPSEEK_API_KEY（用户自填，已 gitignore）
├── config.toml                         # base_url、model、项目注册表、放权等级、决策点开关
├── bin/agent.ts                        # 入口：agent（启动 TUI）、agent doctor（环境自检）
├── src/
│   ├── config.ts                       # 配置加载 + zod 校验
│   ├── llm/client.ts                   # OpenAI 兼容 client 封装
│   ├── agent/loop.ts                   # tool-call 循环（UI 无关，事件驱动）
│   ├── agent/prompt.ts                 # system prompt：传话风格规则 + 决策点清单 + 放权等级
│   ├── agent/tools.ts                  # 工具定义（OpenAI tool schema）
│   ├── backends/{kimi,codex,runCommand}.ts   # 移植自 ckrunner，见下
│   ├── sessions/{reader,kimiParser,codexParser,discovery}.ts  # 增量读取器
│   ├── state/{ledger,offsets,memory}.ts      # 传话台账、session 偏移、memory/
│   └── tui/{App,ChatView,InputBox,DecisionPrompt}.tsx         # Ink 界面
└── tests/                              # vitest；session parser 用真实 jsonl 切片做 fixture
```

## 关键机制

1. **session  reconciliation（介入感知）**：agent 记录自己代发过的 prompt 文本；
   每次派活前增量读目标 CLI 的 session 文件，凡 origin=user 且不在代发记录里的
   新消息，一律视为"用户亲自介入"，作为最高优先级上下文吸收进 agent loop。
2. **session 发现与钉住**：按项目目录定位——kimi 侧 `~/.kimi-code/sessions/
   wd_<项目>_<hash>/`、codex 侧按 session_meta 里的 cwd 匹配；每个项目每个 CLI
   钉住一个当前 session id（存 `state/offsets`），agent 驱动时 `--session` 续上，
   保证用户 tmux 里的交互视图和 agent 驱动的是同一条会话。最新 session 自动发现
   作为兜底。
3. **长任务**：backend 以后台进程方式启动，stdout 流式落 artifact 文件；agent
   loop 通过轮询 artifact + session jsonl 观察进度，TUI 全程可交互、用户可随时
   插话。codex 沙箱模式走配置（默认 `workspace-write`，批准策略在 config 里显式
   写出——这是一个安全相关默认值，请你过目）。
4. **决策点与放权**：`config.toml` 里 `delegation.level`（v1 默认 `supervised`）
   + 决策点清单开关；硬决策点（push、范围/优先级、阶段推进、方案开工、冲突、
   重大偏差）恒等用户；软决策点在 supervised 下也等用户，放宽后降级为仅报告。
   决策点在 TUI 里渲染为可批准/驳回/追问的卡片。
5. **system prompt 的灵魂**（`agent/prompt.ts`）：消息分类 schema
   （task_assignment / review_feedback / completion_report / doc_pointer /
   acceptance_request / user_decision）、按类型定保真度（review/验收全文保真、
   文档传路径+摘要）、agent 看法限于核实性标注/路由建议/时效性标注、不做技术
   拍板。这些规则直接译自 findings 文档。
6. **已知脆弱点的显式告警**：codex JSONL 字段解析失败时必须在 TUI 告警
   （ckrunner 的教训：`extractLastMessageFromJsonl` 靠猜候选字段会静默降级）。

## 里程碑（按序执行，每个都可验证）

- **M0 骨架 + doctor**：pnpm init、tsconfig、config 加载、LLM client。
  `agent doctor` 输出环境事实（两个 CLI 版本、session 目录、key 是否配置、
  LLM ping 结果）。验证：doctor 全绿（需要你先把 key 填进 `.env`）。
- **M1 增量 session 读取器**：移植 `docs/handoff-analysis/extract.py` 的取舍逻辑
  为 TS（kimi：turn.prompt/turn.steer/text part；codex：response_item message
  user/assistant + 注入块剥离），加 byte-offset 增量跟踪。测试：从真实
  wire.jsonl / rollout.jsonl 切 fixture，断言提取结果与 extract.py 输出一致。
  验证：对 stock_data 真实 session 跑，增量读两遍结果幂等。
- **M2 backends 移植**：KimiBackend/CodexBackend/runCommand 移植+三处改造，
  沙箱/超时走配置，后台运行+artifact 落盘，session id 解析失败显式告警。
  验证：在 stock_data 用只读 prompt（"汇报 git status"）实际驱动两个 CLI 各
  一轮，确认 session 续接和结果提取正确。
- **M3 agent 核心**：tool schema（run_kimi / run_codex / read_session_updates /
  read_artifact / git_status(只读) / ask_user / update_ledger）、loop、
  system prompt、台账。验证：脚本化 harness（无 TUI）跑通一条真实传话链
  "让 kimi 做 X → 读回交付 → 发给 codex 审 → 把意见带回"；另用 transcripts/
  里的真实传话事件做分类/framing 回测，人工评一轮质量。
- **M4 Ink TUI**：对话流（用户/agent/传话标注/系统四类消息）、输入框、决策点
  卡片（批准/驳回/追问）、**原文展开查看**（翻两边原始消息）、状态栏（两边
  session、当前任务、放权等级）。验证：真实跑一个 stock_data 小任务全链路，
  你在 TUI 里完成一次完整的"下目标→决策点拍板→看结果"。
- **M5 memory/**：启动时读、任务后追加建议（人审后生效）。验证：一个任务结束
  后 agent 提出 memory 追加，你批准后落盘并在下次启动被读到。

## 风险与待定

- **并发驱动同一 session**：agent 用 `--session` 驱动的同时你在 tmux 里交互输入，
  是否冲突未实测——M2 验证时专门测这个，若冲突则 agent 检测交互占用后退到旁观。
- **codex 沙箱默认值**：计划默认 `workspace-write`，如你想更保守可改 `read-only`
  + 逐次批准。
- DeepSeek key 未配置会阻塞 M0 的 LLM ping 和 M3 之后的验证，骨架和 M1 不受影响。
