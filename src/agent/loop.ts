import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type OpenAI from 'openai'
import type { AgentBackend } from '../backends/AgentBackend.js'
import { CodexBackend } from '../backends/CodexBackend.js'
import { KimiBackend } from '../backends/KimiBackend.js'
import type { Config } from '../config.js'
import { createLlmClient } from '../llm/client.js'
import { SessionReader } from '../sessions/reader.js'
import { Ledger } from '../state/ledger.js'
import { loadMemory } from '../state/memory.js'
import { PinStore } from '../state/pins.js'
import { RunRegistry } from '../state/runs.js'
import { buildSystemPrompt } from './prompt.js'
import { executeTool, toolDefinitions, type ToolContext } from './tools.js'

export type AgentEvent =
  | { type: 'text'; text: string } // assistant 的文字输出（流式或整段均可）
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; ok: boolean; summary: string }
  | { type: 'ask'; question: string; context?: string } // ask_user 触发，UI 层负责拿答案
  | { type: 'error'; message: string }

export interface AgentCoreOptions {
  config: Config
  projectName: string
  askUser: (question: string, context?: string) => Promise<string>
  onEvent: (e: AgentEvent) => void
  /** 测试注入假 LLM；默认 createLlmClient(config)（需要 DEEPSEEK_API_KEY） */
  llm?: OpenAI
  /** 默认 <agents-master>/state/<项目名>/ */
  stateDir?: string
  /** 测试注入假 backend；默认真实 KimiBackend/CodexBackend */
  backends?: { kimi: AgentBackend; codex: AgentBackend }
}

const MAX_ITERATIONS = 40
const MAX_TOOL_RESULT_CHARS = 8000

/** state 目录默认落在 agents-master 仓库内（src/agent/ → 上两级即仓库根） */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function truncateToolResult(text: string, fullPath?: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  const where = fullPath ?? '(无落盘路径)'
  return text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n……[已截断，全文在 ${where}]`
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 200 ? oneLine : oneLine.slice(0, 200) + '…'
}

/** UI 无关的传话 agent 对话循环：OpenAI tool-call loop + 事件回调。 */
export class AgentCore {
  private readonly opts: AgentCoreOptions
  private readonly llm: OpenAI
  private readonly toolCtx: ToolContext
  private readonly messages: OpenAI.Chat.ChatCompletionMessageParam[]

  constructor(opts: AgentCoreOptions) {
    this.opts = opts
    const project = opts.config.projects.find(p => p.name === opts.projectName)
    if (!project) {
      throw new Error(`配置里找不到项目「${opts.projectName}」（config.toml 的 [[projects]]）`)
    }
    const stateDir = opts.stateDir ?? path.join(REPO_ROOT, 'state', project.name)
    const memoryDir = path.join(REPO_ROOT, 'memory')
    this.llm = opts.llm ?? createLlmClient(opts.config)
    this.toolCtx = {
      projectName: project.name,
      projectPath: project.path,
      stateDir,
      memoryDir,
      backends: opts.backends ?? {
        kimi: new KimiBackend(),
        codex: new CodexBackend({ sandboxMode: opts.config.backends.codex.sandbox_mode }),
      },
      runs: new RunRegistry(),
      pins: new PinStore(stateDir),
      ledger: new Ledger(stateDir),
      reader: new SessionReader(stateDir),
      askUser: opts.askUser,
    }
    this.messages = []
    // system prompt 由 memory 拼装（异步），首次 handleUserMessage 前完成
    const messages = this.messages
    this.systemReady = (async () => {
      const memory = await loadMemory(memoryDir)
      const memorySection = memory
        ? `\n\n## 你已积累的经验（memory/）\n\n${memory}`
        : ''
      messages.push({
        role: 'system',
        content: buildSystemPrompt(project.name, project.path) + memorySection,
      })
    })()
  }

  private readonly systemReady: Promise<void>

  /** TUI 等前端读取 runs/pins/reader 等内部状态的只读入口 */
  get context(): ToolContext {
    return this.toolCtx
  }

  async handleUserMessage(text: string): Promise<void> {
    await this.systemReady
    this.messages.push({ role: 'user', content: text })
    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const resp = await this.llm.chat.completions.create({
          model: this.opts.config.llm.model,
          messages: this.messages,
          tools: toolDefinitions,
        })
        const msg = resp.choices[0]?.message
        if (!msg) {
          this.opts.onEvent({ type: 'error', message: 'LLM 返回空 choices' })
          return
        }
        if (msg.content) this.opts.onEvent({ type: 'text', text: msg.content })
        this.messages.push({
          role: 'assistant',
          content: msg.content ?? null,
          tool_calls: msg.tool_calls,
        })
        if (!msg.tool_calls || msg.tool_calls.length === 0) return

        for (const tc of msg.tool_calls) {
          if (tc.type !== 'function') continue
          const name = tc.function.name
          let argsForEvent: unknown
          try {
            argsForEvent = JSON.parse(tc.function.arguments || '{}')
          } catch {
            argsForEvent = tc.function.arguments
          }
          this.opts.onEvent({ type: 'tool_start', name, args: argsForEvent })
          if (name === 'ask_user' && argsForEvent && typeof argsForEvent === 'object') {
            const a = argsForEvent as Record<string, unknown>
            this.opts.onEvent({
              type: 'ask',
              question: String(a.question ?? ''),
              context: typeof a.context === 'string' ? a.context : undefined,
            })
          }
          const { text: result, fullPath } = await executeTool(this.toolCtx, name, tc.function.arguments)
          this.opts.onEvent({
            type: 'tool_end',
            name,
            ok: !result.startsWith('错误'),
            summary: summarize(result),
          })
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateToolResult(result, fullPath),
          })
        }
      }
      this.opts.onEvent({
        type: 'error',
        message: `迭代达到上限 ${MAX_ITERATIONS}，已中止本轮，防止失控`,
      })
    } catch (e) {
      this.opts.onEvent({
        type: 'error',
        message: `loop 异常: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }
}
