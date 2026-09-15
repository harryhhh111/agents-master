import type {
  InboxEvent,
  InboxEventId,
  MainAgentRuntimePort,
  MainAgentRuntimeStore,
  ReceiveUserMessageInput,
  ReceiveUserMessageResult,
} from './types.js'

/**
 * Executor-free foreground orchestration. A later slice may supply an LLM
 * consumer, but this runtime only makes durable inbox lifecycle explicit.
 */
export class MainAgentRuntime implements MainAgentRuntimePort {
  readonly #store: MainAgentRuntimeStore

  constructor(store: MainAgentRuntimeStore) {
    this.#store = store
  }

  receiveUserMessage(input: ReceiveUserMessageInput): ReceiveUserMessageResult {
    return this.#store.receiveUserMessage(input)
  }

  claimNextPendingEvent(claimedAt?: string): InboxEvent | undefined {
    return this.#store.claimNextPendingEvent(claimedAt)
  }

  completeInboxEvent(id: InboxEventId, completedAt?: string): InboxEvent {
    return this.#store.completeInboxEvent(id, completedAt)
  }

  cancelInboxEvent(id: InboxEventId, cancelledAt?: string): InboxEvent {
    return this.#store.cancelInboxEvent(id, cancelledAt)
  }

  recoverClaimedEvents(recoveredAt?: string): number {
    return this.#store.recoverClaimedEvents(recoveredAt)
  }
}
