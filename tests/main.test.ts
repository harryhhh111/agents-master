import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MainAgent, SQLiteMainConversationStore } from '../src/main/index.js'
import {
  SQLitePersonalStore,
  type AccessBoundary,
  type InternalContext,
  type TaskEventSummaryView,
} from '../src/personal/index.js'

const accessBoundary: AccessBoundary = {
  mainAgent: 'full',
  domainAgents: [],
  allowInTaskContext: true,
  allowExternalDisclosure: false,
}

const mainContext = {
  requester: { kind: 'main', access: 'summary' },
  use: 'general',
} as const satisfies InternalContext

describe('main control plane', () => {
  let dir: string
  let personalDatabasePath: string
  let conversationDatabasePath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'main-agent-test-'))
    personalDatabasePath = path.join(dir, 'personal.sqlite')
    conversationDatabasePath = path.join(dir, 'conversation.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists a bounded main transcript without promoting messages into Sources or Claims', () => {
    const conversation = new SQLiteMainConversationStore(conversationDatabasePath)
    const first = conversation.appendMessage({
      role: 'user',
      content: '这个项目这周要推进。',
      createdAt: '2026-09-10T09:00:00.000Z',
    })
    const second = conversation.appendMessage({
      role: 'assistant',
      content: '我会把它作为独立任务维护。',
      createdAt: '2026-09-10T09:01:00.000Z',
    })
    const third = conversation.appendMessage({
      role: 'system',
      content: '任务尚未从聊天自动提升为证据或认识。',
      createdAt: '2026-09-10T09:02:00.000Z',
    })

    expect(conversation.readRecentContext(2)).toEqual([second, third])
    conversation.close()

    const reopened = new SQLiteMainConversationStore(conversationDatabasePath)
    expect(reopened.readRecentContext()).toEqual([first, second, third])
    expect(() => reopened.readRecentContext(101)).toThrow('limit must be a positive integer no greater than 100')
    reopened.close()

    const direct = new DatabaseSync(conversationDatabasePath)
    expect(direct.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sources', 'claims')").all()).toEqual([])
    direct.close()
  })

  it('uses a durable append sequence for equal-time transcript messages, including migrated databases', () => {
    const createdAt = '2026-09-10T09:00:00.000Z'
    const conversation = new SQLiteMainConversationStore(conversationDatabasePath)
    const first = conversation.appendMessage({ role: 'user', content: 'first', createdAt })
    const second = conversation.appendMessage({ role: 'assistant', content: 'second', createdAt })
    const third = conversation.appendMessage({ role: 'system', content: 'third', createdAt })

    expect(conversation.readRecentContext()).toEqual([first, second, third])
    expect(conversation.readRecentContext(2)).toEqual([second, third])
    conversation.close()

    const reopened = new SQLiteMainConversationStore(conversationDatabasePath)
    expect(reopened.readRecentContext(2)).toEqual([second, third])
    reopened.close()

    const legacyPath = path.join(dir, 'legacy-conversation.sqlite')
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(`
      CREATE TABLE main_conversation_messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX main_conversation_messages_by_created
        ON main_conversation_messages(created_at, id);
    `)
    legacy.prepare('INSERT INTO main_conversation_messages VALUES (?, ?, ?, ?)').run(
      'inserted-first', 'user', 'first migrated', createdAt,
    )
    legacy.prepare('INSERT INTO main_conversation_messages VALUES (?, ?, ?, ?)').run(
      'sorts-earlier-by-id', 'assistant', 'second migrated', createdAt,
    )
    legacy.close()

    const migrated = new SQLiteMainConversationStore(legacyPath)
    const appended = migrated.appendMessage({ role: 'system', content: 'third migrated', createdAt })
    expect(migrated.readRecentContext()).toEqual([
      { id: 'inserted-first', role: 'user', content: 'first migrated', createdAt },
      { id: 'sorts-earlier-by-id', role: 'assistant', content: 'second migrated', createdAt },
      appended,
    ])
    expect(migrated.readRecentContext(2)).toEqual([
      { id: 'sorts-earlier-by-id', role: 'assistant', content: 'second migrated', createdAt },
      appended,
    ])
    migrated.close()
  })

  it('records messages and exposes explicit task operations without any executor surface', () => {
    const taskStore = new SQLitePersonalStore(personalDatabasePath)
    const conversationStore = new SQLiteMainConversationStore(conversationDatabasePath)
    const main = new MainAgent({ taskStore, conversationStore, taskContext: mainContext })

    const message = main.recordMessage({
      role: 'user',
      content: '把 Stage 1.1 做成一个任务。',
      createdAt: '2026-09-10T09:00:00.000Z',
    })
    const task = main.createTask({
      title: '实现 Stage 1.1',
      objective: '建立耐久的主 Agent 控制面',
      status: 'active',
      domain: 'work-project',
      owner: 'main-agent',
      projectKey: 'agents-master',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      entityReferences: [],
      accessBoundary,
    })
    const updated = main.updateTask(task.id, {
      visibleProgress: '任务卡已建立。',
      updatedAt: '2026-09-10T09:01:00.000Z',
    })
    const event = taskStore.appendTaskEvent(task.id, {
      type: 'progress',
      content: '控制面现在可读取任务事件。',
      occurredAt: '2026-09-10T09:01:00.000Z',
      recordedAt: '2026-09-10T09:01:01.000Z',
    }, { requester: { kind: 'main', access: 'full' }, use: 'general' })
    const taskAfterEvent = main.inspectTask(task.id)

    expect(main.readRecentContext()).toEqual([message])
    expect(taskAfterEvent).toEqual({ ...updated, updatedAt: event.recordedAt })
    expect(main.listTasks({ domain: 'work-project' })).toEqual([taskAfterEvent])
    const summaryEvents: TaskEventSummaryView[] = main.listTaskEvents(task.id)
    expect(summaryEvents).toEqual([{
      id: event.id,
      taskId: event.taskId,
      sourceId: event.sourceId,
      type: event.type,
      actor: event.actor,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
    }])
    expect(summaryEvents[0]).not.toHaveProperty('content')
    expect(Object.getOwnPropertyNames(MainAgent.prototype)).not.toContain('runExecutor')
    expect(Object.getOwnPropertyNames(MainAgent.prototype)).not.toContain('delegate')
    taskStore.close()
    conversationStore.close()
  })
})
