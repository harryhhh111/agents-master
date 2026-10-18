// 共享 API 尝试账本：append-only JSONL，跨场景、跨 run 在同一 outputRoot 下累计。
// 预留（reserve）发生在 SDK 调用之前，失败尝试同样占额度——这是 2026-10-15 复核
// 发现 1 的修复（旧实现每场景重置计数，所谓总预算实为单场景上限）。
import fs from 'node:fs'
import path from 'node:path'

export class BudgetExceededError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export function createLedger(filePath, { maxTotalCalls }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (!Number.isSafeInteger(maxTotalCalls) || maxTotalCalls < 0) throw new Error('Invalid call budget')
  const readCount = () => {
    let raw
    try { raw = fs.readFileSync(filePath, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return 0
      throw error
    }
    if (raw && !raw.endsWith('\n')) throw new Error('Corrupt ledger: incomplete reservation')
    const rows = raw.split('\n').filter(Boolean).map(JSON.parse)
    if (rows.some((row, i) => row.attempt !== i + 1)) throw new Error('Corrupt ledger: sequence')
    return rows.length
  }
  return {
    path: filePath,
    attemptsUsed: readCount,
    attemptsRemaining: () => Math.max(0, maxTotalCalls - readCount()),
    reserve({ scenario, note }) {
      const lock = `${filePath}.lock`
      // Exclusive, fail closed; a crash leaves a stale lock for manual inspection.
      fs.mkdirSync(lock)
      try {
        const count = readCount()
        if (count + 1 > maxTotalCalls) {
          throw new BudgetExceededError(
            `API 尝试预算已耗尽：ledger ${count}/${maxTotalCalls}（${filePath}）；场景 ${scenario} 不再发起调用`,
          )
        }
        fs.appendFileSync(filePath, JSON.stringify({ attempt: count + 1, ts: new Date().toISOString(), scenario, note: note ?? null }) + '\n', { flag: 'a', flush: true })
        return count + 1
      } finally { fs.rmdirSync(lock) }
    },
  }
}
