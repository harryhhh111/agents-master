import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AccessBoundary,
  AppendableTaskEventType,
  AppendTaskEventInput,
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
  InternalContext,
  ListTasksInput,
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
  TaskDomain,
  TaskEvent,
  TaskEventActor,
  TaskEventSummaryView,
  TaskEventId,
  TaskEventType,
  TaskEventViewForContext,
  TaskId,
  TaskOwner,
  TaskStatus,
  UpdateTaskInput,
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
  objective: string | null
  status: TaskStatus
  domain: TaskDomain | null
  owner: TaskOwner | null
  project_key: string | null
  visible_progress: string | null
  waiting_for_user: string | null
  candidate_result: string | null
  created_at: string
  updated_at: string
  entity_references_json: string
  access_boundary_json: string
}

type TaskEventRow = {
  id: string
  task_id: string
  source_id: string | null
  type: TaskEventType
  content: string
  actor: TaskEventActor
  occurred_at: string
  recorded_at: string
  append_order: number
}

type TaskEventSummaryRow = Omit<TaskEventRow, 'content'>

type RecordedTaskEventInput = Omit<AppendTaskEventInput, 'type'> & {
  type: TaskEventType
}

const now = (): string => new Date().toISOString()
const legacyDenyBoundary: AccessBoundary = {
  mainAgent: 'none',
  domainAgents: [],
  allowInTaskContext: false,
  allowExternalDisclosure: false,
}

const taskStatuses: readonly TaskStatus[] = ['active', 'paused', 'completed', 'cancelled']
const taskDomains: readonly TaskDomain[] = ['relationship', 'work-project', 'goal', 'legacy']
const taskOwners: readonly TaskOwner[] = ['main-agent', 'work-project-agent']
const taskEventTypes: readonly TaskEventType[] = ['note', 'progress', 'waiting-for-user', 'candidate-result', 'status-change']
const appendableTaskEventTypes: readonly AppendableTaskEventType[] = ['note', 'progress', 'waiting-for-user', 'candidate-result']

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

function requireOptionalText(value: string | undefined, field: string): void {
  if (value !== undefined) requireText(value, field)
}

function requireTaskStatus(status: TaskStatus): void {
  if (!taskStatuses.includes(status)) throw new Error(`Unsupported Task status: ${status}`)
}

function requireTaskDomain(domain: TaskDomain): void {
  if (!taskDomains.includes(domain)) throw new Error(`Unsupported Task domain: ${domain}`)
}

function requireTaskOwner(owner: TaskOwner): void {
  if (!taskOwners.includes(owner)) throw new Error(`Unsupported Task owner: ${owner}`)
}

function requireValidTaskAssignment(domain: TaskDomain, owner: TaskOwner): void {
  requireTaskDomain(domain)
  requireTaskOwner(owner)
  if ((domain === 'legacy' || domain === 'relationship' || domain === 'goal') && owner !== 'main-agent') {
    throw new Error(`Task domain ${domain} must be owned by main-agent`)
  }
}

function requireTaskEventType(type: TaskEventType): void {
  if (!taskEventTypes.includes(type)) throw new Error(`Unsupported Task event type: ${type}`)
}

function requireAppendableTaskEventType(type: AppendableTaskEventType): void {
  if (!appendableTaskEventTypes.includes(type)) {
    throw new Error('status-change events may only be created by updateTask')
  }
}

/**
 * Owners remain fixed product roles. Events record the actual authorized
 * requester, so any domain already permitted by a Task boundary can append
 * truthfully without impersonating an owner.
 */
function taskEventActorForContext(context: InternalContext): TaskEventActor {
  if (context.requester.kind === 'main') return 'main-agent'
  // Preserve the established work-project identity; other authorized domains
  // use an explicit requester encoding rather than pretending to be an owner.
  if (context.requester.id === 'work-project-agent') return 'work-project-agent'
  return `domain-agent:${context.requester.id}`
}

