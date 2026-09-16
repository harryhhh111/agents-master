import type {
  MainAgentRuntimePort,
  ProcessNextUserMessageEventInput,
  ProcessNextUserMessageEventResult,
  ReceiveUserMessageInput,
  ReceiveUserMessageResult,
} from './types.js'

/**
 * Stable Stage 1.2c prefix. Keep this text byte-stable unless the product
 * contract changes: it is deliberately the first provider-visible context.
 */
export const defaultMainAgentInstructions = [
  '你是 agents-master 的主 Agent。自然理解用户的话，并用简短、直接的中文回答。',
  '信息不足时先澄清，不要猜测。',
  '当前你不能创建或写入任务、记忆或认识，也不能执行外部动作、联系他人或声称已经完成这些事。',
  '可以说明限制、整理用户已说的信息，并提出下一步需要用户确认的内容。',
].join('\n')

/** Optional fixed checkpoint for the first terminal-chat slice. */
export const defaultMainAgentCheckpoint = 'Stage 1.2c 检查点：只进行自然对话；不调用工具，不执行外部动作。'

export const defaultMainConversationId = 'main'

export interface ForegroundHostOptions {
  conversationId?: string
  instructions?: string
  checkpoint?: string
  maxOutputTokens?: number
  contextMessageLimit?: number
  onEvent?: (event: ForegroundHostEvent) => void
}

export interface SubmitForegroundMessageInput {
  content: string
  /** Caller-generated durable idempotency key, normally a UUID from the UI. */
  idempotencyKey: string
  priority?: ReceiveUserMessageInput['priority']
  receivedAt?: string
}

export type ForegroundHostEvent =
  | { type: 'submitted'; result: ReceiveUserMessageResult }
  | { type: 'reply'; result: ProcessNextUserMessageEventResult }
  | { type: 'error'; error: unknown }
  | { type: 'recovered'; source: 'startup' | 'explicit'; count: number }

/**
 * The foreground serialiser between a UI and MainAgentRuntime.
 *
 * receiveUserMessage is intentionally called synchronously by submit(), so a
 * line has reached the durable inbox before any provider work begins. The
 * drain is single-flight. A failed foreground turn leaves its event claimed
 * and blocks further foreground processing until recover() is explicitly
 * requested; later UI input can still be admitted safely during that time.
 */
export class MainAgentForegroundHost {
  readonly #runtime: MainAgentRuntimePort
  readonly #conversationId: string
  readonly #processInput: ProcessNextUserMessageEventInput
  readonly #onEvent: (event: ForegroundHostEvent) => void
  #drainPromise: Promise<void> | undefined
  #drainRequested = false
  #blockedByFailure = false
  #started = false

  constructor(runtime: MainAgentRuntimePort, options: ForegroundHostOptions = {}) {
    this.#runtime = runtime
    this.#conversationId = options.conversationId ?? defaultMainConversationId
    this.#processInput = {
      instructions: options.instructions ?? defaultMainAgentInstructions,
      ...(options.checkpoint === undefined
        ? { checkpoint: defaultMainAgentCheckpoint }
        : options.checkpoint ? { checkpoint: options.checkpoint } : {}),
      maxOutputTokens: options.maxOutputTokens ?? 512,
      contextMessageLimit: options.contextMessageLimit ?? 20,
    }
    this.#onEvent = options.onEvent ?? (() => {})
  }

  /** Scoped startup recovery; claimed timer/domain events are never touched. */
  start(): number {
    if (this.#started) return 0
    this.#started = true
    const count = this.#runtime.recoverClaimedUserMessageEvents()
    this.#emit({ type: 'recovered', source: 'startup', count })
    this.#startDrain()
    return count
  }

  /**
   * Synchronously persists the user message, then starts (or joins) the
   * asynchronous single-flight drain. This method deliberately never awaits
   * model work, so a readline handler remains receptive while a turn flies.
   */
  submit(input: SubmitForegroundMessageInput): ReceiveUserMessageResult {
    const result = this.#runtime.receiveUserMessage({
      conversationId: this.#conversationId,
      idempotencyKey: input.idempotencyKey,
      content: input.content,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
    })
    this.#emit({ type: 'submitted', result })
    this.#startDrain()
    return result
  }

  /** Retry a failed, idle drain; undefined means no recovery was performed. */
  recover(): number | undefined {
    if (!this.#blockedByFailure || this.#drainPromise) return undefined
    const count = this.#runtime.recoverClaimedUserMessageEvents()
    this.#blockedByFailure = false
    this.#emit({ type: 'recovered', source: 'explicit', count })
    this.#startDrain()
    return count
  }

  /** Test/UI seam: resolves after the current serial drain, if any, is idle. */
  async waitForIdle(): Promise<void> {
    while (this.#drainPromise) await this.#drainPromise
  }

  #startDrain(): void {
    // A submit can arrive while an earlier empty drain is resolving. Retain
    // this bit so that drain observes the new durable event before it exits.
    this.#drainRequested = true
    if (this.#blockedByFailure || this.#drainPromise) return
    this.#drainPromise = this.#drain().finally(() => {
      this.#drainPromise = undefined
      if (this.#drainRequested && !this.#blockedByFailure) this.#startDrain()
    })
  }

  async #drain(): Promise<void> {
    while (!this.#blockedByFailure) {
      this.#drainRequested = false
      try {
        const result = await this.#runtime.processNextUserMessageEvent(this.#processInput)
        if (!result) {
          if (this.#drainRequested) continue
          return
        }
        this.#emit({ type: 'reply', result })
      } catch (error) {
        // Do not loop: Runtime deliberately leaves this user event claimed.
        // Only recover() is allowed to return it to pending for another call.
        this.#blockedByFailure = true
        this.#emit({ type: 'error', error })
        return
      }
    }
  }

  #emit(event: ForegroundHostEvent): void {
    this.#onEvent(event)
  }
}
