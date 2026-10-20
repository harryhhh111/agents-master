import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { iso, transaction } from '../schema.js'

export const FAKE_GROUP = 'fake-work'
export type ScopedMessage = {
  id: string; conversation_id: string; role: 'user' | 'assistant' | 'system'; author: string;
  presentation: string; content: string; created_at: string; append_order: number;
  assignment_id: string | null; run_id: string | null
}
export type Assignment = {
  id: string; source_event: string; conversation_id: string; return_conversation: string; project_key: string;
  agent_id: string; decision: string; accepted: string; status: string; version: number; input_version: number; context: string
}
export type Run = {
  id: string; assignment_id: string; conversation_id: string; project_key: string; version: number;
  input_version: number; context: string; status: string; executor: 'FAKE'; result: string | null
}
export type Question = { id: string; assignment_id: string; run_id: string; version: number; body: string; status: string; answer_event: string | null; answer: string | null; answer_result: string | null }
export type Outbox = { id: string; assignment_id: string; run_id: string | null; version: number; conversation_id: string; kind: string; body: string; status: string; message_id: string | null }
export type AdmittedEvent = { id: string; conversation_id: string; user_message_id: string; status: string; payload: string }
export type FakeDecision = { action: 'fake-check'; objective: string; scope: ['synthetic']; completionCriteria: string[] }
export type AcceptedDecision = { assignmentId: string; dispatchMessageId: string; acceptedMessageId: string }
export type FakeReceipt = { kind: 'completed' | 'failed' | 'waiting_input'; body: string }
export type FrontTurn = { conversation: string; event: AdmittedEvent; context: readonly ScopedMessage[] }

export interface CoordinationStoreLabels {
  dispatchPrefix: string
  acceptedPrefix: string
  controlNote: string
  /** 工作群回执消息前缀；按回执种类给出，便于真实模式用中文状态词。 */
  receiptPrefix: (kind: string) => string
}
export const defaultCoordinationStoreLabels: CoordinationStoreLabels = {
  dispatchPrefix: 'FAKE dispatch: ',
  acceptedPrefix: 'FAKE accepted: ',
  controlNote: '模拟/联调操作已记录：',
  receiptPrefix: kind => `FAKE ${kind}: `,
}

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Nonempty text required')
}

/** Internal host facade, sharing the inbox connection. Never expose it as a
 * client/model tool surface: the caller authenticates admission and confirms
 * structured decisions. No method accepts an author, project path or agent. */
