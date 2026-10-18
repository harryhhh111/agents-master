import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { FAKE_GROUP, type FakeDecision } from '../src/main/coordination/store.js'
import { FakeBackgroundScheduler, FakeForegroundScheduler, HeldFakeExecutor } from '../src/main/coordination/fake.js'

// Deliberately no path/config/provider flags and no dotenv/config imports.
if (process.argv.length !== 2) throw new Error('FAKE smoke accepts no arguments or data paths')
const directory = mkdtempSync(join(tmpdir(), 'FAKE-coordination-'))
chmodSync(directory, 0o700)
const database = join(directory, 'FAKE.sqlite')
let store = new SQLiteMainInboxStore(database, { coordination: { mode: 'fresh' } })
chmodSync(database, 0o600)
const deadline = setTimeout(() => { console.error('FAKE smoke exceeded 10 seconds'); process.exit(1) }, 10_000)
try {
  let c = store.coordination
  const request = c.admit('main', 'FAKE-request', 'FAKE inspect synthetic project')
  const decision: FakeDecision = { action: 'fake-check', objective: 'FAKE inspect synthetic fixture', scope: ['synthetic'], completionCriteria: ['FAKE findings and evidence'] }
  const accepted = c.accept('main', request.event.id, decision)
  assert.deepEqual(c.accept('main', request.event.id, decision), accepted)
  const executor = new HeldFakeExecutor()
  const background = new FakeBackgroundScheduler(c, executor)
  const run = background.startNext(FAKE_GROUP)!
  await Promise.resolve()
  const front = new FakeForegroundScheduler(c, 'main')
  await front.step()
  c.admit('main', 'FAKE-chat', 'FAKE how is the afternoon?')
  const chat = await front.step()
  assert.equal(chat.kind, 'chat')
  assert.match(chat.message!.content, /completed foreground reply/)
  assert.equal(c.runs(FAKE_GROUP)[0].status, 'running')
  console.log('FAKE verification: foreground reply COMPLETED while executor HELD')
  executor.finish(run.id, { kind: 'waiting_input', body: 'FAKE which synthetic case should be checked?' })
  await background.settled(run.id)
  assert.equal(background.errors.length, 0)
  assert.equal(c.runs(FAKE_GROUP)[0].status, 'succeeded')
  store.close()
  store = new SQLiteMainInboxStore(database, { coordination: { mode: 'open' } })
  c = store.coordination
  assert.equal(c.recover(FAKE_GROUP), 0)
  const question = c.questions(FAKE_GROUP)[0]
  assert.equal(question.status, 'pending')
  const answer = c.admit(FAKE_GROUP, 'FAKE-answer', 'FAKE use case A')
  const resumed = c.answer(FAKE_GROUP, question.id, FAKE_GROUP, answer.event.id)
  assert.deepEqual(c.answer(FAKE_GROUP, question.id, FAKE_GROUP, answer.event.id), resumed)
  const nextExecutor = new HeldFakeExecutor()
  const nextBackground = new FakeBackgroundScheduler(c, nextExecutor)
  const nextRun = nextBackground.startNext(FAKE_GROUP)!
  assert.notEqual(nextRun.id, run.id)
  assert.match(nextRun.context, /which synthetic case/)
  await Promise.resolve()
  nextExecutor.finish(nextRun.id, { kind: 'completed', body: 'FAKE case A checked; synthetic evidence only' })
  await nextBackground.settled(nextRun.id)
  const nextFront = new FakeForegroundScheduler(c, 'main')
  for (let i = 0; i < 5; i++) c.admit('main', `FAKE-chat-${i}`, `FAKE continuous chat ${i}`)
  const kinds: string[] = []
  for (let i = 0; i < 4; i++) kinds.push((await nextFront.step()).kind)
  assert.ok(kinds.includes('report'))
  assert.equal(c.outbox('main').find(o => o.kind === 'waiting_input')!.status, 'superseded')
  assert.equal(c.outbox('main').find(o => o.kind === 'completed')!.status, 'delivered')
  console.log('FAKE verification: durable original question + answer + new run after restart; bounded fair delivery', kinds)
  console.log(JSON.stringify({ label: 'FAKE synthetic history/state only', main: c.history('main'), group: c.history(FAKE_GROUP), assignments: c.assignments(FAKE_GROUP), runs: c.runs(FAKE_GROUP), questions: c.questions(FAKE_GROUP), outbox: c.outbox('main'), verification: 'PASS: no model, network, real CLI, owner context or project access' }, null, 2))
} finally {
  clearTimeout(deadline)
  store.close()
  rmSync(directory, { recursive: true, force: true })
}
