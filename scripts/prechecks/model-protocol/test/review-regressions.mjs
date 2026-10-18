// Codex independent offline regressions; no credentials, dotenv config, or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLedger } from '../lib/ledger.mjs'
import { runPrecheck } from '../lib/runner.mjs'
import { queueTransport, createScriptedTransport } from '../lib/transport.mjs'
import { defaultOfflineQueue, textResponse, toolCallResponse } from '../lib/offline-script.mjs'
import { BUDGET } from '../lib/combo.mjs'

const base = fileURLToPath(new URL('../../../../.agent-artifacts/prechecks-2026-10-16/model-protocol/', import.meta.url))
fs.mkdirSync(base, { recursive: true })
const evidence = fs.mkdtempSync(path.join(base, 'codex-regressions-'))
console.log(`New review evidence: ${evidence}`)
const root = name => fs.mkdtempSync(path.join(evidence, `${name}-`))
const cli = fileURLToPath(new URL('../run.mjs', import.meta.url))
const ledgerModule = new URL('../lib/ledger.mjs', import.meta.url).href
const readRows = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const readTranscript = summary => readRows(path.join(summary.runDir, 'transcript.jsonl'))
function child(code) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    proc.stdout.on('data', data => { output += data })
    proc.stderr.on('data', data => { output += data })
    proc.on('error', reject)
    proc.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)))
  })
}
async function runCLI(args, outputRoot, appendOutput = true) {
  const result = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, ...args, ...(appendOutput ? ['--out', outputRoot] : [])], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', data => { stdout += data })
    proc.stderr.on('data', data => { stderr += data })
    proc.on('error', reject)
    proc.on('close', status => resolve({ status, stdout, stderr }))
  })
  fs.writeFileSync(path.join(outputRoot, `cli-${fs.readdirSync(outputRoot).length}.json`), JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr }), { flag: 'wx' })
  assert.ifError(result.error)
  return result
}

test('ledger: separate instances refresh count; malformed/stale locks fail closed', () => {
  const file = path.join(root('ledger-instances'), 'attempts.jsonl')
  const a = createLedger(file, { maxTotalCalls: 1 })
  const b = createLedger(file, { maxTotalCalls: 1 })
  a.reserve({ scenario: 'a' })
  assert.equal(b.attemptsUsed(), 1)
  assert.throws(() => b.reserve({ scenario: 'b' }), /预算/)
  assert.equal(readRows(file).length, 1)
  fs.mkdirSync(`${file}.lock`)
  assert.throws(() => a.reserve({ scenario: 'stale' }), /EEXIST/)
  const corrupt = path.join(root('ledger-corrupt'), 'attempts.jsonl')
  fs.writeFileSync(corrupt, '{"attempt":1}', { flag: 'wx' })
  assert.throws(() => createLedger(corrupt, { maxTotalCalls: 3 }).reserve({ scenario: 'x' }), /Corrupt/)
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{"attempt":1}')
})

test('ledger: four concurrent processes cannot exceed cap or overwrite creation', async () => {
  const file = path.join(root('ledger-processes'), 'attempts.jsonl')
  const code = `import { createLedger } from ${JSON.stringify(ledgerModule)};
    const ledger = createLedger(${JSON.stringify(file)}, { maxTotalCalls: 7 });
    for (let i=0;i<25;i++) { try { ledger.reserve({ scenario: 'worker' }); }
      catch(e) { if(e.code !== 'EEXIST' && e.name !== 'BudgetExceededError') throw e; }
      await new Promise(resolve => setTimeout(resolve, 1)); }
  `
  await Promise.all(Array.from({ length: 4 }, () => child(code)))
  const rows = readRows(file)
  assert.equal(rows.length, 7)
  assert.deepEqual(rows.map(row => row.attempt), [1, 2, 3, 4, 5, 6, 7])
})

