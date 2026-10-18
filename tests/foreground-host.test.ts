import { describe, expect, it } from 'vitest'
import {
  defaultMainAgentCheckpoint,
  defaultMainAgentInstructions,
  MainAgentForegroundHost,
  type ForegroundHostEvent,
} from '../src/main/index.js'
import type {
  InboxEvent,
  MainAgentRuntimePort,
  ProcessNextUserMessageEventInput,
  ProcessNextUserMessageEventResult,
  ReceiveUserMessageInput,
  ReceiveUserMessageResult,
} from '../src/main/index.js'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(result => { resolve = result }), resolve }
}

type Queued = ReceiveUserMessageResult & { claimed: boolean }

class FakeRuntime implements MainAgentRuntimePort {
  readonly received: ReceiveUserMessageInput[] = []
  readonly processInputs: ProcessNextUserMessageEventInput[] = []
  readonly events: Queued[] = []
  processCalls = 0
  activeProcesses = 0
  maxActiveProcesses = 0
  scopedRecoveries = 0
  legacyRecoveries = 0
  #next = 0
  #gate: Promise<void> | undefined
  #failNext = false

  blockNextProcess(gate: Promise<void>): void {
    this.#gate = gate
  }

  failNextProcess(): void {
    this.#failNext = true
  }

