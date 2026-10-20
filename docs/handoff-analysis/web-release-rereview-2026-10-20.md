# 步骤 C 返工后独立复核（2026-10-20）

> 2026-10-20 二轮复核更正：本记录保留当时结果，当前状态见
> [二轮返工独立复核](web-release-round2-review-2026-10-20.md)。N7 的安装失败源于复核夹具
> 漏带仓库已跟踪的 `pnpm-workspace.yaml`（含 esbuild 构建许可），不是产品安装缺陷；
> 撤回将其列为产品阻塞的判断。本次真实应用快照的三个 release 均完整安装成功。

结论：**5 项关闭、2 项部分关闭、1 项未关闭；仍未通过部署前验收。**

依据用户提交的返工报告，由独立 Codex CLI 编写验收脚本与技术报告，协调者核实执行边界，
在经权限审查的外层环境执行合成测试、完整打包尝试和真实 Chromium，随后复核证据。
HEAD 仍为 `86d6072`；应用、测试、部署模板均未由本轮修改，未 commit/push 或操作现网。
本记录不批准部署或裁决产品范围。

## R1–R8 关闭判断

| 项 | 结论 | 实际证据与限制 |
| --- | --- | --- |
| R1 稳定凭据接入 | 关闭 | 仓库外合成 0600 凭据文件经 DOTENV_CONFIG_PATH 供给，真实稳定 CLI 启动并调用本地假模型完成聊天；不含真实凭据或模型外发。 |
| R2 发布标识 | 部分关闭 | 已登录页面、API、预览 A→B 重启标识正确；未登录直达预览后，登录成功仍使用旧 fallback 页面标识，刷新才正确。 |
| R3 切换保护 | 关闭（UI 验证范围） | Chromium 验证回答草稿、其他会话草稿、确认取消/接受及 pending 控制阻止切换。回答/控制使用合成 HTTP 状态夹具；真实任务闭环另有阻塞。 |
| R4 deadline/未知状态 | 部分关闭 | 真实约 30 秒消息超时、明确未知提示、同键重试、取消/接受离开通过；控制超时后缺少可靠的未知接收提示。 |
| R5 worker 环境 | 关闭 | 模板 env -i 限定 HOME/PATH/DOTENV_CONFIG_PATH；测试 worker 以这三项环境启动。未安装真实 service。 |
| R6 发布扫描/源码清单 | 未关闭 | 正常源码被误拒；符号链接遗漏扫描和清单，模板文件名例外还能绕过目录禁令。 |
| R7 相对发布根目录 | 关闭 | 最小合成仓库完整打包/install 成功，current 为有效绝对链接。该结论不代表完整应用 release 成功。 |
| R8 关闭预览返回页 | 关闭 | Chromium 验证关闭预览后 404 HTML 页面包含可用的返回稳定版链接。 |

## 确切缺陷与安装阻塞

| 编号 | 级别 | 触发、影响及位置 |
| --- | --- | --- |
| N1 | P1 | 扫描器把任意层级的 sessions/state 都视为敏感路径，冻结应用快照的两个通道均在安装前拒绝正常 `src/sessions/*.ts`，`src/state/*.ts` 也命中，无法生成应用 release。见 `scripts/package-web-release.ts:113`、`:156`。 |
| N2 | P2 | `.env` 符号链接能被归档，但 collectReleaseFiles 只收普通文件，扫描和 source manifest 都看不到它；`sessions/.env.template` 也因 basename 例外放行。合成探针使用假文件，不表示生产秘密曾泄露。见 `scripts/package-web-release.ts:117`、`:120`。 |
| N3 | P1 | 专用 worker 显式注入 HeldFakeExecutor，但没有驱动其 finish 的入口；真实浏览器发起任务、切回稳定聊天、再返回后，任务一直 running、问题为空，无法完成问答/结果闭环。见 `scripts/preview-worker.ts:82`、`src/main/coordination/fake.ts:17`。这是本轮新发现的既有组装缺陷，不是返工新引入。 |
| N4 | P2 | 清空登录态直接访问 `/preview/`，登录后的页面配置仍为 `coordination-preview-step-b-local`，实际 worker 为 `followup-preview`；刷新才一致。见 `scripts/main-web.ts:326`、`:332`、`:654`。 |
| N5 | P2 | healthz 每 100ms 写数据而不结束时，500ms socket 空闲超时不触发，1.8 秒后 status() 仍 pending，可持续拖住版本接口。需要总时限。见 `scripts/main-web-preview.ts:167`、`:182`。HEAD 原实现也等待 response end，因此属于既有缺口，不能归因为本次解析 manifest 的新回归。 |
| N6 | P2 | 控制请求超时后按钮解禁、同内容重试键保留，但 catch 仅写原始错误，轮询又可清空 error；没有可靠的 control uncertain 状态或用户可见的未知接收提示。见 `src/main/coordination/web-page.ts:33`、`:34`，以及 `scripts/main-web.ts:544`。 |
| N7 | 夹具缺陷（后续更正） | 当时两份源码夹具因 esbuild 的 `ERR_PNPM_IGNORED_BUILDS` 退出 1；二轮查明夹具漏带已跟踪的 pnpm-workspace.yaml。原始失败记录保留，撤回产品安装阻塞归因。 |

