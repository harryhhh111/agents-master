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
