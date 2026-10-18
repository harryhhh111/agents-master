import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { FAKE_GROUP, type FakeDecision } from '../src/main/coordination/store.js'
import { FakeBackgroundScheduler, FakeForegroundScheduler, HeldFakeExecutor } from '../src/main/coordination/fake.js'

const decision: FakeDecision = { action: 'fake-check', objective: 'FAKE inspect', scope: ['synthetic'], completionCriteria: ['FAKE evidence'] }
const at = '2026-10-16T01:00:00.000Z'
let directory: string
let path: string
let store: SQLiteMainInboxStore
let fault = ''
function open(mode: 'fresh' | 'open' = 'fresh') {
  store = new SQLiteMainInboxStore(path, { coordination: { mode }, clock: () => at,
    coordinationFault: point => { if (fault === point) throw new Error(`Injected ${point}`) } })
  return store.coordination
}
function accepted(key = 'work', source = 'main') {
  const c = store.coordination
  const input = c.admit(source, key, 'FAKE work')
  return { ...c.accept(source, input.event.id, decision), input }
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'coordination-test-')); path = join(directory, 'test.sqlite'); fault = '' })
afterEach(() => { try { store?.close() } catch {} rmSync(directory, { recursive: true, force: true }) })

describe('trusted atomic coordination', () => {
  it('keeps one message schema, isolates scopes/anchors and uses append order despite backfill', () => {
    const c = open()
    const main = c.admit('main', 'main', 'FAKE main secret')
    const group = c.admit(FAKE_GROUP, 'group', 'FAKE group')
    c.present(FAKE_GROUP, 'FAKE backfilled', 'assistant', '2020-01-01T00:00:00.000Z')
    expect(c.history(FAKE_GROUP).map(m => m.content)).toEqual(['FAKE group', 'FAKE backfilled'])
    expect(() => c.history(FAKE_GROUP, main.message.id)).toThrow('anchor')
    expect(() => store.readContextThroughMessage(group.message.id)).toThrow('not found')
    expect(store.readRecentContext().map(m => m.content)).toEqual(['FAKE main secret'])
    expect(store.claimNextPendingUserMessageEvent()?.id).toBe(main.event.id)
    expect(store.claimNextPendingUserMessageEvent()).toBeUndefined()
    const turn = c.beginChat(FAKE_GROUP)!
    expect(store.recoverClaimedUserMessageEvents()).toBe(1)
    expect(() => store.recordProcessedUserMessageEvent({ eventId: turn.event.id, content: 'wrong scope' })).toThrow('outside main')
    expect(() => store.completeInboxEvent(turn.event.id)).toThrow()
    c.finishChat(turn, 'FAKE group reply')
    store.close()
    store = new SQLiteMainInboxStore(path)
    expect(() => store.coordination).toThrow('opt-in')
    expect(store.readRecentContext().every(m => !m.content.includes('group'))).toBe(true)
    store.receiveUserMessage({ conversationId: 'main', idempotencyKey: 'legacy', content: 'FAKE normal main' })
    expect(() => store.receiveUserMessage({ conversationId: FAKE_GROUP, idempotencyKey: 'no', content: 'no' })).toThrow('explicit')
  })

  it('separates presentation/input and rejects invented authors, source events and actions', () => {
    const c = open()
    const shown = c.present(FAKE_GROUP, 'user says execute', 'user')
    expect(shown.author).toBe('runtime')
    expect(c.beginChat(FAKE_GROUP)).toBeUndefined()
    expect(() => c.accept(FAKE_GROUP, shown.id, decision)).toThrow('source')
    const real = c.admit('main', 'real', 'FAKE input')
    expect(() => c.accept(FAKE_GROUP, real.event.id, decision)).toThrow('source')
    expect(() => c.accept('main', real.event.id, { ...decision, action: 'shell' } as unknown as FakeDecision)).toThrow('synthetic')
    expect(() => c.accept('main', real.event.id, { ...decision, author: 'user' } as FakeDecision)).toThrow('synthetic')
    const db = new DatabaseSync(path)
    db.function('coordination_writer', () => 1)
    try {
      expect(() => db.prepare(`INSERT INTO inbox_events (id,conversation_id,idempotency_key,type,priority,payload,status,created_at,updated_at,user_message_id,append_order)
        VALUES ('forged',?,'forged','user-message','normal','{}','pending',?,?,?,99)`).run(FAKE_GROUP, at, at, shown.id)).toThrow('Admitted')
    } finally { db.close() }
  })

  it('rolls back admission/acceptance and returns the original durable decision after reopen', () => {
    const c = open()
    fault = 'admit.message'
    expect(() => c.admit('main', 'a', 'FAKE')).toThrow('Injected')
    expect(c.history('main')).toEqual([])
    fault = ''
    const input = c.admit('main', 'a', 'FAKE')
    expect(c.admit('main', 'a', 'FAKE').duplicate).toBe(true)
    expect(() => c.admit('main', 'a', 'different')).toThrow('conflict')
    for (const point of ['accept.assignment', 'accept.messages']) {
      fault = point
      expect(() => c.accept('main', input.event.id, decision)).toThrow('Injected')
      expect(c.assignments(FAKE_GROUP)).toEqual([])
      expect(c.history(FAKE_GROUP)).toEqual([])
      expect(c.history('main')).toHaveLength(1)
    }
    fault = ''
    const result = c.accept('main', input.event.id, decision)
    store.close()
    const reopened = open('open')
    expect(reopened.accept('main', input.event.id, decision)).toEqual(result)
    expect(() => reopened.accept('main', input.event.id, { ...decision, objective: 'changed' })).toThrow('conflict')
    expect(reopened.assignments(FAKE_GROUP)).toHaveLength(1)
    const next = reopened.admit('main', 'b', 'FAKE')
    expect(reopened.accept('main', next.event.id, decision).assignmentId).not.toBe(result.assignmentId)
  })

  it('freezes group-only context and keeps original questions/answers through restart and new runs', () => {
    const c = open()
    c.present('main', 'FAKE private secret')
    c.present(FAKE_GROUP, 'FAKE initial context')
    const a = accepted()
    c.present(FAKE_GROUP, 'FAKE later must not leak')
    const run = c.claim(FAKE_GROUP)!
    expect(run.context).toContain('initial context')
    expect(run.context).not.toContain('private secret')
    expect(run.context).not.toContain('later must not leak')
    fault = 'receipt.outbox'
    expect(() => c.receipt(FAKE_GROUP, run.id, { kind: 'waiting_input', body: 'FAKE original question?' })).toThrow('Injected')
    expect(c.questions(FAKE_GROUP)).toEqual([])
    expect(c.runs(FAKE_GROUP)[0].status).toBe('starting')
    fault = ''
    const receipt = { kind: 'waiting_input' as const, body: 'FAKE original question?' }
    c.receipt(FAKE_GROUP, run.id, receipt)
    expect(c.receipt(FAKE_GROUP, run.id, receipt)).toEqual({ accepted: true })
    expect(() => c.receipt(FAKE_GROUP, run.id, { ...receipt, body: 'changed' })).toThrow('conflict')
    const second = accepted('second')
    expect(c.claim(FAKE_GROUP)?.assignment_id).toBe(second.assignmentId) // waiting frees project
    store.close()
    const reopened = open('open')
    reopened.recover(FAKE_GROUP)
    const q = reopened.questions(FAKE_GROUP)[0]
    expect(q.body).toBe(receipt.body)
    const answer = reopened.admit('main', 'answer', 'FAKE answer, not new permissions')
    fault = 'answer.queued'
    expect(() => reopened.answer(FAKE_GROUP, q.id, 'main', answer.event.id)).toThrow('Injected')
    expect(reopened.questions(FAKE_GROUP)[0].status).toBe('pending')
    fault = ''
    const resumed = reopened.answer(FAKE_GROUP, q.id, 'main', answer.event.id)
    expect(reopened.answer(FAKE_GROUP, q.id, 'main', answer.event.id)).toEqual(resumed)
    const retryRun = reopened.claim(FAKE_GROUP)!
    expect(retryRun.assignment_id).toBe(a.assignmentId)
    expect(retryRun.id).not.toBe(run.id)
    expect(retryRun.context).toContain('FAKE original question?')
    expect(retryRun.context).toContain('FAKE answer, not new permissions')
    expect(retryRun.context).not.toContain('later must not leak')
    expect(reopened.answer(FAKE_GROUP, q.id, 'main', answer.event.id)).toEqual(resumed)
    expect(reopened.questions(FAKE_GROUP)[0].answer_event).toBe(answer.event.id)
    expect(reopened.deliver('main', reopened.outbox('main')[0].id)).toBeUndefined()
    expect(reopened.outbox('main')[0].status).toBe('superseded')
  })
})

