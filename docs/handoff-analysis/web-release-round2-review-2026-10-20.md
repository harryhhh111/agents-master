# 步骤 C 二轮返工独立复核（2026-10-20）

结论：**N1/N3/N4/N5/N7 关闭；N2/N6 部分关闭，剩余三个 P2 问题，C.3 尚未通过。**
真实 release 已完成安装、启动和浏览器任务闭环，上一轮的正常源码误拒与任务停滞已消除。

独立 Codex CLI 编写验收脚本及原始技术报告；协调者审核脚本后在外层执行隔离测试，并核对
原始结果。应用源码、测试和部署模板只读；HEAD 为 `86d6072`，未 commit、push 或操作现网。
CLI 在写完 REVIEW.md 和最终冻结校验后触发额度限制，未生成最终对话摘要；报告与全部验证
产物已落盘，协调者据其原始证据完成本记录，不将 CLI 退出码当作测试结果。

## 尚未关闭的问题

| 编号 | 级别 / 位置 | 复现与影响 | 修复后应验证 |
| --- | --- | --- | --- |
| F1（N2） | P2，`scripts/package-web-release.ts:150` | 仓库含 `rootlink -> .`、`escape -> rootlink/../outside-synthetic` 时，词法 path.resolve 判断仍在 release 内，真实链接却指向父目录。完整打包退出 0，逃逸链接进入产物。探针只使用合成假文件，未读取真实外部内容。 | 按实际链接链检查边界；处理循环/不可解析链接。验证链式 `..` 逃逸被拒且合法内部链接仍能入清单。 |
| F2（N6） | P2，`src/main/coordination/web-page.ts:37–38` | 待答问题的控制请求返回明确 400 拒绝时，catch 写入错误，finally 的 renderState 随即清空。Chromium 看到按钮恢复，但错误区为空，用户不知道拒绝原因。 | 明确拒绝原因稳定显示，轮询不清除；与超时/5xx 的未知接收状态区分。 |
| F3（N6） | P2，`src/main/coordination/web-page.ts:14`、`:28`、`:34` | 控制请求 503 后登出，再在同页登录，uncertainControls 仍为 1，旧提示和切换确认残留；controlKeys 已清空，未知状态和重试键生命周期不一致。 | 统一登出与重登录时的状态清理，并防止旧请求完成后重新写入旧会话状态。后者为静态审查建议，本轮未另做延迟回调复现。 |

证据分别为原始产物目录内 `raw/scanner-probes.json` 的 chain-dotdot、
`raw/control-400-visible.json`、`raw/uncertain-after-relogin.json`；浏览器失败步骤与截图均保留。

## N1–N7 关闭判断

| 项 | 结论 | 证据 |
| --- | --- | --- |
| N1 正常源码误拒 | 关闭 | 真实应用三份 release 均成功；src/state、src/sessions 被正确归档，根部敏感目录及 sessions/.env.template 被拒。 |
| N2 符号链接扫描 | 部分关闭 | 敏感名称链接、直接绝对/相对逃逸被拒；内部链接以 link:目标 哈希入清单；链式逃逸仍见 F1。 |
| N3 合成任务闭环 | 关闭 | 从真实 release 启动，Chromium 委派→waiting_input→切稳定聊天→返回回答→completed，结果回传；未替换执行器或伪造任务状态。 |
| N4 直达登录版本标识 | 关闭 | 未登录直接进入 /preview/，登录后无需刷新，页面和 versions 都是实际 round2-preview-A。 |
| N5 health 总时限 | 关闭 | 实际 release 模块面对每 100ms 滴流且永不结束的响应，在约 1010ms 返回 unavailable。 |
| N6 未知控制提交 | 部分关闭 | 实等约 31 秒超时及 503 的提示跨轮询保留，同键重试成功清除，切换取消/接受通过；F2/F3 仍需修复。 |
| N7 安装 | 关闭并更正归因 | 上轮夹具漏带既有 pnpm-workspace.yaml；本轮三个 release 完整 install 与 esbuild 转换全部成功。 |

N7 是复核方法错误，撤回此前的产品安装阻塞归因。原始失败日志保留以供追溯。
N5 则是既有总时限缺口，HEAD 原代码也等待 response end，并非 manifest 解析引入的新回归。

## 验证范围

- Typecheck 通过；全量 **28 文件、351/351** 通过，仅跑一次。测试进程使用 umask 022，
  私有合成父目录为 0700；只重定向临时路径以避开本机 /tmp/.git 探测标记，不 mock 安全检查。
- Node 22.22.2；隔离环境 pnpm 12.14.0。真实快照带 package、lock、workspace、tsconfig，
  **96 个冻结文件 + 1 个合成配置**与 97 成员发布清单逐项对应，哈希、文件计数及摘要全部一致。
  合成模型配置在快照 commit 前写入，未在打包后修改 release 源码；三个产物都执行完整
  `pnpm install --frozen-lockfile`，没有 skip-install，也没有回退到源码夹具运行。
- Chromium 主流程 6/8 步通过，失败仅 F2/F3；预览 B 重启后历史验证 1/1 通过。
  正常任务使用实际 worker；只有超时/400/503 分支局部拦截 HTTP 请求，不改任务状态。
- 预览 A→B 使用不同发布目录和实际 current 切换；稳定进程 PID、依赖树、数据目录和
  release.json 哈希均不变。B 提前安装，本轮未验证稳定负载下并发安装。
- 双标签、同幂等键跨通道、owner context 隔离、登出后四端点 401、worker 停止后的
  503 返回稳定及稳定聊天、重复 worker 拒绝启动通过。
- 实际 release 模块的专项夹具将合成认证时钟前推 31 天，保留真实 30 秒检查间隔；
  稳定/预览 SSE 均关闭，后续请求 401；预览下游断开后合成上游连接数归零。
  这是模块传输验证，不等同于浏览器连接真实 worker 的资源计数验证。

方案第 5 节逐项通过/未覆盖/阻塞矩阵见原始 REVIEW.md。仍未穷举所有异常路由的浏览器分支、
浏览器断连后的实际 worker 内部资源计数，也未使用生产旧 cookie。普通消息超时、草稿切换、
预览关闭返回页等未改动路径沿用上一轮明确标注的证据。完成本轮复核不代表生产部署获批。

## 原始产物

目录：`.agent-artifacts/web-release-round2-review-2026-10-20/`。

- `REVIEW.md`：独立 CLI 技术报告和完整验收矩阵。
- `BRIEF.md`、`baseline.txt`、`frozen.sha256`、`codex.jsonl`：任务边界、冻结和原始执行记录。
- `HOST_READY`、`FOLLOWUP_READY`、对应 `*_EXIT.json`：执行脚本哈希及外层执行结果。
- `raw/full-tests.*`、`raw/typecheck.*`、`raw/release-verification-*.json`：基线与实际发布证据。
- `raw/browser-primary-results.json`、`raw/browser-restart-results.json`、相关 PNG：浏览器原始结果。
- `raw/health-exact.stdout`、`raw/sse-expiry-resources.stdout`：总 deadline、过期和流资源证据。
- `raw/final-freeze-check.json`：**131/131 冻结文件及所有已发布脚本哈希匹配**。

冻结清单 SHA-256：`4821d1e988aef364b593dd22a25a02a727f2ad7e58c1220f9b2b0e7df9d1979c`。
本次仅新增复核记录、更新路线图事实并更正旧报告；不替用户裁决范围或批准 commit/部署。
