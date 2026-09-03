// 传话回测：真实 DeepSeek + 真 system prompt + 真 toolDefinitions，但工具执行层是假的。
// 把 tests/backtest-cases.json 里每个历史传话事件的"当时到达的内容"喂给 agent，
// 记录它发起的全部工具调用和文字输出，与 expect（用户当年的实际动作）对比。
// r2：每个用例可带 git_status 字段，假 git_status 按该用例历史时刻的 repo 状态返回，
// 避免固定假数据与情境矛盾干扰 agent 行为；用例没提供时用默认值。
// 用法: tsx scripts/backtest.ts [用例名子串过滤...]
import 'dotenv/config'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type OpenAI from 'openai'
import { loadConfig } from '../src/config.js'
import { createLlmClient } from '../src/llm/client.js'
import { buildSystemPrompt } from '../src/agent/prompt.js'
import { toolDefinitions } from '../src/agent/tools.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_ITERATIONS = 15

interface GitStatusFixture {
  branch: string
  dirtyFiles: number
  unpushedCommits: number
  recentCommits: string[]
}

interface BacktestCase {
  name: string
  source: string
  situation: string
  /** r2：该用例历史时刻的 git 状态；缺省时用 DEFAULT_GIT_STATUS */
  git_status?: GitStatusFixture
  expect: {
    classification: string
    action: 'forward_full' | 'ask_user' | 'report_only'
    forward_to?: 'kimi' | 'codex'
    must_contain: string[]
    user_did: string
  }
}

const DEFAULT_GIT_STATUS: GitStatusFixture = {
  branch: 'main',
  dirtyFiles: 2,
  unpushedCommits: 3,
  recentCommits: ['04cb111 fix(p1): 版本层语义修复', '9ad56b0 feat(p1): 双写骨架', 'e6cbd9c fix(p0): 缓存口径'],
}

interface Step {
  kind: 'tool' | 'text'
  name?: string
  args?: string
  text?: string
}

interface CaseResult {
  c: BacktestCase
  steps: Step[]
  iterations: number
  error?: string
}

/** 假工具执行层：全部返回固定假结果，ask_user 只记录不回答。 */
function fakeTool(c: BacktestCase, name: string, argsJson: string): string {
  let args: Record<string, unknown> = {}
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
  } catch {
    return `错误: 工具参数不是合法 JSON: ${argsJson}`
  }
  switch (name) {
    case 'run_kimi':
    case 'run_codex':
      return JSON.stringify({ runId: `fake-${name === 'run_kimi' ? 'kimi' : 'codex'}-001`, note: '已启动（回测假结果，不会有完成通知）' })
    case 'check_run':
      return JSON.stringify({ status: 'done', exitCode: 0, artifactTail: '（回测假结果）' })
    case 'read_session_updates':
      return JSON.stringify({ messages: [], note: '回测假结果：无更多新消息' })
    case 'read_artifact':
      return '（回测假结果：文件存在，内容略）'
    case 'git_status':
      return JSON.stringify(c.git_status ?? DEFAULT_GIT_STATUS)
    case 'ask_user':
      return '（回测模式：用户暂不在线，问题已记录。不要替用户拍板，结束本回合等待用户回答。）'
    case 'update_ledger':
      return '已记录到台账'
    case 'propose_memory':
      return '已写入 memory: memory/backtest-fake.md（回测假结果）'
    default:
      return `错误: 未知工具 ${name}`
  }
}

async function runCase(llm: OpenAI, model: string, systemPrompt: string, c: BacktestCase): Promise<CaseResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: c.situation },
  ]
  const steps: Step[] = []
  let iterations = 0
  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      iterations = i + 1
      const resp = await llm.chat.completions.create({ model, messages, tools: toolDefinitions })
      const msg = resp.choices[0]?.message
      if (!msg) throw new Error('LLM 返回空 choices')
      messages.push(msg)
      if (msg.content?.trim()) steps.push({ kind: 'text', text: msg.content })
      if (!msg.tool_calls?.length) break
      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue
        steps.push({ kind: 'tool', name: tc.function.name, args: tc.function.arguments })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: fakeTool(c, tc.function.name, tc.function.arguments) })
      }
    }
  } catch (e) {
    return { c, steps, iterations, error: e instanceof Error ? e.message : String(e) }
  }
  return { c, steps, iterations }
}

