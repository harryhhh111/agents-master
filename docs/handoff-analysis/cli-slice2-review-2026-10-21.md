# 切片 2 独立复核（2026-10-21，Codex）

最新第四轮复核：上轮四个复现均已通过，独立 typecheck、380/380 通过。
仅剩 C2-3b 的一个 P1：父进程先退出时，仍错误地将其 done 视作整个进程组已停止，
忽略 SIGTERM 的普通子进程继续写文件。详见文末；其余定点项关闭，仍未部署。
按用户本轮四条护栏审查，不恢复旧的完整隔离要求。
未修改应用代码或测试、未 commit、未部署、未运行新的真实 CLI 任务。

## 已核实

- 独立 typecheck 通过，29 文件、372/372 全量测试通过。
- 白名单在 store.accept 与执行器二次查验；real+cli 的工具描述包含项目及 backend 取值。
  非破坏限制主要依赖 prompt 与 CLI 默认权限，属于本轮接受的信任水平。
- envExclude 经过三个 backend 传递；runCommand 与 detached 路径使用 extendEnv:false，
  避免 execa 再次合入已排除变量。现有环境排除测试通过。
- 只读核实 sandbox 的 HELLO.md 为 `real cli works`。实现者报告的 27.5 秒真实执行
  本轮未再次付费复跑；浏览器脚本验证的是新入口配合已完成任务的显示，不是迁移/取消/回答分支。

## C2-1 / P1：有任务回执的 v2 库无法迁移

位置：`src/main/schema.ts:220-235`，尤其 DROP TABLE coordination_runs。

用当前已发布 ab42e00 的旧 store 创建正常 v2 库，执行一次合成任务至 waiting_input，
再用新代码 preview-migrate 打开，稳定报 `FOREIGN KEY constraint failed`，备份已经生成。
questions、receipts、outbox 引用 runs；外键开启时直接 DROP 父表无法处理这些真实历史。
现有迁移测试只插了一条聊天消息，没有任务和引用记录，因此全绿未覆盖此场景。

修正迁移的外键/重建顺序，并用包含 run、question、receipt、outbox 的旧库验证迁移后
数据、引用和版本一致；保留备份与失败回滚。无需更换存储架构。

## C2-2 / P1：回答追问后忽略回答并重复执行原任务

位置：`src/agent/cli-domain-executor.ts:85-105,124-146`；
`src/main/coordination/store.ts:273-276` 为现有回答重新排队逻辑。

store 将回答保存在 run.context.answers，但执行器只提取 decision，CLI prompt 与判读
summary 都没有 answers。使用真实 store/scheduler、注入 backend 与判读模型复现：
第一轮 CLI → ask → 用户回答 → 第二轮 CLI，收到的两份 prompt 完全相同，
回答中的唯一标记在第二轮 CLI 和判读输入中都不存在。

这会忽略用户补充，并可能重复修改文件。最小修补应区分“对已有结果继续判读”和
“根据回答继续执行”，传递绑定的问答及前次执行摘要；不能一回答就无条件重跑原目标。
不要求必须实现 CLI session resume，但必须保证回答有效且已完成动作不被盲目重放。

## C2-3 / P1：尚未确认进程退出就返回 stopped/failed

位置：`src/agent/cli-domain-executor.ts:108-120`；
`src/backends/runCommand.ts` 的 cancel 只发送信号。

stop 的 abort 立即赢得 Promise.race 并返回 stopped；超时也发取消后立即返回 failed，
没有等待 handle.done。调度器据此终结 run，释放同项目执行占用。
用实际 execa 启动一个本地 Node 进程，模拟忽略 SIGTERM：execute 已返回 stopped，
进程仍存活，并在 300ms 后写出文件。不是测试 spy 或仅静态推测。

取消/超时需等待实际退出，在有界宽限后处理未退出进程及相关子进程；
确认停止前保留占用，不能让下个同项目任务与残留执行并发。完成后清理计时器/监听。
本轮复现只证明直接子进程的退出确认缺失，不宣称已覆盖全部进程树行为。

## C2-4 / P2：run 未持久化 CLI session 与产物关联

位置：`src/agent/cli-domain-executor.ts:124-151`；
`src/main/coordination/store.ts` 的 Run 与 receipt。