function isAllowed(boundary: AccessBoundary, context: InternalContext): boolean {
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

function requireAuthorized(record: { id: string; accessBoundary: AccessBoundary }, context: InternalContext, operation: string): void {
  if (!isAllowed(record.accessBoundary, context)) {
    throw new Error(`${operation} is not authorized for this context: ${record.id}`)
  }
}

/**
 * SQLite implementation of the personal-agent cognitive data store.
 * Lifecycle mutations (correction, forgetting, deletion) require an authorized
 * caller context; deletion is additionally gated by a two-step preview and confirm.
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
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        domain TEXT NOT NULL,
        owner TEXT NOT NULL,
        project_key TEXT,
        visible_progress TEXT,
        waiting_for_user TEXT,
        candidate_result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        entity_references_json TEXT NOT NULL,
        access_boundary_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_by_updated_at ON tasks(updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        source_id TEXT NOT NULL REFERENCES sources(id),
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        append_order INTEGER NOT NULL
      ) STRICT;
    `)
    this.#transaction(() => this.#migrateSchema())
    this.#db.exec(`
      DROP INDEX IF EXISTS task_events_by_task;
      CREATE INDEX task_events_by_task ON task_events(task_id, occurred_at, recorded_at, append_order);
      CREATE UNIQUE INDEX IF NOT EXISTS task_events_by_source ON task_events(source_id);
      CREATE UNIQUE INDEX IF NOT EXISTS task_events_by_task_append_order ON task_events(task_id, append_order);
    `)
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

  getSource(id: SourceId, context: InternalContext): SourceView | undefined {
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

  getClaim(id: ClaimId, context: InternalContext): Claim | undefined {
    const claim = this.#findClaim(id)
    return claim && isAllowed(claim.accessBoundary, context) ? claim : undefined
  }

  listActiveClaims(context: InternalContext, asOf = now()): Claim[] {
    requireIsoTime(asOf, 'asOf')
    const rows = this.#db.prepare(
      "SELECT * FROM claims WHERE status IN ('active', 'superseded') AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY valid_from, id",
    ).all(asOf, asOf) as ClaimRow[]
    return rows.map(row => this.#claimFromRow(row)).filter(claim => isAllowed(claim.accessBoundary, context))
  }

  correctClaim(id: ClaimId, input: CorrectClaimInput, context: InternalContext): ClaimCorrection {
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
    requireAuthorized(previous, context, 'Claim correction')
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
      const policiesToRetract = this.#activePoliciesDependingOn(new Set([previous.id]))
      for (const policy of policiesToRetract) requireAuthorized(policy, context, 'Claim correction')
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
      const retractedPolicies = policiesToRetract.map(policy => {
        const retracted: Policy = { ...policy, status: 'retracted' }
        this.#db.prepare("UPDATE policies SET status = 'retracted' WHERE id = ?").run(policy.id)
        return retracted
      })
      return { supersededClaim, replacementClaim: replacement, retractedPolicies }
    })
  }

  forgetClaim(id: ClaimId, context: InternalContext): ForgetClaimResult {
    const claim = this.#findClaim(id)
    if (!claim) throw new Error(`Claim does not exist: ${id}`)
    if (claim.status !== 'active') throw new Error(`Only an active Claim can be forgotten: ${id}`)
    requireAuthorized(claim, context, 'Claim forget')

    return this.#transaction(() => {
      const policiesToInvalidate = this.#activePoliciesDependingOn(new Set([id]))
      for (const policy of policiesToInvalidate) requireAuthorized(policy, context, 'Claim forget')
      const forgottenClaim: Claim = { ...claim, status: 'forgotten' }
      this.#db.prepare("UPDATE claims SET status = 'forgotten' WHERE id = ?").run(id)
      const invalidatedPolicies = policiesToInvalidate.map(policy => {
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

  getPolicy(id: PolicyId, context: InternalContext): Policy | undefined {
    const policy = this.#findPolicy(id)
    return policy && isAllowed(policy.accessBoundary, context) ? policy : undefined
  }

  listActivePolicies(context: InternalContext, asOf = now()): Policy[] {
    requireIsoTime(asOf, 'asOf')
    const rows = this.#db.prepare(
      "SELECT * FROM policies WHERE status = 'active' AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY valid_from, id",
    ).all(asOf, asOf) as PolicyRow[]
    return rows
      .map(row => this.#policyFromRow(row))
      .filter(policy => this.#policyHasActiveDependencies(policy, asOf))
      .filter(policy => isAllowed(policy.accessBoundary, context))
  }

  forgetPolicy(id: PolicyId, context: InternalContext): Policy {
    const policy = this.#findPolicy(id)
    if (!policy) throw new Error(`Policy does not exist: ${id}`)
    if (policy.status !== 'active') throw new Error(`Only an active Policy can be forgotten: ${id}`)
    requireAuthorized(policy, context, 'Policy forget')
    const forgotten: Policy = { ...policy, status: 'forgotten' }
    this.#db.prepare("UPDATE policies SET status = 'forgotten' WHERE id = ?").run(id)
    return forgotten
  }

  createTask(input: CreateTaskInput): Task {
    requireText(input.title, 'title')
    for (const reference of input.entityReferences) this.#validateEntityReference(reference)
    const objective = input.objective ?? input.title
    requireText(objective, 'objective')
    const domain = input.domain ?? 'legacy'
    const owner = input.owner ?? 'main-agent'
    requireTaskStatus(input.status)
    requireValidTaskAssignment(domain, owner)
    requireOptionalText(input.projectKey, 'projectKey')
    requireOptionalText(input.visibleProgress, 'visibleProgress')
    requireOptionalText(input.waitingForUser, 'waitingForUser')
    requireOptionalText(input.candidateResult, 'candidateResult')
    const createdAt = input.createdAt ?? now()
    requireIsoTime(createdAt, 'createdAt')
    if (input.updatedAt !== undefined) requireIsoTime(input.updatedAt, 'updatedAt')
    const updatedAt = input.updatedAt ?? createdAt
    if (updatedAt < createdAt) throw new Error('updatedAt must not be earlier than createdAt')
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      objective,
      status: input.status,
      domain,
      owner,
      ...(input.projectKey === undefined ? {} : { projectKey: input.projectKey }),
      ...(input.visibleProgress === undefined ? {} : { visibleProgress: input.visibleProgress }),
      ...(input.waitingForUser === undefined ? {} : { waitingForUser: input.waitingForUser }),
      ...(input.candidateResult === undefined ? {} : { candidateResult: input.candidateResult }),
      createdAt,
      updatedAt,
      entityReferences: input.entityReferences,
      accessBoundary: input.accessBoundary,
    }
    this.#db.prepare(`
      INSERT INTO tasks (
        id, title, objective, status, domain, owner, project_key, visible_progress,
        waiting_for_user, candidate_result, created_at, updated_at,
        entity_references_json, access_boundary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.title,
      task.objective,
      task.status,
      task.domain,
      task.owner,
      task.projectKey ?? null,
      task.visibleProgress ?? null,
      task.waitingForUser ?? null,
      task.candidateResult ?? null,
      task.createdAt,
      task.updatedAt,
      JSON.stringify(task.entityReferences),
      JSON.stringify(task.accessBoundary),
    )
    return task
  }

  getTask(id: TaskId, context: InternalContext): Task | undefined {
    const task = this.#findTask(id)
    return task && isAllowed(task.accessBoundary, context) ? task : undefined
  }

  listTasks(context: InternalContext, input: ListTasksInput = {}): Task[] {
    if (input.statuses !== undefined) input.statuses.forEach(requireTaskStatus)
    if (input.domain !== undefined) requireTaskDomain(input.domain)
    if (input.owner !== undefined) requireTaskOwner(input.owner)
    if (input.projectKey !== undefined) requireText(input.projectKey, 'projectKey')
    const rows = this.#db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, id').all() as TaskRow[]
    return rows
      .map(row => this.#taskFromRow(row))
      .filter(task => isAllowed(task.accessBoundary, context))
      .filter(task => input.statuses === undefined || input.statuses.includes(task.status))
      .filter(task => input.domain === undefined || task.domain === input.domain)
      .filter(task => input.owner === undefined || task.owner === input.owner)
      .filter(task => input.projectKey === undefined || task.projectKey === input.projectKey)
  }

  updateTask(id: TaskId, input: UpdateTaskInput, context: InternalContext): Task {
    if (input.title !== undefined) requireText(input.title, 'title')
    if (input.objective !== undefined) requireText(input.objective, 'objective')
    if (input.status !== undefined) requireTaskStatus(input.status)
    if (input.projectKey !== undefined && input.projectKey !== null) requireText(input.projectKey, 'projectKey')
    if (input.visibleProgress !== undefined && input.visibleProgress !== null) requireText(input.visibleProgress, 'visibleProgress')
    if (input.waitingForUser !== undefined && input.waitingForUser !== null) requireText(input.waitingForUser, 'waitingForUser')
    if (input.candidateResult !== undefined && input.candidateResult !== null) requireText(input.candidateResult, 'candidateResult')
    if (input.updatedAt !== undefined) requireIsoTime(input.updatedAt, 'updatedAt')

    // Lock before reading so both authorization and timestamp validation use
    // the persisted row that this write will modify. The SQL below only names
    // supplied fields, so an independent store instance cannot overwrite a
    // field it did not intend to change.
    return this.#transaction(() => {
      const current = this.#findTask(id)
      if (!current) throw new Error(`Task does not exist: ${id}`)
      requireAuthorized(current, context, 'Task update')
      if (input.entityReferences !== undefined) {
        for (const reference of input.entityReferences) this.#validateEntityReference(reference)
      }
      const domain = input.domain ?? current.domain
      const owner = input.owner ?? current.owner
      requireValidTaskAssignment(domain, owner)
      const updatedAt = input.updatedAt ?? now()
      if (updatedAt < current.createdAt || updatedAt < current.updatedAt) {
        throw new Error('updatedAt must not be earlier than the current Task timestamp')
      }
      const projectKey = input.projectKey === undefined ? current.projectKey : input.projectKey ?? undefined
      const visibleProgress = input.visibleProgress === undefined ? current.visibleProgress : input.visibleProgress ?? undefined
      const waitingForUser = input.waitingForUser === undefined ? current.waitingForUser : input.waitingForUser ?? undefined
      const candidateResult = input.candidateResult === undefined ? current.candidateResult : input.candidateResult ?? undefined
      const updated: Task = {
        id: current.id,
        title: input.title ?? current.title,
        objective: input.objective ?? current.objective,
        status: input.status ?? current.status,
        domain,
        owner,
        ...(projectKey === undefined ? {} : { projectKey }),
        ...(visibleProgress === undefined ? {} : { visibleProgress }),
        ...(waitingForUser === undefined ? {} : { waitingForUser }),
        ...(candidateResult === undefined ? {} : { candidateResult }),
        createdAt: current.createdAt,
        updatedAt,
        entityReferences: input.entityReferences ?? current.entityReferences,
        accessBoundary: current.accessBoundary,
      }
      const assignments: string[] = []
      const values: Array<string | null> = []
      if (input.title !== undefined) { assignments.push('title = ?'); values.push(updated.title) }
      if (input.objective !== undefined) { assignments.push('objective = ?'); values.push(updated.objective) }
      if (input.status !== undefined) { assignments.push('status = ?'); values.push(updated.status) }
      if (input.domain !== undefined) { assignments.push('domain = ?'); values.push(updated.domain) }
      if (input.owner !== undefined) { assignments.push('owner = ?'); values.push(updated.owner) }
      if (input.projectKey !== undefined) { assignments.push('project_key = ?'); values.push(updated.projectKey ?? null) }
      if (input.visibleProgress !== undefined) { assignments.push('visible_progress = ?'); values.push(updated.visibleProgress ?? null) }
      if (input.waitingForUser !== undefined) { assignments.push('waiting_for_user = ?'); values.push(updated.waitingForUser ?? null) }
      if (input.candidateResult !== undefined) { assignments.push('candidate_result = ?'); values.push(updated.candidateResult ?? null) }
      if (input.entityReferences !== undefined) {
        assignments.push('entity_references_json = ?')
        values.push(JSON.stringify(updated.entityReferences))
      }
      assignments.push('updated_at = ?')
      values.push(updated.updatedAt)
      this.#db.prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ?`).run(...values, updated.id)
      if (input.status !== undefined && input.status !== current.status) {
        this.#appendTaskEventForTask(current, {
          type: 'status-change',
          content: `Task status changed from ${current.status} to ${updated.status}.`,
          // The supplied update timestamp is the effective time of the status
          // change, so using it for both event times preserves their ordering.
          occurredAt: updated.updatedAt,
          recordedAt: updated.updatedAt,
        }, taskEventActorForContext(context))
      }
      return updated
    })
  }

  appendTaskEvent(id: TaskId, input: AppendTaskEventInput, context: InternalContext): TaskEvent {
    requireTaskEventType(input.type)
    requireAppendableTaskEventType(input.type)
    requireText(input.content, 'content')
    if (input.occurredAt !== undefined) requireIsoTime(input.occurredAt, 'occurredAt')
    if (input.recordedAt !== undefined) requireIsoTime(input.recordedAt, 'recordedAt')
    return this.#transaction(() => {
      const task = this.#findTask(id)
      if (!task) throw new Error(`Task does not exist: ${id}`)
      requireAuthorized(task, context, 'Task event append')
      const actor = taskEventActorForContext(context)
      if (input.actor !== undefined && input.actor !== actor) {
        throw new Error(`Task event actor must match the authorized requester: ${actor}`)
      }
      return this.#appendTaskEventForTask(task, input, actor)
    })
  }

  /** Caller holds the transaction that makes the event and its evidence inseparable. */
  #appendTaskEventForTask(
    task: Task,
    input: RecordedTaskEventInput,
    actor: TaskEventActor,
  ): TaskEvent {
    requireTaskEventType(input.type)
    const occurredAt = input.occurredAt ?? now()
    const recordedAt = input.recordedAt ?? now()
    requireIsoTime(occurredAt, 'occurredAt')
    requireIsoTime(recordedAt, 'recordedAt')
    if (recordedAt < occurredAt) throw new Error('recordedAt must not be earlier than occurredAt')

    const eventId = randomUUID() as TaskEventId
    const source: Source = {
      id: randomUUID(),
      rawContent: input.content,
      occurredAt,
      recordedAt,
      origin: { kind: 'task-event', reference: eventId },
      accessBoundary: task.accessBoundary,
    }
    const event: TaskEvent = {
      id: eventId,
      taskId: task.id,
      sourceId: source.id,
      type: input.type,
      content: input.content,
      actor,
      occurredAt,
      recordedAt,
    }
    this.#db.prepare(`
      INSERT INTO sources (
        id, raw_content, summary, occurred_at, recorded_at, origin_json, access_boundary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.id,
      source.rawContent,
      null,
      source.occurredAt,
      source.recordedAt,
      JSON.stringify(source.origin),
      JSON.stringify(source.accessBoundary),
    )
    this.#db.prepare(`
      INSERT INTO task_events (id, task_id, source_id, type, content, actor, occurred_at, recorded_at, append_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (
        SELECT COALESCE(MAX(append_order), 0) + 1 FROM task_events WHERE task_id = ?
      ))
    `).run(
      event.id,
      event.taskId,
      event.sourceId,
      event.type,
      event.content,
      event.actor,
      event.occurredAt,
      event.recordedAt,
      event.taskId,
    )
    // Event evidence and the parent Task's recency are one journal mutation.
    // A backdated event cannot move a Task clock backwards.
    this.#db.prepare(`
      UPDATE tasks
      SET updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE id = ?
    `).run(event.recordedAt, event.recordedAt, event.taskId)
    return event
  }

  listTaskEvents<Context extends InternalContext>(
    id: TaskId,
    context: Context,
    limit?: number,
  ): TaskEventViewForContext<Context>[] {
    const task = this.#findTask(id)
    if (!task || !isAllowed(task.accessBoundary, context)) return []
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('limit must be a positive integer')
    }
    if (context.requester.kind === 'main' && context.requester.access === 'summary') {
      const rows = limit === undefined
        ? this.#db.prepare(`
            SELECT id, task_id, source_id, type, actor, occurred_at, recorded_at
            FROM task_events WHERE task_id = ? ORDER BY occurred_at, recorded_at, append_order
          `).all(id) as TaskEventSummaryRow[]
        : this.#db.prepare(`
            SELECT id, task_id, source_id, type, actor, occurred_at, recorded_at FROM (
              SELECT id, task_id, source_id, type, actor, occurred_at, recorded_at, append_order
              FROM task_events WHERE task_id = ? ORDER BY occurred_at DESC, recorded_at DESC, append_order DESC LIMIT ?
            ) ORDER BY occurred_at, recorded_at, append_order
          `).all(id, limit) as TaskEventSummaryRow[]
      return rows.map(row => this.#taskEventSummaryFromRow(row)) as TaskEventViewForContext<Context>[]
    }
    const rows = limit === undefined
      ? this.#db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY occurred_at, recorded_at, append_order').all(id) as TaskEventRow[]
      : this.#db.prepare(`
          SELECT * FROM (
            SELECT * FROM task_events WHERE task_id = ? ORDER BY occurred_at DESC, recorded_at DESC, append_order DESC LIMIT ?
          ) ORDER BY occurred_at, recorded_at, append_order
        `).all(id, limit) as TaskEventRow[]
    return rows.map(row => this.#taskEventFromRow(row)) as TaskEventViewForContext<Context>[]
  }

  previewSourceDeletion(id: SourceId, context: InternalContext): SourceDeletionPreview | undefined {
    return this.#sourceDeletionPreviewForContext(id, context)
  }

  deleteSource(id: SourceId, context: InternalContext, confirmation: DeleteSourceConfirmation): SourceDeletionResult {
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
      // This is the sole exception to TaskEvent append-only history: deleting
      // its evidence must also remove the duplicate raw event content.
      this.#db.prepare('DELETE FROM task_events WHERE source_id = ?').run(id)
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
  #sourceDeletionPreviewForContext(id: SourceId, context: InternalContext): SourceDeletionPreview | undefined {
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
    const eventLinkedTasks = (this.#db.prepare(`
      SELECT DISTINCT tasks.*
      FROM tasks JOIN task_events ON task_events.task_id = tasks.id
      WHERE task_events.source_id = ?
      ORDER BY tasks.id
    `).all(id) as TaskRow[]).map(row => this.#taskFromRow(row))
    // Removing an event is a mutation of its parent Task's journal even when
    // the task is no longer active, so no hidden journal may be changed.
    if (!eventLinkedTasks.every(task => isAllowed(task.accessBoundary, context))) return undefined

    const affectedIds = new Set<string>([
      id,
      ...claims.map(claim => claim.id),
      ...policiesToRetract.map(policy => policy.id),
    ])
    const eventLinkedTaskIds = new Set(eventLinkedTasks.map(task => task.id))
    const affectedActiveTasks = (this.#db.prepare("SELECT * FROM tasks WHERE status = 'active' ORDER BY id").all() as TaskRow[])
      .map(row => this.#taskFromRow(row))
      .filter(task => eventLinkedTaskIds.has(task.id) || task.entityReferences.some(reference => affectedIds.has(reference.id)))
    if (!affectedActiveTasks.every(task => isAllowed(task.accessBoundary, context))) return undefined

    return {
      source: this.#sourceViewForContext(source, context),
      solelySupportedClaims,
      claimsWithIndependentEvidence,
      policiesToRetract,
      affectedActiveTaskIds: affectedActiveTasks.map(task => task.id),
    }
  }

  #sourceViewForContext(source: SourceSummaryView, context: InternalContext): SourceView {
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
    if (!this.#hasColumn('tasks', 'objective')) {
      this.#db.exec('ALTER TABLE tasks ADD COLUMN objective TEXT')
      this.#db.exec('UPDATE tasks SET objective = title WHERE objective IS NULL')
    }
    if (!this.#hasColumn('tasks', 'domain')) {
      this.#db.exec('ALTER TABLE tasks ADD COLUMN domain TEXT')
      this.#db.exec("UPDATE tasks SET domain = 'legacy' WHERE domain IS NULL")
    }
    if (!this.#hasColumn('tasks', 'owner')) {
      this.#db.exec('ALTER TABLE tasks ADD COLUMN owner TEXT')
      this.#db.exec("UPDATE tasks SET owner = 'main-agent' WHERE owner IS NULL")
    }
    if (!this.#hasColumn('tasks', 'project_key')) this.#db.exec('ALTER TABLE tasks ADD COLUMN project_key TEXT')
    if (!this.#hasColumn('tasks', 'visible_progress')) this.#db.exec('ALTER TABLE tasks ADD COLUMN visible_progress TEXT')
    if (!this.#hasColumn('tasks', 'waiting_for_user')) this.#db.exec('ALTER TABLE tasks ADD COLUMN waiting_for_user TEXT')
    if (!this.#hasColumn('tasks', 'candidate_result')) this.#db.exec('ALTER TABLE tasks ADD COLUMN candidate_result TEXT')
    if (!this.#hasColumn('task_events', 'source_id')) {
      // The prior Stage 1.1 table held raw event text without citable evidence.
      // Rebuild it twice: first permit a temporary NULL while sources are made,
      // then restore the non-null relation used by all current writes.
      this.#rebuildTaskEventsWithoutSourceRelation()
      this.#backfillTaskEventSources()
      this.#rebuildTaskEventsWithSourceRelation(true)
    } else if (!this.#hasColumn('task_events', 'append_order')) {
      // The provenance-aware Stage 1.1 table already has its Sources. Rebuild
      // it with a durable per-Task sequence seeded from insertion rowids.
      this.#rebuildTaskEventsWithSourceRelation(false)
    }
  }

  #rebuildTaskEventsWithoutSourceRelation(): void {
    this.#db.exec('ALTER TABLE task_events RENAME TO task_events_legacy')
    this.#db.exec(`
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        source_id TEXT REFERENCES sources(id),
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        append_order INTEGER NOT NULL
      ) STRICT;
      INSERT INTO task_events (
        id, task_id, source_id, type, content, actor, occurred_at, recorded_at, append_order
      )
      SELECT id, task_id, NULL, type, content, actor, occurred_at, recorded_at, rowid
      FROM task_events_legacy;
      DROP TABLE task_events_legacy;
    `)
  }

  #rebuildTaskEventsWithSourceRelation(preserveAppendOrder: boolean): void {
    this.#db.exec('ALTER TABLE task_events RENAME TO task_events_legacy')
    this.#db.exec(`
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        source_id TEXT NOT NULL REFERENCES sources(id),
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        append_order INTEGER NOT NULL
      ) STRICT;
      INSERT INTO task_events (
        id, task_id, source_id, type, content, actor, occurred_at, recorded_at, append_order
      )
      SELECT id, task_id, source_id, type, content, actor, occurred_at, recorded_at,
        ${preserveAppendOrder ? 'append_order' : 'rowid'}
      FROM task_events_legacy;
      DROP TABLE task_events_legacy;
    `)
  }

  #backfillTaskEventSources(): void {
    const rows = this.#db.prepare('SELECT * FROM task_events WHERE source_id IS NULL').all() as TaskEventRow[]
    for (const row of rows) {
      const task = this.#findTask(row.task_id)
      if (!task) throw new Error(`Task event has no parent Task: ${row.id}`)
      const sourceId = randomUUID()
      this.#db.prepare(`
        INSERT INTO sources (
          id, raw_content, summary, occurred_at, recorded_at, origin_json, access_boundary_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sourceId,
        row.content,
        null,
        row.occurred_at,
        row.recorded_at,
        JSON.stringify({ kind: 'task-event', reference: row.id } satisfies SourceOrigin),
        JSON.stringify(task.accessBoundary),
      )
      this.#db.prepare('UPDATE task_events SET source_id = ? WHERE id = ?').run(sourceId, row.id)
    }
  }

  #hasColumn(table: 'sources' | 'claims' | 'policies' | 'tasks' | 'task_events', column: string): boolean {
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
      // The coalesce guards against a partially migrated database being opened
      // concurrently during deployment; normal migrations backfill these.
      objective: row.objective ?? row.title,
      status: row.status,
      domain: row.domain ?? 'legacy',
      owner: row.owner ?? 'main-agent',
      ...(row.project_key === null ? {} : { projectKey: row.project_key }),
      ...(row.visible_progress === null ? {} : { visibleProgress: row.visible_progress }),
      ...(row.waiting_for_user === null ? {} : { waitingForUser: row.waiting_for_user }),
      ...(row.candidate_result === null ? {} : { candidateResult: row.candidate_result }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      entityReferences: JSON.parse(row.entity_references_json) as EntityReference[],
      accessBoundary: JSON.parse(row.access_boundary_json) as AccessBoundary,
    }
  }

  #taskEventFromRow(row: TaskEventRow): TaskEvent {
    if (row.source_id === null) throw new Error(`Task event is missing its provenance Source: ${row.id}`)
    return {
      id: row.id as TaskEventId,
      taskId: row.task_id,
      sourceId: row.source_id,
      type: row.type,
      content: row.content,
      actor: row.actor,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
    }
  }

  #taskEventSummaryFromRow(row: TaskEventSummaryRow): TaskEventSummaryView {
    if (row.source_id === null) throw new Error(`Task event is missing its provenance Source: ${row.id}`)
    return {
      id: row.id as TaskEventId,
      taskId: row.task_id,
      sourceId: row.source_id,
      type: row.type,
      actor: row.actor,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
    }
  }
}
