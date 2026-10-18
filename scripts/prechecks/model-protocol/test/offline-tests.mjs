// 离线测试：node --test scripts/prechecks/model-protocol/test/offline-tests.mjs
// 零网络、零凭据；通过注入 scripted transport 覆盖全部场景语义、失败记账、
// BLOCKED/UNVERIFIED、预算、脱敏与证据保留。产物写入
// .agent-artifacts/prechecks-2026-10-16/model-protocol/test-output/<唯一run目录>。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runPrecheck } from '../lib/runner.mjs'
import { queueTransport, createScriptedTransport, createLiveTransport } from '../lib/transport.mjs'
import { createRedactor } from '../lib/redact.mjs'
import { defaultOfflineQueue, textResponse, toolCallResponse, timeoutError } from '../lib/offline-script.mjs'
import { COMBO, BUDGET } from '../lib/combo.mjs'

const ARTIFACTS_BASE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..', '..', '..', '..',
  '.agent-artifacts', 'prechecks-2026-10-16', 'model-protocol', 'test-output',
)
fs.mkdirSync(ARTIFACTS_BASE, { recursive: true })
const ARTIFACTS = fs.mkdtempSync(path.join(ARTIFACTS_BASE, 'codex-tests-'))
// 账本文件按"测试进程"隔离：runner 的 ledger 设计为跨 run 累计，重跑本文件时
// 旧 ledger 仍在（正确行为），所以每个测试进程使用带 nonce 的新 ledger 文件；
// 进程内两次 runPrecheck 仍共享同一 ledger（累计行为照常被测）。
const NONCE = `${Date.now()}-${process.pid}`
const ledger = label => path.join(ARTIFACTS, `${label}-${NONCE}.ledger.jsonl`)

test('全场景 happy path：自动判定全 PASS，21 次尝试逐条落账，配对消息可追溯', async () => {
  const summary = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('happy'),
    transport: queueTransport(defaultOfflineQueue()),
    label: 't-happy',
  })
  assert.equal(summary.verdict, 'PASS')
  for (const r of summary.scenarioResults) assert.equal(r.verdict, 'PASS', `${r.scenario}: ${JSON.stringify(r.notes)}`)
  assert.equal(summary.ledger.attemptsUsed, 21)
  assert.equal(summary.ledger.attemptsRemaining, BUDGET.maxTotalCalls - 21)

  const lines = fs.readFileSync(path.join(summary.runDir, 'transcript.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 21)
  for (const l of lines) {
    assert.equal(typeof l.response.latencyMs, 'number', `seq ${l.seq} 缺 latencyMs`)
    if (l.response.error) {
      // 失败调用 usage 必须记为未知（不按零计），且仍保留 latencyMs。
      assert.equal(l.response.usage, null, `seq ${l.seq} 错误记录 usage 应为 null`)
      assert.equal(l.response.usageUnknown, true, `seq ${l.seq} 错误记录应标 usageUnknown`)
    } else {
      assert.ok(l.response.usage && typeof l.response.usage.total_tokens === 'number', `seq ${l.seq} 缺 usage`)
    }
  }
  assert.equal(lines.filter(l => l.response.error).length, 1, '唯一预期错误是 s5 的刻意超时')
  // S2b 第二轮请求必须携带上一轮的 assistant.tool_calls 与配对 tool 消息（配对证据）。
  const s2b = lines.filter(l => l.scenario === 's2b')
  assert.ok(s2b[1].request.messages.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls)))
  assert.ok(s2b[1].request.messages.some(m => m.role === 'tool' && typeof m.tool_call_id === 'string'))
  // 结果文件区分自动判定与人工解释。
  const onDisk = JSON.parse(fs.readFileSync(path.join(summary.runDir, 'results.json'), 'utf-8'))
  assert.equal(onDisk.automated, true)
  assert.match(onDisk.manualInterpretation, /REPORT/)
})

test('失败记账：失败尝试同样占额度，预算耗尽后剩余场景 UNVERIFIED 且不再调用', async () => {
  let calls = 0
  const failing = createScriptedTransport(async () => {
    calls += 1
    return { error: { name: 'APIError', message: 'internal boom', status: 500 } }
  })
  const budget = { ...BUDGET, maxTotalCalls: 4, maxRetriesPerRequest: 1 }
  const summary = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('fail-accounting'),
    transport: failing,
    budget,
    scenarioNames: ['ping', 's1', 's2a'],
    label: 't-failacct',
  })
  assert.equal(calls, 4, '传输层调用次数必须恰好等于预算（预留发生在 SDK 调用前，含失败）')
  assert.equal(summary.ledger.attemptsUsed, 4)
  assert.ok(summary.scenarioResults.every(r => r.verdict === 'UNVERIFIED'))
  assert.match(summary.scenarioResults[2].reason, /budget/)
  // 失败调用同样落 transcript 且 usage 记为未知（不按零计）。
  const lines = fs.readFileSync(path.join(summary.runDir, 'transcript.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 4)
  assert.ok(lines.every(l => l.response.usage === null && l.response.usageUnknown === true))
})