sessionId、artifactStdoutPath 仅放进局部 summary 供判读模型阅读。
scoped state 也只在内存中；最终存储 receipt 只有 kind/body。
独立跑完两次任务后检查 runs：executor=CLI，但注入的唯一 sessionId 和 artifact 路径均不存在。
不能依赖模型在自由文本中自愿转述，尤其取消、超时、判读失败时更无法稳定关联。

在运行记录或关联执行记录中保存 backend、pid/产物路径、退出信息与可用 sessionId，
启动时先绑定产物、结束时补充结果；内部 stderr 路径不必暴露给模型或前端。

## C2-5 / P2：本次也需要更新稳定入口

报告和路线图称只需 worker 单通道，但新 capability 的解析在 main-web-preview.ts，
未登录页面的 real-cli 分支在 main-web.ts，均属于稳定入口代码。

用相同的合成 healthz 响应对比已部署 ab42e00 入口和工作树入口：
旧入口能读到新 previewLabel，却丢弃 execution，capabilities 不含 cli-execution；
新入口则完整透传。旧入口生成的未登录预览页仍走 real-model 文案。
本次需同步部署 main-web 与 worker，或先实现并验证兼容路径。修正发布说明即可，
不需另建发布体系。现有浏览器脚本使用的是工作树新入口，不能证明只换 worker 的组合。

## 证据与范围

`.agent-artifacts/cli-slice2-review-2026-10-21/`：

- `tests.log`：372/372。
- `reproduce.mts`、`reproduced.json`：迁移、回答重放、留痕缺失和真实本地子进程取消复现。
- `entry-compat.mts`、`entry-compat.json`：新旧稳定入口兼容性对比。

以上复现使用临时合成数据、注入模型与本地 Node 子进程，无外部模型调用，
临时数据与子进程已清理；未读取私人聊天、未迁移现网库、未写入真实项目。
返工聚焦上述路径即可，不需要扩大白名单框架或重新审查整个平台。

## 五处返工复核（2026-10-21）

独立 typecheck 与 29 文件、378/378 通过。未修改应用代码和测试、未 commit、未部署。

已关闭：

- C2-1：用已部署旧版本创建的带任务引用 v2 库重新迁移成功，备份存在；新增完整引用链测试通过。
- C2-2：真实 store/scheduler 两轮复现中 prompt 不再相同，用户回答进入 CLI 和判读输入。
  接受本轮以明确续作上下文约束执行的方案，不要求实现 CLI session resume。
- C2-5：报告与路线图已明确本次双通道发布。
- C2-4 的正常完成路径：sessionId 与产物路径已在 runs 中保留；启动路径另有绑定记录。
- 直接子进程的正常退出确认已改善；现有取消测试通过。但下面两个分支仍未覆盖。

### C2-3a / P1：退出未确认仍终结 run、释放同项目占用

位置：`src/agent/cli-domain-executor.ts:193-202`、`src/main/coordination/store.ts:309-318`。

confirmExit 两轮都超时会返回 confirmed:false，但 execute 对 abort 仍返回 stopped，
对超时仍返回 failed；confirmStopped 也不检查 cancelConfirmed，直接改 cancelled。
用不响应两种取消信号的注入 handle 复现：cancelConfirmed=false、run.status=cancelled，
随后成功 claim 同项目第二个任务。故“确认前不释放占用”尚未成立。

最小修补：未确认退出时保持未确认/取消中的占用，不能伪装 cancelled/普通 failed；
即使界面已报告取消超时，也不能启动冲突任务。无需无限阻塞 UI 或新建调度平台。

### C2-3b / P1：只结束 CLI 父进程，实际工作子进程继续运行

位置：`src/agent/cli-domain-executor.ts:104-114` 与 `src/backends/runCommand.ts` 的 cancel。

实际 Node 父进程创建普通子进程（未 detached、未 setsid，仅独立 stdio），
父进程忽略 SIGTERM。升级 SIGKILL 后父进程 done 落定，返回 stopped/cancelConfirmed=true，
但子进程仍存活并在返回后写文件。复现不依赖假 cancel spy 或进程逃逸场景。