test('CLI: first positional arg retained and selected/reordered fixtures match', async () => {
  for (const names of [['s1', 's4'], ['s4', 's1'], ['s5'], ['ping']]) {
    const outputRoot = root('cli-selected')
    const result = await runCLI(names, outputRoot)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const runDir = fs.readdirSync(outputRoot).find(name => name.startsWith('offline-'))
    const rows = readRows(path.join(outputRoot, runDir, 'transcript.jsonl'))
    assert.deepEqual([...new Set(rows.map(row => row.scenario))], names)
    assert.equal(rows.length, names.reduce((n, name) => n + ({ s1: 4, s4: 6, s5: 2, ping: 1 })[name], 0))
  }
})

test('CLI: UNVERIFIED returns nonzero; missing --out and unknown options rejected', async () => {
  const outputRoot = root('cli-budget')
  const result = await runCLI(Array(11).fill('s1'), outputRoot)
  assert.equal(result.status, 1)
  // This host can suppress captured child streams; inspect its durable result.
  const runDir = fs.readdirSync(outputRoot).find(name => name.startsWith('offline-'))
  const summary = JSON.parse(fs.readFileSync(path.join(outputRoot, runDir, 'results.json'), 'utf8'))
  assert.equal(summary.verdict, 'UNVERIFIED')
  assert.equal(summary.ledger.attemptsUsed, 40)
  for (const args of [['--out'], ['--nonsense'], ['constructor']]) {
    const result = await runCLI(args, root('cli-invalid'), false)
    assert.notEqual(result.status, 0)
  }
})

test('CLI: s1 s4 without --out retains args[0] (original parser regression)', async () => {
  const before = new Set(fs.readdirSync(base))
  const result = await runCLI(['s1', 's4'], root('cli-no-out'), false)
  assert.equal(result.status, 0)
  const added = fs.readdirSync(base).filter(name => name.startsWith('offline-') && !before.has(name))
  assert.equal(added.length, 1)
  const runDir = path.join(base, added[0])
  const rows = readRows(path.join(runDir, 'transcript.jsonl'))
  assert.deepEqual([...new Set(rows.map(row => row.scenario))], ['s1', 's4'])
  assert.equal(rows.length, 10)
})

test('offline never consumes a live ledger, including an explicit ledger path', async () => {
  const outputRoot = root('offline-isolation')
  const live = path.join(outputRoot, 'attempts.jsonl')
  const original = '{"attempt":1,"scenario":"historical-live"}\n'
  fs.writeFileSync(live, original, { flag: 'wx' })
  for (const ledgerPath of [undefined, live]) {
    const summary = await runPrecheck({ outputRoot, ledgerPath, scenarioNames: ['ping'], transport: queueTransport([textResponse('pong')]) })
    assert.equal(summary.verdict, 'PASS')
    assert.notEqual(summary.ledger.path, live)
    assert.equal(fs.readFileSync(live, 'utf8'), original)
  }
})

test('remaining wall clock bounds a hung transport and aborts its signal', async () => {
  let received
  const start = performance.now()
  const summary = await runPrecheck({ outputRoot: root('deadline'), runtimeBudgetMs: 40, scenarioNames: ['ping', 's1'], transport: args => { received = args; return new Promise(() => {}) } })
  assert.equal(summary.verdict, 'UNVERIFIED')
  assert.ok(received.timeoutMs > 0 && received.timeoutMs <= 40)
  assert.equal(received.signal.aborted, true)
  assert.ok(performance.now() - start < 1000)
  assert.equal(summary.ledger.attemptsUsed, 1)
  assert.equal(readTranscript(summary)[0].response.usageUnknown, true)
})

test('registered fake secrets redacted from errors, response args, notes and serialized summaries', async () => {
  const secret = 'review_FAKE_literal_456'
  for (const response of [
    { error: { name: secret, type: secret, message: secret, stack: secret, response: { secret }, status: 400 } },
    toolCallResponse('fake-call', 'query_domain_info', { domain: secret }),
  ]) {
    const summary = await runPrecheck({ outputRoot: root('redaction'), apiKey: secret, scenarioNames: ['s4'], transport: createScriptedTransport(() => response) })
    for (const file of ['results.json', 'transcript.jsonl']) {
      const raw = fs.readFileSync(path.join(summary.runDir, file), 'utf8')
      assert.ok(!raw.includes(secret))
      assert.ok(raw.includes('[REDACTED]'))
    }
    assert.ok(!JSON.stringify(summary).includes(secret))
  }
})

