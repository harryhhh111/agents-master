/** Stable identifier for a record in the personal-agent knowledge base. */
export type SourceId = string
export type ClaimId = string
export type PolicyId = string
export type TaskId = string
export type TaskEventId = string

/**
 * Limits how an internal agent may use a record. This is deliberately about
 * internal use, not multi-user authorization or authority to act externally.
 */
export interface AccessBoundary {
  mainAgent: 'none' | 'summary' | 'full'
  domainAgents: readonly string[]
  allowInTaskContext: boolean
  allowExternalDisclosure: boolean
}

export type SourceOrigin =
  | { kind: 'task-event'; reference: TaskEventId }
  | {
    kind: 'conversation' | 'file' | 'web' | 'external' | 'manual'
    reference?: string
  }

/** Raw, time-bound evidence. Being stored does not make it a fact. */
export interface Source {
  id: SourceId
  rawContent: string
  /** Safe, optional synopsis for summary-only readers. */
  summary?: string
  occurredAt: string
  recordedAt: string
  origin: SourceOrigin
  accessBoundary: AccessBoundary
}

export type ClaimScope = 'personal' | 'relationship' | 'project' | 'goal' | 'external'
export type ClaimStatus = 'active' | 'superseded' | 'forgotten' | 'retracted'
export type ClaimEpistemicState = 'user-fact' | 'model-inference'

/** A traceable assertion derived from one or more Sources. */
export interface Claim {
  id: ClaimId
  statement: string
  /** Claims are either an explicit user fact or a model-derived inference. */
  epistemicState: ClaimEpistemicState
  scope: ClaimScope
  status: ClaimStatus
  validFrom: string
  validUntil?: string
  evidenceIds: readonly SourceId[]
  /** The prior Claim this version corrects, if it was made by correction. */
  supersedesClaimId?: ClaimId
  /** The succeeding Claim, retained on the historical Claim for traceability. */
  supersededByClaimId?: ClaimId
  accessBoundary: AccessBoundary
}

/** A rule for behavior, whose basis is one or more Claims rather than a fact. */
export interface Policy {
  id: PolicyId
  condition: string
  action: string
  dependsOnClaimIds: readonly ClaimId[]
  scope: ClaimScope
  status: PolicyStatus
  validFrom: string
  validUntil?: string
  accessBoundary: AccessBoundary
}

export type PolicyStatus = 'active' | 'forgotten' | 'retracted'

export type EntityReference =
  | { kind: 'source'; id: SourceId }
  | { kind: 'claim'; id: ClaimId }
  | { kind: 'policy'; id: PolicyId }
  | { kind: 'task'; id: TaskId }

export type TaskStatus = 'active' | 'paused' | 'completed' | 'cancelled'

/** The three product domains, plus the migration-only bucket for pre-domain Tasks. */
export type TaskDomain = 'relationship' | 'work-project' | 'goal' | 'legacy'

/** This is deliberately a fixed product role set, not a general agent registry. */
export type TaskOwner = 'main-agent' | 'work-project-agent'

/** A running commitment; references provide context but do not define ownership. */
export interface Task {
  id: TaskId
  title: string
  /** The durable outcome being pursued. Legacy Tasks use their title as the objective. */
  objective: string
  status: TaskStatus
  domain: TaskDomain
  owner: TaskOwner
  /** A stable work-project key when this Task belongs to a work project. */
  projectKey?: string
  /** The concise task-list progress line, intentionally separate from the journal. */
  visibleProgress?: string
  /** A decision or missing input which requires the user's attention. */
  waitingForUser?: string
  /** A provisional result that remains distinct from a completed task. */
  candidateResult?: string
  createdAt: string
  updatedAt: string
  entityReferences: readonly EntityReference[]
  accessBoundary: AccessBoundary
}

/** Append-only history for a Task. Events inherit the Task's access boundary. */
export type TaskEventType = 'note' | 'progress' | 'waiting-for-user' | 'candidate-result' | 'status-change'

