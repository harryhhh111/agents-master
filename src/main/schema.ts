import { chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type CoordinationSchemaOptions =
  | { mode: 'preview-fresh' }
  | { mode: 'preview-open' }
  | { mode: 'preview-migrate'; backupPath: string }
  | { mode: 'fresh' }
  | { mode: 'open' }
  | { mode: 'migrate'; syntheticSingleMain: true; backupPath: string; fault?: () => void }

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// The legacy DDL and the opt-in upgrade have one owner. No coordinator table
// or message column is created by ordinary legacy startup.
function legacySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS main_conversation_messages (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL, append_order INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS inbox_events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('user-message', 'domain-update', 'timer')),
      priority TEXT NOT NULL CHECK (priority IN ('normal', 'interrupt')),
      payload TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'processed', 'cancelled')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, claimed_at TEXT, processed_at TEXT,
      cancelled_at TEXT, user_message_id TEXT REFERENCES main_conversation_messages(id),
      append_order INTEGER NOT NULL, UNIQUE (conversation_id, idempotency_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS inbox_events_next_pending ON inbox_events(status, priority, append_order);
  `)
  const columns = db.prepare('PRAGMA table_info(main_conversation_messages)').all()
  if (!columns.some(column => column.name === 'append_order')) {
    db.exec('ALTER TABLE main_conversation_messages ADD COLUMN append_order INTEGER')
    db.exec('UPDATE main_conversation_messages SET append_order = rowid WHERE append_order IS NULL')
  }
  db.exec(`
    DROP INDEX IF EXISTS main_conversation_messages_by_created;
    CREATE UNIQUE INDEX IF NOT EXISTS main_conversation_messages_by_append_order ON main_conversation_messages(append_order);
    CREATE UNIQUE INDEX IF NOT EXISTS inbox_events_by_append_order ON inbox_events(append_order);
  `)
}

function validateLegacy(db: DatabaseSync): void {
  validateKnownSchema(db, false)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name)
  if (JSON.stringify(tables) !== JSON.stringify(['inbox_events', 'main_conversation_messages'])) throw new Error('Unknown or ambiguous legacy schema')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").get()) throw new Error('Unknown legacy trigger or view')
  const expected = {
    main_conversation_messages: 'id,role,content,created_at,append_order',
    inbox_events: 'id,conversation_id,idempotency_key,type,priority,payload,status,created_at,updated_at,claimed_at,processed_at,cancelled_at,user_message_id,append_order',
  }
  for (const [table, names] of Object.entries(expected)) {
    if (db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name).join(',') !== names) throw new Error('Unknown legacy columns')
  }
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Legacy integrity failure')
  if (db.prepare(`SELECT 1 FROM inbox_events e LEFT JOIN main_conversation_messages m ON m.id=e.user_message_id
      WHERE e.conversation_id <> 'main' OR (e.type='user-message' AND
        (m.id IS NULL OR m.role <> 'user' OR NOT json_valid(e.payload) OR json_extract(e.payload,'$.messageId') IS NOT m.id
         OR json_extract(e.payload,'$.text') IS NOT m.content))
      OR (e.type <> 'user-message' AND e.user_message_id IS NOT NULL) LIMIT 1`).get()) throw new Error('Ambiguous legacy conversation or inbox link')
  if (db.prepare(`SELECT user_message_id FROM inbox_events WHERE user_message_id IS NOT NULL
      GROUP BY user_message_id HAVING COUNT(*) > 1`).get()) throw new Error('Ambiguous legacy user input')
  for (const table of Object.keys(expected)) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE append_order IS NULL OR append_order < 1 LIMIT 1`).get()
        || db.prepare(`SELECT append_order FROM ${table} GROUP BY append_order HAVING COUNT(*) > 1`).get()) throw new Error('Invalid append order')
  }
  for (const row of db.prepare('SELECT role, created_at FROM main_conversation_messages').all()) {
    if (!['user', 'assistant', 'system'].includes(String(row.role))) throw new Error('Unknown legacy role')
    iso(String(row.created_at))
  }
  for (const row of db.prepare('SELECT * FROM inbox_events').all()) {
    for (const key of ['created_at', 'updated_at', 'claimed_at', 'processed_at', 'cancelled_at']) if (row[key] !== null) iso(String(row[key]))
  }
}

