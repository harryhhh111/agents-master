#!/usr/bin/env tsx
// 前台模型能力探测：对 provider 发三次受控调用 —— 冷启动基线（共用前缀
// + 尾部）、原样保留上一次完整请求记录（含 assistant 回复）的延续轮、以及
// 两轮分叉请求之后复用同一前缀的分支轮；报告延迟与 provider 实际返回的
// usage/cache 遥测。花真钱，仅在明确需要时手动运行：npm run probe:frontbrain
import 'dotenv/config'
import { loadConfig } from '../src/config.js'
import { createFrontBrain, runFrontBrainProbe } from '../src/frontbrain/index.js'
import type { FrontBrainResponse } from '../src/frontbrain/index.js'

const probeInstructions =
  '你是 agents-master 的前台能力探测。保持每条回复在一行以内，不要使用工具。'
const probeCheckpoint = '探测检查点 v1：只报告，不行动。'

function formatUsageLine(label: string, response: FrontBrainResponse): string {
  const u = response.usage
  const tokens = [
    `in=${u.inputTokens ?? '?'}`,
    `out=${u.outputTokens ?? '?'}`,
    `total=${u.totalTokens ?? '?'}`,
  ]
  const cache =
    u.cachedInputTokens !== undefined || u.uncachedInputTokens !== undefined
      ? ` | cache hit=${u.cachedInputTokens ?? '未上报'} miss=${u.uncachedInputTokens ?? '未上报'}`
      : ' | cache: 未上报'
  return `${label}: latency=${response.latencyMs.toFixed(1)}ms | ${tokens.join(' ')}${cache} | finish=${response.finishReason ?? '?'} | text="${response.text.slice(0, 40)}"`
}

const config = loadConfig()
const brain = createFrontBrain(config)
console.log(`model: ${config.llm.model} @ ${config.llm.base_url}`)
const result = await runFrontBrainProbe(brain, {
  instructions: probeInstructions,
  checkpoint: probeCheckpoint,
})
for (const turn of result.turns) {
  console.log(formatUsageLine(turn.phase, turn.response))
}
console.log(
  '说明：三阶段受控探测。baseline=共用前缀+尾部（冷启动参考）；continuation=原样保留上一次完整' +
    '请求记录（含 assistant 回复）并追加新用户轮；common-prefix=两轮分叉请求后复用同一前缀观察其是否仍被缓存。' +
    'cache 命中/未命中值只如实转述 provider 上报，不据此断言任何缓存能力。',
)
