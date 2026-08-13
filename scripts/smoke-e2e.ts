// 端到端冒烟：真实 DeepSeek + 真实两个 CLI，跑一条只读传话链。
// askUser 自动回答（仅用于无人值守冒烟），全部事件打到 stdout。
// 用法: tsx scripts/smoke-e2e.ts
import 'dotenv/config'
import { loadConfig } from '../src/config.js'
import { AgentCore, type AgentEvent } from '../src/agent/loop.js'

const TASK =
  '让 Kimi 看一下 stock_data 项目 git log 最近 3 条提交，汇报提交信息；' +
  '然后把 Kimi 的汇报发给 Codex，请它评价这些提交信息的质量；' +
  '最后把 Codex 的评价带回来给我。两个 CLI 都只许读不许改。'

const ev = (e: AgentEvent) => {
  const t = new Date().toISOString().slice(11, 19)
  if (e.type === 'text') console.log(`\n[${t}] AGENT: ${e.text}`)
  else if (e.type === 'tool_start') console.log(`[${t}] TOOL→ ${e.name} ${JSON.stringify(e.args).slice(0, 200)}`)
  else if (e.type === 'tool_end') console.log(`[${t}] TOOL✓ ${e.name} ok=${e.ok} ${e.summary.slice(0, 200)}`)
  else if (e.type === 'ask') console.log(`\n[${t}] ASK: ${e.question}`)
  else console.log(`[${t}] ERROR: ${e.message}`)
}

const core = new AgentCore({
  config: loadConfig(),
  projectName: 'stock_data',
  onEvent: ev,
  askUser: async (question, context) => {
    console.log(`\n>>> 决策点: ${question}\n    背景: ${context ?? '(无)'}\n>>> 自动回答: 批准，继续（只读任务）`)
    return '批准，继续。注意两个 CLI 都只许读不许改。'
  },
})

console.log('任务:', TASK)
await core.handleUserMessage(TASK)
console.log('\n=== 完成 ===')
