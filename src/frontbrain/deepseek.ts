import type { Config } from '../config.js'
import { createLlmClient } from '../llm/client.js'
import { maxFrontBrainOutputTokens } from './types.js'
import type {
  FrontBrain,
  FrontBrainClient,
  FrontBrainCompletion,
  FrontBrainCreateParams,
  FrontBrainRequest,
  FrontBrainResponse,
  FrontBrainUsage,
} from './types.js'

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
      messages: request.messages.map(message => ({ role: message.role, content: message.content })),
      max_tokens: request.maxOutputTokens,
      stream: false,
      thinking: { type: 'disabled' },
    }
    const startedAt = performance.now()
    const completion = await this.#client.chat.completions.create(params)
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
