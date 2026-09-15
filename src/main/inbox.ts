import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  EnqueueInboxEventInput,
  EnqueueInboxEventResult,
  InboxEvent,
  InboxEventId,
  InboxEventPriority,
  InboxEventStatus,
  InboxEventType,
  InboxPayload,
  MainConversationMessage,
  MainAgentRuntimeStore,
  ReceiveUserMessageInput,
  ReceiveUserMessageResult,
} from './types.js'
import { InboxIdempotencyConflictError } from './types.js'

type InboxRow = {
  id: string
  conversation_id: string
  idempotency_key: string
  type: InboxEventType
  priority: InboxEventPriority
  payload: string
  status: InboxEventStatus
  created_at: string
  updated_at: string
  claimed_at: string | null
  processed_at: string | null
  cancelled_at: string | null
  user_message_id: string | null
  append_order: number
}

type ConversationRow = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
  append_order: number
}

export interface SQLiteMainInboxStoreOptions {
  clock?: () => string
}

const maxRecentContextMessages = 100

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
}

function requireIsoTime(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`)
  }
}

function requirePriority(value: InboxEventPriority): void {
  if (value !== 'normal' && value !== 'interrupt') throw new Error(`Unsupported inbox priority: ${value}`)
}

function requireEventType(value: InboxEventType): void {
  if (value !== 'user-message' && value !== 'domain-update' && value !== 'timer') {
    throw new Error(`Unsupported inbox event type: ${value}`)
  }
}

function requireFinitePayloadNumbers(payload: InboxPayload): void {
  if (typeof payload === 'number') {
    if (!Number.isFinite(payload)) throw new Error('payload must not contain non-finite numbers')
    return
  }
  if (Array.isArray(payload)) {
    for (const value of payload) requireFinitePayloadNumbers(value)
    return
  }
  if (payload && typeof payload === 'object') {
    for (const value of Object.values(payload)) requireFinitePayloadNumbers(value)
  }
}

function serializePayload(payload: InboxPayload): string {
  requireFinitePayloadNumbers(payload)
  const serialized = JSON.stringify(payload)
  if (serialized === undefined) throw new Error('payload must be JSON-serializable')
  return serialized
}

function parsePayload(payload: string): InboxPayload {
  return JSON.parse(payload) as InboxPayload
}

function toEvent(row: InboxRow): InboxEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    type: row.type,
    priority: row.priority,
    payload: parsePayload(row.payload),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.processed_at ? { processedAt: row.processed_at } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    ...(row.user_message_id ? { userMessageId: row.user_message_id } : {}),
  }
}

function toMessage(row: ConversationRow): MainConversationMessage {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.created_at }
}

/**
 * One SQLite connection owns both tables, so user-message admission is a
 * single database transaction rather than a best-effort cross-store action.
 */
export class SQLiteMainInboxStore implements MainAgentRuntimeStore {
  readonly #db: DatabaseSync
  readonly #clock: () => string

  constructor(databasePath: string, options: SQLiteMainInboxStoreOptions = {}) {
    this.#db = new DatabaseSync(databasePath)
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#initializeSchema()
  }

  appendMessage(input: { role: 'user' | 'assistant' | 'system'; content: string; createdAt?: string }): MainConversationMessage {
    if (input.role !== 'user' && input.role !== 'assistant' && input.role !== 'system') {
      throw new Error(`Unsupported main conversation role: ${input.role}`)
    }
    requireText(input.content, 'content')
    const createdAt = input.createdAt ?? this.#now()
    requireIsoTime(createdAt, 'createdAt')
    const message = { id: randomUUID(), role: input.role, content: input.content, createdAt }
    this.#db.prepare(`
      INSERT INTO main_conversation_messages (id, role, content, created_at, append_order)
      VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(append_order), 0) + 1 FROM main_conversation_messages))
    `).run(message.id, message.role, message.content, message.createdAt)
    return message
  }

  readRecentContext(limit = 20): MainConversationMessage[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRecentContextMessages) {
      throw new Error(`limit must be a positive integer no greater than ${maxRecentContextMessages}`)
    }
    const rows = this.#db.prepare(`
      SELECT * FROM (
        SELECT * FROM main_conversation_messages ORDER BY created_at DESC, append_order DESC LIMIT ?
      ) ORDER BY created_at, append_order
    `).all(limit) as ConversationRow[]
    return rows.map(toMessage)
  }

  receiveUserMessage(input: ReceiveUserMessageInput): ReceiveUserMessageResult {
    requireText(input.conversationId, 'conversationId')
    requireText(input.idempotencyKey, 'idempotencyKey')
    requireText(input.content, 'content')
    const priority = input.priority ?? 'normal'
    requirePriority(priority)
    const receivedAt = input.receivedAt ?? this.#now()
    requireIsoTime(receivedAt, 'receivedAt')

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#findEventByKey(input.conversationId, input.idempotencyKey)
      if (existing) {
        const message = existing.user_message_id
          ? this.#findMessage(existing.user_message_id)
          : undefined
        if (
          existing.type !== 'user-message'
          || existing.priority !== priority
          || !message
          || message.content !== input.content
        ) {
          throw new InboxIdempotencyConflictError(input.conversationId, input.idempotencyKey)
        }
        this.#db.exec('COMMIT')
        return { message: toMessage(message), event: toEvent(existing), duplicate: true }
      }

      const message: MainConversationMessage = {
        id: randomUUID(), role: 'user', content: input.content, createdAt: receivedAt,
      }
      const event: InboxEvent = {
        id: randomUUID(),
        conversationId: input.conversationId,
        idempotencyKey: input.idempotencyKey,
        type: 'user-message',
        priority,
        payload: { messageId: message.id, text: message.content },
        status: 'pending',
        createdAt: receivedAt,
        updatedAt: receivedAt,
        userMessageId: message.id,
      }
      this.#db.prepare(`
        INSERT INTO main_conversation_messages (id, role, content, created_at, append_order)
        VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(append_order), 0) + 1 FROM main_conversation_messages))
      `).run(message.id, message.role, message.content, message.createdAt)
      this.#insertEvent(event)
      this.#db.exec('COMMIT')
      return { message, event, duplicate: false }
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  enqueueEvent(input: EnqueueInboxEventInput): EnqueueInboxEventResult {
    requireText(input.conversationId, 'conversationId')
    requireText(input.idempotencyKey, 'idempotencyKey')
    requireEventType(input.type)
    const priority = input.priority ?? 'normal'
    requirePriority(priority)
    const createdAt = input.createdAt ?? this.#now()
    requireIsoTime(createdAt, 'createdAt')
    const payload = serializePayload(input.payload)

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#findEventByKey(input.conversationId, input.idempotencyKey)
      if (existing) {
        if (existing.type !== input.type || existing.priority !== priority || existing.payload !== payload) {
          throw new InboxIdempotencyConflictError(input.conversationId, input.idempotencyKey)
        }
        this.#db.exec('COMMIT')
        return { event: toEvent(existing), duplicate: true }
      }
      const event: InboxEvent = {
        id: randomUUID(), conversationId: input.conversationId, idempotencyKey: input.idempotencyKey,
        type: input.type, priority, payload: input.payload, status: 'pending', createdAt, updatedAt: createdAt,
      }
      this.#insertEvent(event)
      this.#db.exec('COMMIT')
      return { event, duplicate: false }
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  claimNextPendingEvent(claimedAt = this.#now()): InboxEvent | undefined {
    requireIsoTime(claimedAt, 'claimedAt')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.#db.prepare(`
        SELECT * FROM inbox_events WHERE status = 'pending'
        ORDER BY CASE priority WHEN 'interrupt' THEN 0 ELSE 1 END, append_order LIMIT 1
      `).get() as InboxRow | undefined
      if (!candidate) {
        this.#db.exec('COMMIT')
        return undefined
      }
      const update = this.#db.prepare(`
        UPDATE inbox_events SET status = 'claimed', claimed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(claimedAt, claimedAt, candidate.id)
      if (update.changes !== 1) throw new Error(`Unable to claim pending inbox event: ${candidate.id}`)
      const claimed = this.#findEvent(candidate.id)
      this.#db.exec('COMMIT')
      return toEvent(claimed)
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  completeInboxEvent(id: InboxEventId, completedAt = this.#now()): InboxEvent {
    return this.#transitionClaimedEvent(id, 'processed', completedAt, 'completedAt')
  }

  cancelInboxEvent(id: InboxEventId, cancelledAt = this.#now()): InboxEvent {
    return this.#transitionClaimedEvent(id, 'cancelled', cancelledAt, 'cancelledAt')
  }

  recoverClaimedEvents(recoveredAt = this.#now()): number {
    requireIsoTime(recoveredAt, 'recoveredAt')
    return Number(this.#db.prepare(`
      UPDATE inbox_events SET status = 'pending', claimed_at = NULL, updated_at = ? WHERE status = 'claimed'
    `).run(recoveredAt).changes)
  }

  close(): void {
    this.#db.close()
  }

  #now(): string {
    const value = this.#clock()
    requireIsoTime(value, 'clock result')
    return value
  }

  #insertEvent(event: InboxEvent): void {
    this.#db.prepare(`
      INSERT INTO inbox_events (
        id, conversation_id, idempotency_key, type, priority, payload, status,
        created_at, updated_at, claimed_at, processed_at, cancelled_at, user_message_id, append_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT COALESCE(MAX(append_order), 0) + 1 FROM inbox_events))
    `).run(
      event.id, event.conversationId, event.idempotencyKey, event.type, event.priority,
      serializePayload(event.payload), event.status, event.createdAt, event.updatedAt,
      event.claimedAt ?? null, event.processedAt ?? null, event.cancelledAt ?? null, event.userMessageId ?? null,
    )
  }

  #findEventByKey(conversationId: string, idempotencyKey: string): InboxRow | undefined {
    return this.#db.prepare('SELECT * FROM inbox_events WHERE conversation_id = ? AND idempotency_key = ?')
      .get(conversationId, idempotencyKey) as InboxRow | undefined
  }

  #findEvent(id: string): InboxRow {
    const event = this.#db.prepare('SELECT * FROM inbox_events WHERE id = ?').get(id) as InboxRow | undefined
    if (!event) throw new Error(`Inbox event not found: ${id}`)
    return event
  }

  #findMessage(id: string): ConversationRow | undefined {
    return this.#db.prepare('SELECT * FROM main_conversation_messages WHERE id = ?').get(id) as ConversationRow | undefined
  }

  #transitionClaimedEvent(id: InboxEventId, status: 'processed' | 'cancelled', at: string, field: string): InboxEvent {
    requireText(id, 'id')
    requireIsoTime(at, field)
    const column = status === 'processed' ? 'processed_at' : 'cancelled_at'
    const result = this.#db.prepare(`
      UPDATE inbox_events SET status = ?, ${column} = ?, updated_at = ? WHERE id = ? AND status = 'claimed'
    `).run(status, at, at, id)
    if (result.changes !== 1) {
      const event = this.#db.prepare('SELECT status FROM inbox_events WHERE id = ?').get(id) as { status: InboxEventStatus } | undefined
      if (!event) throw new Error(`Inbox event not found: ${id}`)
      throw new Error(`Cannot transition inbox event ${id} from ${event.status} to ${status}`)
    }
    return toEvent(this.#findEvent(id))
  }

  #initializeSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS main_conversation_messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        append_order INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS inbox_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('user-message', 'domain-update', 'timer')),
        priority TEXT NOT NULL CHECK (priority IN ('normal', 'interrupt')),
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'processed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        processed_at TEXT,
        cancelled_at TEXT,
        user_message_id TEXT REFERENCES main_conversation_messages(id),
        append_order INTEGER NOT NULL,
        UNIQUE (conversation_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS inbox_events_next_pending
        ON inbox_events(status, priority, append_order);
    `)
    const columns = this.#db.prepare('PRAGMA table_info(main_conversation_messages)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'append_order')) {
      this.#db.exec('ALTER TABLE main_conversation_messages ADD COLUMN append_order INTEGER')
      this.#db.exec('UPDATE main_conversation_messages SET append_order = rowid WHERE append_order IS NULL')
    }
    this.#db.exec(`
      DROP INDEX IF EXISTS main_conversation_messages_by_created;
      CREATE INDEX main_conversation_messages_by_created
        ON main_conversation_messages(created_at, append_order);
      CREATE UNIQUE INDEX IF NOT EXISTS main_conversation_messages_by_append_order
        ON main_conversation_messages(append_order);
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_events_by_append_order ON inbox_events(append_order);
    `)
  }
}