/** 从 run_* 调用的 args JSON 里取 prompt 字段 */
function promptOf(argsJson: string | undefined): string {
  if (!argsJson) return ''
  try {
    return String((JSON.parse(argsJson) as Record<string, unknown>).prompt ?? '')
  } catch {
    return argsJson
  }
}

function evaluate(r: CaseResult) {
  const { c, steps } = r
  const tools = steps.filter(s => s.kind === 'tool')
  const forwardCalls = tools.filter(s => s.name === 'run_kimi' || s.name === 'run_codex')
  const askCalls = tools.filter(s => s.name === 'ask_user')
  const ledgerKinds = tools
    .filter(s => s.name === 'update_ledger')
    .map(s => {
      try {
        return String((JSON.parse(s.args ?? '{}') as Record<string, unknown>).kind ?? '')
      } catch {
        return ''
      }
    })
    .filter(Boolean)

  // 动作判定 + must_contain 校验对象
  let actionOk = false
  let target = ''
  if (c.expect.action === 'forward_full') {
    const call = forwardCalls.find(s => s.name === `run_${c.expect.forward_to}`)
    actionOk = !!call
    target = promptOf(call?.args)
  } else if (c.expect.action === 'ask_user') {
    actionOk = askCalls.length > 0
    target = askCalls.map(s => s.args ?? '').join('\n')
  } else {
    actionOk = forwardCalls.length === 0
    target = steps.filter(s => s.kind === 'text').map(s => s.text ?? '').join('\n')
  }
  const mustResults = c.expect.must_contain.map(s => ({ s, ok: target.includes(s) }))

  // 越权检测：该问用户的用例里，agent 是否擅自转发/派活
  const overreach = c.expect.action === 'ask_user' && forwardCalls.length > 0

  return { actionOk, mustResults, ledgerKinds, forwardCalls, askCalls, overreach }
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `……[截断，共 ${s.length} 字]`
}