describe('runs, recovery, cancellation and concurrency', () => {
  it.each(['starting', 'running', 'cancel_requested'])('recovers %s as unknown without replay; retains late evidence', status => {
    const c = open(); const a = accepted(); const run = c.claim(FAKE_GROUP)!
    if (status !== 'starting') c.started(FAKE_GROUP, run.id)
    if (status === 'cancel_requested') c.cancel(FAKE_GROUP, a.assignmentId)
    store.close(); const reopened = open('open')
    expect(reopened.recover('main')).toBe(0)
    expect(reopened.recover(FAKE_GROUP)).toBe(1)
    expect(reopened.recover(FAKE_GROUP)).toBe(0)
    expect(reopened.runs(FAKE_GROUP)[0].status).toBe('unknown')
    expect(reopened.assignments(FAKE_GROUP)[0].status).toBe('interrupted')
    expect(reopened.claim(FAKE_GROUP)).toBeUndefined()
    expect(reopened.receipt(FAKE_GROUP, run.id, { kind: 'completed', body: 'FAKE late' })).toEqual({ accepted: false })
    const db = new DatabaseSync(path)
    try { expect(db.prepare('SELECT accepted,payload FROM coordination_receipts').get()).toMatchObject({ accepted: 0, payload: JSON.stringify({ kind: 'completed', body: 'FAKE late' }) }) } finally { db.close() }
    expect(reopened.outbox('main')).toHaveLength(1)
  })

  it('fences queued and running cancellation, requires explicit stop, rejects stale answers', () => {
    const c = open(); const a = accepted(); const b = accepted('b')
    c.cancel(FAKE_GROUP, b.assignmentId)
    const run = c.claim(FAKE_GROUP)!
    expect(run.assignment_id).toBe(a.assignmentId)
    expect(c.cancel(FAKE_GROUP, a.assignmentId).status).toBe('cancel_requested')
    const version = c.cancel(FAKE_GROUP, a.assignmentId).version
    expect(c.receipt(FAKE_GROUP, run.id, { kind: 'completed', body: 'late' }).accepted).toBe(false)
    expect(c.assignments(FAKE_GROUP)[0]).toMatchObject({ status: 'cancel_requested', version })
    expect(c.claim(FAKE_GROUP)).toBeUndefined()
    c.confirmStopped(FAKE_GROUP, run.id); c.confirmStopped(FAKE_GROUP, run.id)
    expect(c.assignments(FAKE_GROUP)[0].status).toBe('cancelled')
    const third = accepted('c'); const r = c.claim(FAKE_GROUP)!
    c.receipt(FAKE_GROUP, r.id, { kind: 'waiting_input', body: 'FAKE pending question' })
    c.cancel(FAKE_GROUP, third.assignmentId)
    const answer = c.admit(FAKE_GROUP, 'answer', 'FAKE late answer')
    expect(() => c.answer(FAKE_GROUP, c.questions(FAKE_GROUP)[0].id, FAKE_GROUP, answer.event.id)).toThrow('Stale')
    expect(c.questions(FAKE_GROUP)[0].status).toBe('revoked')
  })

  it('serializes project claims across connections and rolls back failed claims', () => {
    const c = open(); accepted(); accepted('b')
    fault = 'claim.run'
    expect(() => c.claim(FAKE_GROUP)).toThrow('Injected')
    expect(c.runs(FAKE_GROUP)).toEqual([])
    expect(c.assignments(FAKE_GROUP).every(a => a.status === 'queued')).toBe(true)
    fault = ''
    const other = new SQLiteMainInboxStore(path, { coordination: { mode: 'open' } })
    try {
      const run = c.claim(FAKE_GROUP)!
      expect(other.coordination.claim(FAKE_GROUP)).toBeUndefined()
      c.receipt(FAKE_GROUP, run.id, { kind: 'completed', body: 'FAKE done' })
      expect(other.coordination.claim(FAKE_GROUP)).toBeDefined()
    } finally { other.close() }
  })
})

