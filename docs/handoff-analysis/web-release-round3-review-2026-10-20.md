# 步骤 C 三轮定点返工验收（2026-10-20）

结论：**M2、M3 关闭；M1 部分修复、仍未关闭，剩余一个 P2 问题。C.3 尚未通过。**
本轮由当前 Codex 会话直接核对源码、生成并执行独立验收脚本；未修改应用源码、测试或部署模板，
未 commit、push、安装生产 service 或操作现网。

## M1：路径解析仍与真实文件系统语义不一致

位置：`scripts/package-web-release.ts:155–160`。
循环增加了普通链接链、悬空、成环检查，但仍先 `path.join` / `path.normalize`，随后只检查
该规范化路径末端是否为链接。它没有按真实文件系统顺序解析中间目录链接。

两个合成 Git 仓库均完成归档、扫描和发布元数据生成，退出码为 **0**，逃逸链接进入 manifest，
目标目录未被清理；实际链接指向发布目录外的假文件：

1. **链式 `..` + 内部同名文件**：

   ```text
   release/rootlink -> .
   release/escape -> rootlink/../outside-synthetic
   release/outside-synthetic             # 普通合成文件
   release/../outside-synthetic          # 另一个普通合成文件
   ```

   扫描把 `rootlink/../outside-synthetic` 提前折叠成目录内的 `outside-synthetic`，发现普通文件
   即放行；真实文件系统先把 rootlink 解析成 release，再执行 `..`，得到 release 父目录的文件。
   上轮没有内部同名文件的原始探针现在被拒，但原因是折叠后的目标不存在，不能证明解析边界正确。

2. **子目录中的绝对链接 + 内部同名路径**：

   ```text
   release/sub/escape -> /var/tmp/<本次合成目录>/outside-synthetic
   release/sub/var/tmp/<本次合成目录>/outside-synthetic  # 普通合成文件
   ```

   `path.join('sub', '/var/tmp/...')` 产生 `sub/var/tmp/...`，丢失了目标的绝对路径性质；
   扫描看到内部同名文件而放行，真实链接仍指向外部假文件。
   应在拼接前识别绝对目标，不能依赖拼接后的 isAbsolute。

所有外部目标都是本轮创建的合成文件，未读取真实外部数据。证据见
`raw/scanner-results.json` 中 `dotdot-decoy`、`nested-absolute-decoy`：
`exitCode=0`、`escapes=true`、`manifestContainsLink=true`。

其余五个探针通过：合法内部链接放行，普通二级绝对链、悬空、成环、无内部同名文件的旧 `..`
探针均拒绝，拒绝后目标目录清理。专用探针使用 `--skip-install`，只验证扫描和发布行为；
下述真实应用双通道另做完整安装，不以探针替代安装验收。

后续仅需修复 M1，使用以上两个确切案例及合法内部链接做回归。若保留符号链接支持，应校验
文件系统实际解析结果，避免先用字符串规范化替代链接解析；无需扩展本轮产品功能范围。

## M2：关闭

实际安装 release 中，Chromium 对真实待答问题的控制请求注入确定性 400 拒绝：

- 显示「提交未被接受：SYNTHETIC_REJECTED_400」，等待 3.2 秒多次轮询仍可见。
- 切换稳定版会询问确认，取消后保留当前页面。
- 恢复真实请求后，同内容重试使用相同幂等键；回答成功、问题完成，拒绝状态和错误文字清除。

证据：`raw/rejection-visible.json`、`raw/rejection-retry.json`、相关截图。
本轮没有重跑未变动的真实 30 秒超时分支，沿用上一轮通过证据。

## M3：关闭

实际安装 release 的 Chromium 定点验证通过：

- 分别触发 503 未知状态和 400 拒绝状态，登出再在同页登录后，两个集合、旧重试键和错误文字
  均清空，多次轮询没有恢复旧提示。
- 旧控制请求挂起期间登出并重登录，随后让旧请求分别返回 503、400、200：
  新会话没有未知/拒绝状态污染，pending 归零。
- 旧请求未结束时重登录并发起新请求：计数先为 2；旧请求结束后为 1，切换仍被硬阻止；
  新请求成功后为 0，目标问题完成，错误状态为空。

重叠场景首轮遇到 Playwright 字符串断言被 CSP 拒绝；第一次补验又错误地要求所有问题消失，
而合成队列还有其他任务。最终改用函数断言并仅检查实际提交的问题，补验通过。
上述失败属于测试夹具，原始结果均保留；没有放宽 CSP、修改产品代码或伪造任务完成状态。

证据：`raw/logout-400.json`、`raw/logout-503.json`、`raw/late-*.json`、
`raw/overlap-final.json` 和截图。主浏览器六项直接通过，重叠项经纠正断言后的单独补验通过。

## 基线与发布验证

- Typecheck 通过；全量 **28 文件、352/352 通过**，仅跑一次。
- 正常源码快照分别打包 stable / preview，执行完整 `pnpm install --frozen-lockfile`，
  两份 release 均安装、启动成功。归档包含 pnpm-workspace.yaml。
- 每份清单 97 个成员，与冻结来源及明确合成的 config.toml 对应；文件哈希、计数和清单摘要
  全部匹配。浏览器运行的是实际 release，无源码夹具回退。
- 模型仅指向本地假 HTTP 服务；所有账号、凭据和任务均为合成数据。测试使用私有
  `/var/tmp/web-round3-y37h2tq6`；umask 022 用于全量测试，外层私有父目录为 0700；
  临时路径重定向沿用上轮方式，不 mock 产品安全检查。
- 本轮 131 个冻结文件始终匹配。执行脚本有哈希记录；所有本轮服务进程已停止，合成产物保留。

方案第 5 节其他已通过项和明确未覆盖项沿用
[二轮验收记录](web-release-round2-review-2026-10-20.md)，本轮不扩大验收范围。
M1 仍未关闭，不将本轮标记为已通过源码交付验收或已获部署批准。

## 证据目录

`.agent-artifacts/web-release-round3-review-2026-10-20/`：

- `review.py`、`followup.py`、`followup-final.py`：主验收和两次定点补验，保留失败过程。
- `executed-scripts.json`、`HOST_EXIT.json`、`FOLLOWUP*_EXIT.json`：脚本哈希、进程退出记录。
  主执行器退出 0 仅表示执行完成，扫描误放行与浏览器分项结果单独判定。
- `frozen.sha256`、`raw/*freeze*.json`：源码冻结与核对。
- `raw/scanner-results.json`、`raw/package-*.stdout/stderr`：M1 复现。
- `raw/browser-results.json`、`raw/overlap-final.json`：M2/M3 实际结果。
- `raw/typecheck.*`、`raw/full-tests.*`、`raw/release-verification-*.json`：必要回归与发布验证。
