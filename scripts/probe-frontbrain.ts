#!/usr/bin/env tsx
// Explicit opt-in paid measurement; importing helpers never starts the probe.
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config.js'
import { createFrontBrain, runFrontBrainProbe, probeDefaultSettleMs, probeTargetInputTokens, validateProbeSettleMs } from '../src/frontbrain/index.js'
import type { FrontBrainResponse } from '../src/frontbrain/index.js'

const probeInstructions =
  '你是 agents-master 的前台能力探测。保持每条回复在一行以内，不要使用工具。'
const probeCheckpoint = '探测检查点 v1：只报告，不行动。'

export function formatUsageLine(label: string, response: FrontBrainResponse): string {
  const u = response.usage
  const target = u.inputTokens === undefined ? 'unknown' : u.inputTokens < probeTargetInputTokens ? 'below target' : 'at target (or above)'
  const tokens = [
    `in=${u.inputTokens ?? '?'}`,
    `out=${u.outputTokens ?? '?'}`,
    `total=${u.totalTokens ?? '?'}`,
  ]
  const cache =
    u.cachedInputTokens !== undefined || u.uncachedInputTokens !== undefined
      ? ` | cache hit=${u.cachedInputTokens ?? '未上报'} miss=${u.uncachedInputTokens ?? '未上报'}`
      : ' | cache: 未上报'
  return `${label}: latency=${response.latencyMs.toFixed(1)}ms | ${tokens.join(' ')} | input-target=${probeTargetInputTokens}: ${target}${cache} | finish=${response.finishReason ?? '?'} | text="${response.text.slice(0, 40)}"`
}

export function parseProbeArgs(args: readonly string[]): { settleMs: number } {
  if (args.length === 0) return { settleMs: probeDefaultSettleMs }
  if (args.length !== 2 || args[0] !== '--settle-ms' || !/^[0-9]+$/.test(args[1])) {
    throw new Error('Usage: probe-frontbrain [--settle-ms INTEGER (0..30000)]')
  }
  return { settleMs: validateProbeSettleMs(Number(args[1])) }
}

async function main() {
  const options = parseProbeArgs(process.argv.slice(2))
  await import('dotenv/config')
  const config = loadConfig()
  const brain = createFrontBrain(config)
  console.log(`model: ${config.llm.model} @ ${config.llm.base_url}`)
  const result = await runFrontBrainProbe(brain, {
    instructions: probeInstructions,
    checkpoint: probeCheckpoint,
    ...options,
  })
  console.log(`settle-ms=${result.settleMs} | target-input-tokens=${result.targetInputTokens}`)
  for (const turn of result.turns) console.log(formatUsageLine(turn.phase, turn.response))
  console.log('Two identical warm-ups, divergent prefix-detection warm-up, settle, true continuation, then common-prefix branch. ' +
    'Synthetic measurement fixture, not a product prompt. Input counts are provider-reported; ' +
    'unknown/below-target counts are insufficient size evidence. Cache results are observations, not guarantees.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
