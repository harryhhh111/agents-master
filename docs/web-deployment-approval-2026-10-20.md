# 稳定版 / 预览版上线审批清单

2026-10-20。**用户已批准并执行上线，17:10 服务切换完成。**
新稳定入口与预览 worker 均 active/enabled，旧服务 inactive/disabled；备份与部署成功标记已生成。
两页面返回预期 releaseId，未登录业务接口均为 401。启动入口软链接问题已通过相对脚本路径修复。
本机检查原 Tailscale HTTPS 地址时 TLS 握手失败，Serve 配置仍指向正常的 31415；用户侧访问待确认。
以下保留上线准备与回退依据，不代表仍需再次审批。
本次以这份机器实测清单为准；通用 runbook 的旧工作树回退命令不能直接视为固定版本回退。

## 1. 用户将得到什么

继续使用原私有网站：
`https://vm-0-2-opencloudos.tail41ae13.ts.net/`。
默认稳定版；页面可进入预览版，体验模拟委派、追问、回答与结果回传。
预览不调用真实模型或 Coding CLI，不读取稳定业务数据。

## 2. 当前机器事实

只读核实时间：2026-10-20 16:40（北京时间）。

| 项目 | 实测 |
| --- | --- |
| 旧系统服务 | `agents-master-web.service`，enabled / active |
| 启动时间 | 2026-10-15 13:35:30 CST |
| 启动目录 | `/home/vinci/projects/agents-master`，可变工作树 |
| 监听 | `127.0.0.1:31415`；Tailscale HTTPS 443 转发至该地址 |
| 稳定数据 | `/home/vinci/.local/share/agents-master/main-chat`，0700 |
| 登录 | 已配置；未读取密码或会话 token |
| 未完成用户消息 | 只读聚合查询时 pending / claimed 均为 0；切换前必须复查 |
| 新服务 / 预览数据 / release 根 | 均尚未安装或创建 |
| 模型私有凭据文件 | `/home/vinci/.config/agents-master/env` 尚不存在 |
| 管理权限 | 仅 `systemctl restart agents-master-web` 有免密 sudo；安装和切换新服务需用户在终端执行管理员操作 |

新旧入口使用同一端口、同一稳定数据与认证文件，不能同时启动。
本次不改 Tailscale 配置、不开放公网、不迁移数据库 schema。

## 3. 已准备的确切版本

候选 releaseId：**`web-preview-20261020-cd428eab5ccd`**（两通道同 ID，目录和依赖独立）。

| 产物 | 标识 |
| --- | --- |
| 候选源代码基线 | 项目 HEAD `86d607208e1572b65017cc5e7f056b6e16c94dc9` + 已验收工作树修改 |
| 候选打包快照提交 | `503db7a7c4646d0f3740a7dbbb75055362fb861d` |
| 候选源清单 SHA-256 | `cd428eab5ccd956653274687fe81642e5ae75d5c76eeb02e3de4d81db79779c8` |
| 固定回退 releaseId | `rollback-e792482` |
| 回退来源 | 版本切换加入前的 `e79248244ff0bc2a63976da829dbf84f440f6196` |
| 回退打包快照提交 | `e87217635cfdf0bcf040efed9ed62a18b1b1f239` |

快照提交只存在于独立打包目录，**项目原分支和 index 未提交或改变**。
候选只包含批准的 97 个运行源码/配置文件；回退包含对应旧版本的 89 个文件。
不把 `.env`、聊天、会话记录、历史交接原文或 `.agent-artifacts` 放入 release。
实际部署配置沿用当前无密钥的 config.toml；凭据届时由外部私有文件提供。

所有准备产物位于：
`.agent-artifacts/web-deployment-prep-2026-10-20/`。
其中 `staging/releases/` 已有两份候选和一份回退包，三份均完整安装依赖，
清单/逐文件哈希校验通过；移到另一个目录后实际启动成功。
**只复制具体版本目录，不能复制 staging 的 current 链接**：最后构建回退包会让 staging 的
main-web/current 指向回退，这是暂存构建副作用，不是上线目标。

