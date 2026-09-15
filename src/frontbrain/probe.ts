import { composeFrontBrainContext, type FrontBrainContextInput } from './context.js'
import type { FrontBrain, FrontBrainMessage, FrontBrainResponse } from './types.js'

/** Keeps every probe call cheap; only for capability measurement, not real turns. */
export const probeMaxOutputTokens = 16

/**
 * Fixed short tails, all distinct: the baseline and branch tails diverge
 * after the shared prefix, the continuation tail is a new appended user turn.
 */
const probeTails = {
  baseline: '能力探测：只需回复一个词"收到"。',
  continuation: '能力探测续：再回复一个词"完成"。',
  branch: '能力探测分支：再回复一个词"继续"。',
} as const

export interface FrontBrainProbeInput {
  instructions: string
  checkpoint?: string
}

/** What each controlled probe call measures; printed verbatim by the CLI. */
export type FrontBrainProbePhase = 'baseline' | 'continuation' | 'common-prefix'

export interface FrontBrainProbeTurn {
  phase: FrontBrainProbePhase
  /** Provider response with telemetry, reported as-is. */
  response: FrontBrainResponse
}

export interface FrontBrainProbeResult {
  maxOutputTokens: number
  /** Ordered by call sequence; each turn carries its own accurate phase label. */
  turns: readonly FrontBrainProbeTurn[]
}

/**
 * Explicit opt-in capability probe: three controlled calls.
 *
 * 1. `baseline`: shared prefix (instructions + optional checkpoint) with a
 *    short tail — the cold reference for latency and uncached usage.
 * 2. `continuation`: a true continuation that retains the exact prior request
 *    transcript, including the baseline assistant response, and appends one
 *    new user turn. This is the shape providers cache per-turn.
 * 3. `common-prefix`: after the two divergent requests, the same shared
 *    prefix with a different tail, to observe whether the prefix bytes still
 *    hit cache after a divergent branch.
 *
 * Latency and whatever usage/cache telemetry the provider reports are
 * returned without asserting hit/miss or drawing any capability conclusion.
 * Costs money when run against a real provider, so it is only invoked from
 * scripts/probe-frontbrain.ts — never from unit tests.
 */
export async function runFrontBrainProbe(
  brain: FrontBrain,
  input: FrontBrainProbeInput,
): Promise<FrontBrainProbeResult> {
  const contextInput: FrontBrainContextInput = {
    instructions: input.instructions,
    checkpoint: input.checkpoint,
    messages: [],
  }
  const prefix = composeFrontBrainContext(contextInput)

  // 1. baseline: shared prefix + divergent tail, cold.
  const baselineMessages: FrontBrainMessage[] = [
    ...prefix,
    { role: 'user', content: probeTails.baseline },
  ]
  const baseline = await brain.complete({
    messages: baselineMessages,
    maxOutputTokens: probeMaxOutputTokens,
  })

  // 2. continuation: the exact prior request transcript — including the
  // assistant response — retained verbatim, with one new user turn appended.
  const continuation = await brain.complete({
    messages: [
      ...baselineMessages,
      { role: 'assistant', content: baseline.text },
      { role: 'user', content: probeTails.continuation },
    ],
    maxOutputTokens: probeMaxOutputTokens,
  })

  // 3. common-prefix: after the two divergent requests, reuse only the shared
  // prefix with a new divergent tail to observe prefix persistence.
  const commonPrefix = await brain.complete({
    messages: [...prefix, { role: 'user', content: probeTails.branch }],
    maxOutputTokens: probeMaxOutputTokens,
  })

  return {
    maxOutputTokens: probeMaxOutputTokens,
    turns: [
      { phase: 'baseline', response: baseline },
      { phase: 'continuation', response: continuation },
      { phase: 'common-prefix', response: commonPrefix },
    ],
  }
}
