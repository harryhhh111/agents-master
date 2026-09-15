import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AppendMainConversationMessageInput,
  MainConversationMessage,
  MainConversationRole,
  MainConversationStore,
} from './types.js'

type ConversationRow = {
  id: string
  role: MainConversationRole
  content: string
  created_at: string
  append_order: number
}

const maxRecentContextMessages = 100

function now(): string {
  return new Date().toISOString()
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
}

function requireIsoTime(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`)
  }
}

function requireRole(role: MainConversationRole): void {
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    throw new Error(`Unsupported main conversation role: ${role}`)
  }
}

/**
 * A deliberately small transcript store. It has no Source/Claim write path:
 * promotion into the cognitive store must remain an explicit later decision.
 */
export class SQLiteMainConversationStore implements MainConversationStore {
  readonly #db: DatabaseSync

  constructor(databasePath: string) {
    this.#db = new DatabaseSync(databasePath)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS main_conversation_messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        append_order INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS main_conversation_messages_by_created
        ON main_conversation_messages(created_at, append_order);
    `)
    this.#migrateSchema()
  }

  appendMessage(input: AppendMainConversationMessageInput): MainConversationMessage {
    requireRole(input.role)
    requireText(input.content, 'content')
    const createdAt = input.createdAt ?? now()
    requireIsoTime(createdAt, 'createdAt')
    const message: MainConversationMessage = {
      id: randomUUID(),
      role: input.role,
      content: input.content,
      createdAt,
    }
    this.#db.prepare(`
      INSERT INTO main_conversation_messages (id, role, content, created_at, append_order)
      VALUES (?, ?, ?, ?, (
        SELECT COALESCE(MAX(append_order), 0) + 1 FROM main_conversation_messages
      ))
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
    return rows.map(row => ({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }))
  }

  close(): void {
    this.#db.close()
  }

  #migrateSchema(): void {
    const columns = this.#db.prepare('PRAGMA table_info(main_conversation_messages)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'append_order')) {
      // The prior Stage 1.1 schema has no sequence. SQLite rowids retain the
      // insertion order for those existing rows, so seed the durable sequence
      // from them before all future appends use it directly.
      this.#db.exec('ALTER TABLE main_conversation_messages ADD COLUMN append_order INTEGER')
      this.#db.exec('UPDATE main_conversation_messages SET append_order = rowid WHERE append_order IS NULL')
    }
    this.#db.exec(`
      DROP INDEX IF EXISTS main_conversation_messages_by_created;
      CREATE INDEX main_conversation_messages_by_created
        ON main_conversation_messages(created_at, append_order);
      CREATE UNIQUE INDEX IF NOT EXISTS main_conversation_messages_by_append_order
        ON main_conversation_messages(append_order);
    `)
  }
}