export class CoordinationStore {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => string,
    private readonly fault: (point: string) => void = () => {}) {}

  /** 用户可见文案；与 host.checkpoint 一样由组装方按模式覆盖，默认合成标识。 */
  labels: CoordinationStoreLabels = { ...defaultCoordinationStoreLabels }

  private now(): string { return iso(this.clock()) }
  private one<T>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined }
  private all<T>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[] }
  private tx<T>(work: () => T): T { return this.db.isTransaction ? work() : transaction(this.db, work) }
  /** Preview journal shares the sole inbox connection and action transaction. */
  protocol<T>(turn: FrontTurn): T | undefined {
    this.source(turn.conversation, turn.event.id)
    const row = this.one<{ state: string }>('SELECT state FROM coordination_protocol WHERE event_id=? AND conversation_id=?', turn.event.id, turn.conversation)
    return row ? JSON.parse(row.state) as T : undefined
  }
  saveProtocol(turn: FrontTurn, state: unknown): void {
    this.source(turn.conversation, turn.event.id)
    this.db.prepare('INSERT INTO coordination_protocol VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET state=excluded.state')
      .run(turn.event.id, turn.conversation, JSON.stringify(state))
  }
  commitProtocol<T>(turn: FrontTurn, work: () => T, state: (result: T) => unknown): T {
    return this.tx(() => { const result = work(); this.saveProtocol(turn, state(result)); return result })
  }
  control(conversation: string, key: string, content: string, kind: 'answer' | 'cancel', id: string): void {
    this.tx(() => {
      const input = this.admit(conversation, key, content)
      const turn = { conversation, event: input.event, context: [] }
      const binding = JSON.stringify({ kind, id })
      const prior = this.protocol<{ binding: string }>(turn)
      if (prior) { if (prior.binding !== binding) throw new Error('Control conflict'); return }
      const result = kind === 'answer' ? this.answer(FAKE_GROUP, id, conversation, input.event.id) : this.cancel(FAKE_GROUP, id)
      this.saveProtocol(turn, { binding, messages: [], rounds: 0, ids: [], final: this.labels.controlNote + result.status })
    })
  }
  private conversation(id: string): void {
    if (!this.one('SELECT id FROM coordination_conversations WHERE id=?', id)) throw new Error('Unknown conversation')
  }
  private message(conversation: string, content: string, author: string, presentation: string,
    assignment: string | null = null, run: string | null = null, at = this.now(), role = author === 'user' ? 'user' : 'assistant'): ScopedMessage {
    this.conversation(conversation); text(content); iso(at)
    const id = randomUUID()
    this.db.prepare(`INSERT INTO main_conversation_messages
      (id,role,content,created_at,append_order,conversation_id,author,presentation,assignment_id,run_id)
      VALUES (?,?,?,?,(SELECT COALESCE(MAX(append_order),0)+1 FROM main_conversation_messages),?,?,?,?,?)`)
      .run(id, role, content, at, conversation, author, presentation, assignment, run)
    return this.one<ScopedMessage>('SELECT * FROM main_conversation_messages WHERE id=?', id)!
  }
  history(conversation: string, anchor?: string, limit = 100): ScopedMessage[] {
    this.conversation(conversation)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid context limit')
    let order = Number.MAX_SAFE_INTEGER
    if (anchor !== undefined) {
      const row = this.one<ScopedMessage>('SELECT * FROM main_conversation_messages WHERE id=? AND conversation_id=?', anchor, conversation)
      if (!row) throw new Error('Cross-conversation or missing anchor')
      order = row.append_order
    }
    return this.all<ScopedMessage>(`SELECT * FROM (SELECT * FROM main_conversation_messages
      WHERE conversation_id=? AND append_order<=? ORDER BY append_order DESC LIMIT ?) ORDER BY append_order`, conversation, order, limit)
  }
  /** Presentation is never admitted input, even if its model role is user. */
  present(conversation: string, content: string, role: 'user' | 'assistant' | 'system' = 'assistant', at = this.now()): ScopedMessage {
    return this.message(conversation, content, role === 'assistant' ? (conversation === 'main' ? 'main-agent' : 'fake-work-agent') : 'runtime', 'chat', null, null, at, role)
  }
  admit(conversation: string, key: string, content: string, at = this.now()): { message: ScopedMessage; event: AdmittedEvent; duplicate: boolean } {
    this.conversation(conversation); text(key); text(content); iso(at)
    return this.tx(() => {
      const prior = this.one<AdmittedEvent>('SELECT * FROM inbox_events WHERE conversation_id=? AND idempotency_key=?', conversation, key)
      if (prior) {
        const message = this.source(conversation, prior.id).message
        if (message.content !== content) throw new Error('Input idempotency conflict')
        return { message, event: prior, duplicate: true }
      }
      const message = this.message(conversation, content, 'user', 'input', null, null, at)
      this.fault('admit.message')
      const id = randomUUID()
      this.db.prepare(`INSERT INTO inbox_events
        (id,conversation_id,idempotency_key,type,priority,payload,status,created_at,updated_at,user_message_id,append_order)
        VALUES (?,?,?,'user-message','normal',?,'pending',?,?,?,(SELECT COALESCE(MAX(append_order),0)+1 FROM inbox_events))`)
        .run(id, conversation, key, JSON.stringify({ messageId: message.id, text: content }), at, at, message.id)
      return { message, event: this.one<AdmittedEvent>('SELECT * FROM inbox_events WHERE id=?', id)!, duplicate: false }
    })
  }
  private source(conversation: string, eventId: string): { event: AdmittedEvent; message: ScopedMessage } {
    this.conversation(conversation)
    const event = this.one<AdmittedEvent>("SELECT * FROM inbox_events WHERE id=? AND conversation_id=? AND type='user-message'", eventId, conversation)
    const message = event && this.one<ScopedMessage>("SELECT * FROM main_conversation_messages WHERE id=? AND conversation_id=? AND author='user' AND presentation='input'", event.user_message_id, conversation)
    if (!event || !message) throw new Error('Trusted admitted source required')
    return { event, message }
  }
  accept(sourceConversation: string, eventId: string, decision: FakeDecision): AcceptedDecision {
    // A tiny host allowlist, not natural-language routing or proof of intent.
    if (decision.action !== 'fake-check' || JSON.stringify(decision.scope) !== '["synthetic"]'
      || !Array.isArray(decision.completionCriteria) || !decision.completionCriteria.length
      || Object.keys(decision).sort().join(',') !== 'action,completionCriteria,objective,scope') throw new Error('Only synthetic fake-check is allowed')
    text(decision.objective); decision.completionCriteria.forEach(text)
    const normalized = JSON.stringify({ action: decision.action, objective: decision.objective, scope: decision.scope, completionCriteria: decision.completionCriteria })
    return this.tx(() => {
      const { event } = this.source(sourceConversation, eventId)
      const prior = this.one<Assignment>('SELECT * FROM coordination_assignments WHERE source_event=?', eventId)
      if (prior) {
        if (prior.decision !== normalized) throw new Error('Decision conflict for admitted source')
        return JSON.parse(prior.accepted) as AcceptedDecision
      }
      if (event.status === 'cancelled') throw new Error('Source was cancelled')
      const binding = this.one<{ agent_id: string; project_key: string; background: string }>('SELECT * FROM coordination_conversations WHERE id=?', FAKE_GROUP)!
      const id = randomUUID()
      // Freeze only group history + explicitly bound synthetic background.
      const messages = this.history(FAKE_GROUP)
      const context = JSON.stringify({ anchor: messages.at(-1)?.id ?? null, inputVersion: 1, background: binding.background, messages, decision })
      this.db.prepare(`INSERT INTO coordination_assignments
        (id,source_event,conversation_id,return_conversation,project_key,agent_id,decision,accepted,status,version,input_version,context,created_at)
        VALUES (?,?,?,'main',?,?,?,'{}','queued',1,1,?,?)`)
        .run(id, eventId, FAKE_GROUP, binding.project_key, binding.agent_id, normalized, context, this.now())
      this.fault('accept.assignment')
      const dispatch = this.message(FAKE_GROUP, this.labels.dispatchPrefix + decision.objective, 'main-agent', 'dispatch', id)
      const accepted = this.message('main', this.labels.acceptedPrefix + decision.objective, 'runtime', 'receipt', id)
      const result = { assignmentId: id, dispatchMessageId: dispatch.id, acceptedMessageId: accepted.id }
      this.db.prepare('UPDATE coordination_assignments SET accepted=? WHERE id=?').run(JSON.stringify(result), id)
      this.fault('accept.messages')
      return result
    })
  }
  assignments(conversation: string): Assignment[] { this.conversation(conversation); return this.all('SELECT * FROM coordination_assignments WHERE conversation_id=? ORDER BY seq', conversation) }
  runs(conversation: string): Run[] { this.conversation(conversation); return this.all('SELECT * FROM coordination_runs WHERE conversation_id=? ORDER BY seq', conversation) }
  questions(conversation: string): Question[] {
    this.conversation(conversation)
    return this.all('SELECT q.* FROM coordination_questions q JOIN coordination_assignments a ON a.id=q.assignment_id WHERE a.conversation_id=? ORDER BY q.rowid', conversation)
  }
  outbox(conversation: string): Outbox[] { this.conversation(conversation); return this.all('SELECT * FROM coordination_outbox WHERE conversation_id=? ORDER BY seq', conversation) }
  pendingOutbox(conversation: string): Outbox[] {
    this.conversation(conversation)
    return this.tx(() => {
      this.db.prepare(`UPDATE coordination_outbox SET status='superseded' WHERE conversation_id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM coordination_assignments a WHERE a.id=assignment_id
          AND (a.version<>coordination_outbox.version OR a.status<>coordination_outbox.kind))`).run(conversation)
      return this.all<Outbox>("SELECT * FROM coordination_outbox WHERE conversation_id=? AND status='pending' ORDER BY seq", conversation)
    })
  }
  private assignment(conversation: string, id: string): Assignment {
    const value = this.one<Assignment>('SELECT * FROM coordination_assignments WHERE id=? AND conversation_id=?', id, conversation)
    if (!value) throw new Error('Assignment not in conversation')
    return value
  }
  private run(conversation: string, id: string): Run {
    const value = this.one<Run>('SELECT * FROM coordination_runs WHERE id=? AND conversation_id=?', id, conversation)
    if (!value) throw new Error('Run not in conversation')
    return value
  }
  claim(conversation: string): Run | undefined {
    this.conversation(conversation)
    return this.tx(() => {
      const a = this.one<Assignment>(`SELECT * FROM coordination_assignments a WHERE a.conversation_id=? AND a.status='queued'
        AND NOT EXISTS(SELECT 1 FROM coordination_runs r WHERE r.project_key=a.project_key AND r.status IN ('starting','running','cancel_requested'))
        ORDER BY a.seq LIMIT 1`, conversation)
      if (!a) return undefined
      const id = randomUUID()
      this.db.prepare("UPDATE coordination_assignments SET status='running' WHERE id=?").run(a.id)
      this.db.prepare(`INSERT INTO coordination_runs (id,assignment_id,conversation_id,project_key,version,input_version,executor,context,status,started_at)
        VALUES (?,?,?,?,?,?,'FAKE',?,'starting',?)`).run(id, a.id, conversation, a.project_key, a.version, a.input_version, a.context, this.now())
      this.fault('claim.run')
      return this.run(conversation, id)
    })
  }
  started(conversation: string, runId: string): boolean {
    return this.db.prepare("UPDATE coordination_runs SET status='running' WHERE id=? AND conversation_id=? AND status='starting'").run(runId, conversation).changes === 1
  }
  private queueReceipt(a: Assignment, kind: FakeReceipt['kind'] | 'cancelled' | 'interrupted', body: string, runId: string | null): void {
    this.message(a.conversation_id, this.labels.receiptPrefix(kind) + body, 'fake-work-agent', 'receipt', a.id, runId)
    this.db.prepare(`INSERT INTO coordination_outbox (id,assignment_id,run_id,version,conversation_id,kind,body,status,created_at)
      VALUES (?,?,?,?,?,?,?,'pending',?)`).run(randomUUID(), a.id, runId, a.version, a.return_conversation, kind, body, this.now())
  }
  receipt(conversation: string, runId: string, receipt: FakeReceipt): { accepted: boolean } {
    if (!['completed','failed','waiting_input'].includes(receipt.kind)) throw new Error('Invalid fake receipt')
    text(receipt.body)
    const payload = JSON.stringify({ kind: receipt.kind, body: receipt.body })
    return this.tx(() => {
      const run = this.run(conversation, runId)
      const prior = this.one<{ payload: string; accepted: number }>('SELECT * FROM coordination_receipts WHERE run_id=?', runId)
      if (prior) {
        if (prior.payload !== payload) throw new Error('Receipt conflict')
        return { accepted: prior.accepted === 1 }
      }
      const a = this.assignment(conversation, run.assignment_id)
      const accepted = a.status === 'running' && a.version === run.version && ['starting','running'].includes(run.status)
      this.db.prepare('INSERT INTO coordination_receipts VALUES (?,?,?,?)').run(runId, payload, accepted ? 1 : 0, this.now())
      if (!accepted) return { accepted: false } // preserve late evidence without mutating terminal run/state
      this.db.prepare('UPDATE coordination_runs SET status=?,ended_at=?,result=? WHERE id=?')
        .run(receipt.kind === 'failed' ? 'failed' : 'succeeded', this.now(), payload, runId)
      this.db.prepare('UPDATE coordination_assignments SET status=? WHERE id=?').run(receipt.kind, a.id)
      if (receipt.kind === 'waiting_input') this.db.prepare(`INSERT INTO coordination_questions
        (id,assignment_id,run_id,version,body,status) VALUES (?,?,?,?,?,'pending')`).run(randomUUID(), a.id, runId, a.version, receipt.body)
      this.queueReceipt(a, receipt.kind, receipt.body, runId)
      this.fault('receipt.outbox')
      return { accepted: true }
    })
  }
  answer(conversation: string, questionId: string, sourceConversation: string, sourceEvent: string): Assignment {
    return this.tx(() => {
      const q = this.one<Question>('SELECT * FROM coordination_questions WHERE id=?', questionId)
      if (!q) throw new Error('Unknown question')
      const a = this.assignment(conversation, q.assignment_id)
      if (![a.conversation_id, a.return_conversation].includes(sourceConversation)) throw new Error('Answer outside binding')
      const { event, message } = this.source(sourceConversation, sourceEvent)
      if (q.status === 'answered' && q.answer_event === sourceEvent) return JSON.parse(q.answer_result!) as Assignment
      if (q.status !== 'pending' || a.status !== 'waiting_input' || a.version !== q.version || event.status === 'cancelled') throw new Error('Stale question or answer')
      this.db.prepare("UPDATE coordination_questions SET status='answered',answer_event=?,answer=? WHERE id=?").run(sourceEvent, message.content, q.id)
      // Keep the original frozen checkpoint and durable question/run evidence;
      // a resume adds only the bound answer, never newly arrived history.
      const context = JSON.parse(a.context) as Record<string, unknown>
      const answers = Array.isArray(context.answers) ? context.answers : []
      const next = JSON.stringify({ ...context, inputVersion: a.input_version + 1, answers: [...answers, { questionId, runId: q.run_id, question: q.body, sourceEvent, answer: message.content }] })
      this.db.prepare("UPDATE coordination_assignments SET status='queued',version=version+1,input_version=input_version+1,context=? WHERE id=?").run(next, a.id)
      const result = JSON.parse(JSON.stringify(this.assignment(conversation, a.id))) as Assignment
      this.db.prepare('UPDATE coordination_questions SET answer_result=? WHERE id=?').run(JSON.stringify(result), q.id)
      this.fault('answer.queued')
      return result
    })
  }
  cancel(conversation: string, assignmentId: string): Assignment {
    return this.tx(() => {
      const a = this.assignment(conversation, assignmentId)
      if (!['queued','waiting_input','running'].includes(a.status)) return a
      const running = a.status === 'running'
      this.db.prepare('UPDATE coordination_assignments SET status=?,version=version+1 WHERE id=?').run(running ? 'cancel_requested' : 'cancelled', a.id)
      this.db.prepare("UPDATE coordination_questions SET status='revoked' WHERE assignment_id=? AND status='pending'").run(a.id)
      if (running) this.db.prepare("UPDATE coordination_runs SET status='cancel_requested' WHERE assignment_id=? AND status IN ('starting','running')").run(a.id)
      else this.queueReceipt(this.assignment(conversation, a.id), 'cancelled', 'Cancelled before execution / while waiting', null)
      return this.assignment(conversation, a.id)
    })
  }
  confirmStopped(conversation: string, runId: string): void {
    this.tx(() => {
      const run = this.run(conversation, runId)
      if (run.status === 'cancelled') return
      const a = this.assignment(conversation, run.assignment_id)
      if (run.status !== 'cancel_requested' || a.status !== 'cancel_requested') throw new Error('No pending stop request')
      this.db.prepare("UPDATE coordination_runs SET status='cancelled',ended_at=? WHERE id=?").run(this.now(), runId)
      this.db.prepare("UPDATE coordination_assignments SET status='cancelled' WHERE id=?").run(a.id)
      this.queueReceipt(a, 'cancelled', 'FAKE executor explicitly confirmed stopped', runId)
    })
  }
  /** Offline restart reconciliation. Never invoke while a live worker owns this scope. */
  recover(conversation: string): number {
    this.conversation(conversation)
    return this.tx(() => {
      const runs = this.all<Run>("SELECT * FROM coordination_runs WHERE conversation_id=? AND status IN ('starting','running','cancel_requested')", conversation)
      for (const run of runs) {
        this.db.prepare("UPDATE coordination_runs SET status='unknown',ended_at=? WHERE id=?").run(this.now(), run.id)
        this.db.prepare("UPDATE coordination_assignments SET status='interrupted',version=version+1 WHERE id=?").run(run.assignment_id)
        this.queueReceipt(this.assignment(conversation, run.assignment_id), 'interrupted', 'Execution outcome unknown after restart; no replay', run.id)
      }
      this.db.prepare("UPDATE inbox_events SET status='pending',claimed_at=NULL,updated_at=? WHERE conversation_id=? AND type='user-message' AND status='claimed'").run(this.now(), conversation)
      this.db.prepare('DELETE FROM coordination_front_locks WHERE conversation_id=?').run(conversation)
      return runs.length
    })
  }
  deliver(conversation: string, outboxId: string, body?: string): ScopedMessage | undefined {
    return this.tx(() => {
      if (this.frontBusy(conversation)) throw new Error('Foreground turn in flight')
      const o = this.one<Outbox>('SELECT * FROM coordination_outbox WHERE id=? AND conversation_id=?', outboxId, conversation)
      if (!o) throw new Error('Outbox not in conversation')
      if (o.status === 'delivered') return this.one<ScopedMessage>('SELECT * FROM main_conversation_messages WHERE id=?', o.message_id!)!
      if (o.status === 'superseded') return undefined
      const a = this.one<Assignment>('SELECT * FROM coordination_assignments WHERE id=?', o.assignment_id)!
      if (a.version !== o.version || a.status !== o.kind) {
        this.db.prepare("UPDATE coordination_outbox SET status='superseded' WHERE id=?").run(o.id)
        return undefined
      }
      const message = this.message(conversation, body ?? `FAKE report ${o.kind}: ${o.body}`, 'main-agent', 'report', a.id, o.run_id)
      this.fault('deliver.message')
      this.db.prepare("UPDATE coordination_outbox SET status='delivered',message_id=? WHERE id=?").run(message.id, o.id)
      this.db.prepare('UPDATE coordination_front_state SET user_turns=0 WHERE conversation_id=?').run(conversation)
      return message
    })
  }
  beginChat(conversation: string): FrontTurn | undefined {
    this.conversation(conversation)
    return this.tx(() => {
      if (this.one('SELECT 1 FROM coordination_front_locks WHERE conversation_id=?', conversation)) return undefined
      const event = this.one<AdmittedEvent>(`SELECT * FROM inbox_events WHERE conversation_id=? AND type='user-message' AND status='pending'
        ORDER BY CASE priority WHEN 'interrupt' THEN 0 ELSE 1 END,append_order LIMIT 1`, conversation)
      if (!event) return undefined
      this.source(conversation, event.id)
      const context = this.history(conversation, event.user_message_id)
      this.db.prepare('INSERT INTO coordination_front_locks VALUES (?,?)').run(conversation, event.id)
      this.db.prepare("UPDATE inbox_events SET status='claimed',claimed_at=?,updated_at=? WHERE id=?").run(this.now(), this.now(), event.id)
      return { conversation, event, context: Object.freeze(context.map(m => Object.freeze(m))) }
    })
  }
  frontBusy(conversation: string): boolean { return !!this.one('SELECT 1 FROM coordination_front_locks WHERE conversation_id=?', conversation) }
  userTurnCount(conversation: string): number {
    this.conversation(conversation)
    return this.one<{ user_turns: number }>('SELECT user_turns FROM coordination_front_state WHERE conversation_id=?', conversation)!.user_turns
  }
  finishChat(turn: FrontTurn, content: string, author = turn.conversation === 'main' ? 'main-agent' : 'fake-work-agent'): ScopedMessage {
    return this.tx(() => {
      if (!this.one('SELECT 1 FROM coordination_front_locks WHERE conversation_id=? AND event_id=?', turn.conversation, turn.event.id)) throw new Error('Front turn lost ownership')
      const result = this.message(turn.conversation, content, author, 'chat')
      const update = this.db.prepare("UPDATE inbox_events SET status='processed',processed_at=?,updated_at=? WHERE id=? AND conversation_id=? AND status='claimed'")
        .run(this.now(), this.now(), turn.event.id, turn.conversation)
      if (update.changes !== 1) throw new Error('Front event lost claim')
      this.fault('front.message')
      this.db.prepare('UPDATE coordination_front_state SET user_turns=user_turns+1 WHERE conversation_id=?').run(turn.conversation)
      this.db.prepare('DELETE FROM coordination_front_locks WHERE conversation_id=?').run(turn.conversation)
      return result
    })
  }
  releaseChat(turn: FrontTurn): void {
    this.tx(() => {
      this.db.prepare("UPDATE inbox_events SET status='pending',claimed_at=NULL,updated_at=? WHERE id=? AND conversation_id=? AND status='claimed'").run(this.now(), turn.event.id, turn.conversation)
      this.db.prepare('DELETE FROM coordination_front_locks WHERE conversation_id=? AND event_id=?').run(turn.conversation, turn.event.id)
    })
  }
}
