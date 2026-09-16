import { composeFrontBrainContext } from './context.js'
import type { FrontBrain, FrontBrainMessage, FrontBrainResponse } from './types.js'

export const probeMaxOutputTokens = 16
export const probeTargetInputTokens = 512
export const probeDefaultSettleMs = 2000
export const probeMaxSettleMs = 30_000

/** Synthetic measurement fixture, NOT a product prompt or real user context.
 * Repeated representative checkpoint sections provide ample stable prefix text.
 * Word/character length is not a token count; only provider usage measures that.
 */
export const probeStablePrefixFixture = [
  'SYNTHETIC CACHE MEASUREMENT FIXTURE v2. Not a product prompt. No real user data.',
  ...Array.from({ length: 12 }, (_, i) =>
    `Checkpoint section ${i + 1}: The fictional project tracks a draft, a review, and a pending decision. ` +
    'Evidence remains separate from assumptions. The user has requested a short status summary. ' +
    'No external action is authorized. Preserve the conversation order and report uncertainty clearly. ' +
    'A fictional colleague will review the draft later; the schedule is unconfirmed. ' +
    'This repeated section is measurement data only. Reply briefly to the final user message.',
  ),
].join('\n')

const probeTails = {
  warmup: '能力探测：只需回复一个词"收到"。',
  continuation: '能力探测续：再回复一个词"完成"。',
  detection: '能力探测预热分支：只回复一个词"好"。',
  branch: '能力探测分支：再回复一个词"继续"。',
} as const

export interface FrontBrainProbeInput {
  instructions: string
  checkpoint?: string
  /** Integer milliseconds in [0, 30000]; default 2000. */
  settleMs?: number
  /** Injectable so fake tests never sleep. Called once after all three warm-ups. */
  sleep?: (ms: number) => Promise<void>
}

export type FrontBrainProbePhase =
  | 'warmup-initial' | 'warmup-repeat' | 'warmup-prefix-detection' | 'measurement-continuation' | 'measurement-common-prefix'

export interface FrontBrainProbeTurn {
  phase: FrontBrainProbePhase
  /** Provider response with telemetry, reported as-is. */
  response: FrontBrainResponse
}

export interface FrontBrainProbeResult {
  maxOutputTokens: number
  targetInputTokens: number
  settleMs: number
  turns: readonly FrontBrainProbeTurn[]
}

export function validateProbeSettleMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > probeMaxSettleMs) {
    throw new Error(`settle-ms must be a nonnegative integer between 0 and ${probeMaxSettleMs}`)
  }
  return value
}

/** Two identical warm-ups plus a divergent prefix-detection warm-up, then
 * settling and two measured shapes.
 * Neither warm-up is assumed cold; persistence and cache hits are best-effort.
 * Explicit opt-in with real providers; fully fake-testable without networking.
 */
export async function runFrontBrainProbe(
  brain: FrontBrain,
  input: FrontBrainProbeInput,
): Promise<FrontBrainProbeResult> {
  const settleMs = validateProbeSettleMs(input.settleMs ?? probeDefaultSettleMs)
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const prefix = [
    ...composeFrontBrainContext({ instructions: input.instructions, checkpoint: input.checkpoint }),
    { role: 'system' as const, content: probeStablePrefixFixture },
  ]
  const warmupMessages: FrontBrainMessage[] = [
    ...prefix, { role: 'user', content: probeTails.warmup },
  ]
  const turns: FrontBrainProbeTurn[] = []
  async function call(phase: FrontBrainProbePhase, messages: FrontBrainMessage[]) {
    const response = await brain.complete({ messages, maxOutputTokens: probeMaxOutputTokens })
    turns.push({ phase, response })
    return response
  }
  await call('warmup-initial', warmupMessages)
  const repeated = await call('warmup-repeat', warmupMessages)
  await call('warmup-prefix-detection', [...prefix, { role: 'user', content: probeTails.detection }])
  if (settleMs > 0) await sleep(settleMs)
  await call('measurement-continuation', [
    ...warmupMessages,
    { role: 'assistant', content: repeated.text },
    { role: 'user', content: probeTails.continuation },
  ])
  await call('measurement-common-prefix', [...prefix, { role: 'user', content: probeTails.branch }])
  return { maxOutputTokens: probeMaxOutputTokens, targetInputTokens: probeTargetInputTokens, settleMs, turns }
}
