// 预检 runner CLI（model-protocol 独立运行器，2026-10-16 重写版）。
//
//   node run.mjs                 # 离线全量：scripted 合成剧本，零网络、零凭据
//   node run.mjs s1 s4           # 离线部分场景
//   node run.mjs --live          # 显式 opt-in 真实探测（读 .env 的 key 入内存，真实调用）
//   node run.mjs --live s5       # live 单场景
//   node run.mjs --out <dir>     # 覆盖产物根目录（默认仓库 .agent-artifacts/prechecks-2026-10-16/model-protocol）
//
// 默认（不带 --live）绝不触网、绝不读 .env。live 模式为唯一真实调用入口，
// 端点白名单只允许配置过的 COMBO.baseUrl。
import path from 'node:path'
import dotenv from 'dotenv'
import { COMBO, BUDGET, DEFAULT_RUNTIME_BUDGET_MS } from './lib/combo.mjs'
import { queueTransport, createLiveTransport } from './lib/transport.mjs'
import { createRedactor } from './lib/redact.mjs'
import { defaultOfflineQueue } from './lib/offline-script.mjs'
import { runPrecheck } from './lib/runner.mjs'
import { SCENARIOS } from './lib/scenarios.mjs'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..')
const DEFAULT_OUTPUT_ROOT = path.join(REPO_ROOT, '.agent-artifacts', 'prechecks-2026-10-16', 'model-protocol')

async function main() {
  const args = process.argv.slice(2)
  let live = false
  let outputRoot = DEFAULT_OUTPUT_ROOT
  const names = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--live') live = true
    else if (arg === '--out') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--out requires a directory')
      outputRoot = path.resolve(args[++i])
    } else if (arg.startsWith('--')) throw new Error('Unknown option')
    else names.push(arg)
  }
  const scenarioNames = names.length === 0 || names.includes('all') ? Object.keys(SCENARIOS) : names
  for (const name of scenarioNames) {
    if (!Object.hasOwn(SCENARIOS, name)) {
      console.error(`未知场景: ${createRedactor().redactText(name)}（可选: ${Object.keys(SCENARIOS).join('|')}）`)
      process.exit(2)
    }
  }

  let mode = 'offline'
  let apiKey = null
  let transport
  if (live) {
    mode = 'live'
    dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true })
    apiKey = process.env[COMBO.apiKeyEnv] ?? null
    transport = apiKey
      ? createLiveTransport({ combo: COMBO, apiKey, redactor: createRedactor() })
      : async () => ({ error: { name: 'BlockedError', message: 'unreachable: runner 会先记录 BLOCKED' } })
  } else {
    transport = queueTransport(defaultOfflineQueue(scenarioNames))
  }

  const summary = await runPrecheck({
    outputRoot,
    mode,
    apiKey,
    transport,
    scenarioNames,
    combo: COMBO,
    budget: BUDGET,
    runtimeBudgetMs: DEFAULT_RUNTIME_BUDGET_MS,
    label: live ? 'live' : 'offline',
  })

  console.log(`\n=== 自动判定汇总（runner 输出，人工解释见 REPORT.md）===`)
  console.log(`runDir: ${summary.runDir}`)
  console.log(`总体: ${summary.verdict}${summary.reason ? ` — ${summary.reason}` : ''}`)
  for (const r of summary.scenarioResults ?? []) {
    console.log(`  ${r.scenario}: ${r.verdict}${r.reason ? ` (${r.reason})` : ''} [attempts=${r.attempts ?? 0}]`)
    for (const note of r.notes ?? []) console.log(`    - ${note}`)
  }
  if (summary.ledger) {
    console.log(`ledger: ${summary.ledger.attemptsUsed}/${summary.ledger.attemptsUsed + summary.ledger.attemptsRemaining} 次尝试已用（含失败），剩余 ${summary.ledger.attemptsRemaining}`)
  }
  process.exitCode = summary.verdict === 'PASS' ? 0 : 1
  return summary
}

main().catch(error => {
  console.error(`runner 失败: ${createRedactor().redactText(String(error.message ?? 'unknown error'))}`)
  process.exit(1)
})