  receiveUserMessage(input: ReceiveUserMessageInput): ReceiveUserMessageResult {
    this.received.push(input)
    const duplicate = this.events.find(event => event.event.idempotencyKey === input.idempotencyKey)
    if (duplicate) return { message: duplicate.message, event: duplicate.event, duplicate: true }
    const id = String(++this.#next)
    const receivedAt = input.receivedAt ?? '2026-09-16T00:00:00.000Z'
    const event: InboxEvent = {
      id: `event-${id}`,
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      type: 'user-message',
      priority: input.priority ?? 'normal',
      payload: null,
      status: 'pending',
      createdAt: receivedAt,
      updatedAt: receivedAt,
      userMessageId: `message-${id}`,
    }
    const result: Queued = {
      message: { id: `message-${id}`, role: 'user', content: input.content, createdAt: receivedAt },
      event,
      duplicate: false,
      claimed: false,
    }
    this.events.push(result)
    return result
  }

  claimNextPendingEvent(): InboxEvent | undefined { return undefined }
  completeInboxEvent(): InboxEvent { throw new Error('not used by foreground host') }
  cancelInboxEvent(): InboxEvent { throw new Error('not used by foreground host') }
  recoverClaimedEvents(): number { this.legacyRecoveries += 1; return 0 }

  recoverClaimedUserMessageEvents(): number {
    this.scopedRecoveries += 1
    let count = 0
    for (const queued of this.events) {
      if (!queued.claimed) continue
      queued.claimed = false
      queued.event = { ...queued.event, status: 'pending' }
      count += 1
    }
    return count
  }

  async processNextUserMessageEvent(input: ProcessNextUserMessageEventInput): Promise<ProcessNextUserMessageEventResult | undefined> {
    this.processInputs.push(input)
    const queued = this.events.find(event => !event.claimed && event.event.status === 'pending')
    if (!queued) return undefined
    this.processCalls += 1
    this.activeProcesses += 1
    this.maxActiveProcesses = Math.max(this.maxActiveProcesses, this.activeProcesses)
    try {
      queued.claimed = true
      queued.event = { ...queued.event, status: 'claimed' }
      const gate = this.#gate
      this.#gate = undefined
      if (gate) await gate
      if (this.#failNext) {
        this.#failNext = false
        throw new Error('fake provider failed')
      }
      const processed: InboxEvent = { ...queued.event, status: 'processed' }
      queued.event = processed
      queued.claimed = true
      return {
        event: processed,
        message: {
          id: `reply-${queued.message.id}`,
          role: 'assistant',
          content: `reply:${queued.message.content}`,
          createdAt: '2026-09-16T00:00:01.000Z',
        },
        response: { text: `reply:${queued.message.content}`, latencyMs: 1, usage: {} },
      }
    } finally {
      this.activeProcesses -= 1
    }
  }
}

describe('MainAgentForegroundHost', () => {
  it('treats an explicit owner-context checkpoint as usable user-provided background without granting authority', () => {
    expect(defaultMainAgentInstructions).toContain('本轮由用户提供的权威背景')
    expect(defaultMainAgentInstructions).toContain('自然使用相关事实')
    expect(defaultMainAgentInstructions).toContain('不得声称看不到或不知道其中内容')
    expect(defaultMainAgentInstructions).toContain('不要要求用户重复其中已有的事实')
    expect(defaultMainAgentInstructions).toContain('当前用户陈述冲突时以当前陈述为准')
    expect(defaultMainAgentInstructions).toContain('某项可能已过时时自然询问')
    expect(defaultMainAgentInstructions).toContain('包括宽泛的背景问题')
    expect(defaultMainAgentInstructions).toContain('区分明示事实、推断和未知')
    expect(defaultMainAgentInstructions).toContain('历史 assistant 对自身背景可见性的自述不是用户事实，不能覆盖当前可见的主人上下文')
    expect(defaultMainAgentInstructions).toContain('即使多次声称没有背景，也不应沿用')
    expect(defaultMainAgentInstructions).toContain('应主动简短纠正，并依据当前背景实质回答')
    expect(defaultMainAgentInstructions).toContain('不等于自动学习或创建持久的认识（Claim）、记忆或任务')
    expect(defaultMainAgentInstructions).toContain('也不提供任何授权')
    expect(defaultMainAgentInstructions).toContain('不能创建或写入任务、记忆或认识，也不能执行外部动作')
  })

  it('persists a submission synchronously, then processes it asynchronously with the fixed prefix', async () => {
    const runtime = new FakeRuntime()
    const gate = deferred<void>()
    runtime.blockNextProcess(gate.promise)
    const events: ForegroundHostEvent[] = []
    const host = new MainAgentForegroundHost(runtime, { onEvent: event => events.push(event) })

    host.start()
    const admitted = host.submit({ content: '第一条', idempotencyKey: 'one' })

    expect(admitted.duplicate).toBe(false)
    expect(runtime.received).toHaveLength(1)
    expect(runtime.received[0]).toMatchObject({ conversationId: 'main', content: '第一条', idempotencyKey: 'one' })
    expect(events.map(event => event.type)).toEqual(['recovered', 'submitted'])
    await Promise.resolve()
    expect(runtime.processCalls).toBe(1)
    expect(events.some(event => event.type === 'reply')).toBe(false)
    expect(runtime.processInputs[0]).toEqual({
      instructions: defaultMainAgentInstructions,
      checkpoint: defaultMainAgentCheckpoint,
      maxOutputTokens: 512,
      contextMessageLimit: 20,
    })

    gate.resolve()
    await host.waitForIdle()
    expect(events.at(-1)).toMatchObject({ type: 'reply', result: { message: { content: 'reply:第一条' } } })
  })

  it('drains input submitted between an empty drain returning and its finally settling', async () => {
    const runtime = new FakeRuntime()
    const gate = deferred<void>()
    runtime.blockNextProcess(gate.promise)
    const replies: string[] = []
    const host = new MainAgentForegroundHost(runtime, {
      onEvent: event => { if (event.type === 'reply') replies.push(event.result.message.content) },
    })

    host.start()
    let idle = false
    const waiting = host.waitForIdle().then(() => { idle = true })
    // The empty process is already resolved. Its await continuation returns
    // before this continuation, but its finally is queued after this one.
    await Promise.resolve()
    host.submit({ content: 'settling', idempotencyKey: 'settling' })
    host.submit({ content: 'later', idempotencyKey: 'later' })
    // Flush the old promise's settlement while the replacement drain is gated.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(runtime.processCalls).toBe(1)
    expect(idle).toBe(false)
    expect(replies).toEqual([])

    gate.resolve()
    await waiting
    expect(idle).toBe(true)
    expect(runtime.maxActiveProcesses).toBe(1)
    expect(replies).toEqual(['reply:settling', 'reply:later'])
    expect(runtime.events.map(event => event.event.status)).toEqual(['processed', 'processed'])
  })

  it('keeps one process in flight and drains later input in durable admission order', async () => {
    const runtime = new FakeRuntime()
    const gate = deferred<void>()
    runtime.blockNextProcess(gate.promise)
    const replies: string[] = []
    const host = new MainAgentForegroundHost(runtime, {
      onEvent: event => { if (event.type === 'reply') replies.push(event.result.message.content) },
    })

    host.start()
    host.submit({ content: 'A', idempotencyKey: 'a' })
    host.submit({ content: 'B', idempotencyKey: 'b' })
    host.submit({ content: 'C', idempotencyKey: 'c' })

    expect(runtime.received.map(input => input.content)).toEqual(['A', 'B', 'C'])
    await Promise.resolve()
    expect(runtime.processCalls).toBe(1)
    expect(runtime.maxActiveProcesses).toBe(1)

    gate.resolve()
    await host.waitForIdle()

    expect(runtime.maxActiveProcesses).toBe(1)
    expect(replies).toEqual(['reply:A', 'reply:B', 'reply:C'])
  })

  it('does not recover or restart processing during a gated first process or after success', async () => {
    const runtime = new FakeRuntime()
    const gate = deferred<void>()
    runtime.blockNextProcess(gate.promise)
    const events: ForegroundHostEvent[] = []
    const host = new MainAgentForegroundHost(runtime, { onEvent: event => events.push(event) })

    host.start()
    host.submit({ content: 'first', idempotencyKey: 'one' })
    await Promise.resolve()
    expect(runtime.processCalls).toBe(1)
    const claim = runtime.events[0]!.event
    const eventCount = events.length
    const processCount = runtime.processInputs.length

    expect(host.recover()).toBeUndefined()
    await Promise.resolve()
    expect(runtime.scopedRecoveries).toBe(1)
    expect(runtime.events[0]!.event).toBe(claim)
    expect(runtime.events[0]!.claimed).toBe(true)
    expect(claim.status).toBe('claimed')
    expect(runtime.processInputs).toHaveLength(processCount)
    expect(runtime.processCalls).toBe(1)
    expect(events).toHaveLength(eventCount)

    gate.resolve()
    await host.waitForIdle()
    expect(runtime.processCalls).toBe(1)
    expect(runtime.maxActiveProcesses).toBe(1)
    expect(events.filter(event => event.type === 'reply')).toHaveLength(1)

    const idleProcessCount = runtime.processInputs.length
    const idleEventCount = events.length
    expect(host.recover()).toBeUndefined()
    await host.waitForIdle()
    expect(runtime.scopedRecoveries).toBe(1)
    expect(runtime.processInputs).toHaveLength(idleProcessCount)
    expect(events).toHaveLength(idleEventCount)
  })

  it('does not recover from an error callback before the failed drain settles', async () => {
    const runtime = new FakeRuntime()
    const host = new MainAgentForegroundHost(runtime, {
      onEvent: event => {
        if (event.type === 'error') expect(host.recover()).toBeUndefined()
      },
    })

    host.start()
    runtime.failNextProcess()
    host.submit({ content: 'first', idempotencyKey: 'one' })
    expect(host.getStatus()).toBe('processing')
    await host.waitForIdle()
    expect(host.getStatus()).toBe('blocked')
    expect(runtime.scopedRecoveries).toBe(1)
    expect(runtime.processCalls).toBe(1)
    expect(runtime.events[0]!.event.status).toBe('claimed')

    expect(host.recover()).toBe(1)
    expect(host.getStatus()).toBe('processing')
    await host.waitForIdle()
    expect(host.getStatus()).toBe('idle')
    expect(runtime.scopedRecoveries).toBe(2)
    expect(runtime.processCalls).toBe(2)
    expect(runtime.events[0]!.event.status).toBe('processed')
  })

  it('uses only scoped user-message recovery at startup and never calls legacy recovery', () => {
    const runtime = new FakeRuntime()
    const events: ForegroundHostEvent[] = []
    const host = new MainAgentForegroundHost(runtime, { onEvent: event => events.push(event) })

    expect(host.start()).toBe(0)
    expect(host.start()).toBe(0)
    expect(runtime.scopedRecoveries).toBe(1)
    expect(runtime.legacyRecoveries).toBe(0)
    expect(events).toContainEqual({ type: 'recovered', source: 'startup', count: 0 })
  })

  it('does not retry a failed claim until explicit scoped recovery, while later input still persists', async () => {
    const runtime = new FakeRuntime()
    const events: ForegroundHostEvent[] = []
    const host = new MainAgentForegroundHost(runtime, { onEvent: event => events.push(event) })

    host.start()
    runtime.failNextProcess()
    host.submit({ content: 'first', idempotencyKey: 'one' })
    await host.waitForIdle()
    expect(runtime.processCalls).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'error' })

    host.submit({ content: 'later', idempotencyKey: 'two' })
    await host.waitForIdle()
    expect(runtime.received.map(input => input.content)).toEqual(['first', 'later'])
    expect(runtime.processCalls).toBe(1)

    expect(host.recover()).toBe(1)
    await host.waitForIdle()
    expect(runtime.legacyRecoveries).toBe(0)
    expect(runtime.scopedRecoveries).toBe(2)
    expect(events.filter(event => event.type === 'reply').map(event =>
      event.type === 'reply' ? event.result.message.content : '',
    )).toEqual(['reply:first', 'reply:later'])
  })

