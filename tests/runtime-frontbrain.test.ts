import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FrontBrain, FrontBrainRequest } from '../src/frontbrain/index.js'
import {
  createMainAgentRuntime,
  MainAgentRuntime,
  SQLiteMainInboxStore,
} from '../src/main/index.js'

const instructions = '你是主 Agent 前台。回复要短。'
const checkpoint = '检查点 v1：先确认上下文再回答。'
const clockTime = '2026-09-15T02:00:00.000Z'

function makeFakeBrain(script: Array<string | Error>): { brain: FrontBrain; requests: FrontBrainRequest[] } {
  const requests: FrontBrainRequest[] = []
  const brain: FrontBrain = {
    async complete(request) {
      requests.push(request)
      const reply = script.shift()
      if (reply instanceof Error) throw reply
      if (reply === undefined) throw new Error('fake FrontBrain ran out of scripted replies')
      return {
        text: reply,
        finishReason: 'stop',
        latencyMs: 7,
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      }
    },
  }
  return { brain, requests }
}

function openStore(databasePath: string): SQLiteMainInboxStore {
  return new SQLiteMainInboxStore(databasePath, { clock: () => clockTime })
}

function countRows(databasePath: string, table: string): number {
  const direct = new DatabaseSync(databasePath)
  try {
    return Number(direct.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)
  } finally {
    direct.close()
  }
}

