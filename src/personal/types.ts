/** Stable identifier for a record in the personal-agent knowledge base. */
export type SourceId = string
export type ClaimId = string
export type PolicyId = string
export type TaskId = string

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

export interface SourceOrigin {
  kind: 'conversation' | 'task-event' | 'file' | 'web' | 'external' | 'manual'
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

/** A running commitment; references provide context but do not define ownership. */
export interface Task {
  id: TaskId
  title: string
  status: 'active' | 'paused' | 'completed' | 'cancelled'
  createdAt: string
  updatedAt: string
  entityReferences: readonly EntityReference[]
  accessBoundary: AccessBoundary
}

export type CreateSourceInput = Omit<Source, 'id' | 'recordedAt'> & { recordedAt?: string }
export type CreateClaimInput = Omit<Claim, 'id' | 'supersedesClaimId' | 'supersededByClaimId'>
/** New Policies are active unless the caller is importing a historical record. */
export type CreatePolicyInput = Omit<Policy, 'id' | 'status'> & { status?: PolicyStatus }
export type CreateTaskInput = Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt?: string
  updatedAt?: string
}

export type InternalRequester =
  | { kind: 'main'; access: 'full' | 'summary' }
  | { kind: 'domain-agent'; id: string }

/**
 * Every read must name an internal requester and whether it is used to build
 * task context. There is intentionally no external requester variant.
 */
export interface InternalReadContext {
  requester: InternalRequester
  use: 'general' | 'task'
}

/** A summary view is structurally unable to contain a Source's raw content. */
export type SourceSummaryView = Omit<Source, 'rawContent'> & { rawContent?: never }
export type SourceFullView = Source
export type SourceView = SourceSummaryView | SourceFullView

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
  getSource(id: SourceId, context: InternalReadContext): SourceView | undefined
  createClaim(input: CreateClaimInput): Claim
  getClaim(id: ClaimId, context: InternalReadContext): Claim | undefined
  listActiveClaims(context: InternalReadContext, asOf?: string): Claim[]
  correctClaim(id: ClaimId, input: CorrectClaimInput): ClaimCorrection
  forgetClaim(id: ClaimId): ForgetClaimResult
  createPolicy(input: CreatePolicyInput): Policy
  getPolicy(id: PolicyId, context: InternalReadContext): Policy | undefined
  listActivePolicies(context: InternalReadContext, asOf?: string): Policy[]
  forgetPolicy(id: PolicyId): Policy
  createTask(input: CreateTaskInput): Task
  getTask(id: TaskId, context: InternalReadContext): Task | undefined
  /** Returns undefined when any record the deletion would expose or mutate is inaccessible. */
  previewSourceDeletion(id: SourceId, context: InternalReadContext): SourceDeletionPreview | undefined
  deleteSource(id: SourceId, context: InternalReadContext, confirmation: DeleteSourceConfirmation): SourceDeletionResult
  close(): void
}
