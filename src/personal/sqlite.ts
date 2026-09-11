import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AccessBoundary,
  Claim,
  ClaimEpistemicState,
  ClaimCorrection,
  ClaimId,
  CorrectClaimInput,
  CreateClaimInput,
  CreatePolicyInput,
  CreateSourceInput,
  CreateTaskInput,
  DeleteSourceConfirmation,
  EntityReference,
  ForgetClaimResult,
  InternalReadContext,
  PersonalStore,
  Policy,
  PolicyId,
  PolicyStatus,
  Source,
  SourceId,
  SourceOrigin,
  SourceDeletionPreview,
  SourceDeletionResult,
  SourceSummaryView,
  SourceView,
  Task,
  TaskId,
} from './types.js'

type SourceRow = {
  id: string
  raw_content: string
  summary: string | null
  occurred_at: string
  recorded_at: string
  origin_json: string
  access_boundary_json: string
}

type SourceSummaryRow = Omit<SourceRow, 'raw_content'>

type ClaimRow = {
  id: string
  statement: string
  epistemic_state: ClaimEpistemicState
  scope: Claim['scope']
  status: Claim['status']
  valid_from: string
  valid_until: string | null
  evidence_ids_json: string
  supersedes_claim_id: string | null
  superseded_by_claim_id: string | null
  access_boundary_json: string
}

type PolicyRow = {
  id: string
  condition: string
  action: string
  depends_on_claim_ids_json: string
  scope: Policy['scope']
  status: PolicyStatus
  valid_from: string
  valid_until: string | null
  access_boundary_json: string
}

type TaskRow = {
  id: string
  title: string
  status: Task['status']
  created_at: string
  updated_at: string
  entity_references_json: string
  access_boundary_json: string
}

const now = (): string => new Date().toISOString()
const legacyDenyBoundary: AccessBoundary = {
  mainAgent: 'none',
  domainAgents: [],
  allowInTaskContext: false,
  allowExternalDisclosure: false,
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
}

function requireEvidence(ids: readonly string[], field: string): void {
  if (ids.length === 0) throw new Error(`${field} must contain at least one id`)
  if (ids.some(id => !id.trim())) throw new Error(`${field} must not contain empty ids`)
}

