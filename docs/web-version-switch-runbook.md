# 稳定版 / 预览版：步骤 C 部署运行手册

> 日期：2026-10-19。状态：部署构件已准备，**尚未安装、未重启现网、未迁移数据**。
> 本手册只描述待用户批准的上线步骤；执行前必须单独确认服务、路径、备份、预计中断和回退方案。
>
> 2026-10-20：本机具体操作以 [上线审批清单](web-deployment-approval-2026-10-20.md) 为准。
> 已核实旧服务指向可变工作树；第 6 节直接重启旧服务不能保证恢复旧版本。
> 本次准备了已验证的固定回退产物和专用 drop-in，批准后按具体清单执行。

## 1. 本轮交付边界

- 稳定版继续使用原私有网站、原登录和原数据目录。
- 预览版是独立 worker，只运行明确标注的合成协调演示；不加载 `.env`，不调用真实模型或 CLI，
  不读取生产聊天、生产 owner context 或真实项目。
- 首次上线不改生产 schema、不合并预览数据、不开放公网端口，既有 Tailscale 转发保持原状。
- 稳定入口和预览 worker 分别使用独立 release 目录与依赖目录；更新预览不顺手更新稳定入口。

## 2. 部署构件

- `scripts/package-web-release.ts`：从干净 Git 提交生成不可变 release，并把对应通道的 `current`
  链接原子切换到新版本。解包后主动扫描并拒绝 `.env`、`.agent-artifacts`、`state/`、私钥等敏感
  路径，生成逐文件哈希清单 `source-manifest.sha256`。
- `deploy/agents-master-web-release.service`：稳定入口 release 服务；默认不启用预览。模型凭据经
  `DOTENV_CONFIG_PATH=/home/vinci/.config/agents-master/env` 私有文件供给，不读工作树 `.env`。
- `deploy/agents-master-web-release.service.d/preview.conf`：可选预览开关；安装后给稳定入口增加
  `--preview-socket`，并声明 worker 依赖。
- `deploy/agents-master-preview-worker.service`：预览 worker（真实模型 + 受限合成工具，无真实 CLI/文件
  执行）；固定 Unix socket，无 TCP 旁路，`env -i` 强制最小环境允许列表（仅 HOME/PATH/
  `DOTENV_CONFIG_PATH`），不继承启动前环境。模型凭据与稳定入口共用
  `/home/vinci/.config/agents-master/env` 私有文件，以 `--model real` 启动；缺凭据时 worker
  启动直接失败，不降级合成。若需回到 `--model demo` 合成演示，应同时把
  `DOTENV_CONFIG_PATH=/dev/null` 恢复为无凭据运行。

现有 `deploy/agents-master-web.service` 是当前旧工作树服务模板，本轮保持不动，便于回退。

## 3. 固定路径

| 用途 | 路径 |
| --- | --- |
| 稳定数据 | `/home/vinci/.local/share/agents-master/main-chat` |
| 预览数据 | `/home/vinci/.local/share/agents-master/main-chat-preview` |
| 私有 socket | `/home/vinci/.local/share/agents-master/run/preview.sock` |
| 稳定 release | `/home/vinci/.local/share/agents-master/releases/main-web/current` |
| 预览 release | `/home/vinci/.local/share/agents-master/releases/preview-worker/current` |
| 备份建议 | `/home/vinci/backups/agents-master/<UTC 时间>/` |

release 根目录必须位于 Git 工作树外。`.env`、会话、`.agent-artifacts`、`state/` 和个人数据不会进入
`git archive` 生成的 release，打包器还会在解包后主动扫描、发现敏感路径即失败并清理；每次 release
生成 `source-manifest.sha256` 与 `release.json`（含 `sourceFileCount`、`sourceManifestSha256`），
用于和批准的冻结源码清单比对。每次上线前仍应人工检查发布目录。

## 4. 构建 release

前置条件：待发布代码已提交，工作树干净；本手册中的命令届时才执行。

```sh
cd /home/vinci/projects/agents-master
git status --short --branch

node --import tsx scripts/package-web-release.ts \
  --channel main-web \
  --release-root /home/vinci/.local/share/agents-master/releases

node --import tsx scripts/package-web-release.ts \
  --channel preview-worker \
  --release-root /home/vinci/.local/share/agents-master/releases
```

每条命令输出 `destination`、`current`、`releaseId` 和 `sourceCommit`。记录这些值；`release.json`
也会在发布目录内保存同样信息。`--dry-run` 只显示计划，`--skip-install` 只允许用于诊断，不能用于上线。

## 5. 待批准的上线顺序

以下命令是部署清单，不是本轮已执行操作。示例使用 systemd 系统服务，按本机权限加 `sudo`。

### 5.1 备份与冻结基线

1. 记录当前服务、端口、进程、启动命令和 Tailscale 状态。
2. 在一个已批准的短暂停写窗口内备份稳定数据：

```sh
sudo systemctl stop agents-master-web.service
install -d -m 700 /home/vinci/backups/agents-master/$(date -u +%Y%m%dT%H%M%SZ)
cp -a /home/vinci/.local/share/agents-master/main-chat \
  /home/vinci/backups/agents-master/<本次目录>/
sudo systemctl start agents-master-web.service
```

备份不得进入 git、日志或模型 prompt。恢复时必须使用同一版本兼容的数据库备份，不能靠删除预览数据回退。

