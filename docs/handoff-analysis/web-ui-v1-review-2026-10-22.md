# Web UI v1 独立复核（2026-10-22）

最新结论（二轮）：原始复现全部通过，U2、U3 关闭；U1 尚有两个时序分支未通过（下文二轮记录）。独立 typecheck、387/387 与本地服务浏览器闭环通过。不扩大功能范围。

复核对象：基于 `db6b157` 的工作树改动，对照 `docs/web-ui-design-v1.md`。本次未改应用代码、测试或部署状态。

## U1 / P1：自由切换会话后，进行中的提交丢失归属和结果

位置：`src/main/coordination/web-page.ts` 的 `request`、`send`、`control`、`switchConversation`（约 333–348、402–423、436–468 行）。

会话切换调用 `load()` 增加 `viewGeneration`，`request()` 随即拒绝旧视图的响应，`send/control` 又通过 `active(generation)` 跳过结果记录。视图已离开不应等于原会话的请求结果可以丢弃，这与设计稿 §4.1 的“结果归回原会话”不符。

Chromium 合成响应复现：

- 群聊提交回答，响应延后；立即切主聊，再返回 409 拒绝。回到群聊后 `rejectedControls.size=0`，横幅为空，用户看不到失败原因。
- 群聊发消息，响应延后；立即切主聊。原请求仍未结束，但 `leaveBlock()` 已返回空（切换把 `sending` 置为 false）。
- 返回 202 接收成功后再回群聊，原消息仍留在草稿；再次点击发送使用不同的幂等键，产生第二次提交。测试记录了两个不同 key，并非同请求重试。

修复边界：把在途请求、原始幂等键与结果保存在来源会话状态中；视图 generation 只阻止更新错误页面。登出仍须隔离旧登录的回调。离开版本/登出检查所有会话在途提交，保持主聊与群聊自由切换。补延迟成功、确定拒绝、网络失败时切换会话的覆盖。

## U2 / P2：使用不存在的 DOM parent 属性，定位无效且回答框失焦

位置：`src/main/coordination/web-page.ts:103`、`:104`、`:472`。

真实 DOM 元素使用 `parentNode/parentElement`，这里的 `card.parent` 始终 undefined：

- 点击可见的“待办 2”，没有调用任何 `scrollIntoView`，定位功能失效。
- `placeCards()` 误判卡片每次都需要移位，反复 remove/append；回答框聚焦输入时收到一条新消息，焦点从输入框移走。独立浏览器实测 focused 从 true 变 false。

现有测试自造 Element 用 `parent` 模拟父节点，恰好掩盖真实 DOM 差异。修正属性，避免对已在正确位置的卡片重新挂载；应使用真实浏览器验收定位和新消息到来时的焦点保留。

## U3 / P2：群聊异常横幅出现在主聊

位置：`src/main/coordination/web-page.ts:198`–`:200`。

`renderState()` 遍历全部 `uncertainControls/rejectedControls`，未按 signature 的来源会话筛选。实测在群聊收到拒绝、切到主聊后，主聊顶部仍显示“已确定被拒绝：fixture refusal”。

应只在当前会话显示其错误；其他会话通过侧栏独立警示点提醒。全局离开页面的 dirty 检查仍覆盖所有会话。

## 验证与证据

- `pnpm typecheck` 通过。
- 独立全量测试：29 文件、382/382 通过。首次沙箱运行因 socket/子进程限制失败，允许本地测试权限后复跑全绿，不计为代码回归。
- 真实本地服务 + Chromium：`scripts/smoke-coordination-web.ts --browser --preview-parent /dev/shm` 通过登录、委派、问题回答、完成回传、刷新及退出。
- Chromium + 当前生成页面 + 合成 API 响应复现上述问题；375px 下侧栏切换正常、页面宽度未溢出。这部分使用合成 API，不能代替真实服务闭环，二者证据分别记录。
- 本轮没有调用真实模型或 Coding CLI，也没有修改现网数据。

原始材料：`.agent-artifacts/web-ui-review-2026-10-22/` 内的 `typecheck.log`、`tests-host.log`、`browser.py`、`browser-result.json`、`page.html`、`narrow.png`。

## 二轮定点复核（2026-10-22）

### 通过项

- 原先切走等待消息成功再切回的案例：来源草稿清空、仅一次提交；在另一会话时离开检查仍能阻止未确认发送。
- 切走后的控制 409 拒绝能记录并回到来源会话显示。
- 群聊拒绝横幅不再出现在主聊。
- 新消息到来后回答框仍聚焦，点击待办调用一次 scrollIntoView；`parentNode` 修复有效。
- 独立 typecheck、30 文件 387/387 全绿。本地真实服务 + Chromium 合成委派、回答、完成、刷新、退出闭环通过。

### U1-a / P1：旧登录的 finally 误清新登录在途发送

位置：`src/main/coordination/web-page.ts:440`–`:442`。

`send` 的 try/catch 检查 sessionRevision，但 finally 无条件 `sendingConversations.delete(source)`。同会话重新登录后的新发送也占用同一个 Set 项，旧请求结束会把新请求的占用清掉。

真实 Chromium + 合成 API 时序：旧消息请求保持未返回 → status 返回 401 → 页面转到登录 → 用户通过登录表单重新登录 → 同会话发送新消息并继续保持未返回 → 旧消息返回 202。结果：新消息仍在途，但 sendingConversations 从 true 变 false、leaveBlock 返回空；下一次轮询后发送按钮可点，再点击相同内容产生两个不同幂等键的新请求。

最小修正：清理占用也必须校验登录代次/请求归属，不能让旧登录删除新登录的状态；检查 request 中 401 处理也应受相同登录边界保护（当前在调用方 alive 检查之前有 showLogin 副作用）。补跨登录旧请求结束时新请求仍在途的覆盖。

### U1-b / P2：提交期间往返同一会话，失败记录不显示

位置：`src/main/coordination/web-page.ts:421`、`:442`。

消息提交后，从工作群切主聊再切回工作群，然后才返回 500。失败已写进当前 failedSends，但 inView 仍要求最初的 viewGeneration，往返后永远不满足，因而不调用 renderSendErrors。常规轮询也不渲染该区域。

实测等待完整轮询后：failedSends.length=1，而重试按钮数量为 0、错误区域为空。必须再次离开并返回才看得到失败提示。

最小修正：保留旧视图对状态推进的保护，但来源会话当前已重新可见时，应从其已保存状态刷新错误列表与发送控件。补“切走再切回、随后才返回失败”的用例。

二轮证据：`.agent-artifacts/web-ui-rereview-2026-10-22/` 中 `browser.py`、`browser-result.json`、生成的 `page.html`、`typecheck.log`、`tests.log`、`smoke.log`。没有调用真实模型/CLI，未改应用代码、测试，未 commit、未部署。