  it('preserves the default checkpoint in admission snapshots when a later checkpoint replaces it', async () => {
    const runtime = new FakeRuntime()
    const gate = deferred<void>()
    runtime.blockNextProcess(gate.promise)
    const replacementCheckpoint = 'replacement checkpoint'
    const host = new MainAgentForegroundHost(runtime)

    host.start()
    host.submit({ content: 'first', idempotencyKey: 'one' })
    await Promise.resolve()
    host.setCheckpoint(replacementCheckpoint)
    host.submit({ content: 'second', idempotencyKey: 'two' })
    gate.resolve()
    await host.waitForIdle()

    expect(runtime.processInputs.slice(1, 3).map(input => input.checkpoint)).toEqual([
      defaultMainAgentCheckpoint,
      replacementCheckpoint,
    ])
    expect(runtime.received.map(input => input.checkpointSnapshot)).toEqual([
      defaultMainAgentCheckpoint,
      replacementCheckpoint,
    ])
  })

  it('preserves an explicit owner-context checkpoint in admission snapshots and processing input', async () => {
    const runtime = new FakeRuntime()
    const gate = deferred<void>()
    runtime.blockNextProcess(gate.promise)
    const explicitOwnerContext = '主人：偏好早上沟通；项目 Orion 的负责人是小林。'
    const updatedOwnerContext = '更新后的主人上下文：项目 Orion 已暂停。'
    const host = new MainAgentForegroundHost(runtime, { checkpoint: explicitOwnerContext })

    host.start()
    host.submit({ content: 'first', idempotencyKey: 'one' })
    await Promise.resolve()
    host.setCheckpoint(updatedOwnerContext)
    host.submit({ content: 'second', idempotencyKey: 'two' })
    gate.resolve()
    await host.waitForIdle()

    expect(runtime.processInputs.slice(1, 3).map(input => input.checkpoint)).toEqual([
      explicitOwnerContext,
      updatedOwnerContext,
    ])
    // The admission snapshots — not just transient drain inputs — retain the
    // value each user message observed while the prior turn was active.
    expect(runtime.received.map(input => input.checkpointSnapshot)).toEqual([
      explicitOwnerContext,
      updatedOwnerContext,
    ])
  })
})
