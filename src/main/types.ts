import type {
  CreateTaskInput,
  InternalContext,
  ListTasksInput,
  PersonalStore,
  Task,
  TaskId,
  TaskEventViewForContext,
  UpdateTaskInput,
} from '../personal/types.js'

export type MainConversationRole = 'user' | 'assistant' | 'system'
export type MainConversationMessageId = string

/** A durable main-thread utterance. It is not evidence or a Claim. */
export interface MainConversationMessage {
  id: MainConversationMessageId
  role: MainConversationRole
  content: string
  createdAt: string
}

export interface AppendMainConversationMessageInput {
  role: MainConversationRole
  content: string
  createdAt?: string
}

export interface MainConversationStore {
  appendMessage(input: AppendMainConversationMessageInput): MainConversationMessage
  /** Returns the latest bounded window in chronological order. */
  readRecentContext(limit?: number): MainConversationMessage[]
  close(): void
}

/** JSON-safe data carried by a durable inbox event. */
export type InboxPayload =
  | null
  | boolean
  | number
  | string
  | readonly InboxPayload[]
  | { readonly [key: string]: InboxPayload }

export type InboxEventId = string
/** A caller-generated message id; unique within one conversation. */
export type InboxIdempotencyKey = string
export type InboxEventType = 'user-message' | 'domain-update' | 'timer'
export type InboxEventPriority = 'normal' | 'interrupt'
export type InboxEventStatus = 'pending' | 'claimed' | 'processed' | 'cancelled'

/**
 * Durable work waiting for the foreground runtime. Claimed work has no lease:
 * callers must explicitly recover it after an unclean worker shutdown.
 */
export interface InboxEvent {
  id: InboxEventId
  conversationId: string
  idempotencyKey: InboxIdempotencyKey
  type: InboxEventType
  priority: InboxEventPriority
  payload: InboxPayload
  status: InboxEventStatus
  createdAt: string
  updatedAt: string
  claimedAt?: string
  processedAt?: string
  cancelledAt?: string
  userMessageId?: MainConversationMessageId
}

export interface ReceiveUserMessageInput {
  conversationId: string
  /** This is the stable caller message id used for retry idempotency. */
  idempotencyKey: InboxIdempotencyKey
  content: string
  priority?: InboxEventPriority
  /** Must be canonical UTC ISO text when supplied. */
  receivedAt?: string
}

export interface ReceiveUserMessageResult {
  message: MainConversationMessage
  event: InboxEvent
  /** True when a retry returned the already-admitted message and event. */
  duplicate: boolean
}

export interface EnqueueInboxEventInput {
  conversationId: string
  idempotencyKey: InboxIdempotencyKey
  type: Exclude<InboxEventType, 'user-message'>
  priority?: InboxEventPriority
  payload: InboxPayload
  /** Must be canonical UTC ISO text when supplied. */
  createdAt?: string
}

export interface EnqueueInboxEventResult {
  event: InboxEvent
  duplicate: boolean
}

export class InboxIdempotencyConflictError extends Error {
  constructor(conversationId: string, idempotencyKey: string) {
    super(`Inbox idempotency key conflict for conversation ${conversationId}: ${idempotencyKey}`)
    this.name = 'InboxIdempotencyConflictError'
  }
}

/** Storage boundary used by the executor-free foreground runtime. */
export interface MainAgentRuntimeStore extends MainConversationStore {
  receiveUserMessage(input: ReceiveUserMessageInput): ReceiveUserMessageResult
  enqueueEvent(input: EnqueueInboxEventInput): EnqueueInboxEventResult
  claimNextPendingEvent(claimedAt?: string): InboxEvent | undefined
  completeInboxEvent(id: InboxEventId, completedAt?: string): InboxEvent
  cancelInboxEvent(id: InboxEventId, cancelledAt?: string): InboxEvent
  /** Explicitly return abandoned claimed work to pending after a worker restart. */
  recoverClaimedEvents(recoveredAt?: string): number
}

export interface MainAgentRuntimePort {
  receiveUserMessage(input: ReceiveUserMessageInput): ReceiveUserMessageResult
  claimNextPendingEvent(claimedAt?: string): InboxEvent | undefined
  completeInboxEvent(id: InboxEventId, completedAt?: string): InboxEvent
  cancelInboxEvent(id: InboxEventId, cancelledAt?: string): InboxEvent
  recoverClaimedEvents(recoveredAt?: string): number
}

export interface MainAgentOptions<Context extends InternalContext = InternalContext> {
  taskStore: PersonalStore
  conversationStore: MainConversationStore
  /** The MainAgent's internal read/mutation boundary for task operations. */
  taskContext: Context
}

/**
 * The control-plane surface deliberately contains no executor dependency.
 * It only records the main thread and maintains explicitly created Tasks.
 */
export interface MainAgentFacade<Context extends InternalContext = InternalContext> {
  recordMessage(input: AppendMainConversationMessageInput): MainConversationMessage
  readRecentContext(limit?: number): MainConversationMessage[]
  createTask(input: CreateTaskInput): Task
  listTasks(input?: ListTasksInput): Task[]
  inspectTask(id: TaskId): Task | undefined
  updateTask(id: TaskId, input: UpdateTaskInput): Task
  /** Read-only task-detail journal retrieval within the MainAgent task boundary. */
  listTaskEvents(id: TaskId, limit?: number): TaskEventViewForContext<Context>[]
}
