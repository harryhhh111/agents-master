import { CoordinationStore, type CliExecutionRecord, type FakeReceipt, type Run, type ScopedMessage } from './store.js'

export interface FakeExecutor {
  readonly identity: 'FAKE' | 'CLI'
  execute(run: Readonly<Run>): Promise<FakeReceipt | { kind: 'stopped'; execution?: CliExecutionRecord }>
}

/** Only explicit test/demo controls finish work; no text routing or real IO. */
export class HeldFakeExecutor implements FakeExecutor {
  readonly identity = 'FAKE' as const
  readonly started: Readonly<Run>[] = []
  private readonly held = new Map<string, (result: FakeReceipt | { kind: 'stopped' }) => void>()
  execute(run: Readonly<Run>): Promise<FakeReceipt | { kind: 'stopped' }> {
    this.started.push(Object.freeze({ ...run }))
    return new Promise(resolve => this.held.set(run.id, resolve))
  }
  finish(runId: string, receipt: FakeReceipt): void { this.resolve(runId, receipt) }
  confirmStop(runId: string): void { this.resolve(runId, { kind: 'stopped' }) }
  private resolve(runId: string, value: FakeReceipt | { kind: 'stopped' }): void {
    const resolve = this.held.get(runId)
    if (!resolve) throw new Error('No held FAKE execution')
    this.held.delete(runId); resolve(value)
  }
}

export class FakeBackgroundScheduler {
  private closed = false
  private readonly pending = new Map<string, Promise<void>>()
  readonly errors: unknown[] = []
  constructor(private readonly store: CoordinationStore, private readonly executor: FakeExecutor, private readonly changed: () => void = () => {}) {
    if (!['FAKE', 'CLI'].includes(executor.identity)) throw new Error('This slice only permits declared coordination executors')
  }
  startNext(conversation: string): Run | undefined {
    if (this.closed) return undefined
    const run = this.store.claim(conversation)
    if (!run) return undefined
    if (!this.store.started(conversation, run.id)) return undefined
    this.changed()
    // Execution starts outside the claim transaction, on an independent queue.
    const done = Promise.resolve().then(() => this.executor.execute(Object.freeze({ ...run, status: 'running' })))
      .then(receipt => {
        if (this.closed) return
        // 退出未确认：不终结 run（保持项目占用），assignment 失败，重启时 recover 恢复。
        if (receipt.execution?.cancelConfirmed === false) {
          this.store.holdUncertainExit(conversation, run.id, receipt.execution, receipt.kind === 'stopped'
            ? '取消未能确认进程退出：已保留项目占用防止与残留执行并发，worker 重启后按未知结局恢复'
            : '执行超时且进程退出未确认：已保留项目占用防止与残留执行并发，worker 重启后按未知结局恢复')
        }
        else if (receipt.kind === 'stopped') this.store.confirmStopped(conversation, run.id, receipt.execution)
        else this.store.receipt(conversation, run.id, receipt)
      }, error => { if (!this.closed) this.store.receipt(conversation, run.id, { kind: 'failed', body: `FAKE executor error: ${String(error)}` }) })
      .catch(error => { this.errors.push(error) })
      .finally(() => { this.pending.delete(run.id); if (!this.closed) this.changed() })
    this.pending.set(run.id, done)
    return run
  }
  async settled(runId: string): Promise<void> { await this.pending.get(runId) }
  /** No real processes exist in this slice. Unsettled runs remain unknown on reopen. */
  close(): void { this.closed = true }
}

type WriterState = { tail: Promise<unknown> }
const writers = new WeakMap<CoordinationStore, Map<string, WriterState>>()
export type FakeCompletion = (context: readonly ScopedMessage[]) => Promise<string>
export type SafePointResult = { kind: 'chat' | 'report' | 'idle'; message?: ScopedMessage; deliveryError?: string }

/** One shared front writer per scope. DB locks also fence a second connection
 * while completion is in flight. All long awaits happen outside transactions. */
export class FakeForegroundScheduler {
  private readonly writer: WriterState
  constructor(private readonly store: CoordinationStore, private readonly conversation: string,
    private readonly complete: FakeCompletion = async context => `FAKE completed foreground reply: ${context.at(-1)?.content ?? ''}`,
    private readonly report: (body: string) => string = body => `FAKE report: ${body}`,
    private readonly maxUserTurns = 3) {
    if (!Number.isSafeInteger(maxUserTurns) || maxUserTurns < 1) throw new Error('Invalid fairness bound')
    let scopes = writers.get(store)
    if (!scopes) { scopes = new Map(); writers.set(store, scopes) }
    let writer = scopes.get(conversation)
    if (!writer) { writer = { tail: Promise.resolve() }; scopes.set(conversation, writer) }
    this.writer = writer
  }
  /** Deterministic control persists immediately; any report waits for a safe point. */
  cancel(assignmentId: string): void { this.store.cancel('fake-work', assignmentId) }
  step(): Promise<SafePointResult> {
    const next = this.writer.tail.then(() => this.safePoint())
    this.writer.tail = next.catch(() => {})
    return next
  }
  private async safePoint(): Promise<SafePointResult> {
    if (this.store.frontBusy(this.conversation)) return { kind: 'idle' }
    let deliveryError: string | undefined
    const deliver = (): ScopedMessage | undefined => {
      for (const receipt of this.store.pendingOutbox(this.conversation)) {
        try {
          const message = this.store.deliver(this.conversation, receipt.id, this.report(receipt.body))
          if (message) return message
        } catch (error) { deliveryError = String(error); return undefined }
      }
      return undefined
    }
    if (this.store.userTurnCount(this.conversation) >= this.maxUserTurns) {
      const message = deliver()
      if (message) return { kind: 'report', message }
    }
    const turn = this.store.beginChat(this.conversation)
    if (turn) {
      try {
        const response = await this.complete(turn.context)
        const message = this.store.finishChat(turn, response)
        return { kind: 'chat', message, ...(deliveryError ? { deliveryError } : {}) }
      } catch (error) { this.store.releaseChat(turn); throw error }
    }
    const message = deliveryError ? undefined : deliver()
    return { kind: message ? 'report' : 'idle', ...(message ? { message } : {}), ...(deliveryError ? { deliveryError } : {}) }
  }
}
