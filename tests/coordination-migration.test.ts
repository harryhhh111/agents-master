import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { createV2PreviewSchemaForMigrationTest } from '../src/main/schema.js'

let directory: string
let path: string
let backup: string
const at = '2026-10-16T01:00:00.000Z'
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'coordination-migration-')); path = join(directory, 'legacy.sqlite'); backup = join(directory, 'backup.sqlite') })
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function legacy(conversationId = 'main') {
  const store = new SQLiteMainInboxStore(path)
  store.appendMessage({ role: 'assistant', content: 'FAKE unlinked legacy message', createdAt: at })
  const input = store.receiveUserMessage({ conversationId, idempotencyKey: 'legacy-user', content: 'FAKE legacy user', receivedAt: at })
  store.claimNextPendingUserMessageEvent(at)
  store.enqueueEvent({ conversationId, idempotencyKey: 'timer', type: 'timer', payload: { fake: true }, createdAt: at })
  store.close()
  return input
}
function migrate(fault?: () => void, backupPath = backup) {
  return new SQLiteMainInboxStore(path, { coordination: { mode: 'migrate', syntheticSingleMain: true, backupPath, fault } })
}
function snapshot(file: string) {
  const db = new DatabaseSync(file)
  try { return {
    version: db.prepare('PRAGMA user_version').get()?.user_version,
    messages: db.prepare('SELECT id,role,content,created_at,append_order FROM main_conversation_messages ORDER BY append_order').all(),
    inbox: db.prepare('SELECT * FROM inbox_events ORDER BY append_order').all(),
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  } } finally { db.close() }
}

it('does not upgrade normal startup; explicit migration preserves IDs/content/order/links/state and consistent backup', () => {
  const input = legacy()
  const before = snapshot(path)
  const normal = new SQLiteMainInboxStore(path); normal.close()
  expect(snapshot(path)).toEqual(before)
  const migrated = migrate()
  expect(migrated.readRecentContext().map(m => m.id)).toEqual(before.messages.map(m => m.id))
  expect(migrated.coordination.history('main').find(m => m.id === input.message.id)?.presentation).toBe('input')
  migrated.close()
  const after = snapshot(path)
  expect(after.messages).toEqual(before.messages)
  expect(after.inbox).toEqual(before.inbox)
  expect(after.version).toBe(1)
  expect(snapshot(backup)).toEqual(before)
  expect(statSync(backup).mode & 0o777).toBe(0o600)
  const repeated = migrate(); repeated.close()
  expect(snapshot(path)).toEqual(after)
  expect(snapshot(backup)).toEqual(before)
})

