// Runner：每次 runPrecheck 在 outputRoot 下新建唯一 run 目录（不删除、不覆盖任何
// 既有文件），写入 transcript.jsonl / results.json；共享 ledger 跨 run 累计尝试。
// live 模式缺凭据 → 写 BLOCKED 报告并返回，零传输层调用。
import fs from 'node:fs'
import path from 'node:path'
import { COMBO, BUDGET, DEFAULT_RUNTIME_BUDGET_MS } from './combo.mjs'
import { createLedger, BudgetExceededError } from './ledger.mjs'
import { createRedactor } from './redact.mjs'
import { createProbe, RuntimeBudgetExceededError } from './probe.mjs'
import { SCENARIOS } from './scenarios.mjs'

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function makeUniqueDir(outputRoot, label) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const base = `${label}-${timestamp()}-${process.pid}`.replace(/[^A-Za-z0-9._-]+/g, '_')
  return fs.mkdtempSync(path.join(outputRoot, `${base}-`))
}

function overallVerdict(results) {
  if (results.some(r => r.verdict === 'FAIL')) return 'FAIL'
  if (results.some(r => r.verdict === 'BLOCKED')) return 'BLOCKED'
  if (!results.length || results.some(r => r.verdict !== 'PASS')) return 'UNVERIFIED'
  return 'PASS'
}

export async function runPrecheck({
  outputRoot,
  ledgerPath,
  mode = 'offline',
  apiKey = null,
  transport,
  scenarioNames = Object.keys(SCENARIOS),
  combo = COMBO,
  budget = BUDGET,
  runtimeBudgetMs = DEFAULT_RUNTIME_BUDGET_MS,
  label = 'run',
}) {
  if (typeof transport !== 'function') throw new Error('runPrecheck 需要注入 transport（scripted 或 live）')
  if (!['live', 'offline'].includes(mode)) throw new Error('Invalid mode')
  if (!Number.isFinite(runtimeBudgetMs) || runtimeBudgetMs <= 0) throw new Error('Invalid runtime budget')
  const runDir = makeUniqueDir(outputRoot, label)
  const transcriptPath = path.join(runDir, 'transcript.jsonl')
  fs.writeFileSync(transcriptPath, '', { flag: 'wx' })
  const resultsPath = path.join(runDir, 'results.json')
  const base = {
    runDir,
    mode,
    ranAt: new Date().toISOString(),
    automated: true,
    manualInterpretation: '本文件仅为自动判定；人工解释与归因见 REPORT.md（runner 不产出人工结论）。',
    combo,
    budget: { ...budget, runtimeBudgetMs },
  }

  if (mode === 'live' && !apiKey) {
    const summary = {
      ...base,
      verdict: 'BLOCKED',
      reason: `缺少凭据: 环境变量 ${combo.apiKeyEnv} 为空。按约定记录 BLOCKED；未发起任何模型调用、未读取任何替代 key。`,
      scenarioResults: [],
      attemptsUsed: 0,
      attemptsRemaining: budget.maxTotalCalls,
    }
    fs.writeFileSync(resultsPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
    return summary
  }

  // Offline defaults are per-run; explicit shared offline ledgers have a distinct suffix.
  const effectiveLedger = mode === 'offline'
    ? (ledgerPath ? `${ledgerPath}.offline` : path.join(runDir, 'offline-attempts.jsonl'))
    : (ledgerPath ?? path.join(outputRoot, 'attempts.jsonl'))
  const ledger = createLedger(effectiveLedger, budget)
  const redactor = createRedactor({ extraSecrets: apiKey ? [apiKey] : [] })
  const deadlineMs = Date.now() + runtimeBudgetMs
  const results = []
  for (const name of scenarioNames) {
    const before = ledger.attemptsUsed()
    let result
    try {
      if (Date.now() > deadlineMs) {
        result = { scenario: name, verdict: 'UNVERIFIED', reason: `runtime-budget-exceeded: 超过 ${runtimeBudgetMs}ms 墙钟预算`, notes: [], evidence: [], automated: true }
      } else {
        const probe = createProbe({ scenarioTag: name, transport, ledger, redactor, transcriptPath, combo, budget, deadlineMs })
        if (!Object.hasOwn(SCENARIOS, name)) throw new Error('Unknown scenario')
        result = await SCENARIOS[name](probe)
      }
    } catch (error) {
      const reason = error instanceof BudgetExceededError
        ? `api-attempt-budget-exhausted: ${error.message}`
        : error instanceof RuntimeBudgetExceededError
          ? `runtime-budget-exceeded: ${error.message}`
          : `runner-error: ${redactor.redactText(String(error?.message ?? error))}`
      result = { scenario: name, verdict: 'UNVERIFIED', reason, notes: [], evidence: [], automated: true }
    }
    result.attempts = ledger.attemptsUsed() - before
    results.push(result)
  }

  const summary = {
    ...base,
    verdict: overallVerdict(results),
    ledger: { path: ledger.path, attemptsUsed: ledger.attemptsUsed(), attemptsRemaining: ledger.attemptsRemaining() },
    scenarioResults: results,
  }
  const safeSummary = redactor.redactValue(summary)
  fs.writeFileSync(resultsPath, JSON.stringify(safeSummary, null, 2) + '\n', { flag: 'wx' })
  return safeSummary
}