源码清单仍需与批准范围对应；仅生成清单不等于验证批准集合。N1 必须修复后才可能验证
真正的应用打包/install 路径；独立源码夹具及最小无应用依赖包均不能替代它。

## 验证结果与环境解释

- Typecheck：通过。
- 全量测试：常规 umask 022 下 **28 文件、351/351 通过**，原跨进程停止/崩溃恢复项通过。
  首轮使用 umask 077 时为 350/351：已有目录测试依赖默认权限，0700 使检查进入读取缺失
  PREVIEW-v2 的分支，得到 ENOENT 而非期望的 reopen 文本。两种情况都拒绝该目录；不据此
  判断数据保护失效。初次失败和对照复跑均保留。
- 临时路径适配：仅将 mkdtempSync 的 `/tmp/`、`/dev/shm/` 前缀移入本次 0700 的 `/var/tmp`
  父目录，保持安全检查和产品代码不变；使用合成 HOME、空凭据环境、`--no-cache`。
- Chromium 通过：一次登录/同站切换/刷新，正常发布标识，回答与其他会话草稿，真实消息超时
  及同键重试，双标签同键跨通道隔离，owner context 隔离，双标签登出/页面清理/四个 API/SSE
  返回 401，worker 停止后的 503 返回页与稳定聊天，预览关闭后的返回页。
- 浏览器阻塞：N3 真实任务问答闭环、N4 直接预览登录后的标识、N6 控制超时提示。
  首轮消息重试和停止 worker 的夹具时序错误、未展开设置就点击登出的操作错误，均通过专门
  补验纠正，未计作产品缺陷。
- Release：91 个批准应用文件逐项对应冻结哈希，含本次未跟踪打包器；在全新快照 Git 仓库中
  实际打包双通道均被 N1 拦截，尚未进入 install。单独两份源码夹具的完整 install 遇 N7；
  虽然已下载依赖可支持浏览器运行，安装退出码仍为 1。
- 浏览器使用的是源码夹具及独立下载的依赖，**不是成功发布的 release**；运行配置只指向
  127.0.0.1 假模型。预览重启 A→B 后稳定 PID/标识/历史保持、预览历史及 unknown/interrupted
  回传有证据，但不能据此声明完整不可变发布验收完成。

本轮普通 shell 预检显示 pnpm 11.21.0，而隔离 HOME/XDG 执行器实际报告 12.14.0；保留各自
环境事实，不把其中一个版本推定为所有会话的版本。两个 CLI 为 Codex 0.163.0、Kimi 2.2.0，
Claude Code 2.1.195。受限桌面 shell 的 DeepSeek DNS 仍失败；外层依赖下载实际成功，这两项
观测描述不同执行环境与目标，不互相替代。

## 原始证据与后续验收

原始产物位于 `.agent-artifacts/web-release-rereview-2026-10-20/`：

- `REVIEW.md`：独立 CLI 完整报告，含方案第 5 节逐项通过/未覆盖/阻塞表。
- `BRIEF.md`、`baseline.txt`、`frozen.sha256`、`codex.jsonl`：委派、基线、冻结与原始执行。
- `HOST_READY`、`FOLLOWUP*_READY`、对应 `*_EXIT.json`：外层执行脚本哈希及执行记录。
- `raw/full-tests-umask022.*`、`raw/typecheck.*`：最终全量和类型检查。
- `raw/browser-results.json`、`raw/confirm-browser-results.json`、`raw/direct-preview-releaseid.json`：
  浏览器初轮、纠正夹具后的补验及发布标识复现；同目录保存截图与网络步骤。
- `raw/release-*.stderr`、`raw/probe-result-*.json`、`raw/fixture-install-*`：真实打包拒绝、
  扫描漏洞、相对链接和安装失败证据。
- `raw/final-freeze-check.json`：130 个冻结文件及 READY 脚本哈希校验。

应继续修复 N1–N7 并补齐完整发布、任务问答、双通道实际过期、浏览器断连后的服务端资源
计数及其余异常路由证据。此前已通过项不必无理由重复验证；修复影响到的检查与最终必要
基线仍需重跑。完成验收后再由用户决定 commit 和部署，当前未获部署授权。