it('backs up committed WAL frames, not just the main SQLite file', () => {
  legacy()
  // Abrupt exit intentionally leaves committed frames without checkpointing.
  // Only this fresh synthetic DB is passed to the child, with no network IO.
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    db.prepare("UPDATE main_conversation_messages SET content='FAKE committed WAL content' WHERE role='assistant'").run();
    process.exit(0);
  `, path], { timeout: 5000, encoding: 'utf8' })
  expect(writer.status).toBe(0)
  expect(existsSync(`${path}-wal`)).toBe(true)
  const migrated = migrate(); migrated.close()
  expect(snapshot(backup).messages[0].content).toBe('FAKE committed WAL content')
})

it('backup failure leaves legacy untouched; migration failure rolls back schema/data/version and keeps usable backup', () => {
  legacy(); const before = snapshot(path)
  expect(() => migrate(undefined, join(directory, 'missing', 'backup.sqlite'))).toThrow()
  expect(snapshot(path)).toEqual(before)
  expect(() => migrate(() => { throw new Error('Injected after schema upgrade') })).toThrow('Injected')
  expect(snapshot(path)).toEqual(before)
  expect(snapshot(backup)).toEqual(before)
  const migrated = migrate(undefined, join(directory, 'retry-backup.sqlite')); migrated.close()
  expect(snapshot(path).version).toBe(1)
})

it.each(['group', 'orphan', 'wrong-role', 'wrong-payload', 'duplicate-link', 'unknown-version', 'partial', 'unknown-table', 'unknown-trigger'])('refuses ambiguous/unknown legacy %s without producing a backup', bad => {
  const input = legacy(bad === 'group' ? 'other-group' : 'main')
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys=OFF') // construct intentionally damaged synthetic legacy fixture
    if (bad === 'orphan') db.prepare("UPDATE inbox_events SET user_message_id='absent' WHERE type='user-message'").run()
    if (bad === 'wrong-role') db.prepare("UPDATE main_conversation_messages SET role='assistant' WHERE id=?").run(input.message.id)
    if (bad === 'wrong-payload') db.prepare("UPDATE inbox_events SET payload='{}' WHERE type='user-message'").run()
    if (bad === 'duplicate-link') db.prepare("UPDATE inbox_events SET type='user-message',user_message_id=?,payload=? WHERE type='timer'").run(input.message.id, JSON.stringify({ messageId: input.message.id, text: input.message.content }))
    if (bad === 'unknown-version') db.exec('PRAGMA user_version=99')
    if (bad === 'partial') db.exec('ALTER TABLE main_conversation_messages ADD COLUMN conversation_id TEXT')
    if (bad === 'unknown-table') db.exec('CREATE TABLE unknown (id TEXT)')
    if (bad === 'unknown-trigger') db.exec('CREATE TRIGGER unknown AFTER UPDATE ON inbox_events BEGIN SELECT 1; END')
  } finally { db.close() }
  const before = snapshot(path)
  expect(() => migrate()).toThrow()
  expect(snapshot(path)).toEqual(before)
  expect(existsSync(backup)).toBe(false)
})

it('prevents old connection writes, including inbox claims, while current main-only APIs remain usable', () => {
  legacy(); const migrated = migrate(); migrated.close()
  const old = new DatabaseSync(path)
  try {
    expect(() => old.prepare("INSERT INTO main_conversation_messages (id,role,content,created_at,append_order) VALUES ('old','assistant','old',?,99)").run(at)).toThrow()
    expect(() => old.exec("UPDATE inbox_events SET status='pending'")).toThrow('coordination_writer')
  } finally { old.close() }
  const current = new SQLiteMainInboxStore(path)
  expect(current.recoverClaimedUserMessageEvents()).toBe(1)
  const event = current.claimNextPendingUserMessageEvent()!
  current.recordProcessedUserMessageEvent({ eventId: event.id, content: 'FAKE new main reply' })
  current.close()
})

it('rejects damaged version-one schema rather than silently repairing on startup', () => {
  const fresh = new SQLiteMainInboxStore(path, { coordination: { mode: 'fresh' } }); fresh.close()
  const broken = new DatabaseSync(path)
  broken.exec('DROP TABLE coordination_questions'); broken.close()
  expect(() => new SQLiteMainInboxStore(path)).toThrow(/incomplete/i)
})

it('preview v2→v3：备份 0600、数据保留、executor CHECK 放宽、旧库拒绝直接打开', () => {
  const v2 = join(directory, 'preview-v2.sqlite')
  const v2Backup = join(directory, 'v3-backup.sqlite')
  const fixture = new DatabaseSync(v2)
  fixture.function('coordination_writer', () => 1)
  createV2PreviewSchemaForMigrationTest(fixture)
  fixture.prepare(`INSERT INTO main_conversation_messages (id,role,content,created_at,append_order,conversation_id,author,presentation)
    VALUES ('m1','user','v2 遗留消息','2026-10-20T00:00:00.000Z',1,'main','user','input')`).run()
  fixture.close()
  expect(Number(new DatabaseSync(v2).prepare('PRAGMA user_version').get()?.user_version)).toBe(2)

  // 旧版本库拒绝直接 preview-open
  expect(() => new SQLiteMainInboxStore(v2, { coordination: { mode: 'preview-open' } })).toThrow(/migration/i)

  const migrated = new SQLiteMainInboxStore(v2, { coordination: { mode: 'preview-migrate', backupPath: v2Backup } })
  expect(migrated.coordination.history('main').some(m => m.content === 'v2 遗留消息')).toBe(true)
  migrated.close()
  expect(statSync(v2Backup).mode & 0o777).toBe(0o600)
  const backupDb = new DatabaseSync(v2Backup)
  expect(Number(backupDb.prepare('PRAGMA user_version').get()?.user_version)).toBe(2)
  backupDb.close()

  // 迁移后可正常打开，且 executor CHECK 放宽到 CLI、仍然拒绝未知值
  const opened = new SQLiteMainInboxStore(v2, { coordination: { mode: 'preview-open' } })
  opened.close()
  const check = new DatabaseSync(v2)
  check.exec('PRAGMA foreign_keys=OFF')
  check.prepare(`INSERT INTO coordination_runs (id,assignment_id,conversation_id,project_key,version,input_version,executor,context,status,started_at)
    VALUES ('r-cli','a-x','fake-work','sandbox',1,1,'CLI','{}','starting','2026-10-20T00:00:00.000Z')`).run()
  expect(() => check.prepare(`INSERT INTO coordination_runs (id,assignment_id,conversation_id,project_key,version,input_version,executor,context,status,started_at)
    VALUES ('r-bad','a-x','fake-work','sandbox',1,1,'BOGUS','{}','starting','2026-10-20T00:00:00.000Z')`).run()).toThrow()
  check.close()
})

it('preview v2→v3：含 run/question/receipt/outbox 引用链的任务历史可迁移，数据与外键完整', () => {
  const v2 = join(directory, 'preview-v2-full.sqlite')
  const v2Backup = join(directory, 'v3-full-backup.sqlite')
  const fixture = new DatabaseSync(v2)
  fixture.function('coordination_writer', () => 1)
  createV2PreviewSchemaForMigrationTest(fixture)
  fixture.exec(`
    INSERT INTO main_conversation_messages (id,role,content,created_at,append_order,conversation_id,author,presentation)
      VALUES ('mu1','user','请检查','2026-10-20T00:00:00.000Z',1,'main','user','input');
    INSERT INTO inbox_events (id,conversation_id,idempotency_key,type,priority,payload,status,created_at,updated_at,user_message_id,append_order)
      VALUES ('e1','main','k1','user-message','normal','{}','processed','2026-10-20T00:00:00.000Z','2026-10-20T00:00:01.000Z','mu1',1);
    INSERT INTO coordination_assignments (id,source_event,conversation_id,return_conversation,project_key,agent_id,decision,accepted,status,version,input_version,context,created_at)
      VALUES ('a1','e1','fake-work','main','FAKE-project','fake-work-agent','{}','{}','waiting_input',1,1,'{}','2026-10-20T00:00:02.000Z');
    INSERT INTO coordination_runs (id,assignment_id,conversation_id,project_key,version,input_version,executor,context,status,started_at,ended_at,result)
      VALUES ('r1','a1','fake-work','FAKE-project',1,1,'FAKE','{}','succeeded','2026-10-20T00:00:03.000Z','2026-10-20T00:00:04.000Z','{"kind":"waiting_input","body":"继续吗？"}');
    INSERT INTO coordination_questions (id,assignment_id,run_id,version,body,status)
      VALUES ('q1','a1','r1',1,'继续吗？','pending');
    INSERT INTO coordination_receipts (run_id,payload,accepted,created_at)
      VALUES ('r1','{"kind":"waiting_input","body":"继续吗？"}',1,'2026-10-20T00:00:04.000Z');
    INSERT INTO coordination_outbox (id,assignment_id,run_id,version,conversation_id,kind,body,status,created_at)
      VALUES ('o1','a1','r1',1,'main','waiting_input','继续吗？','pending','2026-10-20T00:00:04.000Z');
  `)
  fixture.close()

  const migrated = new SQLiteMainInboxStore(v2, { coordination: { mode: 'preview-migrate', backupPath: v2Backup } })
  const q = migrated.coordination.questions('fake-work')
  expect(q).toHaveLength(1)
  expect(q[0]!.run_id).toBe('r1')
  expect(q[0]!.status).toBe('pending')
  migrated.close()

  const check = new DatabaseSync(v2)
  expect(Number(check.prepare('PRAGMA user_version').get()?.user_version)).toBe(3)
  expect(check.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
  expect(check.prepare('SELECT * FROM coordination_receipts WHERE run_id=?').all('r1')).toHaveLength(1)
  expect(check.prepare('SELECT * FROM coordination_outbox WHERE run_id=?').all('r1')).toHaveLength(1)
  check.close()

  const backupDb = new DatabaseSync(v2Backup)
  expect(Number(backupDb.prepare('PRAGMA user_version').get()?.user_version)).toBe(2)
  expect(backupDb.prepare('SELECT * FROM coordination_questions').all()).toHaveLength(1)
  backupDb.close()
  expect(statSync(v2Backup).mode & 0o777).toBe(0o600)
})
