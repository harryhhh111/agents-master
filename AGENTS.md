# AGENTS.md

个人 Agent 项目：一个带独立 LLM 大脑的 agent，驱动 codex-cli 和 Kimi Code 两个 CLI 协作，
替代用户手工传话。背景与已敲定的技术决策见 `docs/discussion-summary-2026-08-12.md`，
真实传话需求规格见 `docs/handoff-analysis/findings-2026-08-12.md`，
当前阶段与后续规划见 `docs/roadmap.md`。

## 行为规范

- **先感知当前机器环境再动手**：每次会话开始（尤其是跨机器、新对话）时，主动确认
  本机的事实——两个 CLI 是否在、网络/代理是否通、ckrunner 在不在、session 记录在哪——
  不要套用另一台机器的假设。环境事实**按机器各自成立**：实测到本机的新事实，
  追加记录即可，不用它去推翻另一台机器的结论（那边的事实在那边依然有效）。
- agent 不直接处理项目代码，只负责和两个 CLI 对话；对项目工作区只做只读核实
  （git log/status、产物存在性），技术验收永远交给对面的 CLI 做。
- agent 的"看法"限于核实性标注、路由建议、时效性标注；优先级裁决、范围砍削、
  push 批准、"出方案"口令永远留给用户。

## 当前机器环境（vinci 的云服务器，2026-08-12 实测）

- `codex` 0.147.0（`~/.local/bin/codex`）：本机实测**网络直连可用，无需代理**。
  注意另一台机器情况不同（那边依赖 `127.0.0.1:7897`），两边事实各自有效。
- `kimi` 0.35.0（`~/.kimi-code/bin/kimi`）。
- Node v22.22.2、Python3 可用。
- 会话记录：Codex 在 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`；
  Kimi 在 `~/.kimi-code/sessions/wd_<项目>_<hash>/session_*/agents/main/wire.jsonl`。
- **ckrunner 不在这台机器上**（在另一台机器 `~/Documents/GitHub/harryhhh111/ckrunner`），
  如需复用其 backend 代码要先拷贝。
- 环境变量里暂无 DeepSeek API key，跑 agent 前需配置。
- 项目工作区：`~/projects/stock_data`（两个 CLI 共享同一 repo 和 git 远端，存在并发
  写入，派活前注意 git 状态）。
