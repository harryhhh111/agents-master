import type { FrontBrainResponse } from '../frontbrain/types.js'
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

/** Maximum persisted messages that one foreground context may compose. */
export const maxMainConversationContextMessages = 100

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

/**
 * Foreground-turn input for the FrontBrain-wired runtime. Instructions and
 * checkpoint are immutable stable-prefix bytes; nothing here is persisted
 * into the conversation or the cognitive store.
 */
export interface ProcessNextUserMessageEventInput {
  /** Stable system instructions; must be non-empty and is passed verbatim. */
  instructions: string
  /** Optional string checkpoint, appended verbatim right after instructions. */
  checkpoint?: string
  /** Output cap for the FrontBrain completion: a safe integer from 1 through 8192. */
  maxOutputTokens: number
  /**
   * Optional upper bound of persisted conversation messages composed into
   * context: a safe integer from 1 through 100 (default 20).
   * The window is anchored at the claimed event's conversation message, so
   * that message is always included; messages appended after it never leak.
   */
  contextMessageLimit?: number
}

export interface ProcessNextUserMessageEventResult {
  /** The exact user-message event that was claimed and is now processed. */
  event: InboxEvent
  /** The persisted assistant reply; committed with the processed transition. */
  message: MainConversationMessage
  /** FrontBrain telemetry for this turn. Never persisted into the conversation. */
  response: FrontBrainResponse
}

/** One-transaction persistence of an assistant reply plus processed state. */
export interface RecordProcessedUserMessageEventInput {
  eventId: InboxEventId
  content: string
  /** Must be canonical UTC ISO text when supplied. */
  processedAt?: string
}

export interface RecordProcessedUserMessageEventResult {
  message: MainConversationMessage
  event: InboxEvent
}

/** Storage boundary used by the executor-free foreground runtime. */
export interface MainAgentRuntimeStore extends MainConversationStore {
  receiveUserMessage(input: ReceiveUserMessageInput): ReceiveUserMessageResult
  enqueueEvent(input: EnqueueInboxEventInput): EnqueueInboxEventResult
  claimNextPendingEvent(claimedAt?: string): InboxEvent | undefined
  /** Claims only pending user-message events; timer and domain-update events stay untouched. */
  claimNextPendingUserMessageEvent(claimedAt?: string): InboxEvent | undefined
  /**
   * Anchored foreground read: the persisted conversation up to and including
   * the anchor message in append order, windowed to the most recent `limit`
   * messages. The anchor is always included no matter how small the limit is;
   * messages appended after the anchor never appear. Window selection is by
   * append order (the deterministic admission sequence), then the window is
   * returned in the usual chronological order.
   */
  readContextThroughMessage(messageId: MainConversationMessageId, limit?: number): MainConversationMessage[]
  /**
   * Persists the assistant reply and flips the exact claimed user-message
   * event to processed in one SQLite transaction. Exact-once: a failed
   * transition rolls the insert back, so no duplicate reply can be committed.
   */
  recordProcessedUserMessageEvent(input: RecordProcessedUserMessageEventInput): RecordProcessedUserMessageEventResult
  completeInboxEvent(id: InboxEventId, completedAt?: string): InboxEvent
  cancelInboxEvent(id: InboxEventId, cancelledAt?: string): InboxEvent
  /**
   * Explicitly return ALL abandoned claimed work to pending after a worker
   * restart. Legacy surface: also resets claimed timer/domain-update events,
   * which may belong to other consumers — foreground user-message recovery
   * must use recoverClaimedUserMessageEvents instead.
   */
  recoverClaimedEvents(recoveredAt?: string): number
  /**
   * Foreground-only recovery: returns only abandoned claimed user-message
   * events to pending. Claimed timer/domain-update events are never reset.
   */
  recoverClaimedUserMessageEvents(recoveredAt?: string): number
}

export interface MainAgentRuntimePort {
  receiveUserMessage(input: ReceiveUserMessageInput): ReceiveUserMessageResult
  claimNextPendingEvent(claimedAt?: string): InboxEvent | undefined
  completeInboxEvent(id: InboxEventId, completedAt?: string): InboxEvent
  cancelInboxEvent(id: InboxEventId, cancelledAt?: string): InboxEvent
  recoverClaimedEvents(recoveredAt?: string): number
  /**
   * Foreground-only recovery: returns only abandoned claimed user-message
   * events to pending; claimed timer/domain-update events stay untouched.
   */
  recoverClaimedUserMessageEvents(recoveredAt?: string): number
  /**
   * One foreground turn over the next pending user-message event. Returns
   * undefined when no user-message event is pending. On FrontBrain failure
   * the event stays claimed for explicit recovery; nothing is persisted.
   */
  processNextUserMessageEvent(input: ProcessNextUserMessageEventInput): Promise<ProcessNextUserMessageEventResult | undefined>
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