test('缺凭据：live 模式记录 BLOCKED，传输层零调用', async () => {
  let calls = 0
  const transport = createScriptedTransport(() => {
    calls += 1
    return textResponse('不应到达')
  })
  const summary = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('blocked'),
    mode: 'live',
    apiKey: null,
    transport,
    scenarioNames: ['ping'],
    label: 't-blocked',
  })
  assert.equal(summary.verdict, 'BLOCKED')
  assert.equal(calls, 0)
  assert.match(summary.reason, /BLOCKED/)
  const onDisk = JSON.parse(fs.readFileSync(path.join(summary.runDir, 'results.json'), 'utf-8'))
  assert.equal(onDisk.verdict, 'BLOCKED')
  assert.equal(onDisk.attemptsUsed, 0)
})

test('live 传输层端点白名单：拒绝任意端点（防数据外泄到非配置端点）', () => {
  assert.throws(
    () => createLiveTransport({ combo: { ...COMBO, baseUrl: 'https://collector.invalid.example' }, apiKey: 'sk-fakevalue123456', redactor: createRedactor() }),
    /白名单/,
  )
})

test('S3：全部请求失败时 UNVERIFIED（不是无条件 PASS）', async () => {
  const failing = createScriptedTransport(async () => ({ error: { name: 'APIError', message: 'down', status: 400 } }))
  const summary = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('s3-all-fail'),
    transport: failing,
    scenarioNames: ['s3'],
    label: 't-s3-fail',
  })
  assert.equal(summary.scenarioResults[0].verdict, 'UNVERIFIED')
  assert.match(summary.scenarioResults[0].reason, /观察不完整/)
})

test('S4：注入误触发 → FAIL 并记录工具与参数；部分请求失败 → UNVERIFIED', async () => {
  const triggerRun = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('s4-trigger'),
    transport: queueTransport([
      textResponse('闲聊回复1'),
      toolCallResponse('call_tri', 'query_domain_info', { domain: 'work-project' }),
      textResponse('闲聊回复3'), textResponse('闲聊回复4'), textResponse('闲聊回复5'), textResponse('闲聊回复6'),
    ]),
    scenarioNames: ['s4'],
    label: 't-s4-trigger',
  })
  const tr = triggerRun.scenarioResults[0]
  assert.equal(tr.verdict, 'FAIL')
  assert.ok(tr.notes.some(n => n.includes('误触发 query_domain_info') && n.includes('work-project')))

  const partialRun = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('s4-partial'),
    transport: queueTransport([
      { error: { name: 'APIError', message: 'net down', status: 400 } },
      textResponse('闲聊回复2'), textResponse('闲聊回复3'), textResponse('闲聊回复4'), textResponse('闲聊回复5'), textResponse('闲聊回复6'),
    ]),
    scenarioNames: ['s4'],
    label: 't-s4-partial',
  })
  const pr = partialRun.scenarioResults[0]
  assert.equal(pr.verdict, 'UNVERIFIED')
  assert.match(pr.reason, /证据不足/)
})

test('S2b：模型改为澄清时自动判 FAIL，notes 标注真实行为供人工解释', async () => {
  const summary = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('s2b-clarify'),
    transport: queueTransport([
      toolCallResponse('call_c1', 'query_domain_info', { domain: 'work-project', projectKey: 'stock_data' }),
      textResponse('请确认 projectKey 用 stock_data 还是其他已绑定项目？'),
    ]),
    scenarioNames: ['s2b'],
    label: 't-s2b-clarify',
  })
  const r = summary.scenarioResults[0]
  assert.equal(r.verdict, 'FAIL')
  assert.ok(r.notes.some(n => n.includes('真实行为')))
  assert.ok(r.notes.some(n => n.includes('observedChain=query_domain_info')))
})

test('S2a：一轮工具后产出最终文本即 PASS（语义修复：不再要求 >=2 轮）', async () => {
  const summary = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('s2a-single-round'),
    transport: queueTransport([
      toolCallResponse('call_a1', 'query_domain_info', { domain: 'work-project', projectKey: 'stock_data' }),
      textResponse('已查询并收尾（合成）。'),
    ]),
    scenarioNames: ['s2a'],
    label: 't-s2a-oneround',
  })
  const r = summary.scenarioResults[0]
  assert.equal(r.verdict, 'PASS')
  assert.ok(r.notes.some(n => n.includes('toolRounds=1')))
})

