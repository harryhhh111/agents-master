# 稳定版 / 预览版步骤 C.3 独立复核

日期：2026-10-19。结论：**需要返工，尚未通过部署前验收。**

Kimi 完成实现后，协调者直接委派独立 Codex CLI 复核，无需经 Kimi 转派。
基线 HEAD 为 `86d6072`，步骤 C 的六个文件仍未跟踪。复核冻结 129 个文件，结束时全部
匹配原始哈希；未修改应用源码、测试、配置模板和运行手册，未部署、操作生产数据或 commit/push。

## 证据与本轮结果

原始产物在 `.agent-artifacts/web-release-independent-review-2026-10-19/`（本地忽略目录）：

- `BRIEF.md`、`baseline.txt`、`frozen.sha256`：任务边界、基线与源码清单。
- `codex.jsonl`、`codex.stderr`、`REVIEW.md`、`FINAL.md`：独立 CLI 原始执行及报告。
- `raw/`：命令、退出码、stdout/stderr、最小复现与合成打包产物。

**证据补充说明：**独立 CLI 在内层沙箱中运行，报告中的“未取得真实浏览器证据”和
338/347 的补充测试结果仅描述该环境。协调者随后在经权限审查的外层执行环境运行同一
CLI 准备的隔离执行器及项目既有 smoke，得到下列额外证据。原始报告保留原样，综合结论以
本记录为准；这些补充未消除部署阻塞。

| 检查 | 实际结果 | 原始证据 |
| --- | --- | --- |
| Typecheck | 通过 | `raw/03-typecheck.*` |
| 全量测试，外层复跑 | 346/347 通过；跨进程 worker 恢复测试在 5 秒超时，尚未完成归因 | `raw/20-full-tests-host.*` |
| 真实 Chromium 基础 smoke | 通过：登录、同站切换、预览发消息、返回后历史保留、消息草稿切换取消/确认 | `raw/22-browser-smoke-var-tmp.*` |
| 合成打包与缺陷探针 | 复现下表问题；双通道 current 链接独立的局部检查通过 | `raw/13-package-repro.*`、`raw/16-ui-runtime-repro.*` |
| 冻结校验 | 129/129 一致，清单自身哈希未变化 | `raw/21-final-freeze-check.json` |

本轮不能宣称独立复现了 Kimi 的 347 项全绿。内层沙箱限制本地 socket、子进程管道，并在
`/dev/shm/.git` 暴露探测标记；外层 `/dev/shm` 的 smoke 也被仓库外目录检查拒绝，改用
`--preview-parent /var/tmp` 后真实 Chromium 成功。测试采用空凭据环境与合成 HOME，部分
写死 `/tmp` 的测试由 CLI 提供的 preload 改写临时目录前缀；没有修改测试文件。
环境失败与产品缺陷分开记录，不推翻其他机器或会话的历史结果。

## 返工项

| 编号 | 级别 | 问题与影响 | 主要位置 |
| --- | --- | --- | --- |
| R1 | P1 | 新稳定服务缺少 `DEEPSEEK_API_KEY` 的私有供给路径；release 不带 `.env`，按手册先停旧服务后启动新服务会在缺 key 时失败 | `deploy/agents-master-web-release.service:10`；`scripts/main-web.ts:415` |
| R2 | P2 | 页面和 `/api/versions` 使用固定 releaseId，未读取发布 manifest，入口也无法获知实际 worker 版本 | `scripts/main-web.ts:32`；`scripts/main-web-preview.ts:160` |
| R3 | P2 | 版本切换只保护部分输入；问题回答草稿及待确认控制提交可以无提示离开，其他会话草稿也未纳入检查 | `scripts/main-web.ts:671`；`src/main/coordination/web-page.ts:16` |
| R4 | P2 | 消息/控制 fetch 没有应用层 deadline；请求一直 pending 时不能进入有界的“接收状态未知、允许确认离开”流程 | `scripts/main-web.ts:583`、`:640` |
| R5 | P2 | worker 模板仅设置 `DOTENV_CONFIG_PATH=/dev/null`，未强制最小环境允许列表；这不清除启动前已有变量 | `deploy/agents-master-preview-worker.service:10` |
| R6 | P2 | 整个 commit archive 没有绑定批准的源码清单；手册宣称 `.env` 等不会进入包并非工具保证 | `scripts/package-web-release.ts:110`、`:131`；`docs/web-version-switch-runbook.md:37` |
| R7 | P2 | 接受相对 `--release-root`，却把未解析的 destination 写成 symlink target，返回成功但 current 断链 | `scripts/package-web-release.ts:99`、`:150` |
| R8 | P2 | 按手册移除预览配置后，旧 `/preview/` 返回无“返回稳定版”链接的 JSON 404 | `scripts/main-web.ts:295`；`docs/web-version-switch-runbook.md:131` |

R1/R2/R3/R4/R8 有真实 handler 或实际页面脚本的合成 VM 复现，不能称为真实浏览器缺陷复现。
R7 经独立合成 Git 仓库真实打包确认。R5 没有声称 systemd 默认继承调用者的完整 shell 环境，
检查的是缺少强制允许列表。R6 只在合成仓库用假敏感文件复现，不表示真实项目泄露过秘密。

此外，六个未跟踪文件虽已冻结哈希，现有打包器仍拒绝脏工作树；需要把批准源码、提交或源码
快照与最终包建立可验证对应。不能通过擅自提交或清理工作树消除这个缺项。依赖安装及可运行
release 验证也未完成，`--skip-install` 合成探针不算可部署发布物。

## 第 5 节综合验收状态

| 验证项 | 综合状态 |
| --- | --- |
| 旧入口回归 | handler 回归通过；真实 release 启动被 R1 阻塞 |
| 同站切换 | Chromium 基础切换通过；直接刷新及完整状态恢复仍需补证 |
| 数据隔离 | 外层 HTTP 集成中的历史/owner 标记隔离通过；完整问题、任务、事件及双运行时目录验证不足 |
| 完整路由 | 静态枚举通过；全部浏览器分支的网络轨迹未覆盖 |
| 并行标签 | 未覆盖真实双标签与相同请求 ID 跨通道行为 |
| 输入与未决提交 | 普通消息草稿的浏览器确认通过；R3、R4 阻塞完整验收 |
| 后台持续 | 底层合成测试局部通过；双通道任务→切换→回答→结果浏览器闭环未覆盖 |
| 故障降级 | 外层 worker 停止后的 HTTP 集成通过；R8 阻塞关闭配置后的回退体验 |
| 持久重启 | 单进程重开测试通过；跨进程停止/崩溃恢复测试仍超时 |
| 单实例 | 函数级拒绝重复实例通过；跨进程完整验收未通过 |
| 认证边界 | 外层集成覆盖部分未授权、跨源、路径边界；全部伪造头、编码及浏览器组合未覆盖 |
| 退出与过期 | 外层预览 SSE 登出关闭和后续 401 通过；双通道过期和浏览器清理未完整覆盖 |
| 流式与资源 | 外层预览 SSE 增量到达通过；浏览器断开资源释放和异常恢复未完整覆盖 |
| 发布隔离 | 合成链接/manifest 局部通过；R1/R2/R6/R7 与源码、依赖产物缺项阻塞 |
| 范围与保密 | 合成执行和模拟标识有证据；R5/R6 阻塞完整发布边界验收 |

下一步是执行 CLI 修复上述问题后重新冻结、复跑受影响检查并补全浏览器证据。通过后再提交
确切服务、路径、凭据供给、备份、中断窗口及回退方案供用户批准。当前没有部署授权。