/** Status transitions are recorded only by updateTask after a persisted change. */
export type AppendableTaskEventType = Exclude<TaskEventType, 'status-change'>

/**
 * Task ownership stays a fixed product role set. Event actors instead record
 * the authorized requester that actually made an append, including domains
 * which are allowed by a Task boundary but are not Task owners.
 */
export type TaskEventActor = TaskOwner | `domain-agent:${string}`

export interface TaskEvent {
  id: TaskEventId
  taskId: TaskId
  /** The citable Source created atomically with this event. */
  sourceId: SourceId
  type: TaskEventType
  content: string
  actor: TaskEventActor
  occurredAt: string
  recordedAt: string
}

export type CreateSourceInput = Omit<Source, 'id' | 'recordedAt'> & { recordedAt?: string }
export type CreateClaimInput = Omit<Claim, 'id' | 'supersedesClaimId' | 'supersededByClaimId'>
/** New Policies are active unless the caller is importing a historical record. */
export type CreatePolicyInput = Omit<Policy, 'id' | 'status'> & { status?: PolicyStatus }
/**
 * The new task fields are optional at creation for source compatibility with
 * pre-domain callers. They receive conservative MainAgent/legacy defaults.
 */
export type CreateTaskInput = Omit<
  Task,
  'id' | 'createdAt' | 'updatedAt' | 'objective' | 'domain' | 'owner' | 'projectKey' | 'visibleProgress' | 'waitingForUser' | 'candidateResult'
> & {
  createdAt?: string
  updatedAt?: string
  objective?: string
  domain?: TaskDomain
  owner?: TaskOwner
  projectKey?: string
  visibleProgress?: string
  waitingForUser?: string
  candidateResult?: string
}

/**
 * All Task fields that can change during its lifetime. Access boundaries are
 * intentionally immutable through this API so a visible caller cannot widen
 * a record's audience as a side effect of an update.
 */
export interface UpdateTaskInput {
  title?: string
  objective?: string
  status?: TaskStatus
  domain?: TaskDomain
  owner?: TaskOwner
  projectKey?: string | null
  visibleProgress?: string | null
  waitingForUser?: string | null
  candidateResult?: string | null
  entityReferences?: readonly EntityReference[]
  updatedAt?: string
}

export interface ListTasksInput {
  statuses?: readonly TaskStatus[]
  domain?: TaskDomain
  owner?: TaskOwner
  projectKey?: string
}

export interface AppendTaskEventInput {
  /** status-change is intentionally unavailable to direct appends. */
  type: AppendableTaskEventType
  content: string
  /** Must exactly match the actor derived from the authorized requester. */
  actor?: TaskEventActor
  occurredAt?: string
  recordedAt?: string
}

export type InternalRequester =
  | { kind: 'main'; access: 'full' | 'summary' }
  | { kind: 'domain-agent'; id: string }

/**
 * Every read and lifecycle mutation must name an internal requester and
 * whether it is used to build task context. There is intentionally no
 * external requester variant.
 */
export interface InternalContext {
  requester: InternalRequester
  use: 'general' | 'task'
}

/** A summary view is structurally unable to contain a Source's raw content. */
export type SourceSummaryView = Omit<Source, 'rawContent'> & { rawContent?: never }
export type SourceFullView = Source
export type SourceView = SourceSummaryView | SourceFullView

/** A summary view is structurally unable to contain a TaskEvent's content. */
export type TaskEventSummaryView = Omit<TaskEvent, 'content'> & { content?: never }
export type TaskEventFullView = TaskEvent
export type TaskEventView = TaskEventSummaryView | TaskEventFullView

/** Maps a requester's declared read level to its safe TaskEvent response shape. */
export type TaskEventViewForContext<Context extends InternalContext> =
  [Extract<Context['requester'], { kind: 'main'; access: 'summary' }>] extends [never]
    ? TaskEventFullView
    : Context['requester'] extends { kind: 'main'; access: 'summary' }
      ? TaskEventSummaryView
      : TaskEventView

