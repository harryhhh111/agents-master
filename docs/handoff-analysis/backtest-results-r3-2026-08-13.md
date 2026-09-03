# 传话回测结果 r3（2026-08-13，DeepSeek deepseek-v4-flash，边界澄清版 prompt）

> 只重跑 r1/r2 一直"先问后转"的两个用例（P1-review、doc-pointer），验证 prompt 新增的
> "边界澄清"段（①转发验收结论不阻塞；②用户明示过执行方的文档转交视为开工已批准）是否生效。
> 装置同 r2（用例级 git_status 假数据）。原始记录：backtest-raw-r3-2026-08-13.json。

## 案例 1：P1-review-不通过回传

- 期望：分类=review_feedback，动作=forward_full → kimi
- 动作序列（4 轮 LLM 调用）：廉价核实（git_status + read_artifact 核行号 + 两边 session）
  → **run_kimi 全文转发** → update_ledger（kind=review_feedback ✓）→ ask_user（只问阶段裁决）
  → 三段式汇报。
- **是否直接转发：是。** 转发先于 ask_user，阶段定位没有卡住转发——正是边界澄清①的行为。
  转发后的 ask_user 只问"是否认可 Codex 的阶段裁决（P1A 通过 / P1 不关闭 / 暂缓 Phase 2）"，
  context 里明写"按边界澄清，转发不因阶段建议阻塞（已完成）；阶段推进/关闭以你明示为准"。
- 保真校验：**must_contain 6/6 全过**（r1/r2 均为 0/6 因未转发）。行级保真粗查：review 原文
  69 个非空行中 67 行逐字出现在转发 prompt；仅 2 行的中文弯引号被写成直引号（"P1A 双写骨架
  完成"、"一次实际抓取"），内容零损耗。转发 prompt 还带：明确的任务类型头、"不要自行降级
  任何一条"、10 步顺序、报告落 .agent-artifacts/ 的约定、"验收权在 Codex、不要自称 P1 通过"。
- 结论：**缺陷 #1 消除。**

## 案例 4：doc-pointer-执行文档转交

- 期望：分类=doc_pointer，动作=forward_full → kimi
- 动作序列（3 轮 LLM 调用）：廉价核实（read_artifact + git_status，确认"唯一脏文件即该文档"
  与 Codex 声明一致）→ **run_kimi 直接转交开工** → update_ledger → 三段式汇报。无 ask_user。
- **是否直接转发：是。** agent 明确援引边界澄清②："用户已在场景里定下执行方是 Kimi（'准备
  交给 Kimi 执行'），按边界澄清这属于预先批准，直接转交开工，不再问。"
- 保真校验：**must_contain 2/2 全过**（全路径 + "TTM 双口径"摘要都在）。转交 prompt 注明了
  "文档尚未 commit、无 sha 锚点，以当前内容为准"，并要求报告落 .agent-artifacts/、给出可核查
  锚点、预告验收由 Codex 独立核查。
- 一个分类小变化：台账 kind 记为 task_assignment 而非 doc_pointer——入站消息是 doc_pointer，
  出站动作被记成派活。考虑到转交即开工，这个归类说得通，但如果想追踪"文档指针"类消息的
  到达，台账口径需要统一（建议：kind 记入站消息类型，direction 表达去向）。
- 结论：**案例 4 卡点消除。**

## 结论

两个边界澄清都生效：案例 1 先全文转发再呈阶段裁决（6/6 保真），案例 4 凭事先分工意图直接
转交开工（2/2）。三轮对比：案例 1 动作 ✗→✗→**✓**，案例 4 动作 ✗→✗→**✓**。r1 发现的 6 个
prompt 缺陷至此全部消除或按用户批准的边界落定。唯一新增观察：doc_pointer 转交的台账 kind
口径（task_assignment vs doc_pointer）可统一，非阻塞。

注意：单样本运行，但案例 1 两轮"先问"一轮"直接转"的转变与 prompt 修订逐条对应，可归因于
边界澄清而非随机抖动。