固定回退验证：候选在合成数据上登录并完成本地假模型回复，停止后由回退版本打开同一数据，
原 cookie、历史保留，继续回复成功。存储与认证实现与候选相同。
现网启动于旧改动提交前，无法证明该回退提交与当时加载的未提交文件逐字一致；
这里批准的是已固定、已验证的回退版本，不宣称恢复内存中的精确旧代码。

## 4. 本次申请批准的动作

1. 将已验收改动、部署模板和复核/上线文档做一次**本地提交**，不 push。
   确切文件及哈希见准备目录的 `proposed-main-commit-files.json`、`proposed-main-commit.sha256`。
   提交前再次比对；新增不相关改动不顺带提交。记录正式项目提交与上述打包快照的对应关系。
2. 把三份已验证产物安装到下表目录，并明确建立候选 current。
3. 从工作树 `.env` 中只提取 `DEEPSEEK_API_KEY`，写入 0600 私有凭据文件。
   不打印值，不复制其他变量，不把凭据放入 git、报告或发布包。
4. 安装两个新系统服务；先运行独立预览 worker，再在维护窗口切换稳定入口。
5. 停写后备份稳定数据与旧服务配置；验证预览关闭的稳定入口，再启用预览。
6. 如果验收失败，按第 7 节关闭预览或切换到固定回退产物；保留所有业务数据。

| 用途 | 确切目标 |
| --- | --- |
| 稳定候选 | `/home/vinci/.local/share/agents-master/releases/main-web/web-preview-20261020-cd428eab5ccd` |
| 预览候选 | `/home/vinci/.local/share/agents-master/releases/preview-worker/web-preview-20261020-cd428eab5ccd` |
| 固定回退 | `/home/vinci/.local/share/agents-master/releases/main-web/rollback-e792482` |
| 稳定 current | `/home/vinci/.local/share/agents-master/releases/main-web/current` → 稳定候选绝对路径 |
| 预览 current | `/home/vinci/.local/share/agents-master/releases/preview-worker/current` → 预览候选绝对路径 |
| 稳定数据 | `/home/vinci/.local/share/agents-master/main-chat`，保持原目录 |
| 预览数据 | `/home/vinci/.local/share/agents-master/main-chat-preview`，新建私有目录 |
| socket | `/home/vinci/.local/share/agents-master/run/preview.sock`，目录 0700 / socket 0600 |
| 凭据 | `/home/vinci/.config/agents-master/env`，0600 |
| 本次备份 | `/home/vinci/backups/agents-master/20261020-web-preview-cd428eab5ccd/`，0700 |

如目标版本、备份目录或新 unit/drop-in 已存在，先核实来源，不能覆盖未知状态。

## 5. 操作顺序与中断

**预留 5 分钟维护窗口；正常估计两次短中断，合计约 1–3 分钟。**
这是预算，不是零停机承诺；服务停止超时配置为 60 秒，异常时转回退。
所有下载、安装、产物比对在维护窗口之前完成。

### A. 窗口前：不停止旧服务

- 核实候选源清单、整包文件摘要、工作树提交范围和当前机器状态仍一致。
- 安装三个具体版本目录，重新校验完整内容；用绝对路径建立候选 current。
- 以 vinci 身份运行准备目录的 `prepare-private-env.mjs`，只创建尚不存在的私有凭据文件。
  若已存在，不覆盖，改为只核实其用途和权限。
- 安装准备目录 `units/` 中的两个新 service 到 `/etc/systemd/system/`，
  **此时不安装 preview.conf**；执行 `daemon-reload`。
- 启动预览 worker 并检查私有 socket `/healthz` 的 releaseId 和模拟能力。
  此阶段旧网站一直运行，worker 没有浏览器可绕过的 TCP 入口。

管理员命令范围：

```sh
sudo install -m 0644 .agent-artifacts/web-deployment-prep-2026-10-20/units/agents-master-web-release.service /etc/systemd/system/
sudo install -m 0644 .agent-artifacts/web-deployment-prep-2026-10-20/units/agents-master-preview-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agents-master-preview-worker.service
```

### B. 第一次短中断：停止、备份、切换

