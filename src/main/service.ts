import type {
  AppendMainConversationMessageInput,
  MainAgentFacade,
  MainAgentOptions,
  MainConversationMessage,
} from './types.js'
import type {
  CreateTaskInput,
  InternalContext,
  ListTasksInput,
  Task,
  TaskId,
  TaskEventViewForContext,
  UpdateTaskInput,
} from '../personal/types.js'

/**
 * Minimal MainAgent control plane. It records conversation and delegates only
 * to the persistence interfaces supplied by the caller; it has no executor
 * dependency and therefore cannot start relay/backend work.
 */
export class MainAgent<Context extends InternalContext = InternalContext> implements MainAgentFacade<Context> {
  readonly #taskStore: MainAgentOptions<Context>['taskStore']
  readonly #conversationStore: MainAgentOptions<Context>['conversationStore']
  readonly #taskContext: MainAgentOptions<Context>['taskContext']

  constructor(options: MainAgentOptions<Context>) {
    this.#taskStore = options.taskStore
    this.#conversationStore = options.conversationStore
    this.#taskContext = options.taskContext
  }

  recordMessage(input: AppendMainConversationMessageInput): MainConversationMessage {
    return this.#conversationStore.appendMessage(input)
  }

  readRecentContext(limit?: number): MainConversationMessage[] {
    return this.#conversationStore.readRecentContext(limit)
  }

  createTask(input: CreateTaskInput): Task {
    return this.#taskStore.createTask(input)
  }

  listTasks(input?: ListTasksInput): Task[] {
    return this.#taskStore.listTasks(this.#taskContext, input)
  }

  inspectTask(id: TaskId): Task | undefined {
    return this.#taskStore.getTask(id, this.#taskContext)
  }

  updateTask(id: TaskId, input: UpdateTaskInput): Task {
    return this.#taskStore.updateTask(id, input, this.#taskContext)
  }

  listTaskEvents(id: TaskId, limit?: number): TaskEventViewForContext<Context>[] {
    return this.#taskStore.listTaskEvents(id, this.#taskContext, limit)
  }
}
