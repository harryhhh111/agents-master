# 切片 1 独立复核（2026-10-20，Codex）

最新核实（2026-10-21）：原三项与协议修正的两个遗漏均已关闭；双通道已部署，
见文末。以下保留逐轮复核证据。

首轮结论：真实模型接线与受限工具闭环验收通过，可作为个人预览继续推进；
“全部收尾完成”的表述需修正。以下两处小修和验收脚本问题不要求重做切片，
但本次部署必须包含稳定入口的模式标识更新。未修改应用代码、未 commit、未部署。

## 独立验证

- typecheck 通过；28 个测试文件、358/358 通过。首轮受限沙箱出现监听 EPERM 等环境失败；
  在允许本地监听与临时目录的环境复跑全绿。
- 使用既有私有凭据、隔离临时数据和合成输入调用 `deepseek-flash`：
  闲聊与“只讨论、不做任务”各一次，任务数量均保持 0；
  明确委托 → 真实追问 → 提交回答 → completed，结果明确说明未检查实际项目。
  最终保存的一轮包含 7 次模型调用，无协议失败。此前另一轮也跑通，但证据文件被先前
  验收脚本的迟到输出覆盖，因此重新保存；不以这些少量样本推断长期成功率。
- 独立 Chromium：登录、切换、真实模型标识通过；单独等待 assistant 消息，
  排除失败回复，并核实普通聊天未创建任务。
- 缺 key 拒启动由源码与子进程回归测试覆盖。service 保留 env -i 白名单；
  CLI 使用私有 dotenv 文件。执行器仍仅有 synthetic_inspect / ask / finish，
  不提供真实项目文件、shell 或 Coding CLI 执行能力。
- 默认 demo 的既有测试通过；不能称“逐字节一致”，healthz 增加字段、页面模板也有变化。

原始脚本及证据：
`.agent-artifacts/real-model-slice1-review-2026-10-20/` 中的
`tests.log`、`live-check.mts`、`live-confirmed.json`、`live-confirmed.log`、
`compat-check.mts`、`compat.json`、`browser.log`；
浏览器脚本为 `.agent-artifacts/real-model-browser-review.mts`。
`live-evidence.json` 仅为首版验收脚本误用消息 kind 字段造成的超时记录，不是产品失败证据。
真实闭环使用修正后的 presentation 字段判定。临时运行数据已清理。

## 发现与处置建议

1. **P2：工作群回执仍有 FAKE 文案。**
   `src/main/coordination/store.ts:214` 的 queueReceipt 仍硬编码
   `FAKE ${kind}: ${body}`。真实闭环中工作群实际出现 `FAKE waiting_input`、
   `FAKE completed`，与“文案整体切换完成”的声明不符。将该回执前缀纳入已有
   labels 即可；保留工具受限声明和内部 FAKE 身份，不需改协议。

2. **P2：首次 real 升级不能只发布 worker。**
   Kimi 报告的部署边界称只需重新打包 preview-worker；但当前线上稳定入口仍硬编码
   synthetic:true 和模拟导航文案。无网络兼容性复现实测：同一个上报 real 的 worker，
   旧入口 status 返回 synthetic:true；新入口返回 false 和真实模型标签。
   首次发布需同时更新 main-web 与 preview-worker，才能正确显示导航、未登录预览页和
   /api/versions。将此例外写入本次部署说明；之后兼容的 worker 更新仍可独立发布。

3. **P2：原浏览器脚本存在误通过路径。**
   `.agent-artifacts/real-model-browser-verify.mts:69-76` 检查整个消息区，
   其中用户输入本来就带“不能”；轮询结束后也没有最终断言不存在“本轮未能完成”。
   因此失败回复可能被当作真实有效回复通过。独立复核使用副本明确检查 assistant
   消息且排除失败文案，本次通过；原脚本建议同样修正，避免以后误报。

## 协议失败与重试裁决建议