### 5.2 安装基础服务，预览保持关闭

先准备稳定版的私有凭据文件（一次性；0600、位于 Git 仓库与发布目录之外）：

```sh
install -d -m 700 /home/vinci/.config/agents-master
# 写入 DEEPSEEK_API_KEY=...（从现有 .env 复制该键；此文件不进 git、不进模型 prompt）
$EDITOR /home/vinci/.config/agents-master/env
chmod 600 /home/vinci/.config/agents-master/env
```

新稳定服务经 `DOTENV_CONFIG_PATH` 只从该文件读取模型凭据；旧服务仍读工作树 `.env`，两套供给
互不影响。缺少该文件时新服务会因缺 key 启动失败，因此必须在切换服务前完成本步。

```sh
sudo install -m 0644 deploy/agents-master-web-release.service /etc/systemd/system/
sudo install -m 0644 deploy/agents-master-preview-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
install -d -m 700 /home/vinci/.local/share/agents-master/run
```

先启动并验证 worker：

```sh
sudo systemctl enable --now agents-master-preview-worker.service
curl --unix-socket /home/vinci/.local/share/agents-master/run/preview.sock \
  http://localhost/healthz
```

预期返回合成 worker 健康 JSON。socket 所在目录为 `0700`，socket 为 `0600`。

再切换稳定入口到 release 版本；此时**尚未安装 preview.conf，预览仍关闭**：

```sh
sudo systemctl disable --now agents-master-web.service
sudo systemctl enable --now agents-master-web-release.service
```

先验证旧入口回归：原登录仍可用、稳定聊天/历史/设置正常、`/preview/` 返回 404。

### 5.3 启用预览并验收

```sh
sudo install -d /etc/systemd/system/agents-master-web-release.service.d
sudo install -m 0644 deploy/agents-master-web-release.service.d/preview.conf \
  /etc/systemd/system/agents-master-web-release.service.d/
sudo systemctl daemon-reload
sudo systemctl restart agents-master-web-release.service
```

浏览器验收至少包括：

1. 原地址默认仍是稳定版，顶部出现「稳定版 / 预览版 · 模拟演示」。
2. 一次登录可进入 `/preview/`，刷新仍停留预览，不需要第二个密码。
3. 预览页持续显示“模拟 / 联调 · 无真实项目执行”。
4. 稳定版和预览版各写一条合成标记；历史、owner context、问题与任务互不出现。
5. 预览中发起合成任务，切回稳定版聊天，再返回预览可看到状态并回答问题。
6. 未提交草稿切换有确认；提交未确认时不会跨版本补发。
7. 停止 worker 后稳定版仍可用，预览显示可返回的 503；重启 worker 后预览历史保留。
8. 退出登录后两通道 SSE 关闭，后续 API 返回 401。
9. `/api/versions` 只返回通道状态、能力和 releaseId，不包含私有路径、cookie、环境变量或用户内容。

## 6. 回退

### 只关闭预览

```sh
sudo rm /etc/systemd/system/agents-master-web-release.service.d/preview.conf
sudo systemctl daemon-reload
sudo systemctl restart agents-master-web-release.service
```

关闭后访问 `/preview/` 会由稳定入口返回带「返回稳定版」链接的 404 页面，稳定版不受影响。
保留预览数据；worker 可稍后有界停止，不删除其数据库。

### 回退到旧服务

```sh
sudo systemctl disable --now agents-master-web-release.service agents-master-preview-worker.service
sudo systemctl enable --now agents-master-web.service
```

旧服务仍指向原工作树和原稳定数据目录。回退不会撤销预览中已发生的合成数据；将来合并或转正必须另行设计和授权。

## 7. 后续更新

- **真实模型切换（切片 1）必须双通道同步上线**：预览能力标识（`previewLabel`、`synthetic`）
  由 worker healthz 上报，但稳定入口只有在运行包含标识注入的新代码时才会读取并展示它。
  只换 worker 不换入口，旧入口会把真实模型继续标成「模拟演示」。因此本次切换必须同时
  重新打包 `main-web` 与 `preview-worker` 两个 release，并先重启 worker、再重启入口。
- 只更新预览（后续小版本，入口代码已含标识注入后）：重新执行
  `package-web-release.ts --channel preview-worker`，确认新 `current`，
  然后只重启 `agents-master-preview-worker.service`；稳定入口 releaseId、依赖和数据必须不变。
- 更新稳定入口：重新打包 `main-web` 并重启 `agents-master-web-release.service`；预览 worker 不随之更新。
- 禁止通过直接编辑 release 目录修 bug。修复必须回到源码、提交、重新打包。
- 查看日志：

```sh
journalctl -u agents-master-web-release.service -n 100 --no-pager
journalctl -u agents-master-preview-worker.service -n 100 --no-pager
```

## 8. 部署申请必须附带的信息

- 两个通道的 `releaseId`、`sourceCommit`、发布目录和依赖安装结果。
- `source-manifest.sha256` 与批准的冻结源码清单的比对结果。
- 备份路径、预计中断时间、确切 service 启停顺序。
- 全量测试、typecheck、HTTP 集成、真实 Chromium 步骤和独立复核结论。
- 未覆盖项：真实模型/CLI、生产数据迁移、预览转正、通用多版本平台和高可用。