应让 CLI 启动进入可管理的进程组/作业范围，取消和超时覆盖其工作子进程并确认停止。
仅等待 launcher 的 done 不足以支撑“已停止执行”和同项目串行。

### C2-4 仍有 P2：CLI 完成后，判读失败会丢失最终执行信息

位置：`src/agent/cli-domain-executor.ts:210-247`。

execution 在 try 内生成，判读调用抛异常/超时后外层 catch 返回的 failed/stopped 不带它。
独立注入“CLI exitCode=0、sessionId 已知，随后判读抛错”：run.context 只有启动时 pid/路径，
run.result 只有失败文案，sessionId、退出码、耗时未落库。

将已拿到的执行信息在判读前持久化，或确保所有后续失败/取消出口携带 execution。
否则 CLI 实际已经完成的工作容易被误认为执行本身失败，且无法稳定定位原会话。

### C2-6 / P2：续作 priorResult 绕过 stderr 路径过滤

位置：`src/agent/cli-domain-executor.ts:154-157,219`。

store.answer 保存的 priorResult 包含完整 execution（含 artifactStderrPath），
续作将它直接 JSON.stringify 给 CLI，并原样放进判读 summary.answers。
独立注入唯一 stderr 路径标记，两个模型输入中均出现；“stderr 路径只进存储”不成立。
这里确认的是路径透传，没有证据表明 stderr 文件内容已被读取或泄露。

将存储用完整记录与模型可见摘要分开，显式选取需要的 body、stdout 路径等字段；
第二轮测试应使用完整 execution 夹具，不能只放 stdout 路径。

证据：`.agent-artifacts/cli-slice2-rework-review-2026-10-21/` 的 `tests.log`、
`previous-cases-rerun.json`、`edge-check.mts`、`edge-result.json`。
旧案例重跑中 writesAfterStopped 字段仅表示后来检查发现文件：该例文件在等待直接进程退出时已写入，
不据此判回归；新的 ordinary-child 复现才证明返回 stopped 后仍发生写入。
复现均用临时合成数据、注入模型和本地 Node 进程；全部清理，未调用真实 CLI 或外部模型。

## 第四轮定点复核（2026-10-21）

独立 typecheck、29 文件 380/380 通过。上轮复现以新的回调名及调度路由重跑：

- cancelConfirmed=false 时 holdUncertainExit 保持 cancel_requested，占用有效，第二个同项目任务无法 claim。
- 判读抛错后 sessionId、退出码等已在 run.context 与 run.result 保留。
- 完整 priorResult 中的 stderr 路径不再进入 CLI 或判读模型输入。
- 父子都忽略 SIGTERM 的上轮案例中，SIGKILL 整组清理成功，返回后无残留写入。

### C2-3b 剩余 P1：父进程先结束时跳过对残留进程组的确认

位置：`src/agent/cli-domain-executor.ts:128-132`。

仅将同一普通子进程复现中的父进程改为正常响应 SIGTERM，子进程仍忽略 SIGTERM，
并使用独立 stdio（无 detached/setsid 逃逸）。父进程收到信号后退出，handle.done 落定，
confirmExit 第 129 行立即返回 confirmed:true，不再升级 SIGKILL 或核对组内成员。
实测 execute 返回 stopped/cancelConfirmed=true 时子进程仍活着，随后继续写文件。

因此“向组发过信号”还不是“已确认整组退出”。此分支会绕过新 holdUncertainExit，
仍可释放项目占用。本轮不新增隔离要求，继续修复原取消语义即可。

最小修补：父进程 done 后仍检查/清理该任务进程组的剩余执行；确认组内工作停止前，
不能标 cancelConfirmed=true。若无法确认，复用 holdUncertainExit 保留占用。
补“父进程正常退出、子进程忽略 SIGTERM”这一例，保留原双忽略案例。

证据：`.agent-artifacts/cli-slice2-round4-review-2026-10-21/` 中 `tests.log`、
`rerun.mts`/`rerun-result.json`、`parent-exits.mts`/`parent-exits-result.json`。
前一组 childAliveAfterStopped=false、writesAfterStopped=false；后一组两者均为 true。
临时进程及目录均已清理，无真实 CLI/外部模型调用、无现网变更、无应用源码修改。
