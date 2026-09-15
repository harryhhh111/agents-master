import { composeFrontBrainContext } from '../frontbrain/context.js'
import type { FrontBrain } from '../frontbrain/types.js'
import { maxFrontBrainOutputTokens } from '../frontbrain/types.js'
import type {
  InboxEvent,
  InboxEventId,
  MainAgentRuntimePort,
  MainAgentRuntimeStore,
  ProcessNextUserMessageEventInput,
  ProcessNextUserMessageEventResult,
  ReceiveUserMessageInput,
  ReceiveUserMessageResult,
} from './types.js'
import { maxMainConversationContextMessages } from './types.js'

function validateProcessNextUserMessageEventInput(input: ProcessNextUserMessageEventInput): void {
  if (!input || typeof input !== 'object') {
    throw new Error('processNextUserMessageEvent input must be an object')
  }
  if (typeof input.instructions !== 'string' || !input.instructions.trim()) {
    throw new Error('instructions must not be empty')
  }
  if (input.checkpoint !== undefined && typeof input.checkpoint !== 'string') {
    throw new Error('checkpoint must be a string when provided')
  }
  if (
    !Number.isSafeInteger(input.maxOutputTokens)
    || input.maxOutputTokens < 1
    || input.maxOutputTokens > maxFrontBrainOutputTokens
  ) {
    throw new Error(`maxOutputTokens must be an integer between 1 and ${maxFrontBrainOutputTokens}`)
  }
  if (
    input.contextMessageLimit !== undefined
    && (
      !Number.isSafeInteger(input.contextMessageLimit)
      || input.contextMessageLimit < 1
      || input.contextMessageLimit > maxMainConversationContextMessages
    )
  ) {
    throw new Error(
      `contextMessageLimit must be a positive integer no greater than ${maxMainConversationContextMessages}`,
    )
  }
}

/**
 * Foreground orchestration over the durable inbox. The legacy surface stays
 * executor-free; the optional FrontBrain enables exactly one new capability:
 * turning the next pending user-message event into a persisted assistant
 * reply. Timer and domain-update events are never claimed or altered here.
 */
export class MainAgentRuntime implements MainAgentRuntimePort {
  readonly #store: MainAgentRuntimeStore
  readonly #frontBrain: FrontBrain | undefined

  constructor(store: MainAgentRuntimeStore, frontBrain?: FrontBrain) {
    this.#store = store
    this.#frontBrain = frontBrain
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

  recoverClaimedUserMessageEvents(recoveredAt?: string): number {
    return this.#store.recoverClaimedUserMessageEvents(recoveredAt)
  }

  /**
   * One foreground turn: claim the next eligible pending user-message event,
   * compose the stable prefix (instructions, optional checkpoint) plus the
   * persisted main conversation anchored at the claimed event's message, ask
   * FrontBrain, then persist the assistant reply together with the processed
   * transition in one transaction. Returns undefined when no user-message
   * event is pending.
   *
   * The context window ends at the claimed message: anything appended after
   * it — later user messages included — never leaks into this turn, and the
   * claimed message itself is always included no matter how small
   * contextMessageLimit is. Retrying the same event therefore composes
   * identical bytes.
   *
   * On FrontBrain failure the event stays claimed and nothing is persisted;
   * callers explicitly recover claimed user-message work
   * (recoverClaimedUserMessageEvents) — never the legacy recoverClaimedEvents,
   * which would also reset claimed timer/domain-update events owned by other
   * consumers — before a retry regenerates the reply. A crash after the
   * transaction commits can never produce a duplicate reply because the
   * event is no longer eligible.
   */
  async processNextUserMessageEvent(
    input: ProcessNextUserMessageEventInput,
  ): Promise<ProcessNextUserMessageEventResult | undefined> {
    const frontBrain = this.#frontBrain
    if (!frontBrain) {
      throw new Error(
        'MainAgentRuntime has no FrontBrain wired: construct it with one before processing user-message events',
      )
    }
    // Validate local caller input before changing inbox state. Provider
    // failures below deliberately retain their claimed event.
    validateProcessNextUserMessageEventInput(input)
    const event = this.#store.claimNextPendingUserMessageEvent()
    if (!event) return undefined
    if (!event.userMessageId) {
      throw new Error(
        `User-message inbox event ${event.id} has no conversation message to anchor the foreground context on`,
      )
    }
    const messages = composeFrontBrainContext({
      instructions: input.instructions,
      ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}),
      messages: this.#store.readContextThroughMessage(event.userMessageId, input.contextMessageLimit),
    })
    const response = await frontBrain.complete({ messages, maxOutputTokens: input.maxOutputTokens })
    if (!response.text.trim()) {
      throw new Error(
        `FrontBrain returned an empty reply for inbox event ${event.id}; the event stays claimed for explicit recovery`,
      )
    }
    const { message, event: processedEvent } = this.#store.recordProcessedUserMessageEvent({
      eventId: event.id,
      content: response.text,
    })
    return { event: processedEvent, message, response }
  }
}