1. 告知用户暂不发消息；确认没有 pending / claimed 用户消息。若有，等待完成或另行处理，
   不通过重启意外重放模型请求。
2. `sudo systemctl stop agents-master-web.service`；确认服务停止、31415 释放。
3. 新建上述唯一备份目录，完整复制稳定数据目录（包含 SQLite 及可能存在的 WAL/SHM）、
   旧 unit 和新私有凭据文件。全部留在私有备份目录，不输出内容。
   生成备份文件校验清单；检查备份数据库完整性与权限，确认复制成功后才能继续。
4. 执行：

   ```sh
   sudo systemctl disable agents-master-web.service
   sudo systemctl enable --now agents-master-web-release.service
   ```

5. 核实稳定入口、31415 和公开认证状态正常，预览关闭时 `/preview/` 返回 404。
   用户用原浏览器确认原登录和历史仍在；无需向 Agent 提供密码、cookie 或历史内容。
   任一关键检查失败，直接按第 7 节回退，不继续启用预览。

### C. 第二次短中断：打开预览

```sh
sudo install -d /etc/systemd/system/agents-master-web-release.service.d
sudo install -m 0644 .agent-artifacts/web-deployment-prep-2026-10-20/units/preview.conf /etc/systemd/system/agents-master-web-release.service.d/preview.conf
sudo systemctl daemon-reload
sudo systemctl restart agents-master-web-release.service
```

核实同站切换、实际 releaseId、模拟任务→待答→回答→完成，完成后记录服务、版本、
备份和验收时间。首次真实聊天检查由用户在原浏览器发送一条测试消息，
按现有稳定配置调用 DeepSeek；预览检查始终只用合成流程。
认证过期、故障和数据隔离的破坏性演练沿用已完成的隔离验收，不在生产上重复全套故障测试。

## 6. 管理员操作怎么完成

现有免密规则不足以安装/启停新 unit。用户需在自己的终端对第 5、7 节所列 sudo 命令完成
管理员认证；不把 sudo 密码发进聊天，也不为本次上线扩大永久 sudoers 权限。
如果尚不能取得这些权限，停在窗口前准备阶段，旧服务继续运行。

## 7. 回退条件与确切动作

**仅预览异常、稳定聊天正常**：将新安装的 preview.conf 移到本次备份目录保存，
`daemon-reload` 后重启 release 入口；确认稳定正常后停止并禁用 worker。预览数据保留。

**稳定启动、登录或历史回归失败**：停止新入口和 worker，将准备好的固定回退 drop-in
安装到旧服务，再启用旧服务。这个 drop-in 把旧服务指向固定产物，不再运行工作树。

```sh
sudo systemctl disable --now agents-master-web-release.service agents-master-preview-worker.service
sudo install -d /etc/systemd/system/agents-master-web.service.d
sudo install -m 0644 .agent-artifacts/web-deployment-prep-2026-10-20/units/rollback.conf /etc/systemd/system/agents-master-web.service.d/rollback.conf
sudo systemctl daemon-reload
sudo systemctl enable --now agents-master-web.service
```

回退继续使用当前稳定数据，正常情况下**不恢复数据库备份**，避免覆盖上线后的新消息。
如确需恢复数据，先停写、另存当前目录，再单独确认恢复范围；不自动删除或覆盖。
也不通过 `git reset` 或清理工作树回退。

## 8. 已完成的准备证据

- 四轮源码验收通过：353/353 测试、typecheck，参见
  [四轮报告](handoff-analysis/web-release-round4-review-2026-10-20.md)。
- 候选两份 / 回退一份均完整安装，源码清单一致；两份候选各 97 成员，回退 89 成员。
- relocation 冒烟通过：实际移动后的依赖可用；合成登录、聊天和固定版本回退保留登录/历史。
- 两个新 service 的 `systemd-analyze verify` 退出 0。
- 准备目录的 `plan.json`、`live-observation.json`、`raw/preparation-result.json`、
  `units.sha256`、`release-trees.json` 记录确切版本、机器事实与产物校验。

尚未本地提交项目修改、写入生产 release/凭据/备份路径、安装服务、重启现网或 push。
