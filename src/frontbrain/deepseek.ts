import type { Config } from '../config.js'
import { createLlmClient } from '../llm/client.js'
import { maxFrontBrainOutputTokens } from './types.js'
import type {
  FrontBrain,
  FrontBrainClient,
  FrontBrainCompletion,
  FrontBrainCreateParams,
  FrontBrainMessage,
  FrontBrainRequest,
  FrontBrainResponse,
  FrontBrainUsage,
} from './types.js'

function providerMessages(messages: readonly FrontBrainMessage[]): FrontBrainCreateParams['messages'] {
  let prefixLength = 0
  while (messages[prefixLength]?.role === 'system') prefixLength += 1
  // DeepSeek receives the stable instructions and checkpoint as one leading
  // system message. Preserve all later conversation messages and caller input.
  if (prefixLength < 2) {
    return messages.map(message => ({ role: message.role, content: message.content }))
  }
  return [
    { role: 'system', content: messages.slice(0, prefixLength).map(message => message.content).join('\n\n') },
    ...messages.slice(prefixLength).map(message => ({ role: message.role, content: message.content })),
  ]
}

function requireMaxOutputTokens(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxFrontBrainOutputTokens) {
    throw new Error(`maxOutputTokens must be an integer between 1 and ${maxFrontBrainOutputTokens}`)
  }
}

function mapUsage(usage: FrontBrainCompletion['usage']): FrontBrainUsage {
  if (!usage) return {}
  const mapped: FrontBrainUsage = {}
  if (typeof usage.prompt_tokens === 'number') mapped.inputTokens = usage.prompt_tokens
  if (typeof usage.completion_tokens === 'number') mapped.outputTokens = usage.completion_tokens
  if (typeof usage.total_tokens === 'number') mapped.totalTokens = usage.total_tokens
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  if (typeof cached === 'number') mapped.cachedInputTokens = cached
  if (typeof usage.prompt_cache_miss_tokens === 'number') {
    mapped.uncachedInputTokens = usage.prompt_cache_miss_tokens
  }
  return mapped
}

export interface DeepSeekFrontBrainOptions {
  /** Any OpenAI-compatible chat client; the real one comes from createFrontBrain. */
  client: FrontBrainClient
  model: string
}

/**
 * Foreground-model implementation for DeepSeek (OpenAI-compatible API).
 * Every call explicitly disables thinking, is non-streaming, and is capped
 * by maxOutputTokens so foreground output stays bounded and fast.
 */
export class DeepSeekFrontBrain implements FrontBrain {
  readonly #client: FrontBrainClient
  readonly #model: string

  constructor(options: DeepSeekFrontBrainOptions) {
    this.#client = options.client
    this.#model = options.model
  }

  async complete(request: FrontBrainRequest): Promise<FrontBrainResponse> {
    requireMaxOutputTokens(request.maxOutputTokens)
    const params: FrontBrainCreateParams = {
      model: this.#model,
      messages: providerMessages(request.messages),
      max_tokens: request.maxOutputTokens,
      stream: false,
      thinking: { type: 'disabled' },
    }
    const startedAt = performance.now()
    // SDK timeout aborts the underlying request; foreground turns must not
    // inherit the SDK's ten-minute timeout and automatic retries.
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 30_000)
    let completion: FrontBrainCompletion
    try {
      completion = await this.#client.chat.completions.create(params, { timeout: 30_000, maxRetries: 0, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('Foreground request deadline exceeded'), { name: 'APIConnectionTimeoutError' })
      throw error
    } finally {
      clearTimeout(deadline)
    }
    const latencyMs = performance.now() - startedAt
    const choice = completion.choices?.[0]
    if (!choice) {
      throw new Error('FrontBrain provider returned no choices')
    }
    return {
      text: choice.message?.content ?? '',
      finishReason: choice.finish_reason ?? undefined,
      latencyMs,
      usage: mapUsage(completion.usage),
    }
  }
}

/** Builds a DeepSeekFrontBrain from config; requires DEEPSEEK_API_KEY in the environment. */
export function createFrontBrain(config: Config): DeepSeekFrontBrain {
  // The openai client accepts extra body fields at runtime, but its static
  // types do not include `thinking`; the cast is confined to this factory.
  return new DeepSeekFrontBrain({
    client: createLlmClient(config) as unknown as FrontBrainClient,
    model: config.llm.model,
  })
}
