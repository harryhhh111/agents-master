# model-protocol 预检 runner（2026-10-16 重写版）

独立、可复用的模型工具协议预检运行器，替代
`.agent-artifacts/prechecks-2026-10-15/model-protocol/probes/` 的旧探针。
保留旧探针的合成工具 schema、场景输入与"被测组合"抄录形状；修复
`REVIEW-by-codex.md` 列出的判定与预算缺陷。

## 命令

```bash
# 离线全量（默认）：scripted 合成剧本，零网络、零凭据、零 .env 读取
node scripts/prechecks/model-protocol/run.mjs
node scripts/prechecks/model-protocol/run.mjs s1 s4        # 部分场景

# live（唯一真实调用入口，显式 opt-in）
node scripts/prechecks/model-protocol/run.mjs --live       # 经 dotenv 读 .env 的 key 入内存

# 离线测试（零网络）
node --test scripts/prechecks/model-protocol/test/offline-tests.mjs
node --test --experimental-test-isolation=none scripts/prechecks/model-protocol/test/*.mjs
```

产物：每次运行在建库根目录（默认仓库
`.agent-artifacts/prechecks-2026-10-16/model-protocol/`）下新建唯一 run 目录
（`<label>-<ISO时间>-<pid>-<随机后缀>`，原子创建），内含 `transcript.jsonl` 与
`results.json`；**绝不删除或覆盖既有证据文件**。live 共享账本 `attempts.jsonl`
跨场景、跨 run 累计 API 尝试。offline 默认在 run 目录写 `offline-attempts.jsonl`；
库调用显式传入 ledgerPath 时使用 `<ledgerPath>.offline`，不消耗 live 账本。
CLI 按指定场景顺序选择剧本；只有 PASS 返回退出码 0。

## 预算与限制（默认）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| API 尝试总数 | 40 | 在传输层调用前于 ledger 预留；**失败尝试同样计数** |
| 每次 max_tokens | 2048 | 超出即拒绝 |
| 同一请求异常重试 | 2 | runner 层；超时与 4xx 不重试；SDK maxRetries=0 |
| 单次运行墙钟 | 600s | 超出后剩余场景记 UNVERIFIED（reason=runtime-budget-exceeded） |

## 安全性质

- 默认离线模式不触网、不读 `.env`、不需要凭据。
- live 模式为显式 opt-in；端点白名单只允许 `COMBO.baseUrl`
  （`https://api.deepseek.com`），拒绝连接任意其他端点。
- 出站前扫描 payload，发现疑似秘密（Bearer/Authorization/sk-…/api_key）即拒绝发送。
- API key 仅驻留内存并注册进 redactor；错误消息经脱敏后才落盘；
  **绝不写入 headers**。
- 失败调用的 `usage` 记为 `null` + `usageUnknown: true`（服务端消耗未知，不按零计），
  `latencyMs` 成功/失败都记录。
- 工具回执为固定合成 JSON，无副作用、无网络、不执行真实操作。

## 判定语义（verdict ∈ {PASS, FAIL, UNVERIFIED, BLOCKED}）

- 请求失败/预算耗尽导致证据不足 → **UNVERIFIED**（绝不把"未观察到"当"通过"）。
- 缺凭据（live 且无 key）→ **BLOCKED**，零传输层调用，写出 BLOCKED 报告。
- S2a 不再要求 ≥2 轮：≥1 轮工具 + 配对合法 + 非空最终文本即 PASS（澄清式收尾是合法行为）。
- S2b 断言实际工具链 == `query_domain_info>delegate_work`；模型改为澄清时自动判 FAIL，
  notes 标注"真实行为，供人工解释"。
- S3 为观察性场景：全部调用完成即 PASS，行为分类写入 notes；任一失败 → UNVERIFIED。
- S4 任一请求失败 → UNVERIFIED；0 触发 PASS；有触发 FAIL 并记录参数。
- S5 断言恢复后的工具名必须是 `delegate_work` 且 schemaValid。
- runner 产物只含自动判定（`automated: true`）；人工解释写在 REPORT.md，不混入机器结果。

## 已知限制

- ledger 用独占目录锁保护重新读取、校验和追加；锁冲突直接失败，不自动抢锁。
  崩溃遗留的锁须人工核实；损坏/不完整账本拒绝继续。仅保证同一路径、同一预算、
  同一文件系统的协作进程；不防外部篡改或另建账本规避预算。
- 单次 timeout 取请求限制、组合限制和剩余墙钟的最小值；probe 超时返回并 abort，
  live SDK 接收同一 signal。同步阻塞代码与忽略 signal 的自定义 transport 不受强制终止保证。
- scripted 剧本只模拟协议形状，不模拟 provider 内部机制（如参数强转），
  S3 的机制归因仍需 live 证据或人工解释。
- live 模式的 BLOCKED/白名单行为有单元级测试；端到端 `--live` 需在有凭据环境下复验。
