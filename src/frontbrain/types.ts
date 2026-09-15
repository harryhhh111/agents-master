/**
 * Stage 1.2b foreground-model boundary. The FrontBrain is deliberately narrow:
 * one non-streaming completion with bounded output and reported telemetry.
 * Nothing here assumes provider caching behavior — cache fields are only
 * surfaced when the provider actually reports them.
 */

export type FrontBrainRole = 'system' | 'user' | 'assistant'

/** Maximum bounded foreground completion size accepted by this runtime. */
export const maxFrontBrainOutputTokens = 8192

export interface FrontBrainMessage {
  role: FrontBrainRole
  content: string
}

export interface FrontBrainRequest {
  /** Fully composed context, stable prefix first. */
  messages: readonly FrontBrainMessage[]
  /** Output cap for this completion: a safe integer from 1 through 8192. */
  maxOutputTokens: number
}

/**
 * Usage as reported by the provider. Cache-related fields stay undefined
 * unless the provider reported them; no caching is assumed or inferred.
 */
export interface FrontBrainUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** Input tokens the provider reports as cache hits (e.g. cached_tokens / prompt_cache_hit_tokens). */
  cachedInputTokens?: number
  /** Input tokens the provider reports as cache misses (e.g. prompt_cache_miss_tokens). */
  uncachedInputTokens?: number
}

export interface FrontBrainResponse {
  text: string
  finishReason?: string
  /** Wall-clock latency in milliseconds, measured around the provider call. */
  latencyMs: number
  usage: FrontBrainUsage
}

export interface FrontBrain {
  complete(request: FrontBrainRequest): Promise<FrontBrainResponse>
}

/* Minimal OpenAI/DeepSeek-compatible wire shapes. Kept narrow and strict so
 * tests can fake the client without pulling in the openai SDK. */

export interface FrontBrainCreateParams {
  model: string
  messages: ReadonlyArray<{ role: FrontBrainRole; content: string }>
  max_tokens: number
  stream: false
  /** Explicitly sent so the provider never spends time on reasoning tokens. */
  thinking: { type: 'disabled' }
}

export interface FrontBrainCompletion {
  choices?: ReadonlyArray<{
    message?: { content?: string | null }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
}

export interface FrontBrainClient {
  chat: {
    completions: {
      create(params: FrontBrainCreateParams): Promise<FrontBrainCompletion>
    }
  }
}