function renderMd(results: CaseResult[]): string {
  const lines: string[] = []
  lines.push('# 传话回测结果 r2（2026-08-13，DeepSeek deepseek-v4-flash，修订版 system prompt）')
  lines.push('')
  lines.push('> 方法：tests/backtest-cases.json 的 8 个真实历史传话事件，真 DeepSeek + 修订版 system prompt')
  lines.push('>（buildSystemPrompt，含"转发评审是搬运不是拍板"等 7 处修订）+ 真 toolDefinitions，')
  lines.push('> 假工具执行层（scripts/backtest.ts）。r2 起每个用例自带 git_status 假数据，')
  lines.push('> 与该用例历史时刻的 repo 状态一致，排除 r1 中固定假 git 数据的干扰。')
  lines.push('> 每个用例 = system prompt + 一条 user 消息（情境+当时到达的原文），loop 到无 tool_calls 或 15 轮上限。')
  lines.push('> r1 报告见 backtest-results-2026-08-13.md。')
  lines.push('')
  for (const r of results) {
    const ev = evaluate(r)
    lines.push(`## ${r.c.name}`)
    lines.push('')
    lines.push(`- 来源：${r.c.source}`)
    lines.push(`- 期望：分类=${r.c.expect.classification}，动作=${r.c.expect.action}${r.c.expect.forward_to ? ` → ${r.c.expect.forward_to}` : ''}`)
    lines.push(`- 实际动作序列（${r.iterations} 轮 LLM 调用）：`)
    for (const s of r.steps) {
      if (s.kind === 'tool') {
        const brief = s.name === 'run_kimi' || s.name === 'run_codex' ? trunc(promptOf(s.args), 120) : trunc(s.args ?? '', 200)
        lines.push(`  - TOOL ${s.name}: ${brief}`)
      } else {
        lines.push(`  - TEXT: ${trunc((s.text ?? '').replace(/\n+/g, ' '), 300)}`)
      }
    }
    if (r.error) lines.push(`  - ERROR: ${r.error}`)
    lines.push(`- 台账分类（update_ledger kind）：${ev.ledgerKinds.join(', ') || '（未记台账）'}`)
    const fwd = ev.forwardCalls[0]
    if (fwd) {
      lines.push('')
      lines.push(`转发 prompt 全文（${fwd.name}）：`)
      lines.push('')
      lines.push('```')
      lines.push(promptOf(fwd.args))
      lines.push('```')
    }
    if (ev.askCalls.length > 0) {
      lines.push('')
      lines.push('ask_user 内容：')
      lines.push('')
      lines.push('```')
      lines.push(ev.askCalls.map(s => s.args ?? '').join('\n---\n'))
      lines.push('```')
    }
    lines.push('')
    lines.push(`must_contain 校验（${ev.mustResults.filter(m => m.ok).length}/${ev.mustResults.length}）：`)
    for (const m of ev.mustResults) lines.push(`  - ${m.ok ? '✓' : '✗'} ${m.s}`)
    lines.push(`- 动作判定：${ev.actionOk ? '✓ 符合预期' : '✗ 不符合预期'}${ev.overreach ? '；⚠️ 越权：该问用户的场景擅自派活/转发' : ''}`)
    lines.push(`- 用户当年实际动作：${r.c.expect.user_did}`)
    lines.push('')
    lines.push('点评：<!-- REVIEW -->')
    lines.push('')
  }
  lines.push('## 总评（r1 → r2 对比）')
  lines.push('')
  lines.push('<!-- SUMMARY -->')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  // --tag r3：输出文件名改为 backtest-results-r3-*.md/json，默认 r2
  const tagIdx = argv.indexOf('--tag')
  const tag = tagIdx >= 0 ? argv[tagIdx + 1] : null
  const filters = argv.filter((a, i) => a !== '--tag' && i !== tagIdx + 1)
  const cases = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, 'tests/backtest-cases.json'), 'utf8'),
  ) as BacktestCase[]
  const selected = filters.length ? cases.filter(c => filters.some(f => c.name.includes(f))) : cases
  if (!selected.length) throw new Error('没有用例命中过滤条件')

  const config = loadConfig()
  const llm = createLlmClient(config)
  const systemPrompt = buildSystemPrompt('stock_data', '/home/vinci/projects/stock_data')

  console.log(`回测 ${selected.length}/${cases.length} 个用例，模型 ${config.llm.model}`)
  const results: CaseResult[] = []
  for (const c of selected) {
    console.log(`\n=== ${c.name} ===`)
    const r = await runCase(llm, config.llm.model, systemPrompt, c)
    results.push(r)
    for (const s of r.steps) {
      console.log(s.kind === 'tool' ? `  TOOL ${s.name} ${trunc(s.args ?? '', 150)}` : `  TEXT ${trunc(s.text ?? '', 200)}`)
    }
    if (r.error) console.log(`  ERROR: ${r.error}`)
    const ev = evaluate(r)
    console.log(`  → 动作${ev.actionOk ? '✓' : '✗'} must_contain ${ev.mustResults.filter(m => m.ok).length}/${ev.mustResults.length}${ev.overreach ? ' ⚠️越权' : ''}`)
  }

  const mdPath = path.join(REPO_ROOT, `docs/handoff-analysis/backtest-results-${tag ?? 'r2'}-2026-08-13.md`)
  await fs.writeFile(mdPath, renderMd(results))
  const rawPath = path.join(REPO_ROOT, `docs/handoff-analysis/backtest-raw-${tag ?? 'r2'}-2026-08-13.json`)
  await fs.writeFile(rawPath, JSON.stringify(results, null, 2))
  console.log(`\n结果已写入 ${mdPath}\n原始记录 ${rawPath}`)
}

await main()