describe('separate background and safe-point front writer', () => {
  it('records executor rejection as durable failure, and explicit fake stop as cancellation', async () => {
    const c = open(); accepted()
    const failed = new FakeBackgroundScheduler(c, { identity: 'FAKE', execute: async () => { throw new Error('synthetic failure') } })
    const failedRun = failed.startNext(FAKE_GROUP)!
    await failed.settled(failedRun.id)
    expect(c.runs(FAKE_GROUP)[0].status).toBe('failed')
    expect(c.outbox('main')[0].body).toContain('synthetic failure')
    const next = accepted('stop-me')
    const executor = new HeldFakeExecutor()
    const background = new FakeBackgroundScheduler(c, executor)
    const run = background.startNext(FAKE_GROUP)!
    await Promise.resolve()
    const front = new FakeForegroundScheduler(c, 'main')
    front.cancel(next.assignmentId)
    expect(c.runs(FAKE_GROUP)[1].status).toBe('cancel_requested')
    expect(c.assignments(FAKE_GROUP)[1].status).toBe('cancel_requested')
    executor.confirmStop(run.id)
    await background.settled(run.id)
    expect(c.runs(FAKE_GROUP)[1].status).toBe('cancelled')
    expect(c.outbox('main').at(-1)?.kind).toBe('cancelled')
  })

  it('rolls back foreground commit and retries with identical frozen input after failure', async () => {
    const c = open(); c.admit('main', 'a', 'FAKE original')
    const contexts: string[] = []
    const front = new FakeForegroundScheduler(c, 'main', async context => {
      contexts.push(JSON.stringify(context)); return 'FAKE reply'
    })
    fault = 'front.message'
    await expect(front.step()).rejects.toThrow('Injected')
    expect(c.history('main')).toHaveLength(1)
    expect(c.userTurnCount('main')).toBe(0)
    c.admit('main', 'b', 'FAKE later')
    fault = ''
    expect((await front.step()).kind).toBe('chat')
    expect(contexts[1]).toBe(contexts[0])
    expect(c.userTurnCount('main')).toBe(1)
  })

  it('preserves fairness across restart and leaves claimed legacy domain/timer events unchanged', async () => {
    const c = open()
    for (const type of ['timer', 'domain-update'] as const) store.enqueueEvent({ conversationId: 'main', idempotencyKey: type, type, payload: null })
    store.claimNextPendingEvent(); store.claimNextPendingEvent()
    accepted(); const run = c.claim(FAKE_GROUP)!
    c.receipt(FAKE_GROUP, run.id, { kind: 'completed', body: 'FAKE result' })
    const front = new FakeForegroundScheduler(c, 'main')
    for (let i = 0; i < 3; i++) { c.admit('main', `turn-${i}`, 'FAKE turn'); await front.step() }
    store.close(); const reopened = open('open')
    reopened.recover('main')
    expect((await new FakeForegroundScheduler(reopened, 'main').step()).kind).toBe('report')
    const db = new DatabaseSync(path)
    try { expect(db.prepare("SELECT status FROM inbox_events WHERE type<>'user-message'").all()).toEqual([{ status: 'claimed' }, { status: 'claimed' }]) } finally { db.close() }
  })

  it('report formatting failure does not block chat or consume the receipt', async () => {
    const c = open(); accepted(); const run = c.claim(FAKE_GROUP)!
    c.receipt(FAKE_GROUP, run.id, { kind: 'completed', body: 'FAKE report' })
    const front = new FakeForegroundScheduler(c, 'main', undefined, () => { throw new Error('FAKE formatting down') }, 1)
    await front.step()
    c.admit('main', 'more', 'FAKE more')
    expect(await front.step()).toMatchObject({ kind: 'chat', deliveryError: 'Error: FAKE formatting down' })
    expect(c.outbox('main')[0].status).toBe('pending')
    expect(c.runs(FAKE_GROUP)).toHaveLength(1)
  })

  it('supersedes stale questions before calling the report formatter', async () => {
    const c = open(); accepted(); const run = c.claim(FAKE_GROUP)!
    c.receipt(FAKE_GROUP, run.id, { kind: 'waiting_input', body: 'FAKE stale question' })
    const answer = c.admit(FAKE_GROUP, 'answer', 'FAKE answer')
    c.answer(FAKE_GROUP, c.questions(FAKE_GROUP)[0].id, FAKE_GROUP, answer.event.id)
    const resumed = c.claim(FAKE_GROUP)!
    c.receipt(FAKE_GROUP, resumed.id, { kind: 'completed', body: 'FAKE current result' })
    const front = new FakeForegroundScheduler(c, 'main', undefined, body => {
      if (body.includes('stale')) throw new Error('Must not format stale question')
      return body
    })
    await front.step()
    expect((await front.step()).message?.content).toBe('FAKE current result')
    expect(c.outbox('main')[0].status).toBe('superseded')
  })

  it('rejects noncanonical time and unknown groups before persisting input', () => {
    const c = open()
    expect(() => c.admit('main', 'bad', 'FAKE', '2026-10-16T09:00:00+08:00')).toThrow('UTC')
    expect(() => c.admit('other', 'bad', 'FAKE')).toThrow('Unknown')
    expect(c.history('main')).toEqual([])
  })
  it('actually completes a foreground reply while executor is held; queues delivery during in-flight context', async () => {
    const c = open(); accepted()
    const executor = new HeldFakeExecutor(); const background = new FakeBackgroundScheduler(c, executor)
    const run = background.startNext(FAKE_GROUP)!
    await Promise.resolve()
    const front = new FakeForegroundScheduler(c, 'main')
    expect((await front.step()).message?.content).toContain('completed foreground reply')
    expect(c.runs(FAKE_GROUP)[0].status).toBe('running')
    const chat = c.admit('main', 'chat', 'FAKE unrelated chat')
    let finish!: (text: string) => void
    let frozen = ''
    const heldFront = new FakeForegroundScheduler(c, 'main', async context => {
      frozen = JSON.stringify(context)
      return new Promise(resolve => { finish = resolve })
    })
    const inFlight = heldFront.step()
    await Promise.resolve(); await Promise.resolve()
    executor.finish(run.id, { kind: 'completed', body: 'FAKE completed in background' })
    await background.settled(run.id)
    expect(c.outbox('main')[0].status).toBe('pending')
    expect(() => c.deliver('main', c.outbox('main')[0].id)).toThrow('in flight')
    expect(frozen).toContain(chat.message.id)
    expect(frozen).not.toContain('completed in background')
    finish('FAKE actual held foreground reply')
    expect((await inFlight).message?.content).toBe('FAKE actual held foreground reply')
    expect((await front.step()).kind).toBe('report')
    expect(background.errors).toEqual([])
  })

  it('delivers after three user turns under sustained arrivals; failures preserve pending and allow chat', async () => {
    const c = open(); accepted(); const run = c.claim(FAKE_GROUP)!
    c.receipt(FAKE_GROUP, run.id, { kind: 'completed', body: 'FAKE result' })
    const front = new FakeForegroundScheduler(c, 'main')
    for (let i = 0; i < 3; i++) { c.admit('main', `chat-${i}`, `FAKE ${i}`); expect((await front.step()).kind).toBe('chat') }
    c.admit('main', 'chat-more', 'FAKE continuous input')
    fault = 'deliver.message'
    const failedDelivery = await front.step()
    expect(failedDelivery.kind).toBe('chat')
    expect(failedDelivery.deliveryError).toContain('Injected')
    expect(c.outbox('main')[0].status).toBe('pending')
    expect(c.history('main').filter(m => m.presentation === 'report')).toEqual([])
    fault = ''
    expect((await front.step()).kind).toBe('report')
    const delivered = c.outbox('main')[0]
    expect(c.deliver('main', delivered.id)?.id).toBe(delivered.message_id)
    expect(c.history('main').filter(m => m.presentation === 'report')).toHaveLength(1)
  })

  it('shares writer across scheduler instances and fences other connections while await is pending', async () => {
    const c = open(); c.admit('main', 'a', 'FAKE a'); c.admit('main', 'b', 'FAKE b')
    let finish!: (text: string) => void
    const first = new FakeForegroundScheduler(c, 'main', () => new Promise(resolve => { finish = resolve }))
    const second = new FakeForegroundScheduler(c, 'main')
    const one = first.step(); const two = second.step()
    await Promise.resolve(); await Promise.resolve()
    const other = new SQLiteMainInboxStore(path, { coordination: { mode: 'open' } })
    try { expect(await new FakeForegroundScheduler(other.coordination, 'main').step()).toEqual({ kind: 'idle' }) } finally { other.close() }
    expect(c.history('main').filter(m => m.author === 'main-agent')).toEqual([])
    finish('FAKE first done')
    expect((await one).kind).toBe('chat'); expect((await two).kind).toBe('chat')
    expect(c.history('main').filter(m => m.author === 'main-agent')).toHaveLength(2)
  })

  it('keeps terminal outbox across restart, ignores legacy events, recovers only scoped users', async () => {
    const c = open(); accepted(); const run = c.claim(FAKE_GROUP)!
    c.receipt(FAKE_GROUP, run.id, { kind: 'failed', body: 'FAKE failure' })
    store.enqueueEvent({ conversationId: 'main', idempotencyKey: 'timer', type: 'timer', payload: null })
    store.enqueueEvent({ conversationId: 'main', idempotencyKey: 'domain', type: 'domain-update', payload: null })
    c.beginChat('main')
    store.close(); const reopened = open('open')
    expect(reopened.recover('main')).toBe(0)
    expect(reopened.recover(FAKE_GROUP)).toBe(0)
    const front = new FakeForegroundScheduler(reopened, 'main')
    expect((await front.step()).kind).toBe('chat')
    expect((await front.step()).kind).toBe('report')
    expect((await front.step()).kind).toBe('idle')
    expect(reopened.claim(FAKE_GROUP)).toBeUndefined()
    const db = new DatabaseSync(path)
    try { expect(db.prepare("SELECT type,status FROM inbox_events WHERE type<>'user-message'").all()).toEqual([{ type: 'timer', status: 'pending' }, { type: 'domain-update', status: 'pending' }]) } finally { db.close() }
  })
})