function schemaFingerprint(db: DatabaseSync): string {
  // 标识符的可选双引号（如 ALTER RENAME 后 sqlite_master 保存的形式）不影响 schema 等价性。
  return JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .map(row => ({ type: row.type, name: row.name, sql: String(row.sql).replace(/"/g, '').replace(/\s+/g, '').toLowerCase() })))
}

/** Refuse unknown DDL/constraints/indexes/triggers, not merely unknown columns. */
function validateKnownSchema(db: DatabaseSync, upgraded: boolean, preview = false): void {
  const expected = new DatabaseSync(':memory:')
  try {
    legacySchema(expected)
    if (upgraded) upgrade(expected)
    if (preview) previewSchema(expected)
    if (schemaFingerprint(db) !== schemaFingerprint(expected)) throw new Error('Unknown or incomplete schema definition')
  } finally { expected.close() }
}

export function iso(value: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Time must be canonical UTC ISO')
  return value
}

function upgrade(db: DatabaseSync, executorCheck = `CHECK(executor IN ('FAKE','CLI'))`): void {
  db.exec(`
    CREATE TABLE coordination_conversations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('main','domain')),
      agent_id TEXT NOT NULL, project_key TEXT, background TEXT NOT NULL
    ) STRICT;
    INSERT INTO coordination_conversations VALUES ('main','main','main-agent',NULL,''),
      ('fake-work','domain','fake-work-agent','FAKE-project','FAKE synthetic project background v1');
    ALTER TABLE main_conversation_messages ADD COLUMN conversation_id TEXT REFERENCES coordination_conversations(id);
    ALTER TABLE main_conversation_messages ADD COLUMN author TEXT;
    ALTER TABLE main_conversation_messages ADD COLUMN presentation TEXT;
    ALTER TABLE main_conversation_messages ADD COLUMN assignment_id TEXT;
    ALTER TABLE main_conversation_messages ADD COLUMN run_id TEXT;
    UPDATE main_conversation_messages SET conversation_id='main',
      author=CASE role WHEN 'user' THEN 'user' WHEN 'assistant' THEN 'main-agent' ELSE 'runtime' END,
      presentation=CASE WHEN id IN (SELECT user_message_id FROM inbox_events WHERE type='user-message') THEN 'input' ELSE 'chat' END;
    CREATE TABLE coordination_assignments (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, source_event TEXT NOT NULL UNIQUE REFERENCES inbox_events(id),
      conversation_id TEXT NOT NULL REFERENCES coordination_conversations(id), return_conversation TEXT NOT NULL REFERENCES coordination_conversations(id),
      project_key TEXT NOT NULL, agent_id TEXT NOT NULL, decision TEXT NOT NULL, accepted TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_input','cancel_requested','completed','failed','cancelled','interrupted')),
      version INTEGER NOT NULL, input_version INTEGER NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE coordination_runs (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, assignment_id TEXT NOT NULL REFERENCES coordination_assignments(id),
      conversation_id TEXT NOT NULL REFERENCES coordination_conversations(id), project_key TEXT NOT NULL,
      version INTEGER NOT NULL, input_version INTEGER NOT NULL, executor TEXT NOT NULL ${executorCheck}, context TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('starting','running','succeeded','failed','cancel_requested','cancelled','unknown')),
      started_at TEXT NOT NULL, ended_at TEXT, result TEXT
    ) STRICT;
    CREATE UNIQUE INDEX coordination_one_active_project ON coordination_runs(project_key)
      WHERE status IN ('starting','running','cancel_requested');
    CREATE TABLE coordination_questions (
      id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES coordination_assignments(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES coordination_runs(id), version INTEGER NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','answered','revoked')), answer_event TEXT REFERENCES inbox_events(id), answer TEXT, answer_result TEXT
    ) STRICT;
    CREATE TABLE coordination_receipts (
      run_id TEXT PRIMARY KEY REFERENCES coordination_runs(id), payload TEXT NOT NULL, accepted INTEGER NOT NULL CHECK(accepted IN (0,1)), created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE coordination_front_locks (
      conversation_id TEXT PRIMARY KEY REFERENCES coordination_conversations(id),
      event_id TEXT NOT NULL UNIQUE REFERENCES inbox_events(id)
    ) STRICT;
    CREATE TABLE coordination_front_state (
      conversation_id TEXT PRIMARY KEY REFERENCES coordination_conversations(id), user_turns INTEGER NOT NULL
    ) STRICT;
    INSERT INTO coordination_front_state VALUES ('main',0),('fake-work',0);
    CREATE TABLE coordination_outbox (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, assignment_id TEXT NOT NULL REFERENCES coordination_assignments(id),
      run_id TEXT REFERENCES coordination_runs(id), version INTEGER NOT NULL, conversation_id TEXT NOT NULL REFERENCES coordination_conversations(id),
      kind TEXT NOT NULL CHECK(kind IN ('completed','failed','waiting_input','cancelled','interrupted')),
      body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','delivered','superseded')),
      message_id TEXT REFERENCES main_conversation_messages(id), created_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER coordination_message_guard BEFORE INSERT ON main_conversation_messages BEGIN
      SELECT CASE WHEN NEW.conversation_id IS NULL OR NEW.author IS NULL OR NEW.presentation IS NULL
        OR NEW.author NOT IN ('user','main-agent','fake-work-agent','runtime')
        OR NEW.presentation NOT IN ('input','chat','dispatch','receipt','report')
        OR (NEW.presentation='input' AND (NEW.author<>'user' OR NEW.role<>'user'))
        THEN RAISE(ABORT,'Explicit scoped message provenance required') END;
    END;
    CREATE TRIGGER coordination_inbox_guard BEFORE INSERT ON inbox_events BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM coordination_conversations WHERE id=NEW.conversation_id)
        OR (NEW.type='user-message' AND NOT EXISTS(SELECT 1 FROM main_conversation_messages
          WHERE id=NEW.user_message_id AND conversation_id=NEW.conversation_id AND author='user' AND presentation='input'))
        THEN RAISE(ABORT,'Admitted input required') END;
    END;
    CREATE UNIQUE INDEX coordination_input_once ON inbox_events(user_message_id) WHERE user_message_id IS NOT NULL;
    PRAGMA user_version=1;
  `)
  // Old binaries lack this connection-local capability and cannot mutate an
  // upgraded database, including claims/recovery that do not insert messages.
  for (const table of ['main_conversation_messages', 'inbox_events']) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER coordination_writer_${table}_${operation} BEFORE ${operation} ON ${table}
        BEGIN SELECT coordination_writer(); END;`)
    }
  }
}

function previewSchema(db: DatabaseSync, userVersion = 3): void {
  db.exec(`CREATE TABLE coordination_protocol (
    event_id TEXT PRIMARY KEY REFERENCES inbox_events(id), conversation_id TEXT NOT NULL REFERENCES coordination_conversations(id),
    state TEXT NOT NULL
  ) STRICT; PRAGMA user_version=${userVersion};`)
}

/** 仅供迁移测试构造 v2 夹具：与线上 v2 预览库同形（旧 executor CHECK + user_version=2）。 */
export function createV2PreviewSchemaForMigrationTest(db: DatabaseSync): void {
  legacySchema(db)
  upgrade(db, `CHECK(executor='FAKE')`)
  previewSchema(db, 2)
}

/** v2→v3：重建 coordination_runs 以放宽 executor CHECK（'FAKE' → 'FAKE'|'CLI'）。
 *  先用旧 DDL 指纹校验来路，VACUUM INTO 备份后再重建；调用方负责停写。 */
function migratePreviewV2toV3(db: DatabaseSync, backupPath: string): void {
  const expected = new DatabaseSync(':memory:')
  try {
    legacySchema(expected)
    upgrade(expected, `CHECK(executor='FAKE')`)
    previewSchema(expected, 2)
    if (schemaFingerprint(db) !== schemaFingerprint(expected)) throw new Error('Unknown or incomplete v2 preview schema')
  } finally { expected.close() }
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Preview integrity failure')
  db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;')
  db.prepare('VACUUM INTO ?').run(backupPath)
  chmodSync(backupPath, 0o600)
  // questions/receipts/outbox 引用 runs：node:sqlite 默认开启外键，重建父表期间
  // 必须临时关闭（PRAGMA 在事务内无效，须在 BEGIN 前设置），提交后恢复并复核引用。
  db.exec('PRAGMA foreign_keys=OFF')
  try {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE coordination_runs_v3 (
          seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, assignment_id TEXT NOT NULL REFERENCES coordination_assignments(id),
          conversation_id TEXT NOT NULL REFERENCES coordination_conversations(id), project_key TEXT NOT NULL,
          version INTEGER NOT NULL, input_version INTEGER NOT NULL, executor TEXT NOT NULL CHECK(executor IN ('FAKE','CLI')), context TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('starting','running','succeeded','failed','cancel_requested','cancelled','unknown')),
          started_at TEXT NOT NULL, ended_at TEXT, result TEXT
        ) STRICT;
        INSERT INTO coordination_runs_v3 SELECT * FROM coordination_runs;
        DROP TABLE coordination_runs;
        ALTER TABLE coordination_runs_v3 RENAME TO coordination_runs;
        CREATE UNIQUE INDEX coordination_one_active_project ON coordination_runs(project_key)
          WHERE status IN ('starting','running','cancel_requested');
        PRAGMA user_version=3;
      `)
    })
  } finally {
    db.exec('PRAGMA foreign_keys=ON')
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Preview migration broke foreign keys')
}

export function initializeMainSchema(db: DatabaseSync, options?: CoordinationSchemaOptions): boolean {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  if (options?.mode === 'preview-fresh') {
    if (version !== 0 || db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) throw new Error('Preview requires new empty database')
    transaction(db, () => { legacySchema(db); upgrade(db); previewSchema(db) })
    return true
  }
  if (options?.mode === 'preview-migrate') {
    if (version !== 2) throw new Error('Preview migration requires schema version 2')
    migratePreviewV2toV3(db, options.backupPath)
    validateKnownSchema(db, true, true)
    return true
  }
  if (version === 2 && options?.mode === 'preview-open') throw new Error('Preview v2 requires explicit migration (backup first)')
  if (version === 3 || options?.mode === 'preview-open') {
    if (version !== 3 || options?.mode !== 'preview-open') throw new Error('Explicit preview-open required for version 3')
    validateKnownSchema(db, true, true)
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Preview integrity failure')
    return true
  }
  if (version !== 0 && version !== 1) throw new Error('Unknown schema version')
  if (version === 1) {
    validateKnownSchema(db, true)
    // Reject partial upgrades instead of repairing them on ordinary startup.
    for (const table of ['coordination_conversations','coordination_assignments','coordination_runs','coordination_questions','coordination_receipts','coordination_outbox','coordination_front_locks','coordination_front_state']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('Incomplete coordination schema')
    }
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length
      || db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'coordination_%'").get()?.n !== 8
      || db.prepare('PRAGMA table_info(main_conversation_messages)').all().map(r => r.name).join(',') !== 'id,role,content,created_at,append_order,conversation_id,author,presentation,assignment_id,run_id') throw new Error('Incomplete coordination schema')
    if (options?.mode === 'fresh') throw new Error('Fresh requires empty database')
    return true
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  if (tables.some(r => String(r.name).startsWith('coordination_'))
      || db.prepare('PRAGMA table_info(main_conversation_messages)').all().some(r => r.name === 'conversation_id')) throw new Error('Unversioned partial upgrade')
  if (!options) { legacySchema(db); return false }
  if (options.mode === 'open') throw new Error('Coordination schema requires explicit creation or migration')
  if (options.mode === 'fresh') {
    if (tables.length) throw new Error('Fresh requires empty database')
    transaction(db, () => { legacySchema(db); upgrade(db) })
    return true
  }
  if (options.syntheticSingleMain !== true) throw new Error('Synthetic single-main assertion required')
  validateLegacy(db)
  db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;')
  // VACUUM INTO includes committed WAL frames. It refuses an existing nonempty
  // destination. Caller must stop all writers for this offline operation.
  db.prepare('VACUUM INTO ?').run(options.backupPath)
  chmodSync(options.backupPath, 0o600)
  transaction(db, () => { validateLegacy(db); upgrade(db); options.fault?.() })
  return true
}
