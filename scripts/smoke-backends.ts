// M2 冒烟：真实驱动 kimi / codex 各两轮（新 session → resume），只读 prompt。
// 用法: tsx scripts/smoke-backends.ts
import 'dotenv/config'
import { KimiBackend } from '../src/backends/KimiBackend.js'
import { CodexBackend } from '../src/backends/CodexBackend.js'

const cwd = '/home/vinci/projects/stock_data'
const prompt1 = '不要做任何修改，只回复：当前 git 分支名和一个字"好"。'
const prompt2 = '还是什么都不要改，回复你上一轮回复的第一个词。'

async function smokeKimi() {
  console.log('=== KIMI ===')
  const b = new KimiBackend()
  const r1 = await b.run(prompt1, { cwd, timeoutMs: 300_000 })
  console.log('exit:', r1.exitCode, '| session:', r1.sessionId, '| warnings:', r1.warnings)
  console.log('reply1:', r1.stdout.slice(0, 300))
  if (!r1.sessionId) throw new Error('kimi session id 提取失败')
  const r2 = await b.run(prompt2, { cwd, sessionId: r1.sessionId, timeoutMs: 300_000 })
  console.log('resume exit:', r2.exitCode, '| session:', r2.sessionId, '| warnings:', r2.warnings)
  console.log('reply2:', r2.stdout.slice(0, 300))
}

async function smokeCodex() {
  console.log('=== CODEX ===')
  const b = new CodexBackend({ sandboxMode: 'read-only' })
  const r1 = await b.run(prompt1, { cwd, timeoutMs: 300_000 })
  console.log('exit:', r1.exitCode, '| session:', r1.sessionId, '| warnings:', r1.warnings)
  console.log('reply1:', r1.stdout.slice(0, 300))
  if (!r1.sessionId) throw new Error('codex session id 提取失败')
  const r2 = await b.run(prompt2, { cwd, sessionId: r1.sessionId, timeoutMs: 300_000 })
  console.log('resume exit:', r2.exitCode, '| session:', r2.sessionId, '| warnings:', r2.warnings)
  console.log('reply2:', r2.stdout.slice(0, 300))
}

const which = process.argv[2] ?? 'both'
if (which === 'kimi' || which === 'both') await smokeKimi()
if (which === 'codex' || which === 'both') await smokeCodex()