/** Corrections are immediate or historical; scheduled future corrections are unsupported. */
export interface CorrectClaimInput {
  statement: string
  epistemicState: ClaimEpistemicState
  scope: ClaimScope
  evidenceIds: readonly SourceId[]
  accessBoundary: AccessBoundary
  effectiveAt: string
  validUntil?: string
}

export interface ClaimCorrection {
  supersededClaim: Claim
  replacementClaim: Claim
  /** Policies whose basis included the superseded Claim are retained as retracted history. */
  retractedPolicies: readonly Policy[]
}

export interface ForgetClaimResult {
  forgottenClaim: Claim
  invalidatedPolicies: readonly Policy[]
}

/** Deletion is intentionally a two-step operation: preview, then confirm. */
export interface SourceDeletionPreview {
  /** A summary reader never receives the deleted Source's raw content. */
  source: SourceView
  solelySupportedClaims: readonly Claim[]
  claimsWithIndependentEvidence: readonly Claim[]
  policiesToRetract: readonly Policy[]
  affectedActiveTaskIds: readonly TaskId[]
}

export interface DeleteSourceConfirmation {
  confirm: true
}

export interface SourceDeletionResult {
  /** A summary reader never receives the deleted Source's raw content. */
  deletedSource: SourceView
  retractedClaims: readonly Claim[]
  survivingClaims: readonly Claim[]
  retractedPolicies: readonly Policy[]
  affectedActiveTaskIds: readonly TaskId[]
}

export interface PersonalStore {
  createSource(input: CreateSourceInput): Source
  getSource(id: SourceId, context: InternalContext): SourceView | undefined
  createClaim(input: CreateClaimInput): Claim
  getClaim(id: ClaimId, context: InternalContext): Claim | undefined
  listActiveClaims(context: InternalContext, asOf?: string): Claim[]
  /** Throws when the Claim, or any Policy cascaded by the correction, is outside the caller's boundary. */
  correctClaim(id: ClaimId, input: CorrectClaimInput, context: InternalContext): ClaimCorrection
  /** Throws when the Claim, or any Policy cascaded by the forget, is outside the caller's boundary. */
  forgetClaim(id: ClaimId, context: InternalContext): ForgetClaimResult
  createPolicy(input: CreatePolicyInput): Policy
  getPolicy(id: PolicyId, context: InternalContext): Policy | undefined
  listActivePolicies(context: InternalContext, asOf?: string): Policy[]
  /** Throws when the Policy is outside the caller's boundary. */
  forgetPolicy(id: PolicyId, context: InternalContext): Policy
  createTask(input: CreateTaskInput): Task
  getTask(id: TaskId, context: InternalContext): Task | undefined
  listTasks(context: InternalContext, input?: ListTasksInput): Task[]
  /** Throws when the Task is not visible to the caller. */
  updateTask(id: TaskId, input: UpdateTaskInput, context: InternalContext): Task
  /** Events are append-only and can be added only by a caller authorized for the parent Task. */
  appendTaskEvent(id: TaskId, input: AppendTaskEventInput, context: InternalContext): TaskEvent
  /**
   * Returns no events when the parent Task is absent or outside the caller
   * boundary. Summary MainAgent contexts receive structural redactions.
   */
  listTaskEvents<Context extends InternalContext>(
    id: TaskId,
    context: Context,
    limit?: number,
  ): TaskEventViewForContext<Context>[]
  /** Returns undefined when any record the deletion would expose or mutate is inaccessible. */
  previewSourceDeletion(id: SourceId, context: InternalContext): SourceDeletionPreview | undefined
  deleteSource(id: SourceId, context: InternalContext, confirmation: DeleteSourceConfirmation): SourceDeletionResult
  close(): void
}
