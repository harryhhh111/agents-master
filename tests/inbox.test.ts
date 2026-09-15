import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createMainAgentRuntime,
  InboxIdempotencyConflictError,
  MainAgentRuntime,
  SQLiteMainInboxStore,
} from '../src/main/index.js'

describe('durable main inbox and runtime', () => {
  let dir: string
  let databasePath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'main-inbox-test-'))
    databasePath = path.join(dir, 'main.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('atomically admits one user message and inbox event across idempotent retries', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    const first = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '先保存，再思考。',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })
    const retry = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '先保存，再思考。',
      receivedAt: '2026-09-15T01:01:00.000Z',
    })

    expect(first.duplicate).toBe(false)
    expect(retry).toMatchObject({
      duplicate: true,
      message: first.message,
      event: { id: first.event.id, userMessageId: first.message.id, status: 'pending' },
    })
    expect(store.readRecentContext()).toEqual([first.message])
    store.close()

    const direct = new DatabaseSync(databasePath)
    expect(direct.prepare('SELECT COUNT(*) AS count FROM main_conversation_messages').get()).toEqual({ count: 1 })
    expect(direct.prepare('SELECT COUNT(*) AS count FROM inbox_events').get()).toEqual({ count: 1 })
    direct.close()
  })

  it('returns the originally admitted event for an exact user-message retry', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    const first = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'exact-retry', content: '保持普通优先级', priority: 'normal',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })

    const retry = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'exact-retry', content: '保持普通优先级', priority: 'normal',
      receivedAt: '2026-09-15T01:01:00.000Z',
    })

    expect(retry).toEqual({ message: first.message, event: first.event, duplicate: true })
    store.close()
  })

  it('rejects a normal user-message retry changed to interrupt priority', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'normal-to-interrupt', content: '同一条消息', priority: 'normal',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })

    expect(() => store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'normal-to-interrupt', content: '同一条消息', priority: 'interrupt',
      receivedAt: '2026-09-15T01:01:00.000Z',
    })).toThrow(InboxIdempotencyConflictError)
    store.close()
  })

  it('rejects an interrupt user-message retry changed to normal priority', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'interrupt-to-normal', content: '同一条消息', priority: 'interrupt',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })

    expect(() => store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'interrupt-to-normal', content: '同一条消息', priority: 'normal',
      receivedAt: '2026-09-15T01:01:00.000Z',
    })).toThrow(InboxIdempotencyConflictError)
    store.close()
  })

  it('rejects a retry key reused for a different user-message text', () => {
    const runtime = new MainAgentRuntime(new SQLiteMainInboxStore(databasePath))
    runtime.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '原始内容',
      receivedAt: '2026-09-15T01:00:00.000Z',
    })

    expect(() => runtime.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '不同内容',
      receivedAt: '2026-09-15T01:01:00.000Z',
    })).toThrow(InboxIdempotencyConflictError)
  })

  it('claims interrupts before normal events and otherwise preserves inbox append order', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    const normalUser = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'one', content: 'normal user',
      receivedAt: '2026-09-15T01:00:00.000Z',
    }).event
    const normalTimer = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'two', type: 'timer', payload: { timer: 'daily' },
      createdAt: '2026-09-15T01:01:00.000Z',
    }).event
    const firstInterrupt = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'three', type: 'domain-update', priority: 'interrupt', payload: { state: 'paused' },
      createdAt: '2026-09-15T01:02:00.000Z',
    }).event
    const secondInterrupt = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'four', content: 'interrupt user', priority: 'interrupt',
      receivedAt: '2026-09-15T01:03:00.000Z',
    }).event

    const claimedIds: string[] = []
    for (const claimedAt of [
      '2026-09-15T01:04:00.000Z', '2026-09-15T01:05:00.000Z',
      '2026-09-15T01:06:00.000Z', '2026-09-15T01:07:00.000Z',
    ]) {
      const event = store.claimNextPendingEvent(claimedAt)
      expect(event).toBeDefined()
      claimedIds.push(event!.id)
      store.completeInboxEvent(event!.id, '2026-09-15T01:08:00.000Z')
    }

    expect(claimedIds).toEqual([firstInterrupt.id, secondInterrupt.id, normalUser.id, normalTimer.id])
    expect(store.claimNextPendingEvent('2026-09-15T01:09:00.000Z')).toBeUndefined()
    store.close()
  })

  it('requires claimed lifecycle transitions and explicitly recovers work after reopening', () => {
    const first = new SQLiteMainInboxStore(databasePath)
    const event = first.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'message-1', content: '需要恢复的前台工作',
      receivedAt: '2026-09-15T01:00:00.000Z',
    }).event
    expect(() => first.completeInboxEvent(event.id, '2026-09-15T01:01:00.000Z'))
      .toThrow(`Cannot transition inbox event ${event.id} from pending to processed`)
    first.claimNextPendingEvent('2026-09-15T01:02:00.000Z')
    first.close()

    const reopened = new SQLiteMainInboxStore(databasePath)
    expect(reopened.recoverClaimedEvents('2026-09-15T01:03:00.000Z')).toBe(1)
    const reclaimed = reopened.claimNextPendingEvent('2026-09-15T01:04:00.000Z')
    expect(reclaimed).toMatchObject({ id: event.id, status: 'claimed', claimedAt: '2026-09-15T01:04:00.000Z' })
    expect(reopened.completeInboxEvent(event.id, '2026-09-15T01:05:00.000Z'))
      .toMatchObject({ status: 'processed', processedAt: '2026-09-15T01:05:00.000Z' })
    expect(() => reopened.cancelInboxEvent(event.id, '2026-09-15T01:06:00.000Z'))
      .toThrow(`Cannot transition inbox event ${event.id} from processed to cancelled`)
    reopened.close()
  })

  it('scoped recovery returns only claimed user-message events; legacy recovery keeps resetting every claim', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    const timer = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'timer-1', type: 'timer', payload: { at: 'daily' },
      createdAt: '2026-09-15T01:00:00.000Z',
    }).event
    const domain = store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'domain-1', type: 'domain-update', payload: { state: 'paused' },
      createdAt: '2026-09-15T01:01:00.000Z',
    }).event
    const claimedUser = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'user-claimed', content: '被领取的前台工作',
      receivedAt: '2026-09-15T01:02:00.000Z',
    }).event
    const pendingUser = store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'user-pending', content: '还没被领取',
      receivedAt: '2026-09-15T01:03:00.000Z',
    }).event
    const claimAt = '2026-09-15T01:04:00.000Z'
    expect(store.claimNextPendingEvent(claimAt)!.id).toBe(timer.id)
    expect(store.claimNextPendingEvent(claimAt)!.id).toBe(domain.id)
    expect(store.claimNextPendingUserMessageEvent(claimAt)!.id).toBe(claimedUser.id)

    // Scoped recovery returns exactly the one claimed user-message event; the
    // claimed timer/domain-update events keep their claims and the pending
    // user message stays pending.
    expect(store.recoverClaimedUserMessageEvents('2026-09-15T01:05:00.000Z')).toBe(1)
    const direct = new DatabaseSync(databasePath)
    try {
      expect(direct.prepare('SELECT id, status, claimed_at, updated_at FROM inbox_events ORDER BY append_order').all())
        .toEqual([
          { id: timer.id, status: 'claimed', claimed_at: claimAt, updated_at: claimAt },
          { id: domain.id, status: 'claimed', claimed_at: claimAt, updated_at: claimAt },
          { id: claimedUser.id, status: 'pending', claimed_at: null, updated_at: '2026-09-15T01:05:00.000Z' },
          { id: pendingUser.id, status: 'pending', claimed_at: null, updated_at: '2026-09-15T01:03:00.000Z' },
        ])
    } finally {
      direct.close()
    }
    // The recovered event is immediately re-claimable by the foreground surface.
    expect(store.claimNextPendingUserMessageEvent('2026-09-15T01:06:00.000Z'))
      .toMatchObject({ id: claimedUser.id, status: 'claimed' })

    // Legacy recovery retains its broad semantics: every claimed event resets,
    // timer/domain-update events included.
    expect(store.recoverClaimedEvents('2026-09-15T01:07:00.000Z')).toBe(3)
    expect(store.claimNextPendingEvent('2026-09-15T01:08:00.000Z')!.id).toBe(timer.id)
    store.close()
  })

  it('rejects non-canonical timestamps at the persistent boundary', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    expect(() => store.receiveUserMessage({
      conversationId: 'main', idempotencyKey: 'bad-time', content: 'bad', receivedAt: '2026-09-15T09:00:00+08:00',
    })).toThrow('receivedAt must be an ISO-8601 UTC timestamp')
    expect(() => store.enqueueEvent({
      conversationId: 'main', idempotencyKey: 'bad-time-2', type: 'timer', payload: null, createdAt: '2026-09-15 01:00:00Z',
    })).toThrow('createdAt must be an ISO-8601 UTC timestamp')
    expect(() => store.claimNextPendingEvent('2026-09-15T01:00:00Z'))
      .toThrow('claimedAt must be an ISO-8601 UTC timestamp')
    store.close()
  })

  it('rejects non-finite numbers in nested payloads before any event is stored', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    for (const [idempotencyKey, payload] of [
      ['nan', { nested: [Number.NaN] }],
      ['infinity', { nested: { value: Number.POSITIVE_INFINITY } }],
      ['negative-infinity', [{ value: Number.NEGATIVE_INFINITY }]],
    ] as const) {
      expect(() => store.enqueueEvent({
        conversationId: 'main', idempotencyKey, type: 'timer', payload,
        createdAt: '2026-09-15T01:00:00.000Z',
      })).toThrow('payload must not contain non-finite numbers')
    }
    expect(store.claimNextPendingEvent('2026-09-15T01:01:00.000Z')).toBeUndefined()
    store.close()
  })

  it('keeps finite nested JSON payloads idempotent', () => {
    const store = new SQLiteMainInboxStore(databasePath)
    const input = {
      conversationId: 'main', idempotencyKey: 'finite-nested', type: 'timer' as const,
      payload: { nested: [0, { value: 1.5 }] }, createdAt: '2026-09-15T01:00:00.000Z',
    }
    const first = store.enqueueEvent(input)
    const retry = store.enqueueEvent(input)
    expect(retry).toMatchObject({ duplicate: true, event: first.event })
    store.close()
  })

  it('has the composition root create a missing data directory before opening SQLite', () => {
    const dataDirectory = path.join(dir, 'missing', 'runtime-data')
    expect(existsSync(dataDirectory)).toBe(false)
    const resources = createMainAgentRuntime({ dataDirectory, databaseFileName: 'runtime.sqlite' })
    expect(existsSync(dataDirectory)).toBe(true)
    expect(existsSync(resources.databasePath)).toBe(true)
    resources.close()
  })

  it('makes an existing data directory and its created database private', () => {
    const dataDirectory = path.join(dir, 'runtime-data')
    mkdirSync(dataDirectory, { mode: 0o755 })
    chmodSync(dataDirectory, 0o755)
    expect(statSync(dataDirectory).mode & 0o777).toBe(0o755)

    const resources = createMainAgentRuntime({ dataDirectory, databaseFileName: 'runtime.sqlite' })
    const dataDirectoryStats = statSync(dataDirectory)
    const databaseStats = statSync(resources.databasePath)
    expect(dataDirectoryStats.mode & 0o777).toBe(0o700)
    expect(databaseStats.mode & 0o777).toBe(0o600)
    if (process.platform === 'linux') {
      expect(dataDirectoryStats.uid).toBe(process.getuid?.())
      expect(databaseStats.uid).toBe(process.getuid?.())
    }
    resources.close()
  })

  it('leaves missing parent-directory creation to the composition root', () => {
    const missingParent = path.join(dir, 'store-must-not-create-this')
    expect(() => new SQLiteMainInboxStore(path.join(missingParent, 'main.sqlite'))).toThrow()
    expect(existsSync(missingParent)).toBe(false)
  })
})