test('empty scenarios, empty responses and S3/S4 all-fail never PASS', async () => {
  for (const scenarioNames of [[], ['s3'], ['s4']]) {
    const summary = await runPrecheck({ outputRoot: root('empty-fail'), scenarioNames, transport: createScriptedTransport(() => ({ error: { name: 'APIError', message: 'offline failure', status: 400 } })) })
    assert.equal(summary.verdict, 'UNVERIFIED')
  }
  for (const scenarioNames of [['s3'], ['s4']]) {
    const summary = await runPrecheck({ outputRoot: root('empty-response'), scenarioNames, transport: createScriptedTransport(() => ({})) })
    assert.equal(summary.verdict, 'UNVERIFIED')
  }
})

test('invalid/unknown/wrong-chain calls and duplicate IDs get no successful tool receipt', async () => {
  const calls = [
    toolCallResponse('bad', 'query_domain_info', { domain: 3 }),
    toolCallResponse('bad', 'delete_everything', {}),
    toolCallResponse('bad', 'constructor', {}),
    toolCallResponse('bad', 'cancel_assignment', { assignmentId: 'fake' }),
    toolCallResponse('', 'query_domain_info', { domain: 'work-project' }),
  ]
  const duplicate = toolCallResponse('same', 'query_domain_info', { domain: 'work-project' })
  duplicate.choices[0].message.tool_calls.push(structuredClone(duplicate.choices[0].message.tool_calls[0]))
  calls.push(duplicate)
  for (const response of calls) {
    const summary = await runPrecheck({ outputRoot: root('invalid-tool'), scenarioNames: ['s2a'], transport: queueTransport([response, textResponse('done')]) })
    assert.equal(summary.verdict, 'FAIL')
    assert.equal(readTranscript(summary).length, 1, 'must not submit a follow-up with a successful receipt')
  }
  const summary = await runPrecheck({ outputRoot: root('wrong-chain'), scenarioNames: ['s2b'], transport: queueTransport([toolCallResponse('wrong', 'cancel_assignment', { assignmentId: 'fake' }), textResponse('done')]) })
  assert.equal(summary.verdict, 'FAIL')
  assert.equal(readTranscript(summary).length, 1)
})

test('successful tool rounds pair each exact ID; concurrent same-label runs preserve originals', async () => {
  const outputRoot = root('preservation')
  const run = () => runPrecheck({ outputRoot, label: 'same', scenarioNames: ['s2b'], transport: queueTransport(defaultOfflineQueue(['s2b'])) })
  const first = await run()
  const originals = Object.fromEntries(fs.readdirSync(first.runDir).map(name => [name, fs.readFileSync(path.join(first.runDir, name))]))
  const more = await Promise.all(Array.from({ length: 8 }, run))
  assert.equal(new Set([first, ...more].map(s => s.runDir)).size, 9)
  for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(fs.readFileSync(path.join(first.runDir, name)), bytes)
  for (const row of readTranscript(first)) {
    const messages = row.request.messages
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].tool_calls) {
        for (const [j, call] of messages[i].tool_calls.entries()) {
          assert.equal(messages[i + j + 1].role, 'tool')
          assert.equal(messages[i + j + 1].tool_call_id, call.id)
        }
      }
    }
  }
})

test('failed attempts accumulate across two runs and stop at the shared cap', async () => {
  const outputRoot = root('failed-cumulative')
  const ledgerPath = path.join(outputRoot, 'shared')
  let calls = 0
  const run = () => runPrecheck({ outputRoot, ledgerPath, budget: { ...BUDGET, maxTotalCalls: 1 }, scenarioNames: ['ping'], transport: async () => { calls++; throw new Error('offline failure') } })
  const first = await run()
  const second = await run()
  assert.equal(first.verdict, 'UNVERIFIED')
  assert.equal(second.verdict, 'UNVERIFIED')
  assert.equal(second.ledger.attemptsUsed, 1)
  assert.equal(calls, 1)
})
