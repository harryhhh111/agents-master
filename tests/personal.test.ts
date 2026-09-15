import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SQLitePersonalStore,
  type AccessBoundary,
  type InternalContext,
  type TaskEvent,
  type TaskEventSummaryView,
} from '../src/personal/index.js'

const accessBoundary: AccessBoundary = {
  mainAgent: 'summary',
  domainAgents: ['relationships'],
  allowInTaskContext: true,
  allowExternalDisclosure: false,
}

const fullMain: InternalContext = { requester: { kind: 'main', access: 'full' }, use: 'general' }
const summaryMain: InternalContext = { requester: { kind: 'main', access: 'summary' }, use: 'general' }
const relationshipAgent: InternalContext = {
  requester: { kind: 'domain-agent', id: 'relationships' },
  use: 'general',
}

describe('SQLitePersonalStore', () => {
  let dir: string
  let databasePath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'personal-store-test-'))
    databasePath = path.join(dir, 'personal.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists and restores Source, Claim, Policy, and Task after reopening SQLite', () => {
    const first = new SQLitePersonalStore(databasePath)
    const source = first.createSource({
      rawContent: '用户说周四适合考虑周末安排。',
      summary: '用户会在周四考虑周末安排。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      recordedAt: '2026-09-10T09:01:00.000Z',
      origin: { kind: 'conversation', reference: 'chat:42' },
      accessBoundary,
    })
    const claim = first.createClaim({
      statement: '用户偏好在周四考虑周末安排。',
      epistemicState: 'user-fact',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const policy = first.createPolicy({
      condition: '周四且近期未讨论周末安排。',
      action: '适时询问是否要安排周末。',
      dependsOnClaimIds: [claim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:02:00.000Z',
      accessBoundary,
    })
    first.createClaim({
      statement: '已经被撤回的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'retracted',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const task = first.createTask({
      title: '安排本周末',
      status: 'active',
      createdAt: '2026-09-10T09:03:00.000Z',
      updatedAt: '2026-09-10T09:03:00.000Z',
      entityReferences: [{ kind: 'claim', id: claim.id }],
      accessBoundary,
    })
    first.close()

    const reopened = new SQLitePersonalStore(databasePath)
    expect(reopened.getSource(source.id, relationshipAgent)).toEqual(source)
    expect(reopened.getClaim(claim.id, relationshipAgent)).toEqual(claim)
    expect(reopened.getPolicy(policy.id, relationshipAgent)).toEqual(policy)
    expect(reopened.getTask(task.id, relationshipAgent)).toEqual(task)
    expect(reopened.listActiveClaims(relationshipAgent, '2026-09-10T09:03:00.000Z')).toEqual([claim])
    reopened.close()
  })

  it('requires Claims to name an existing Source as evidence', () => {
    const store = new SQLitePersonalStore(databasePath)
    expect(() => store.createClaim({
      statement: '没有来源的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [],
      accessBoundary,
    })).toThrow('evidenceIds must contain at least one id')

    expect(() => store.createClaim({
      statement: '悬空来源。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: ['missing-source'],
      accessBoundary,
    })).toThrow('Source does not exist: missing-source')
    store.close()
  })

  it('round-trips access boundaries and keeps Tasks independent while allowing Claim references', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '只给主 Agent 摘要。',
      summary: '可供摘要阅读的来源。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '这条认识有受限访问边界。',
      epistemicState: 'model-inference',
      scope: 'project',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const referencedTask = store.createTask({
      title: '使用认识作为上下文',
      status: 'active',
      entityReferences: [{ kind: 'claim', id: claim.id }],
      accessBoundary,
    })
    const independentTask = store.createTask({
      title: '独立运行的任务',
      status: 'paused',
      entityReferences: [],
      accessBoundary,
    })

    expect(store.getSource(source.id, relationshipAgent)?.accessBoundary).toEqual(accessBoundary)
    expect(store.getClaim(claim.id, relationshipAgent)?.accessBoundary).toEqual(accessBoundary)
    expect(store.getTask(referencedTask.id, relationshipAgent)?.entityReferences).toEqual([{ kind: 'claim', id: claim.id }])
    expect(store.getTask(independentTask.id, relationshipAgent)?.entityReferences).toEqual([])
    store.close()
  })

  it('persists a Claim epistemic state and refuses unknown as a Claim', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '用户明确说不喜欢早会。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'conversation' },
      accessBoundary,
    })
    const fact = store.createClaim({
      statement: '用户不喜欢早会。',
      epistemicState: 'user-fact',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })

    expect(store.getClaim(fact.id, relationshipAgent)?.epistemicState).toBe('user-fact')
    expect(() => store.createClaim({
      statement: '未知状态不应进入 Claim。',
      epistemicState: 'unknown' as never,
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })).toThrow('unknown is not a Claim')
    store.close()
  })

  it('returns active Claims only within their validity window at the requested as-of time', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '一条证据。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const expired = store.createClaim({
      statement: '已经过期。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: '2026-09-10T00:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const current = store.createClaim({
      statement: '当前有效。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T00:00:00.000Z',
      validUntil: '2026-09-20T00:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    store.createClaim({
      statement: '尚未生效。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-20T00:00:00.000Z',
      validUntil: '2026-09-21T00:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })

    expect(store.listActiveClaims(relationshipAgent, '2026-09-05T00:00:00.000Z')).toEqual([expired])
    expect(store.listActiveClaims(relationshipAgent, '2026-09-10T00:00:00.000Z')).toEqual([current])
    expect(store.listActiveClaims(relationshipAgent, '2026-09-21T00:00:00.000Z')).toEqual([])
    expect(() => store.listActiveClaims(relationshipAgent, 'not-an-iso-time')).toThrow('asOf must be an ISO-8601 UTC timestamp')
    store.close()
  })

  it('enforces source and Claim boundaries for main modes, domain ids, and task context', () => {
    const store = new SQLitePersonalStore(databasePath)
    const taskForbiddenBoundary: AccessBoundary = { ...accessBoundary, allowInTaskContext: false }
    const source = store.createSource({
      rawContent: '绝不能出现在摘要里的原始内容。',
      summary: '允许给摘要读者的内容。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary: taskForbiddenBoundary,
    })
    const claim = store.createClaim({
      statement: '受访问边界约束的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const summary = store.getSource(source.id, summaryMain)

    expect(summary).toMatchObject({ id: source.id, summary: '允许给摘要读者的内容。' })
    expect(summary).not.toHaveProperty('rawContent')
    expect(store.getSource(source.id, fullMain)).toBeUndefined()
    expect(store.getSource(source.id, relationshipAgent)).toEqual(source)
    expect(store.getSource(source.id, { requester: { kind: 'domain-agent', id: 'goals' }, use: 'general' })).toBeUndefined()
    expect(store.getSource(source.id, { requester: { kind: 'main', access: 'summary' }, use: 'task' })).toBeUndefined()
    expect(store.getSource(source.id, { requester: { kind: 'external' } as never, use: 'general' })).toBeUndefined()
    expect(store.getClaim(claim.id, summaryMain)).toEqual(claim)
    expect(store.getClaim(claim.id, fullMain)).toBeUndefined()
    expect(store.listActiveClaims(summaryMain, '2026-09-10T09:00:00.000Z')).toEqual([claim])
    expect(store.listActiveClaims({ requester: { kind: 'domain-agent', id: 'goals' }, use: 'general' }, '2026-09-10T09:00:00.000Z')).toEqual([])

    const fullBoundary: AccessBoundary = { ...accessBoundary, mainAgent: 'full', allowExternalDisclosure: true }
    const fullSource = store.createSource({
      rawContent: '仅完整主 Agent 可以读取的原始内容。',
      summary: '完整来源的摘要。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary: fullBoundary,
    })
    expect(store.getSource(fullSource.id, fullMain)).toEqual(fullSource)
    expect(store.getSource(fullSource.id, summaryMain)).not.toHaveProperty('rawContent')
    expect(store.getSource(fullSource.id, { requester: { kind: 'external' } as never, use: 'general' })).toBeUndefined()
    store.close()
  })

  it('requires every Task entity reference to exist at creation', () => {
    const store = new SQLitePersonalStore(databasePath)
    expect(() => store.createTask({
      title: '不能引用不存在的对象',
      status: 'active',
      entityReferences: [{ kind: 'policy', id: 'missing-policy' }],
      accessBoundary,
    })).toThrow('Referenced policy does not exist: missing-policy')

    const source = store.createSource({
      rawContent: '任务参考的来源。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const first = store.createTask({
      title: '先存在的任务',
      status: 'active',
      entityReferences: [{ kind: 'source', id: source.id }],
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '任务可引用已有 Claim。',
      epistemicState: 'model-inference',
      scope: 'project',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const policy = store.createPolicy({
      condition: '任务上下文有此认识。',
      action: '允许使用。',
      dependsOnClaimIds: [claim.id],
      scope: 'project',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })
    const second = store.createTask({
      title: '可以引用已有任务',
      status: 'active',
      entityReferences: [
        { kind: 'source', id: source.id },
        { kind: 'claim', id: claim.id },
        { kind: 'policy', id: policy.id },
        { kind: 'task', id: first.id },
      ],
      accessBoundary,
    })
    expect(store.getTask(second.id, summaryMain)?.entityReferences).toEqual([
      { kind: 'source', id: source.id },
      { kind: 'claim', id: claim.id },
      { kind: 'policy', id: policy.id },
      { kind: 'task', id: first.id },
    ])
    expect(store.getPolicy(policy.id, fullMain)).toBeUndefined()
    expect(store.getPolicy(policy.id, summaryMain)).toEqual(policy)
    expect(store.getTask(second.id, fullMain)).toBeUndefined()
    store.close()
  })

  it('rejects a Task updated before creation while allowing equal timestamps', () => {
    const store = new SQLitePersonalStore(databasePath)
    const createdAt = '2026-09-10T09:03:00.000Z'

    expect(() => store.createTask({
      title: '时间倒流的任务',
      status: 'active',
      createdAt,
      updatedAt: '2026-09-10T09:02:59.999Z',
      entityReferences: [],
      accessBoundary,
    })).toThrow('updatedAt must not be earlier than createdAt')
    expect(store.createTask({
      title: '同一创建与更新时间的任务',
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      entityReferences: [],
      accessBoundary,
    }).updatedAt).toBe(createdAt)
    store.close()
  })

  it('preserves independent Task changes across store instances and validates against the persisted timestamp', () => {
    const first = new SQLitePersonalStore(databasePath)
    const task = first.createTask({
      title: '并发更新任务',
      status: 'active',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      entityReferences: [],
      accessBoundary,
    })
    const second = new SQLitePersonalStore(databasePath)

    first.updateTask(task.id, {
      title: '第一个实例更新的标题',
      updatedAt: '2026-09-10T09:01:00.000Z',
    }, relationshipAgent)
    const independentlyUpdated = second.updateTask(task.id, {
      visibleProgress: '第二个实例更新的进展。',
      updatedAt: '2026-09-10T09:02:00.000Z',
    }, relationshipAgent)

    expect(independentlyUpdated).toMatchObject({
      title: '第一个实例更新的标题',
      visibleProgress: '第二个实例更新的进展。',
      updatedAt: '2026-09-10T09:02:00.000Z',
    })
    expect(first.getTask(task.id, relationshipAgent)).toEqual(independentlyUpdated)
    expect(() => second.updateTask(task.id, {
      candidateResult: '不应写入。',
      updatedAt: '2026-09-10T09:01:59.999Z',
    }, relationshipAgent)).toThrow('updatedAt must not be earlier than the current Task timestamp')
    first.close()
    second.close()
  })

  it('advances Task recency atomically for journal activity without moving timestamps backwards', () => {
    const store = new SQLitePersonalStore(databasePath)
    const task = store.createTask({
      title: '事件应更新任务新鲜度',
      status: 'active',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      entityReferences: [],
      accessBoundary,
    })
    const lessRecent = store.createTask({
      title: '用于验证排序的任务',
      status: 'active',
      createdAt: '2026-09-10T09:01:00.000Z',
      updatedAt: '2026-09-10T09:01:00.000Z',
      entityReferences: [],
      accessBoundary,
    })

    store.appendTaskEvent(task.id, {
      type: 'progress',
      content: '这条日志比另一个任务更新。',
      occurredAt: '2026-09-10T09:02:00.000Z',
      recordedAt: '2026-09-10T09:02:00.000Z',
    }, relationshipAgent)
    expect(store.getTask(task.id, relationshipAgent)?.updatedAt).toBe('2026-09-10T09:02:00.000Z')
    expect(store.listTasks(relationshipAgent).map(entry => entry.id)).toEqual([task.id, lessRecent.id])

    store.appendTaskEvent(task.id, {
      type: 'note',
      content: '历史补录不得使任务时间倒退。',
      occurredAt: '2026-09-10T08:00:00.000Z',
      recordedAt: '2026-09-10T08:00:00.000Z',
    }, relationshipAgent)
    expect(store.getTask(task.id, relationshipAgent)?.updatedAt).toBe('2026-09-10T09:02:00.000Z')

    const statusChanged = store.updateTask(task.id, {
      status: 'paused',
      updatedAt: '2026-09-10T09:03:00.000Z',
    }, relationshipAgent)
    expect(statusChanged.updatedAt).toBe('2026-09-10T09:03:00.000Z')
    expect(store.getTask(task.id, relationshipAgent)).toEqual(statusChanged)
    store.close()
  })

  it('uses per-Task append order for equal-time event reads and bounded summary reads', () => {
    const store = new SQLitePersonalStore(databasePath)
    const task = store.createTask({
      title: '同一时间的事件顺序',
      status: 'active',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      entityReferences: [],
      accessBoundary,
    })
    const eventInput = {
      occurredAt: '2026-09-10T09:01:00.000Z',
      recordedAt: '2026-09-10T09:01:00.000Z',
    }
    const first = store.appendTaskEvent(task.id, { type: 'note', content: 'first', ...eventInput }, relationshipAgent)
    const second = store.appendTaskEvent(task.id, { type: 'progress', content: 'second', ...eventInput }, relationshipAgent)
    const third = store.appendTaskEvent(task.id, { type: 'waiting-for-user', content: 'third', ...eventInput }, relationshipAgent)

    expect(store.listTaskEvents(task.id, relationshipAgent)).toEqual([first, second, third])
    expect(store.listTaskEvents(task.id, relationshipAgent, 2)).toEqual([second, third])
    expect(store.listTaskEvents(task.id, summaryMain, 2).map(event => event.id)).toEqual([second.id, third.id])
    store.close()

    const reopened = new SQLitePersonalStore(databasePath)
    expect(reopened.listTaskEvents(task.id, relationshipAgent, 2)).toEqual([second, third])
    expect(reopened.listTaskEvents(task.id, summaryMain, 2).map(event => event.id)).toEqual([second.id, third.id])
    reopened.close()
  })

  it('migrates the provenance-aware Stage 1.1 event schema with its insertion order intact', () => {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, raw_content TEXT NOT NULL, summary TEXT,
        occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
        origin_json TEXT NOT NULL, access_boundary_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL,
        status TEXT NOT NULL, domain TEXT NOT NULL, owner TEXT NOT NULL,
        project_key TEXT, visible_progress TEXT, waiting_for_user TEXT, candidate_result TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        entity_references_json TEXT NOT NULL, access_boundary_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        source_id TEXT NOT NULL REFERENCES sources(id), type TEXT NOT NULL,
        content TEXT NOT NULL, actor TEXT NOT NULL, occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;
    `)
    const timestamp = '2026-09-10T09:01:00.000Z'
    legacy.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'stage-task', '旧 Stage 任务', '旧 Stage 任务', 'active', 'relationship', 'main-agent',
      null, null, null, null, '2026-09-10T09:00:00.000Z', '2026-09-10T09:00:00.000Z', '[]', JSON.stringify(accessBoundary),
    )
    for (const [id, content] of [['source-first', 'first'], ['source-second', 'second']] as const) {
      legacy.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, content, null, timestamp, timestamp,
        JSON.stringify({ kind: 'task-event', reference: `event-${content}` }), JSON.stringify(accessBoundary),
      )
    }
    legacy.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'event-z-first', 'stage-task', 'source-first', 'note', 'first', 'main-agent', timestamp, timestamp,
    )
    legacy.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'event-a-second', 'stage-task', 'source-second', 'progress', 'second', 'main-agent', timestamp, timestamp,
    )
    legacy.close()

    const store = new SQLitePersonalStore(databasePath)
    expect(store.listTaskEvents('stage-task', relationshipAgent).map(event => event.id))
      .toEqual(['event-z-first', 'event-a-second'])
    expect(store.listTaskEvents('stage-task', summaryMain, 1).map(event => event.id))
      .toEqual(['event-a-second'])
    store.close()
  })

  it('maintains a MainAgent task card, filters visible Tasks, and preserves its immutable event journal', () => {
    const store = new SQLitePersonalStore(databasePath)
    const task = store.createTask({
      title: '推进个人 Agent 主线',
      objective: '完成 Stage 1.1 控制面基础',
      status: 'active',
      domain: 'work-project',
      owner: 'main-agent',
      projectKey: 'agents-master',
      visibleProgress: '正在建立持久化基础。',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      entityReferences: [],
      accessBoundary: { ...accessBoundary, mainAgent: 'full' },
    })
    const unrelated = store.createTask({
      title: '关系任务',
      status: 'paused',
      domain: 'relationship',
      owner: 'main-agent',
      createdAt: '2026-09-10T09:01:00.000Z',
      updatedAt: '2026-09-10T09:01:00.000Z',
      entityReferences: [],
      accessBoundary,
    })

    const updated = store.updateTask(task.id, {
      visibleProgress: 'SQLite task journal 已可用。',
      waitingForUser: '请确认下一阶段优先级。',
      candidateResult: 'Stage 1.1 实现候选。',
      updatedAt: '2026-09-10T10:00:00.000Z',
    }, relationshipAgent)
    const firstEvent = store.appendTaskEvent(task.id, {
      type: 'progress',
      content: '持久化任务模型已扩展。',
      occurredAt: '2026-09-10T09:30:00.000Z',
      recordedAt: '2026-09-10T09:31:00.000Z',
    }, fullMain)
    const secondEvent = store.appendTaskEvent(task.id, {
      type: 'waiting-for-user',
      content: '等待用户确认范围。',
      actor: 'main-agent',
      occurredAt: '2026-09-10T09:45:00.000Z',
      recordedAt: '2026-09-10T09:46:00.000Z',
    }, fullMain)

    expect(updated).toMatchObject({
      ...task,
      visibleProgress: 'SQLite task journal 已可用。',
      waitingForUser: '请确认下一阶段优先级。',
      candidateResult: 'Stage 1.1 实现候选。',
      updatedAt: '2026-09-10T10:00:00.000Z',
    })
    expect(store.listTasks(relationshipAgent, { domain: 'work-project', projectKey: 'agents-master' }))
      .toEqual([updated])
    expect(store.listTasks(relationshipAgent, { statuses: ['paused'] })).toEqual([unrelated])
    expect(store.listTaskEvents(task.id, relationshipAgent)).toEqual([firstEvent, secondEvent])
    expect(store.listTaskEvents(task.id, relationshipAgent, 1)).toEqual([secondEvent])
    expect(() => store.updateTask(task.id, { visibleProgress: '不应写入。' }, {
      requester: { kind: 'domain-agent', id: 'goals' }, use: 'general',
    })).toThrow(`Task update is not authorized for this context: ${task.id}`)
    expect(() => store.appendTaskEvent(task.id, { type: 'note', content: '不应写入。' }, {
      requester: { kind: 'domain-agent', id: 'goals' }, use: 'general',
    })).toThrow(`Task event append is not authorized for this context: ${task.id}`)
    expect(() => store.appendTaskEvent(task.id, {
      type: 'note',
      content: '主 Agent 不能伪装成工作项目 Agent。',
      actor: 'work-project-agent',
    }, fullMain)).toThrow('Task event actor must match the authorized requester: main-agent')
    expect(store.listTaskEvents(task.id, { requester: { kind: 'domain-agent', id: 'goals' }, use: 'general' })).toEqual([])
    expect(() => store.updateTask(task.id, { updatedAt: '2026-09-10T08:59:59.999Z' }, relationshipAgent))
      .toThrow('updatedAt must not be earlier than the current Task timestamp')
    store.close()

    const reopened = new SQLitePersonalStore(databasePath)
    expect(reopened.getTask(task.id, relationshipAgent)).toEqual(updated)
    expect(reopened.listTaskEvents(task.id, relationshipAgent)).toEqual([firstEvent, secondEvent])
    reopened.close()
  })

  it('makes every TaskEvent citable evidence and removes it only with its Source', () => {
    const store = new SQLitePersonalStore(databasePath)
    const task = store.createTask({
      title: '保留事件证据',
      status: 'active',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      entityReferences: [],
      accessBoundary,
    })
    const event = store.appendTaskEvent(task.id, {
      type: 'note',
      content: '用户确认这条进展可以作为后续认识的证据。',
      actor: 'domain-agent:relationships',
      occurredAt: '2026-09-10T09:01:00.000Z',
      recordedAt: '2026-09-10T09:02:00.000Z',
    }, relationshipAgent)
    const source = store.getSource(event.sourceId, relationshipAgent)
    expect(source).toEqual({
      id: event.sourceId,
      rawContent: event.content,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      origin: { kind: 'task-event', reference: event.id },
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '该任务有用户确认的可引用进展。',
      epistemicState: 'user-fact',
      scope: 'project',
      status: 'active',
      validFrom: '2026-09-10T09:02:00.000Z',
      evidenceIds: [event.sourceId],
      accessBoundary,
    })
    store.close()

    const reopened = new SQLitePersonalStore(databasePath)
    expect(reopened.listTaskEvents(task.id, relationshipAgent)).toEqual([event])
    expect(reopened.getSource(event.sourceId, relationshipAgent)).toEqual(source)
    const preview = reopened.previewSourceDeletion(event.sourceId, relationshipAgent)
    expect(preview?.affectedActiveTaskIds).toEqual([task.id])
    expect(preview?.solelySupportedClaims).toEqual([claim])
    const deletion = reopened.deleteSource(event.sourceId, relationshipAgent, { confirm: true })
    expect(deletion.affectedActiveTaskIds).toEqual([task.id])
    expect(deletion.retractedClaims).toEqual([{ ...claim, status: 'retracted' }])
    expect(reopened.getSource(event.sourceId, relationshipAgent)).toBeUndefined()
    expect(reopened.listTaskEvents(task.id, relationshipAgent)).toEqual([])
    reopened.close()
  })

  it('redacts TaskEvent content structurally for a summary MainAgent reader', () => {
    const store = new SQLitePersonalStore(databasePath)
    const task = store.createTask({
      title: '摘要可见的任务事件',
      status: 'active',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      entityReferences: [],
      accessBoundary: { ...accessBoundary, mainAgent: 'full' },
    })
    const event = store.appendTaskEvent(task.id, {
      type: 'note',
      content: '这段原始事件内容绝不能交给摘要读取者。',
      occurredAt: '2026-09-10T09:01:00.000Z',
      recordedAt: '2026-09-10T09:02:00.000Z',
    }, relationshipAgent)
    const typedSummaryMain = {
      requester: { kind: 'main', access: 'summary' },
      use: 'general',
    } as const satisfies InternalContext
    const summaryEvents: TaskEventSummaryView[] = store.listTaskEvents(task.id, typedSummaryMain)
    const typedDomainAgent = {
      requester: { kind: 'domain-agent', id: 'relationships' },
      use: 'general',
    } as const satisfies InternalContext
    const typedFullMain = {
      requester: { kind: 'main', access: 'full' },
      use: 'general',
    } as const satisfies InternalContext
    const fullEvents: TaskEvent[] = store.listTaskEvents(task.id, typedDomainAgent)
    const mainFullEvents: TaskEvent[] = store.listTaskEvents(task.id, typedFullMain)

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
    expect(fullEvents).toEqual([event])
    expect(mainFullEvents).toEqual([event])
    store.close()
  })

  it('records only actual status transitions with the authorized requester as actor', () => {
    const store = new SQLitePersonalStore(databasePath)
    const task = store.createTask({
      title: '验证状态事件',
      status: 'active',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      entityReferences: [],
      accessBoundary,
    })
    expect(() => store.appendTaskEvent(task.id, {
      type: 'status-change' as never,
      content: '直接追加状态变更不能绕过任务状态写入。',
    }, relationshipAgent)).toThrow('status-change events may only be created by updateTask')
    const paused = store.updateTask(task.id, {
      status: 'paused',
      updatedAt: '2026-09-10T09:03:00.000Z',
    }, relationshipAgent)
    const [transition] = store.listTaskEvents(task.id, relationshipAgent)
    expect(transition).toMatchObject({
      taskId: task.id,
      type: 'status-change',
      content: 'Task status changed from active to paused.',
      actor: 'domain-agent:relationships',
      occurredAt: paused.updatedAt,
      recordedAt: paused.updatedAt,
    })
    expect(store.getSource(transition.sourceId, relationshipAgent)).toMatchObject({
      rawContent: transition.content,
      occurredAt: paused.updatedAt,
      recordedAt: paused.updatedAt,
      origin: { kind: 'task-event', reference: transition.id },
      accessBoundary,
    })
    store.updateTask(task.id, {
      status: 'paused',
      visibleProgress: '状态未变，只更新可见进展。',
      updatedAt: '2026-09-10T09:04:00.000Z',
    }, relationshipAgent)
    store.updateTask(task.id, {
      visibleProgress: '未提供状态也不写状态事件。',
      updatedAt: '2026-09-10T09:05:00.000Z',
    }, relationshipAgent)
    expect(store.listTaskEvents(task.id, relationshipAgent)).toEqual([transition])
    const completed = store.updateTask(task.id, {
      status: 'completed',
      updatedAt: '2026-09-10T09:06:00.000Z',
    }, summaryMain)
    expect(store.listTaskEvents(task.id, relationshipAgent)).toEqual([
      transition,
      expect.objectContaining({
        type: 'status-change',
        actor: 'main-agent',
        content: 'Task status changed from paused to completed.',
        occurredAt: completed.updatedAt,
      }),
    ])
    expect(() => store.appendTaskEvent(task.id, {
      type: 'note', content: '领域请求者不能伪装成主 Agent。', actor: 'main-agent',
    }, relationshipAgent)).toThrow('Task event actor must match the authorized requester: domain-agent:relationships')
    store.close()
  })

  it('corrects a Claim as linked history and retrieves the effective version by time', () => {
    const store = new SQLitePersonalStore(databasePath)
    const firstSource = store.createSource({
      rawContent: '用户说偏好周四。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'conversation' },
      accessBoundary,
    })
    const correctionSource = store.createSource({
      rawContent: '用户更正为周五。',
      occurredAt: '2026-09-11T09:00:00.000Z',
      origin: { kind: 'conversation' },
      accessBoundary,
    })
    const original = store.createClaim({
      statement: '用户偏好周四考虑周末安排。',
      epistemicState: 'user-fact',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [firstSource.id],
      accessBoundary,
    })

    expect(() => store.correctClaim(original.id, {
      statement: '无效回溯。',
      epistemicState: 'user-fact',
      scope: 'personal',
      effectiveAt: '2026-09-10T09:00:00.000Z',
      evidenceIds: [correctionSource.id],
      accessBoundary,
    }, relationshipAgent)).toThrow('effectiveAt must be after')

    const correction = store.correctClaim(original.id, {
      statement: '用户偏好周五考虑周末安排。',
      epistemicState: 'user-fact',
      scope: 'personal',
      effectiveAt: '2026-09-11T09:00:00.000Z',
      evidenceIds: [correctionSource.id],
      accessBoundary,
    }, relationshipAgent)

    expect(correction.supersededClaim).toMatchObject({
      id: original.id,
      status: 'superseded',
      validUntil: '2026-09-11T09:00:00.000Z',
      supersededByClaimId: correction.replacementClaim.id,
    })
    expect(correction.replacementClaim).toMatchObject({
      status: 'active',
      validFrom: '2026-09-11T09:00:00.000Z',
      supersedesClaimId: original.id,
    })
    expect(correction.replacementClaim.id).not.toBe(original.id)
    expect(correction.retractedPolicies).toEqual([])
    expect(store.listActiveClaims(relationshipAgent, '2026-09-10T12:00:00.000Z')).toEqual([correction.supersededClaim])
    expect(store.listActiveClaims(relationshipAgent, '2026-09-11T09:00:00.000Z')).toEqual([correction.replacementClaim])
    store.close()

    const reopened = new SQLitePersonalStore(databasePath)
    expect(reopened.getClaim(original.id, relationshipAgent)).toEqual(correction.supersededClaim)
    expect(reopened.getClaim(correction.replacementClaim.id, relationshipAgent)).toEqual(correction.replacementClaim)
    reopened.close()
  })

  it('rejects scheduled Claim corrections without superseding the Claim or retracting its Policies', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '当前认识的证据。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const correctionSource = store.createSource({
      rawContent: '未来更正的证据。',
      occurredAt: '2026-09-11T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '当前认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const policy = store.createPolicy({
      condition: '当前认识成立。',
      action: '继续执行当前策略。',
      dependsOnClaimIds: [claim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })

    expect(() => store.correctClaim(claim.id, {
      statement: '不应预先生效的未来认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      effectiveAt: '2027-09-12T09:00:00.000Z',
      evidenceIds: [correctionSource.id],
      accessBoundary,
    }, relationshipAgent)).toThrow('future effectiveAt is not supported')

    expect(store.getClaim(claim.id, relationshipAgent)).toEqual(claim)
    expect(store.getPolicy(policy.id, relationshipAgent)).toEqual(policy)
    store.close()
  })

  it('forgets Claims and Policies without deleting Sources, cascading to dependent Policies', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '用户不想被晨间提醒。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '用户不想被晨间提醒。',
      epistemicState: 'user-fact',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const dependent = store.createPolicy({
      condition: '早晨。',
      action: '不要主动提醒。',
      dependsOnClaimIds: [claim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })
    const independent = store.createPolicy({
      condition: '周四。',
      action: '询问周末安排。',
      dependsOnClaimIds: [claim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:01:00.000Z',
      accessBoundary,
    })

    const result = store.forgetClaim(claim.id, relationshipAgent)
    expect(result.forgottenClaim.status).toBe('forgotten')
    expect(result.invalidatedPolicies.map(policy => policy.id)).toEqual([dependent.id, independent.id])
    expect(store.getSource(source.id, relationshipAgent)).toEqual(source)
    expect(store.getClaim(claim.id, relationshipAgent)?.status).toBe('forgotten')
    expect(store.getPolicy(dependent.id, relationshipAgent)?.status).toBe('forgotten')
    expect(store.listActiveClaims(relationshipAgent, '2026-09-10T10:00:00.000Z')).toEqual([])
    expect(store.listActivePolicies(relationshipAgent, '2026-09-10T10:00:00.000Z')).toEqual([])
    expect(() => store.forgetPolicy(dependent.id, relationshipAgent)).toThrow('Only an active Policy can be forgotten')
    store.close()
  })

  it('requires an authorized context to correct or forget a record', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '受限记录的原始证据。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '受边界约束的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const policy = store.createPolicy({
      condition: '该认识成立。',
      action: '执行受限动作。',
      dependsOnClaimIds: [claim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })
    const goalsAgent: InternalContext = { requester: { kind: 'domain-agent', id: 'goals' }, use: 'general' }

    expect(() => store.correctClaim(claim.id, {
      statement: '无权纠正。',
      epistemicState: 'model-inference',
      scope: 'personal',
      effectiveAt: '2026-09-11T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    }, goalsAgent)).toThrow(`Claim correction is not authorized for this context: ${claim.id}`)
    expect(() => store.forgetClaim(claim.id, goalsAgent)).toThrow(`Claim forget is not authorized for this context: ${claim.id}`)
    expect(() => store.forgetPolicy(policy.id, goalsAgent)).toThrow(`Policy forget is not authorized for this context: ${policy.id}`)

    expect(store.getClaim(claim.id, relationshipAgent)).toEqual(claim)
    expect(store.getPolicy(policy.id, relationshipAgent)).toEqual(policy)
    store.close()
  })

  it('refuses Claim correction and forgetting when a cascaded Policy is outside the caller boundary', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '级联检查的原始证据。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '可被关系 Agent 读到的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const hiddenBoundary: AccessBoundary = { ...accessBoundary, domainAgents: ['goals'] }
    const hiddenPolicy = store.createPolicy({
      condition: '隐藏策略的条件。',
      action: '不应被关系 Agent 连带改动。',
      dependsOnClaimIds: [claim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary: hiddenBoundary,
    })

    expect(() => store.correctClaim(claim.id, {
      statement: '试图纠正。',
      epistemicState: 'model-inference',
      scope: 'personal',
      effectiveAt: '2026-09-11T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    }, relationshipAgent)).toThrow(`Claim correction is not authorized for this context: ${hiddenPolicy.id}`)
    expect(() => store.forgetClaim(claim.id, relationshipAgent)).toThrow(`Claim forget is not authorized for this context: ${hiddenPolicy.id}`)

    expect(store.getClaim(claim.id, relationshipAgent)).toEqual(claim)
    expect(store.listActiveClaims(relationshipAgent, '2026-09-11T10:00:00.000Z')).toEqual([claim])
    expect(store.getPolicy(hiddenPolicy.id, relationshipAgent)).toBeUndefined()
    expect(store.getPolicy(hiddenPolicy.id, { requester: { kind: 'domain-agent', id: 'goals' }, use: 'general' })?.status).toBe('active')
    store.close()
  })

  it('previews source deletion, preserves independent evidence, and reports unchanged active Tasks', () => {
    const store = new SQLitePersonalStore(databasePath)
    const deletedSource = store.createSource({
      rawContent: '待删除的原始聊天。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'conversation' },
      accessBoundary,
    })
    const remainingSource = store.createSource({
      rawContent: '独立佐证。',
      occurredAt: '2026-09-10T09:01:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const solelySupported = store.createClaim({
      statement: '只由待删除聊天支持。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [deletedSource.id],
      accessBoundary,
    })
    const independentlySupported = store.createClaim({
      statement: '仍有独立佐证。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [deletedSource.id, remainingSource.id],
      accessBoundary,
    })
    const retractedPolicy = store.createPolicy({
      condition: '只由待删除认识支持。',
      action: '执行旧策略。',
      dependsOnClaimIds: [solelySupported.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })
    const retainedPolicy = store.createPolicy({
      condition: '仍由独立认识支持。',
      action: '继续执行。',
      dependsOnClaimIds: [independentlySupported.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })
    const affectedTask = store.createTask({
      title: '受影响但不取消的任务',
      status: 'active',
      entityReferences: [
        { kind: 'source', id: deletedSource.id },
        { kind: 'claim', id: solelySupported.id },
        { kind: 'policy', id: retractedPolicy.id },
      ],
      accessBoundary,
    })
    const unaffectedTask = store.createTask({
      title: '独立任务',
      status: 'active',
      entityReferences: [{ kind: 'policy', id: retainedPolicy.id }],
      accessBoundary,
    })

    const preview = store.previewSourceDeletion(deletedSource.id, relationshipAgent)
    expect(preview).toBeDefined()
    if (!preview) throw new Error('expected an authorized deletion preview')
    expect(preview.source).toEqual(deletedSource)
    expect(preview.solelySupportedClaims.map(claim => claim.id)).toEqual([solelySupported.id])
    expect(preview.claimsWithIndependentEvidence.map(claim => claim.id)).toEqual([independentlySupported.id])
    expect(preview.policiesToRetract.map(policy => policy.id)).toEqual([retractedPolicy.id])
    expect(preview.affectedActiveTaskIds).toEqual([affectedTask.id])
    expect(store.getSource(deletedSource.id, relationshipAgent)).toEqual(deletedSource)
    expect(store.getClaim(solelySupported.id, relationshipAgent)?.status).toBe('active')
    expect(() => store.deleteSource(deletedSource.id, relationshipAgent, {} as never)).toThrow('requires { confirm: true }')
    expect(store.getSource(deletedSource.id, relationshipAgent)).toEqual(deletedSource)
    expect(store.getClaim(solelySupported.id, relationshipAgent)?.status).toBe('active')
    expect(store.getPolicy(retractedPolicy.id, relationshipAgent)?.status).toBe('active')

    const result = store.deleteSource(deletedSource.id, relationshipAgent, { confirm: true })
    expect(result.deletedSource).toEqual(deletedSource)
    expect(result.retractedClaims.map(claim => claim.id)).toEqual([solelySupported.id])
    expect(result.survivingClaims).toEqual([{ ...independentlySupported, evidenceIds: [remainingSource.id] }])
    expect(result.retractedPolicies.map(policy => policy.id)).toEqual([retractedPolicy.id])
    expect(result.affectedActiveTaskIds).toEqual([affectedTask.id])
    expect(store.getSource(deletedSource.id, relationshipAgent)).toBeUndefined()
    expect(store.getClaim(solelySupported.id, relationshipAgent)?.status).toBe('retracted')
    expect(store.getClaim(independentlySupported.id, relationshipAgent)).toEqual({
      ...independentlySupported,
      evidenceIds: [remainingSource.id],
    })
    expect(store.getPolicy(retractedPolicy.id, relationshipAgent)?.status).toBe('retracted')
    expect(store.getPolicy(retainedPolicy.id, relationshipAgent)?.status).toBe('active')
    expect(store.getTask(affectedTask.id, relationshipAgent)?.status).toBe('active')
    expect(store.getTask(unaffectedTask.id, relationshipAgent)?.status).toBe('active')
    store.close()

    const reopened = new SQLitePersonalStore(databasePath)
    expect(reopened.getSource(deletedSource.id, relationshipAgent)).toBeUndefined()
    expect(reopened.getClaim(solelySupported.id, relationshipAgent)?.status).toBe('retracted')
    expect(reopened.getClaim(independentlySupported.id, relationshipAgent)?.evidenceIds).toEqual([remainingSource.id])
    expect(reopened.getPolicy(retractedPolicy.id, relationshipAgent)?.status).toBe('retracted')
    reopened.close()
  })

  it('refuses source deletion when an affected active Task is outside the caller boundary', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '受影响任务关联的证据。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '受删除影响的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    store.createTask({
      title: '不应向关系 Agent 暴露的受影响任务',
      status: 'active',
      entityReferences: [{ kind: 'claim', id: claim.id }],
      accessBoundary: { ...accessBoundary, domainAgents: ['goals'] },
    })

    expect(store.previewSourceDeletion(source.id, relationshipAgent)).toBeUndefined()
    expect(() => store.deleteSource(source.id, relationshipAgent, { confirm: true }))
      .toThrow('Source deletion is not authorized for this context')
    expect(store.getSource(source.id, relationshipAgent)).toEqual(source)
    expect(store.getClaim(claim.id, relationshipAgent)).toEqual(claim)
    store.close()
  })

  it('requires an authorized deletion context and never exposes raw source content to a summary reader', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '只允许领域 Agent 读取的原始删除证据。',
      summary: '可供主 Agent 预览的删除证据摘要。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const claim = store.createClaim({
      statement: '可供主 Agent 读取的认识。',
      epistemicState: 'user-fact',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const policy = store.createPolicy({
      condition: '该认识仍有效。',
      action: '执行策略。',
      dependsOnClaimIds: [claim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })

    const mainPreview = store.previewSourceDeletion(source.id, summaryMain)
    expect(mainPreview).toBeDefined()
    expect(mainPreview?.source).toMatchObject({ id: source.id, summary: source.summary })
    expect(mainPreview?.source).not.toHaveProperty('rawContent')
    expect(store.previewSourceDeletion(source.id, relationshipAgent)?.source).toEqual(source)

    const policyRestrictedBoundary: AccessBoundary = { ...accessBoundary, mainAgent: 'none' }
    const policyRestrictedSource = store.createSource({
      rawContent: '策略受限的证据。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const policyRestrictedClaim = store.createClaim({
      statement: '策略受限的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [policyRestrictedSource.id],
      accessBoundary,
    })
    store.createPolicy({
      condition: '不应向主 Agent 暴露。',
      action: '不应删除。',
      dependsOnClaimIds: [policyRestrictedClaim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary: policyRestrictedBoundary,
    })

    expect(store.previewSourceDeletion(policyRestrictedSource.id, summaryMain)).toBeUndefined()
    expect(() => store.deleteSource(policyRestrictedSource.id, summaryMain, { confirm: true }))
      .toThrow('not authorized')
    expect(store.getSource(policyRestrictedSource.id, relationshipAgent)).toBeDefined()

    const result = store.deleteSource(source.id, summaryMain, { confirm: true })
    expect(result.deletedSource).not.toHaveProperty('rawContent')
    expect(result.retractedPolicies.map(item => item.id)).toEqual([policy.id])
    store.close()
  })

  it('retracts every active Policy that depends on a corrected Claim, including multi-Claim Policies', () => {
    const store = new SQLitePersonalStore(databasePath)
    const originalSource = store.createSource({
      rawContent: '最初的认识。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const correctionSource = store.createSource({
      rawContent: '更正的认识。',
      occurredAt: '2026-09-11T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const oldClaim = store.createClaim({
      statement: '旧认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [originalSource.id],
      accessBoundary,
    })
    const independentClaim = store.createClaim({
      statement: '独立认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [originalSource.id],
      accessBoundary,
    })
    const onlyOld = store.createPolicy({
      condition: '旧认识成立。',
      action: '旧动作。',
      dependsOnClaimIds: [oldClaim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })
    const multipleDependencies = store.createPolicy({
      condition: '旧认识和独立认识成立。',
      action: '组合动作。',
      dependsOnClaimIds: [oldClaim.id, independentClaim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })
    const independent = store.createPolicy({
      condition: '独立认识成立。',
      action: '保留动作。',
      dependsOnClaimIds: [independentClaim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })

    const correction = store.correctClaim(oldClaim.id, {
      statement: '新认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      effectiveAt: '2026-09-11T09:00:00.000Z',
      evidenceIds: [correctionSource.id],
      accessBoundary,
    }, relationshipAgent)

    expect(correction.retractedPolicies.map(item => item.id)).toEqual(expect.arrayContaining([onlyOld.id, multipleDependencies.id]))
    expect(correction.retractedPolicies).toHaveLength(2)
    expect(store.getPolicy(onlyOld.id, relationshipAgent)?.status).toBe('retracted')
    expect(store.getPolicy(multipleDependencies.id, relationshipAgent)?.status).toBe('retracted')
    expect(store.listActivePolicies(relationshipAgent, '2026-09-11T10:00:00.000Z')).toEqual([independent])
    store.close()
  })

  it('rejects Policies based on non-active Claims and defensively hides corrupted active Policies', () => {
    const store = new SQLitePersonalStore(databasePath)
    const source = store.createSource({
      rawContent: '策略的证据。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const activeClaim = store.createClaim({
      statement: '有效认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const superseded = store.correctClaim(activeClaim.id, {
      statement: '替代认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      effectiveAt: '2026-09-11T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    }, relationshipAgent).supersededClaim
    const forgottenClaim = store.createClaim({
      statement: '将被遗忘的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const forgotten = store.forgetClaim(forgottenClaim.id, relationshipAgent).forgottenClaim
    const retractedSource = store.createSource({
      rawContent: '将被删除的唯一证据。',
      occurredAt: '2026-09-10T09:00:00.000Z',
      origin: { kind: 'manual' },
      accessBoundary,
    })
    const retractedClaim = store.createClaim({
      statement: '将被撤回的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [retractedSource.id],
      accessBoundary,
    })
    const retracted = store.deleteSource(retractedSource.id, relationshipAgent, { confirm: true }).retractedClaims[0]

    for (const claim of [superseded, forgotten, retracted]) {
      expect(() => store.createPolicy({
        condition: '无效认识不应作为策略依据。',
        action: '拒绝创建。',
        dependsOnClaimIds: [claim.id],
        scope: 'personal',
        validFrom: '2026-09-12T09:00:00.000Z',
        accessBoundary,
      })).toThrow('Policy dependencies must be active Claims')
    }

    const defensivelyCheckedClaim = store.createClaim({
      statement: '数据库损坏前的认识。',
      epistemicState: 'model-inference',
      scope: 'personal',
      status: 'active',
      validFrom: '2026-09-10T09:00:00.000Z',
      evidenceIds: [source.id],
      accessBoundary,
    })
    const defensivelyCheckedPolicy = store.createPolicy({
      condition: '数据库损坏前的策略。',
      action: '不应继续返回。',
      dependsOnClaimIds: [defensivelyCheckedClaim.id],
      scope: 'personal',
      validFrom: '2026-09-10T09:00:00.000Z',
      accessBoundary,
    })
    const directDatabase = new DatabaseSync(databasePath)
    directDatabase.prepare("UPDATE claims SET status = 'forgotten' WHERE id = ?").run(defensivelyCheckedClaim.id)
    directDatabase.close()

    expect(store.getPolicy(defensivelyCheckedPolicy.id, relationshipAgent)?.status).toBe('active')
    expect(store.listActivePolicies(relationshipAgent, '2026-09-12T10:00:00.000Z')).not.toContainEqual(defensivelyCheckedPolicy)
    store.close()
  })

  it('migrates a database made by the prior personal-store slice', () => {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE sources (id TEXT PRIMARY KEY, raw_content TEXT NOT NULL, summary TEXT, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, origin_json TEXT NOT NULL, access_boundary_json TEXT NOT NULL) STRICT;
      CREATE TABLE claims (id TEXT PRIMARY KEY, statement TEXT NOT NULL, epistemic_state TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, evidence_ids_json TEXT NOT NULL, access_boundary_json TEXT NOT NULL) STRICT;
      CREATE TABLE policies (id TEXT PRIMARY KEY, condition TEXT NOT NULL, action TEXT NOT NULL, depends_on_claim_ids_json TEXT NOT NULL, scope TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, access_boundary_json TEXT NOT NULL) STRICT;
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, entity_references_json TEXT NOT NULL, access_boundary_json TEXT NOT NULL) STRICT;
      CREATE TABLE task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, content TEXT NOT NULL, actor TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL) STRICT;
    `)
    const sourceId = 'legacy-source'
    const claimId = 'legacy-claim'
    const policyId = 'legacy-policy'
    legacy.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      sourceId, '旧来源', null, '2026-09-10T09:00:00.000Z', '2026-09-10T09:00:00.000Z', JSON.stringify({ kind: 'manual' }), JSON.stringify(accessBoundary),
    )
    legacy.prepare('INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      claimId, '旧认识', 'model-inference', 'personal', 'active', '2026-09-10T09:00:00.000Z', null, JSON.stringify([sourceId]), JSON.stringify(accessBoundary),
    )
    legacy.prepare('INSERT INTO policies VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      policyId, '旧条件', '旧动作', JSON.stringify([claimId]), 'personal', '2026-09-10T09:00:00.000Z', null, JSON.stringify(accessBoundary),
    )
    legacy.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-task', '旧任务', 'active', '2026-09-10T09:00:00.000Z', '2026-09-10T09:00:00.000Z', '[]', JSON.stringify(accessBoundary),
    )
    legacy.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-event', 'legacy-task', 'note', '旧事件仍应保留为可引用证据。', 'main-agent',
      '2026-09-10T09:01:00.000Z', '2026-09-10T09:02:00.000Z',
    )
    legacy.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-event-second', 'legacy-task', 'progress', '同一时间的第二条旧事件。', 'main-agent',
      '2026-09-10T09:01:00.000Z', '2026-09-10T09:02:00.000Z',
    )
    legacy.close()

    const store = new SQLitePersonalStore(databasePath)
    expect(store.getClaim(claimId, relationshipAgent)).toMatchObject({ id: claimId, status: 'active' })
    expect(store.getPolicy(policyId, relationshipAgent)).toMatchObject({ id: policyId, status: 'active' })
    expect(store.listActivePolicies(relationshipAgent, '2026-09-10T10:00:00.000Z')).toHaveLength(1)
    expect(store.getTask('legacy-task', relationshipAgent)).toMatchObject({
      id: 'legacy-task',
      title: '旧任务',
      objective: '旧任务',
      domain: 'legacy',
      owner: 'main-agent',
      status: 'active',
    })
    const [legacyEvent] = store.listTaskEvents('legacy-task', relationshipAgent)
    expect(legacyEvent).toMatchObject({
      id: 'legacy-event',
      taskId: 'legacy-task',
      content: '旧事件仍应保留为可引用证据。',
      actor: 'main-agent',
      occurredAt: '2026-09-10T09:01:00.000Z',
      recordedAt: '2026-09-10T09:02:00.000Z',
    })
    expect(store.getSource(legacyEvent.sourceId, relationshipAgent)).toEqual({
      id: legacyEvent.sourceId,
      rawContent: legacyEvent.content,
      occurredAt: legacyEvent.occurredAt,
      recordedAt: legacyEvent.recordedAt,
      origin: { kind: 'task-event', reference: legacyEvent.id },
      accessBoundary,
    })
    expect(store.listTaskEvents('legacy-task', relationshipAgent).map(event => event.id))
      .toEqual(['legacy-event', 'legacy-event-second'])
    expect(store.listTaskEvents('legacy-task', summaryMain, 1).map(event => event.id))
      .toEqual(['legacy-event-second'])
    store.close()
  })
})
