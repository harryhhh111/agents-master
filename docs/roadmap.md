# agents-master Roadmap

> v1 实现计划（`implementation-plan-v1-2026-08-12.md`）已全部落地，本文档接管后续规划。
> 最近更新：2026-09-03。

## 现状（已完成，已入 git）

- v1 全链路 M0–M5：agent 核心 + Ink TUI + 双 backend + session 增量读取 + 台账/memory。
- 四轮真实冒烟：零轮询（长轮询 check_run）、零报错，全链路闭环。
- 三轮回测（8 用例）：r1 发现 prompt 六处缺陷，r2/r3 验证全部消除。
  报告见 `docs/handoff-analysis/backtest-results{,-r2,-r3}-2026-08-13.md`。

## 近期：实战校准（当前阶段）

主线只有一个：**用户在 stock_data 真实任务里用 TUI 干活**，在实战中校准，而不是继续纸面回测。

- 放权等级校准：从 `supervised` 起步，观察哪些决策点其实不需要等用户。
- prompt 微调：真实传话里暴露的风格/保真问题，按轮修。
- 顺手清两个小尾巴（回测遗留，不影响主流程）：
  - 案例 4 台账 kind 口径：入站 doc_pointer vs 出站 task_assignment，倾向记入站类型；
  - 案例 3 路径拆行瑕疵。

## 中期：借鉴 Grok Bot 机制的三件事

机制分析见 2026-09-03 调研（Grok Bot = 云端 VM 执行 + 审批门控 + 批量待批 +
teach→routine）。我们 agent 没有"手"（只驱动两个 CLI），可落地的是这三件：

1. **批量待审批清单**：ask_user 已有台账，TUI 加"批量审批"视图——用户回来一眼
   看全待决事项，逐条批/否，而不是被逐次打断。匹配用户"等几分钟才回来看"的节奏。
2. **teach → routine 半自动沉淀**：用户纠正 agent 一次，把那次的纠正固化成规则
   （现在是手动改 prompt.ts / 回测案例，做成半自动：agent 提议规则 → 用户批准 →
   落进 prompt 或 memory）。
3. **放权等级进阶**：从"每个决策点等用户"到"一个大 feature 内不介入，完成时报告，
   除非出现与规划的重大偏差"。前提：批量审批和实战信任都跑顺之后。

## 远期 / 待定

- hard stops 显式化：把"没有用户批准绝不能做"的清单从 prompt/AGENTS.md 里抽成
  一张显式表（参考 Grok Bot 第三方使用规范的 NON-PROMISES 做法）。
- 多项目并行：当前钉住单个项目目录，未来用户同时推多个项目时再议。
- 回测案例扩充：实战中产生的新传话模式回灌进 `tests/backtest-cases.json`。