function requireIsoTime(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`)
  }
}

function requireValidWindow(validFrom: string, validUntil: string | undefined): void {
  requireIsoTime(validFrom, 'validFrom')
  if (validUntil !== undefined) {
    requireIsoTime(validUntil, 'validUntil')
    if (validUntil <= validFrom) throw new Error('validUntil must be after validFrom')
  }
}

function isAllowed(boundary: AccessBoundary, context: InternalReadContext): boolean {
  if (!context || typeof context !== 'object' || !context.requester || typeof context.requester !== 'object') {
    return false
  }
  if (context.use !== 'general' && context.use !== 'task') return false
  if (context.use === 'task' && !boundary.allowInTaskContext) return false

  const requester = context.requester
  if (requester.kind === 'main') {
    return requester.access === 'full'
      ? boundary.mainAgent === 'full'
      : requester.access === 'summary' && (boundary.mainAgent === 'summary' || boundary.mainAgent === 'full')
  }
  return requester.kind === 'domain-agent'
    && typeof requester.id === 'string'
    && boundary.domainAgents.includes(requester.id)
}

/**
 * SQLite implementation of the personal-agent cognitive data store.
 * It intentionally supplies no mutation APIs beyond creation in this slice.
 */
export class SQLitePersonalStore implements PersonalStore {
  readonly #db: DatabaseSync

  constructor(databasePath: string) {
    this.#db = new DatabaseSync(databasePath)
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        raw_content TEXT NOT NULL,
        summary TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        origin_json TEXT NOT NULL,
        access_boundary_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        statement TEXT NOT NULL,
        epistemic_state TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        evidence_ids_json TEXT NOT NULL,
        supersedes_claim_id TEXT,
        superseded_by_claim_id TEXT,
        access_boundary_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS claims_by_status ON claims(status);
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        condition TEXT NOT NULL,
        action TEXT NOT NULL,
        depends_on_claim_ids_json TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        access_boundary_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        entity_references_json TEXT NOT NULL,
        access_boundary_json TEXT NOT NULL
      ) STRICT;
    `)
    this.#migrateSchema()
  }

  createSource(input: CreateSourceInput): Source {
    requireText(input.rawContent, 'rawContent')
    if (input.summary !== undefined) requireText(input.summary, 'summary')
    requireIsoTime(input.occurredAt, 'occurredAt')
    if (input.recordedAt !== undefined) requireIsoTime(input.recordedAt, 'recordedAt')
    const source: Source = {
      id: randomUUID(),
      rawContent: input.rawContent,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      occurredAt: input.occurredAt,
      recordedAt: input.recordedAt ?? now(),
      origin: input.origin,
      accessBoundary: input.accessBoundary,
    }
    this.#db.prepare(`INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      source.id,
      source.rawContent,
      source.summary ?? null,
      source.occurredAt,
      source.recordedAt,
      JSON.stringify(source.origin),
      JSON.stringify(source.accessBoundary),
    )
    return source
  }

  getSource(id: SourceId, context: InternalReadContext): SourceView | undefined {
    const source = this.#findSourceSummary(id)
    if (!source || !isAllowed(source.accessBoundary, context)) return undefined
    if (context.requester.kind === 'main' && context.requester.access === 'summary') return source

    // This query is deliberately reached only after an internal boundary
    // decision grants full visibility; the raw lookup below is otherwise
    // reserved for write-time reference validation.
    const row = this.#db.prepare('SELECT raw_content FROM sources WHERE id = ?').get(id) as { raw_content: string } | undefined
    return row && { ...source, rawContent: row.raw_content }
  }

  createClaim(input: CreateClaimInput): Claim {
    requireText(input.statement, 'statement')
    if (input.epistemicState !== 'user-fact' && input.epistemicState !== 'model-inference') {
      throw new Error('epistemicState must be user-fact or model-inference; unknown is not a Claim')
    }
    requireEvidence(input.evidenceIds, 'evidenceIds')
    requireValidWindow(input.validFrom, input.validUntil)
    for (const sourceId of input.evidenceIds) {
      if (!this.#findSourceForValidation(sourceId)) throw new Error(`Source does not exist: ${sourceId}`)
    }
    const claim: Claim = { id: randomUUID(), ...input }
    this.#db.prepare(`
      INSERT INTO claims (
        id, statement, epistemic_state, scope, status, valid_from, valid_until,
        evidence_ids_json, supersedes_claim_id, superseded_by_claim_id, access_boundary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claim.id,
      claim.statement,
      claim.epistemicState,
      claim.scope,
      claim.status,
      claim.validFrom,
      claim.validUntil ?? null,
      JSON.stringify(claim.evidenceIds),
      null,
      null,
      JSON.stringify(claim.accessBoundary),
    )
    return claim
  }

  getClaim(id: ClaimId, context: InternalReadContext): Claim | undefined {
    const claim = this.#findClaim(id)
    return claim && isAllowed(claim.accessBoundary, context) ? claim : undefined
  }

  listActiveClaims(context: InternalReadContext, asOf = now()): Claim[] {
    requireIsoTime(asOf, 'asOf')
    const rows = this.#db.prepare(
      "SELECT * FROM claims WHERE status IN ('active', 'superseded') AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY valid_from, id",
    ).all(asOf, asOf) as ClaimRow[]
    return rows.map(row => this.#claimFromRow(row)).filter(claim => isAllowed(claim.accessBoundary, context))
  }

  correctClaim(id: ClaimId, input: CorrectClaimInput): ClaimCorrection {
    requireText(input.statement, 'statement')
    if (input.epistemicState !== 'user-fact' && input.epistemicState !== 'model-inference') {
      throw new Error('epistemicState must be user-fact or model-inference; unknown is not a Claim')
    }
    requireEvidence(input.evidenceIds, 'evidenceIds')
    requireIsoTime(input.effectiveAt, 'effectiveAt')
    requireValidWindow(input.effectiveAt, input.validUntil)
    if (input.effectiveAt > now()) {
      throw new Error('future effectiveAt is not supported')
    }

    const previous = this.#findClaim(id)
    if (!previous) throw new Error(`Claim does not exist: ${id}`)
    if (previous.status !== 'active') throw new Error(`Only an active Claim can be corrected: ${id}`)
    if (input.effectiveAt <= previous.validFrom) {
      throw new Error('effectiveAt must be after the existing Claim validFrom')
    }
    if (previous.validUntil !== undefined && input.effectiveAt >= previous.validUntil) {
      throw new Error('effectiveAt must be before the existing Claim validUntil')
    }
    for (const sourceId of input.evidenceIds) {
      if (!this.#findSourceForValidation(sourceId)) throw new Error(`Source does not exist: ${sourceId}`)
    }

    return this.#transaction(() => {
      const replacement: Claim = {
        id: randomUUID(),
        statement: input.statement,
        epistemicState: input.epistemicState,
        scope: input.scope,
        status: 'active',
        validFrom: input.effectiveAt,
        ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
        evidenceIds: input.evidenceIds,
        supersedesClaimId: previous.id,
        accessBoundary: input.accessBoundary,
      }
      const supersededClaim: Claim = {
        ...previous,
        status: 'superseded',
        validUntil: input.effectiveAt,
        supersededByClaimId: replacement.id,
      }
      this.#db.prepare(`
        UPDATE claims
        SET status = 'superseded', valid_until = ?, superseded_by_claim_id = ?
        WHERE id = ?
      `).run(input.effectiveAt, replacement.id, previous.id)
      this.#insertClaim(replacement)
      const retractedPolicies = this.#activePoliciesDependingOn(new Set([previous.id])).map(policy => {
        const retracted: Policy = { ...policy, status: 'retracted' }
        this.#db.prepare("UPDATE policies SET status = 'retracted' WHERE id = ?").run(policy.id)
        return retracted
      })
      return { supersededClaim, replacementClaim: replacement, retractedPolicies }
    })
  }

  forgetClaim(id: ClaimId): ForgetClaimResult {
    const claim = this.#findClaim(id)
    if (!claim) throw new Error(`Claim does not exist: ${id}`)
    if (claim.status !== 'active') throw new Error(`Only an active Claim can be forgotten: ${id}`)

    return this.#transaction(() => {
      const forgottenClaim: Claim = { ...claim, status: 'forgotten' }
      this.#db.prepare("UPDATE claims SET status = 'forgotten' WHERE id = ?").run(id)
      const invalidatedPolicies = this.#activePoliciesDependingOn(new Set([id])).map(policy => {
        const invalidated: Policy = { ...policy, status: 'forgotten' }
        this.#db.prepare("UPDATE policies SET status = 'forgotten' WHERE id = ?").run(policy.id)
        return invalidated
      })
      return { forgottenClaim, invalidatedPolicies }
    })
  }

  createPolicy(input: CreatePolicyInput): Policy {
    requireText(input.condition, 'condition')
    requireText(input.action, 'action')
    requireEvidence(input.dependsOnClaimIds, 'dependsOnClaimIds')
    requireValidWindow(input.validFrom, input.validUntil)
    for (const claimId of input.dependsOnClaimIds) {
      const claim = this.#findClaim(claimId)
      if (!claim) throw new Error(`Claim does not exist: ${claimId}`)
      if (claim.status !== 'active') throw new Error(`Policy dependencies must be active Claims: ${claimId}`)
    }
    const policy: Policy = { id: randomUUID(), ...input, status: input.status ?? 'active' }
    this.#db.prepare(`
      INSERT INTO policies (
        id, condition, action, depends_on_claim_ids_json, scope, status, valid_from,
        valid_until, access_boundary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      policy.id,
      policy.condition,
      policy.action,
      JSON.stringify(policy.dependsOnClaimIds),
      policy.scope,
      policy.status,
      policy.validFrom,
      policy.validUntil ?? null,
      JSON.stringify(policy.accessBoundary),
    )
    return policy
  }

  getPolicy(id: PolicyId, context: InternalReadContext): Policy | undefined {
    const policy = this.#findPolicy(id)
    return policy && isAllowed(policy.accessBoundary, context) ? policy : undefined
  }

  listActivePolicies(context: InternalReadContext, asOf = now()): Policy[] {
    requireIsoTime(asOf, 'asOf')
    const rows = this.#db.prepare(
      "SELECT * FROM policies WHERE status = 'active' AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY valid_from, id",
    ).all(asOf, asOf) as PolicyRow[]
    return rows
      .map(row => this.#policyFromRow(row))
      .filter(policy => this.#policyHasActiveDependencies(policy, asOf))
      .filter(policy => isAllowed(policy.accessBoundary, context))
  }

  forgetPolicy(id: PolicyId): Policy {
    const policy = this.#findPolicy(id)
    if (!policy) throw new Error(`Policy does not exist: ${id}`)
    if (policy.status !== 'active') throw new Error(`Only an active Policy can be forgotten: ${id}`)
    const forgotten: Policy = { ...policy, status: 'forgotten' }
    this.#db.prepare("UPDATE policies SET status = 'forgotten' WHERE id = ?").run(id)
    return forgotten
  }

  createTask(input: CreateTaskInput): Task {
    requireText(input.title, 'title')
    for (const reference of input.entityReferences) this.#validateEntityReference(reference)
    const createdAt = input.createdAt ?? now()
    requireIsoTime(createdAt, 'createdAt')
    if (input.updatedAt !== undefined) requireIsoTime(input.updatedAt, 'updatedAt')
    const updatedAt = input.updatedAt ?? createdAt
    if (updatedAt < createdAt) throw new Error('updatedAt must not be earlier than createdAt')
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      status: input.status,
      createdAt,
      updatedAt,
      entityReferences: input.entityReferences,
      accessBoundary: input.accessBoundary,
    }
    this.#db.prepare(`INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      task.id,
      task.title,
      task.status,
      task.createdAt,
      task.updatedAt,
      JSON.stringify(task.entityReferences),
      JSON.stringify(task.accessBoundary),
    )
    return task
  }

  getTask(id: TaskId, context: InternalReadContext): Task | undefined {
    const task = this.#findTask(id)
    return task && isAllowed(task.accessBoundary, context) ? task : undefined
  }

  previewSourceDeletion(id: SourceId, context: InternalReadContext): SourceDeletionPreview | undefined {
    return this.#sourceDeletionPreviewForContext(id, context)
  }

  deleteSource(id: SourceId, context: InternalReadContext, confirmation: DeleteSourceConfirmation): SourceDeletionResult {
    if (!confirmation || confirmation.confirm !== true) {
      throw new Error('Source deletion requires { confirm: true }')
    }

    return this.#transaction(() => {
      const preview = this.#sourceDeletionPreviewForContext(id, context)
      if (!preview) throw new Error('Source deletion is not authorized for this context')
      const retractedClaims = preview.solelySupportedClaims.map(claim => {
        const retracted: Claim = { ...claim, status: 'retracted' }
        this.#db.prepare("UPDATE claims SET status = 'retracted' WHERE id = ?").run(claim.id)
        return retracted
      })
      const survivingClaims = preview.claimsWithIndependentEvidence.map(claim => {
        const evidenceIds = claim.evidenceIds.filter(evidenceId => evidenceId !== id)
        const surviving: Claim = { ...claim, evidenceIds }
        this.#db.prepare('UPDATE claims SET evidence_ids_json = ? WHERE id = ?').run(
          JSON.stringify(evidenceIds),
          claim.id,
        )
        return surviving
      })
      const retractedPolicies = preview.policiesToRetract.map(policy => {
        const retracted: Policy = { ...policy, status: 'retracted' }
        this.#db.prepare("UPDATE policies SET status = 'retracted' WHERE id = ?").run(policy.id)
        return retracted
      })
      this.#db.prepare('DELETE FROM sources WHERE id = ?').run(id)
      return {
        deletedSource: preview.source,
        retractedClaims,
        survivingClaims,
        retractedPolicies,
        affectedActiveTaskIds: preview.affectedActiveTaskIds,
      }
    })
  }

  close(): void {
    this.#db.close()
  }

  #insertClaim(claim: Claim): void {
    this.#db.prepare(`
      INSERT INTO claims (
        id, statement, epistemic_state, scope, status, valid_from, valid_until,
        evidence_ids_json, supersedes_claim_id, superseded_by_claim_id, access_boundary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claim.id,
      claim.statement,
      claim.epistemicState,
      claim.scope,
      claim.status,
      claim.validFrom,
      claim.validUntil ?? null,
      JSON.stringify(claim.evidenceIds),
      claim.supersedesClaimId ?? null,
      claim.supersededByClaimId ?? null,
      JSON.stringify(claim.accessBoundary),
    )
  }

  /** Raw records are intentionally available only to write-time validation. */
  #findSourceForValidation(id: SourceId): Source | undefined {
    const row = this.#db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined
    return row && this.#sourceFromRow(row)
  }

  #findSourceSummary(id: SourceId): SourceSummaryView | undefined {
    const row = this.#db.prepare(
      'SELECT id, summary, occurred_at, recorded_at, origin_json, access_boundary_json FROM sources WHERE id = ?',
    ).get(id) as SourceSummaryRow | undefined
    return row && this.#sourceSummaryFromRow(row)
  }

  #findClaim(id: ClaimId): Claim | undefined {
    const row = this.#db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as ClaimRow | undefined
    return row && this.#claimFromRow(row)
  }

  #findPolicy(id: PolicyId): Policy | undefined {
    const row = this.#db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as PolicyRow | undefined
    return row && this.#policyFromRow(row)
  }

  #findTask(id: TaskId): Task | undefined {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row && this.#taskFromRow(row)
  }

  #activePoliciesDependingOn(claimIds: ReadonlySet<ClaimId>): Policy[] {
    const rows = this.#db.prepare("SELECT * FROM policies WHERE status = 'active' ORDER BY valid_from, id").all() as PolicyRow[]
    return rows
      .map(row => this.#policyFromRow(row))
      .filter(policy => policy.dependsOnClaimIds.some(claimId => claimIds.has(claimId)))
  }

  #policyHasActiveDependencies(policy: Policy, asOf: string): boolean {
    return policy.dependsOnClaimIds.every(claimId => {
      const claim = this.#findClaim(claimId)
      return claim?.status === 'active'
        && claim.validFrom <= asOf
        && (claim.validUntil === undefined || claim.validUntil > asOf)
    })
  }

  /**
   * A deletion may change every listed Claim and Policy, so it is all-or-nothing
   * with respect to their read boundaries. Returning a partial preview would
   * both conceal a mutation and let the subsequent deletion bypass that boundary.
   */
  #sourceDeletionPreviewForContext(id: SourceId, context: InternalReadContext): SourceDeletionPreview | undefined {
    const source = this.#findSourceSummary(id)
    if (!source) throw new Error(`Source does not exist: ${id}`)
    if (!isAllowed(source.accessBoundary, context)) return undefined

    const claims = (this.#db.prepare('SELECT * FROM claims ORDER BY valid_from, id').all() as ClaimRow[])
      .map(row => this.#claimFromRow(row))
      .filter(claim => claim.evidenceIds.includes(id))
    const solelySupportedClaims = claims.filter(claim => claim.evidenceIds.every(evidenceId => evidenceId === id))
    const claimsWithIndependentEvidence = claims.filter(claim => claim.evidenceIds.some(evidenceId => evidenceId !== id))
    const retractedClaimIds = new Set(solelySupportedClaims.map(claim => claim.id))
    const policiesToRetract = (this.#db.prepare("SELECT * FROM policies WHERE status = 'active' ORDER BY valid_from, id").all() as PolicyRow[])
      .map(row => this.#policyFromRow(row))
      .filter(policy => policy.dependsOnClaimIds.some(claimId => retractedClaimIds.has(claimId)))
    if (!claims.every(claim => isAllowed(claim.accessBoundary, context))
      || !policiesToRetract.every(policy => isAllowed(policy.accessBoundary, context))) {
      return undefined
    }
    const affectedIds = new Set<string>([
      id,
      ...claims.map(claim => claim.id),
      ...policiesToRetract.map(policy => policy.id),
    ])
    const affectedActiveTasks = (this.#db.prepare("SELECT * FROM tasks WHERE status = 'active' ORDER BY id").all() as TaskRow[])
      .map(row => this.#taskFromRow(row))
      .filter(task => task.entityReferences.some(reference => affectedIds.has(reference.id)))
    if (!affectedActiveTasks.every(task => isAllowed(task.accessBoundary, context))) return undefined

    return {
      source: this.#sourceViewForContext(source, context),
      solelySupportedClaims,
      claimsWithIndependentEvidence,
      policiesToRetract,
      affectedActiveTaskIds: affectedActiveTasks.map(task => task.id),
    }
  }

  #sourceViewForContext(source: SourceSummaryView, context: InternalReadContext): SourceView {
    if (context.requester.kind === 'main' && context.requester.access === 'summary') return source
    const row = this.#db.prepare('SELECT raw_content FROM sources WHERE id = ?').get(source.id) as { raw_content: string } | undefined
    if (!row) throw new Error(`Source does not exist: ${source.id}`)
    return { ...source, rawContent: row.raw_content }
  }

  #transaction<Result>(operation: () => Result): Result {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #validateEntityReference(reference: EntityReference): void {
    if (!reference || !reference.id?.trim()) throw new Error('Task entity reference must contain an id')
    const exists = reference.kind === 'source'
      ? this.#findSourceForValidation(reference.id)
      : reference.kind === 'claim'
        ? this.#findClaim(reference.id)
        : reference.kind === 'policy'
          ? this.#findPolicy(reference.id)
          : reference.kind === 'task'
            ? this.#findTask(reference.id)
            : undefined
    if (!exists) throw new Error(`Referenced ${reference.kind} does not exist: ${reference.id}`)
  }

  #migrateSchema(): void {
    if (!this.#hasColumn('sources', 'summary')) {
      this.#db.exec('ALTER TABLE sources ADD COLUMN summary TEXT')
    }
    if (!this.#hasColumn('claims', 'epistemic_state')) {
      // A legacy Claim had no explicit provenance. Treating it as inference is
      // conservative and avoids silently promoting it to a user fact.
      this.#db.exec("ALTER TABLE claims ADD COLUMN epistemic_state TEXT NOT NULL DEFAULT 'model-inference'")
    }
    if (!this.#hasColumn('claims', 'supersedes_claim_id')) {
      this.#db.exec('ALTER TABLE claims ADD COLUMN supersedes_claim_id TEXT')
    }
    if (!this.#hasColumn('claims', 'superseded_by_claim_id')) {
      this.#db.exec('ALTER TABLE claims ADD COLUMN superseded_by_claim_id TEXT')
    }
    if (!this.#hasColumn('policies', 'status')) {
      this.#db.exec("ALTER TABLE policies ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    }
    if (!this.#hasColumn('policies', 'access_boundary_json')) {
      this.#db.exec('ALTER TABLE policies ADD COLUMN access_boundary_json TEXT')
      this.#db.prepare('UPDATE policies SET access_boundary_json = ? WHERE access_boundary_json IS NULL').run(
        JSON.stringify(legacyDenyBoundary),
      )
    }
    if (!this.#hasColumn('tasks', 'access_boundary_json')) {
      this.#db.exec('ALTER TABLE tasks ADD COLUMN access_boundary_json TEXT')
      this.#db.prepare('UPDATE tasks SET access_boundary_json = ? WHERE access_boundary_json IS NULL').run(
        JSON.stringify(legacyDenyBoundary),
      )
    }
  }

  #hasColumn(table: 'sources' | 'claims' | 'policies' | 'tasks', column: string): boolean {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return columns.some(entry => entry.name === column)
  }

  #sourceFromRow(row: SourceRow): Source {
    return {
      id: row.id,
      rawContent: row.raw_content,
      ...(row.summary === null ? {} : { summary: row.summary }),
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      origin: JSON.parse(row.origin_json) as SourceOrigin,
      accessBoundary: JSON.parse(row.access_boundary_json) as AccessBoundary,
    }
  }

  #sourceSummaryFromRow(row: SourceSummaryRow): SourceSummaryView {
    return {
      id: row.id,
      ...(row.summary === null ? {} : { summary: row.summary }),
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      origin: JSON.parse(row.origin_json) as SourceOrigin,
      accessBoundary: JSON.parse(row.access_boundary_json) as AccessBoundary,
    }
  }

  #claimFromRow(row: ClaimRow): Claim {
    return {
      id: row.id,
      statement: row.statement,
      epistemicState: row.epistemic_state,
      scope: row.scope,
      status: row.status,
      validFrom: row.valid_from,
      ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
      evidenceIds: JSON.parse(row.evidence_ids_json) as SourceId[],
      ...(row.supersedes_claim_id === null ? {} : { supersedesClaimId: row.supersedes_claim_id }),
      ...(row.superseded_by_claim_id === null ? {} : { supersededByClaimId: row.superseded_by_claim_id }),
      accessBoundary: JSON.parse(row.access_boundary_json) as AccessBoundary,
    }
  }

  #policyFromRow(row: PolicyRow): Policy {
    return {
      id: row.id,
      condition: row.condition,
      action: row.action,
      dependsOnClaimIds: JSON.parse(row.depends_on_claim_ids_json) as ClaimId[],
      scope: row.scope,
      status: row.status,
      validFrom: row.valid_from,
      ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
      accessBoundary: JSON.parse(row.access_boundary_json) as AccessBoundary,
    }
  }

  #taskFromRow(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      entityReferences: JSON.parse(row.entity_references_json) as EntityReference[],
      accessBoundary: JSON.parse(row.access_boundary_json) as AccessBoundary,
    }
  }
}