describe('runtime user-message processing with a fake FrontBrain', () => {
  let dir: string
  let databasePath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'runtime-frontbrain-test-'))
    databasePath = path.join(dir, 'main.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('claims the next user message, composes the stable prefix plus chronological conversation, and persists reply with processed state', async () => {
    const store = openStore(databasePath)
    store.appendMessage({ role: 'assistant', content: '更早的回复', createdAt: '2026-09-15T00:58:00.000Z' })
    store.appendMessage({ role: 'user', content: '更早的追问', createdAt: '2026-09-15T00:59:00.000Z' })
    const received = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '今天过得怎么样？',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const { brain, requests } = makeFakeBrain(['今天很好，谢谢。'])
    const runtime = new MainAgentRuntime(store, brain)

    const result = await runtime.processNextUserMessageEvent({
      instructions, checkpoint, maxOutputTokens: 128,
    })

    expect(result).toBeDefined()
    expect(result!.event).toMatchObject({
      id: received.event.id, type: 'user-message', status: 'processed', processedAt: clockTime,
    })
    expect(result!.message).toMatchObject({ role: 'assistant', content: '今天很好，谢谢。' })
    expect(result!.response).toMatchObject({ text: '今天很好，谢谢。', finishReason: 'stop' })
    // The composed request: stable prefix verbatim, then the persisted
    // conversation (including the triggering user message) chronologically.
    expect(requests).toHaveLength(1)
    expect(requests[0].maxOutputTokens).toBe(128)
    expect(requests[0].messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'system', content: checkpoint },
      { role: 'assistant', content: '更早的回复' },
      { role: 'user', content: '更早的追问' },
      { role: 'user', content: '今天过得怎么样？' },
    ])
    expect(store.readRecentContext().map(message => [message.role, message.content])).toEqual([
      ['assistant', '更早的回复'],
      ['user', '更早的追问'],
      ['user', '今天过得怎么样？'],
      ['assistant', '今天很好，谢谢。'],
    ])
    // The processed event is no longer eligible for another foreground turn.
    expect(await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 128 })).toBeUndefined()
    store.close()
  })

  it('claims interrupt user messages before normal ones and never claims or alters non-user events', async () => {
    const store = openStore(databasePath)
    const timer = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'timer-1', type: 'timer', payload: { at: 'daily' },
      createdAt: '2026-09-15T01:00:00.000Z',
    }).event
    const domainInterrupt = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'domain-1', type: 'domain-update', priority: 'interrupt',
      payload: { state: 'paused' }, createdAt: '2026-09-15T01:01:00.000Z',
    }).event
    const normalUser = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'user-1', content: '普通问题', priority: 'normal',
      receivedAt: '2026-09-15T01:02:00.000Z',
    }).event
    const interruptUser = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'user-2', content: '紧急问题', priority: 'interrupt',
      receivedAt: '2026-09-15T01:03:00.000Z',
    }).event
    const { brain, requests } = makeFakeBrain(['回答紧急问题', '回答普通问题'])
    const runtime = new MainAgentRuntime(store, brain)

    const first = await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })
    const second = await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })

    expect(first!.event.id).toBe(interruptUser.id)
    expect(second!.event.id).toBe(normalUser.id)
    // Each turn's context is anchored at its own claimed message: the first
    // turn (紧急问题) sees the earlier user message before it, the second
    // turn (普通问题) sees neither the later user message nor the earlier
    // turn's reply — nothing appended after the anchor ever leaks.
    expect(requests[0].messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'user', content: '普通问题' },
      { role: 'user', content: '紧急问题' },
    ])
    expect(requests[1].messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'user', content: '普通问题' },
    ])

    // Timer and domain-update events were never claimed or altered.
    const direct = new DatabaseSync(databasePath)
    try {
      const statuses = direct.prepare('SELECT id, status, claimed_at FROM inbox_events ORDER BY append_order').all()
      expect(statuses).toEqual([
        { id: timer.id, status: 'pending', claimed_at: null },
        { id: domainInterrupt.id, status: 'pending', claimed_at: null },
        { id: normalUser.id, status: 'processed', claimed_at: clockTime },
        { id: interruptUser.id, status: 'processed', claimed_at: clockTime },
      ])
    } finally {
      direct.close()
    }
    // The legacy claim surface still picks the interrupt domain-update first.
    expect(store.claimNextPendingEvent('2026-09-15T02:01:00.000Z')!.id).toBe(domainInterrupt.id)
    store.close()
  })

  it('returns undefined and leaves non-user events pending when only those are queued', async () => {
    const store = openStore(databasePath)
    const timer = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'timer-1', type: 'timer', payload: { at: 'daily' },
      createdAt: '2026-09-15T01:00:00.000Z',
    }).event
    const { brain, requests } = makeFakeBrain([])
    const runtime = new MainAgentRuntime(store, brain)

    const result = await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })

    expect(result).toBeUndefined()
    expect(requests).toHaveLength(0)
    expect(store.claimNextPendingEvent('2026-09-15T02:01:00.000Z'))
      .toMatchObject({ id: timer.id, status: 'claimed' })
    store.close()
  })

  it.each([
    ['empty instructions', { instructions: '   ', maxOutputTokens: 64 }, 'instructions must not be empty'],
    ['non-string checkpoint', { instructions, checkpoint: null as unknown as string, maxOutputTokens: 64 }, 'checkpoint must be a string when provided'],
    ['invalid context message limit', { instructions, maxOutputTokens: 64, contextMessageLimit: 0 }, 'contextMessageLimit must be a positive integer no greater than 100'],
    ['invalid output token cap', { instructions, maxOutputTokens: 0 }, 'maxOutputTokens must be an integer between 1 and 8192'],
  ])('rejects %s before claiming the pending user event', async (_name, invalidInput, error) => {
    const store = openStore(databasePath)
    const received = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '必须保持 pending',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const { brain, requests } = makeFakeBrain([])
    const runtime = new MainAgentRuntime(store, brain)

    await expect(runtime.processNextUserMessageEvent(invalidInput)).rejects.toThrow(error)
    expect(requests).toHaveLength(0)
    const direct = new DatabaseSync(databasePath)
    try {
      expect(direct.prepare('SELECT status, claimed_at FROM inbox_events WHERE id = ?').get(received.event.id))
        .toEqual({ status: 'pending', claimed_at: null })
    } finally {
      direct.close()
    }
    store.close()
  })

  it('keeps a provider-failed event claimed with nothing persisted, then recovers and persists exactly one reply', async () => {
    const store = openStore(databasePath)
    const received = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '这个问题会先失败',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const { brain, requests } = makeFakeBrain([new Error('provider boom'), '重试后的回复'])
    const runtime = new MainAgentRuntime(store, brain)

    await expect(runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 }))
      .rejects.toThrow('provider boom')
    // The event stays claimed; nothing was persisted into the conversation.
    expect(store.claimNextPendingUserMessageEvent('2026-09-15T02:01:00.000Z')).toBeUndefined()
    expect(store.readRecentContext()).toEqual([received.message])
    expect(countRows(databasePath, 'main_conversation_messages')).toBe(1)
    expect(requests).toHaveLength(1)
    // The raw provider error never leaks into stored conversation bytes.
    expect(store.readRecentContext().map(message => message.content)).not.toContain('provider boom')

    // Explicit scoped recovery returns the abandoned claim to pending; the
    // retry regenerates the reply and persists exactly one assistant message.
    expect(runtime.recoverClaimedUserMessageEvents('2026-09-15T02:02:00.000Z')).toBe(1)
    const result = await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })
    expect(result!.message).toMatchObject({ role: 'assistant', content: '重试后的回复' })
    expect(result!.event).toMatchObject({ id: received.event.id, status: 'processed' })
    expect(requests).toHaveLength(2)
    expect(countRows(databasePath, 'main_conversation_messages')).toBe(2)
    const direct = new DatabaseSync(databasePath)
    try {
      expect(direct.prepare("SELECT COUNT(*) AS count FROM main_conversation_messages WHERE role = 'assistant'").get())
        .toEqual({ count: 1 })
    } finally {
      direct.close()
    }
    store.close()
  })

  it('never persists a duplicate assistant reply: a second recorded transition rolls back atomically', async () => {
    const store = openStore(databasePath)
    const received = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '只处理一次',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const { brain } = makeFakeBrain(['唯一的回复'])
    const runtime = new MainAgentRuntime(store, brain)

    const result = await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })
    expect(result!.event.status).toBe('processed')

    // Replaying the persistence step for the same event must fail and roll
    // back, committing neither a second assistant message nor a state change.
    expect(() => store.recordProcessedUserMessageEvent({
      eventId: received.event.id, content: '重复回复', processedAt: '2026-09-15T02:03:00.000Z',
    })).toThrow(`Cannot transition inbox event ${received.event.id} from processed to processed`)
    expect(countRows(databasePath, 'main_conversation_messages')).toBe(2)
    const direct = new DatabaseSync(databasePath)
    try {
      expect(direct.prepare("SELECT content FROM main_conversation_messages WHERE role = 'assistant'").all())
        .toEqual([{ content: '唯一的回复' }])
      expect(direct.prepare('SELECT status, processed_at FROM inbox_events WHERE id = ?').get(received.event.id))
        .toEqual({ status: 'processed', processed_at: clockTime })
    } finally {
      direct.close()
    }
    // The event is no longer eligible for a foreground turn.
    expect(await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })).toBeUndefined()
    store.close()
  })

  it('refuses to record a processed reply for non-user events and persists nothing', async () => {
    const store = openStore(databasePath)
    const timer = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'timer-1', type: 'timer', payload: { at: 'daily' },
      createdAt: '2026-09-15T01:00:00.000Z',
    }).event
    store.claimNextPendingEvent('2026-09-15T02:01:00.000Z')
    expect(() => store.recordProcessedUserMessageEvent({
      eventId: timer.id, content: '不该存在', processedAt: '2026-09-15T02:02:00.000Z',
    })).toThrow(`Cannot record a processed reply for non-user inbox event ${timer.id} (type timer)`)
    expect(countRows(databasePath, 'main_conversation_messages')).toBe(0)
    store.close()
  })

  it('treats an empty FrontBrain reply as a failure: event stays claimed, nothing persisted', async () => {
    const store = openStore(databasePath)
    const received = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '会得到空回复',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const { brain } = makeFakeBrain(['   '])
    const runtime = new MainAgentRuntime(store, brain)

    await expect(runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 }))
      .rejects.toThrow(`FrontBrain returned an empty reply for inbox event ${received.event.id}`)
    expect(countRows(databasePath, 'main_conversation_messages')).toBe(1)
    expect(store.recoverClaimedUserMessageEvents('2026-09-15T02:01:00.000Z')).toBe(1)
    store.close()
  })

  it('anchors the context at the claimed message: later user messages never leak and the claimed message is always included', async () => {
    const store = openStore(databasePath)
    store.appendMessage({ role: 'assistant', content: '历史回复', createdAt: '2026-09-15T00:57:00.000Z' })
    store.appendMessage({ role: 'user', content: '历史消息', createdAt: '2026-09-15T00:58:00.000Z' })
    store.appendMessage({ role: 'user', content: '更早的追问', createdAt: '2026-09-15T00:59:00.000Z' })
    const first = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '第一条待处理',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-2', content: '更晚的用户消息',
      receivedAt: '2026-09-15T01:01:00.000Z',
    })
    const { brain, requests } = makeFakeBrain(['回答第一条', '回答第二条'])
    const runtime = new MainAgentRuntime(store, brain)

    // Turn 1: claimed message is '第一条待处理'. The later user message
    // ('更晚的用户消息', still pending) must not leak into this turn, and a
    // limit smaller than the history must never omit the claimed message.
    const firstResult = await runtime.processNextUserMessageEvent({
      instructions, checkpoint, maxOutputTokens: 64, contextMessageLimit: 2,
    })
    expect(firstResult!.event.id).toBe(first.event.id)
    expect(requests[0].messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'system', content: checkpoint },
      { role: 'user', content: '更早的追问' },
      { role: 'user', content: '第一条待处理' },
    ])

    // Turn 2: the later message is now the anchor; nothing after it exists,
    // and the previous turn's reply was appended after it, so it is excluded.
    const secondResult = await runtime.processNextUserMessageEvent({
      instructions, maxOutputTokens: 64,
    })
    expect(secondResult!.message.content).toBe('回答第二条')
    expect(requests[1].messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'assistant', content: '历史回复' },
      { role: 'user', content: '历史消息' },
      { role: 'user', content: '更早的追问' },
      { role: 'user', content: '第一条待处理' },
      { role: 'user', content: '更晚的用户消息' },
    ])
    store.close()
  })

  it('always includes the claimed user message when contextMessageLimit is tiny', async () => {
    const store = openStore(databasePath)
    store.appendMessage({ role: 'assistant', content: '历史回复一', createdAt: '2026-09-15T00:56:00.000Z' })
    store.appendMessage({ role: 'user', content: '历史消息一', createdAt: '2026-09-15T00:57:00.000Z' })
    store.appendMessage({ role: 'assistant', content: '历史回复二', createdAt: '2026-09-15T00:58:00.000Z' })
    const received = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '被领取的那条',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const { brain, requests } = makeFakeBrain(['收到'])
    const runtime = new MainAgentRuntime(store, brain)

    const result = await runtime.processNextUserMessageEvent({
      instructions, checkpoint, maxOutputTokens: 64, contextMessageLimit: 1,
    })

    expect(result!.event.id).toBe(received.event.id)
    // The stable prefix stays verbatim and the claimed message survives even a
    // limit of one — the anchor is always inside its own window.
    expect(requests[0].messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'system', content: checkpoint },
      { role: 'user', content: '被领取的那条' },
    ])
    store.close()
  })

  it('excludes conversation messages admitted after the claimed event from its composed context', async () => {
    const store = openStore(databasePath)
    store.appendMessage({ role: 'user', content: '更早的历史', createdAt: '2026-09-15T00:58:00.000Z' })
    const claimed = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '要处理的这条',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    // Admitted after the claimed event: a later user message and an assistant
    // reply persisted by another consumer. Neither may leak into this turn.
    store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-2', content: '之后才到的用户消息',
      receivedAt: '2026-09-15T01:01:00.000Z',
    })
    store.appendMessage({ role: 'assistant', content: '其他消费者追加的回复', createdAt: '2026-09-15T01:02:00.000Z' })
    const { brain, requests } = makeFakeBrain(['只看到截至这条的上下文'])
    const runtime = new MainAgentRuntime(store, brain)

    const result = await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })

    expect(result!.event.id).toBe(claimed.event.id)
    expect(requests[0].messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'user', content: '更早的历史' },
      { role: 'user', content: '要处理的这条' },
    ])
    store.close()
  })

  it('composes identical anchored context bytes for the same claimed event across a retry', async () => {
    const store = openStore(databasePath)
    store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '要重试的消息',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const { brain, requests } = makeFakeBrain([new Error('provider boom'), '重试成功'])
    const runtime = new MainAgentRuntime(store, brain)

    await expect(runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 }))
      .rejects.toThrow('provider boom')
    const failedRequest = requests[0]
    expect(runtime.recoverClaimedUserMessageEvents('2026-09-15T02:01:00.000Z')).toBe(1)
    await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })

    expect(requests).toHaveLength(2)
    expect(requests[1].messages).toEqual(failedRequest.messages)
    expect(requests[1].messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'user', content: '要重试的消息' },
    ])
    expect(await runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 }))
      .toBeUndefined()
    store.close()
  })

  it('recovers only claimed user-message events; claimed timer/domain-update events keep their claims', async () => {
    const store = openStore(databasePath)
    const timer = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'timer-1', type: 'timer', payload: { at: 'daily' },
      createdAt: '2026-09-15T01:00:00.000Z',
    }).event
    const domain = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'domain-1', type: 'domain-update', payload: { state: 'paused' },
      createdAt: '2026-09-15T01:01:00.000Z',
    }).event
    const user = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'user-1', content: '前台工作',
      receivedAt: '2026-09-15T01:02:00.000Z',
    }).event
    const otherClaimAt = '2026-09-15T01:03:00.000Z'
    expect(store.claimNextPendingEvent(otherClaimAt)!.id).toBe(timer.id)
    expect(store.claimNextPendingEvent(otherClaimAt)!.id).toBe(domain.id)
    expect(store.claimNextPendingUserMessageEvent(otherClaimAt)!.id).toBe(user.id)
    const runtime = new MainAgentRuntime(store)

    // Scoped recovery: only the claimed user-message event returns to pending.
    expect(runtime.recoverClaimedUserMessageEvents('2026-09-15T02:00:00.000Z')).toBe(1)
    const direct = new DatabaseSync(databasePath)
    try {
      expect(direct.prepare('SELECT id, status, claimed_at FROM inbox_events ORDER BY append_order').all())
        .toEqual([
          { id: timer.id, status: 'claimed', claimed_at: otherClaimAt },
          { id: domain.id, status: 'claimed', claimed_at: otherClaimAt },
          { id: user.id, status: 'pending', claimed_at: null },
        ])
    } finally {
      direct.close()
    }
    // The foreground surface can immediately reprocess the recovered event.
    const { brain } = makeFakeBrain(['恢复后的回复'])
    const wired = new MainAgentRuntime(store, brain)
    const result = await wired.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })
    expect(result!.event).toMatchObject({ id: user.id, status: 'processed' })

    // Legacy surface retained: recoverClaimedEvents still resets every claim.
    expect(store.recoverClaimedEvents('2026-09-15T02:02:00.000Z')).toBe(2)
    expect(store.claimNextPendingEvent('2026-09-15T02:03:00.000Z')!.id).toBe(timer.id)
    store.close()
  })

  it('fails loudly instead of silently omitting the anchor when the claimed event has no conversation message', async () => {
    const store = openStore(databasePath)
    store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '锚点被破坏',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const direct = new DatabaseSync(databasePath)
    try {
      direct.prepare('UPDATE inbox_events SET user_message_id = NULL').run()
    } finally {
      direct.close()
    }
    const { brain, requests } = makeFakeBrain([])
    const runtime = new MainAgentRuntime(store, brain)

    await expect(runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 }))
      .rejects.toThrow('has no conversation message to anchor the foreground context on')
    expect(requests).toHaveLength(0)
    // The un-anchorable event stays claimed and is recoverable via the
    // scoped protocol instead of blocking other events forever.
    expect(store.recoverClaimedUserMessageEvents('2026-09-15T02:01:00.000Z')).toBe(1)
    store.close()
  })

  it('rejects an unknown anchor message instead of silently composing an empty context', async () => {
    const store = openStore(databasePath)
    expect(() => store.readContextThroughMessage('no-such-message', 10))
      .toThrow('Main conversation message not found: no-such-message')
    store.close()
  })

  it('keeps the legacy executor-free surface working and explains missing FrontBrain wiring', async () => {
    const store = openStore(databasePath)
    const runtime = new MainAgentRuntime(store)
    const received = runtime.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '还没有大脑',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    await expect(runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 }))
      .rejects.toThrow('MainAgentRuntime has no FrontBrain wired')
    // The misconfigured call claims nothing; the legacy surface still works.
    expect(runtime.claimNextPendingEvent('2026-09-15T02:01:00.000Z'))
      .toMatchObject({ id: received.event.id, status: 'claimed' })
    expect(runtime.completeInboxEvent(received.event.id, '2026-09-15T02:02:00.000Z').status).toBe('processed')
    store.close()
  })

  it('wires an optional FrontBrain through the composition root', async () => {
    const { brain } = makeFakeBrain(['工厂接入的回复'])
    const resources = createMainAgentRuntime({
      dataDirectory: dir, databaseFileName: 'runtime.sqlite', frontBrain: brain,
    })
    resources.runtime.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '你好',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const result = await resources.runtime.processNextUserMessageEvent({ instructions, maxOutputTokens: 64 })
    expect(result!.message.content).toBe('工厂接入的回复')
    expect(result!.event.status).toBe('processed')
    resources.close()
  })
})