严格拒绝未知字段与未授权工具本身合理，测试也证明无效批次不会执行。
但“模型输出随机”不能证明失败不是产品接入问题，既有 fail-fast 测试也不是不可变产品决策。
本次未复现 Kimi 报告的协议失败，无法据小样本确定发生频率；受限个人预览可带此已知限制验收。

建议后续用一个小修补处理：只对尚未执行该批工具的可修正参数错误，
向模型反馈校验错误并最多再请求一次；保留原始输出、累计预算和重复调用保护。
不可盲目重放整个回合、重试已提交动作，或用删除未知参数的方式静默放行。
具体实现尚未授权或完成，不必另建一套重试平台，也不以此阻塞真实 CLI 接线的独立准备。

## 收尾及协议修正复核（2026-10-20 23:51）

原三项接受：queueReceipt 已使用 receiptPrefix；runbook 第 7 节已明确首次双通道升级；
浏览器验收改用独立复核的加强断言版本，原脚本仅作参考，不再作为有效通过证据。
real 模式前台与领域执行器均接入 protocolCorrection，默认 demo 不启用。
独立 typecheck 与全量 359/359 通过，日志为原证据目录下 `rework-tests.log`。

新增修正仍有两个相邻的 P2 遗漏：

- **修正次数未持久化**（`src/agent/scoped-turn.ts:25,59-62`）。
  corrections 是每次调用初始化的局部变量。在第一次错误已保存修正反馈、下一次模型调用前
  重启，恢复相同 ScopedState 后又获得一次修正机会。独立故障注入复现：
  错误输出 → 保存修正并模拟重启 → 再次错误输出 → 再次修正 → 第三次输出成功。
  最终 3 次模型调用、2 条修正反馈、1 次工具执行。三轮总预算仍有效，未重复执行工具；
  但“同一回合最多一次修正”的承诺不成立。
- **被修正的原始输出丢失**（同文件 `:61`）。
  清空 pending 时只追加校验原因，没有保留原始坏输出。后续状态覆盖存储后无法还原当时
  哪个字段违规，违背本轮要求的原始证据保留。该问题正常修正成功时也存在，不依赖重启。

最小修补：在现有 ScopedState 中保存修正计数和被拒 reply/原因；恢复时读取计数，
后续工具提交重建 next 状态时也保留这些字段。补一次恢复边界验证和原始输出留存断言即可，
无需另建表或重试系统。原四组测试均在单次 scopedTurn 调用内，未覆盖恢复场景。

复现脚本及结果在原证据目录：
`correction-recovery-check.mts`、`correction-recovery-result.json`。
该检查仅使用确定性注入模型与序列化状态，无外部模型费用、无现网改动。
本轮未重复做真实 DeepSeek/浏览器全链路，沿用首轮独立通过证据和实现者本轮报告；
新逻辑的结论依据源码、全量回归及故障注入。

## 部署后核实（2026-10-21）

`ScopedState.corrections/rejected` 已持久化，工具提交构造 next 时也保留；
恢复时不再从局部变量重置次数。独立运行 `tests/coordination-model.test.ts`，
14/14 通过，覆盖原始坏输出留存及恢复后不再次修正；两个遗漏关闭。
本次未重跑全量或向线上发送测试聊天。

两服务 active/running，启动时间为北京时间 2026-10-21 00:14:09（worker）、
00:14:30（入口）。两通道 current 与清单均为 `web-real-20261020-ab42e00`，
来源提交 `ab42e00dbd87a5f506199279e013a9b3e6ff321a`；
线上 scoped-turn.ts、preview-worker.ts 与工作树对应文件哈希相同。
worker healthz 为 synthetic:false、deepseek-flash；本地稳定页与预览页均 200，
均展示真实模型标识；未登录 /api/versions 为 401。

旧 deployment-last.json 未随此次发布更新，不据此认定部署失败；
本机原 HTTPS 地址仍返回 TLS 握手失败，用户侧访问未由本次核实确认。