test('S5：恢复必须是指定工具名；超时调用 usage 记为未知而非零', async () => {
  const passRun = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('s5-pass'),
    transport: queueTransport([
      timeoutError(),
      toolCallResponse('call_r1', 'delegate_work', { targetAgentId: 'work-project', projectKey: 'stock_data', objective: 'o', scope: ['s'], completionCriteria: ['c'], contextRefs: [] }),
    ]),
    scenarioNames: ['s5'],
    label: 't-s5-pass',
  })
  assert.equal(passRun.scenarioResults[0].verdict, 'PASS')
  const lines = fs.readFileSync(path.join(passRun.runDir, 'transcript.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse)
  assert.equal(lines[0].response.error.name, 'APIConnectionTimeoutError')
  assert.equal(lines[0].response.usage, null)
  assert.equal(lines[0].response.usageUnknown, true)
  assert.equal(typeof lines[0].response.latencyMs, 'number')

  const failRun = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('s5-wrong-name'),
    transport: queueTransport([
      timeoutError(),
      toolCallResponse('call_r2', 'query_domain_info', { domain: 'work-project' }),
    ]),
    scenarioNames: ['s5'],
    label: 't-s5-wrongname',
  })
  const fr = failRun.scenarioResults[0]
  assert.equal(fr.verdict, 'FAIL')
  assert.ok(fr.notes.some(n => n.includes('delegate_work')))
})

test('S1：工具名错误 → FAIL（name 检查为断言，非无条件通过）', async () => {
  const summary = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('s1-wrong-name'),
    transport: queueTransport([
      toolCallResponse('call_w1', 'delete_everything', { domain: 'work-project' }),
      toolCallResponse('call_w2', 'delegate_work', { targetAgentId: 'work-project', projectKey: 'stock_data', objective: 'o', scope: ['s'], completionCriteria: ['c'], contextRefs: [] }),
      toolCallResponse('call_w3', 'cancel_assignment', { assignmentId: 'asg-a-123' }),
      toolCallResponse('call_w4', 'delegate_work', { targetAgentId: 'work-project', projectKey: 'stock_data', objective: 'o', scope: ['s'], completionCriteria: ['c'], contextRefs: [] }),
    ]),
    scenarioNames: ['s1'],
    label: 't-s1-wrongname',
  })
  const r = summary.scenarioResults[0]
  assert.equal(r.verdict, 'FAIL')
  assert.ok(r.notes.some(n => n.includes('nameOk=false')))
})

test('错误脱敏与证据保留：含秘密的错误消息落盘前被替换，记录不丢弃', async () => {
  const summary = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath: ledger('redaction'),
    transport: queueTransport([
      { error: { name: 'APIError', message: 'request failed: Authorization: Bearer sk-leakedsecret123456 end', status: 400 } },
    ]),
    scenarioNames: ['ping'],
    label: 't-redaction',
  })
  assert.equal(summary.scenarioResults[0].verdict, 'UNVERIFIED')
  const transcriptRaw = fs.readFileSync(path.join(summary.runDir, 'transcript.jsonl'), 'utf-8')
  const resultsRaw = fs.readFileSync(path.join(summary.runDir, 'results.json'), 'utf-8')
  for (const raw of [transcriptRaw, resultsRaw]) {
    assert.ok(!raw.includes('sk-leakedsecret'), '秘密不得出现在产物中')
    assert.ok(!raw.includes('Bearer'), 'Bearer 头不得出现在产物中')
    assert.ok(raw.includes('[REDACTED]'))
  }
  assert.equal(transcriptRaw.trim().split('\n').length, 1, '错误记录必须保留（证据 retention）')
})

test('账本跨 run 累计；run 目录唯一；不删除不覆盖既有文件', async () => {
  const ledgerPath = ledger('cumulative')
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  const marker = path.join(ARTIFACTS, 'marker-do-not-touch.txt')
  fs.writeFileSync(marker, 'keep-me')
  const first = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath,
    transport: queueTransport([textResponse('pong')]),
    scenarioNames: ['ping'],
    label: 't-cum-a',
  })
  const second = await runPrecheck({
    outputRoot: ARTIFACTS,
    ledgerPath,
    transport: queueTransport([textResponse('pong')]),
    scenarioNames: ['ping'],
    label: 't-cum-b',
  })
  assert.equal(first.ledger.attemptsUsed, 1)
  assert.equal(second.ledger.attemptsUsed, 2, 'ledger 必须跨 run 累计')
  assert.notEqual(first.runDir, second.runDir)
  assert.ok(fs.existsSync(first.runDir) && fs.existsSync(second.runDir))
  assert.equal(fs.readFileSync(marker, 'utf-8'), 'keep-me')
})
