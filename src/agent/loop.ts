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
import { RunRegistry, type RunRecord } from '../state/runs.js'
import { buildSystemPrompt } from './prompt.js'
import { executeTool, toolDefinitions, type ToolContext } from './tools.js'

export type AgentEvent =
  | { type: 'text'; text: string } // assistant 的文字输出（流式或整段均可）
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; ok: boolean; summary: string }
  | { type: 'ask'; question: string; context?: string } // ask_user 触发，UI 层负责拿答案
  | { type: 'run_done'; runId: string; backend: string; exitCode?: number; error?: string } // 后台任务完成自动注入
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

// check_run 默认兜底 5 分钟/次，120 次迭代足以覆盖小时级任务
const MAX_ITERATIONS = 120
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
    // run 完成自动注入：进程退出 → 通知进对话流 → 若当前不在回合里就叫醒一个新回合
    this.toolCtx.runs.onDone(record => this.onRunDone(record))
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
  /** 回合串行化：用户消息和 run 完成注入共用一条链，永不并发跑两个 loop */
  private turnChain: Promise<void> = Promise.resolve()
  private inLoop = false
  /** loop 进行中到达的消息（run 完成通知 / 用户插话）：排队到安全点再入 messages。
   * 安全点 = 一轮 tool 响应全部入列之后。直接在 tool 调用中途插入 user 消息会
   * 破坏 "assistant(tool_calls) 后必须紧跟 tool 响应" 的 API 约束（400）。 */
  private pendingNotices: string[] = []

  /** TUI 等前端读取 runs/pins/reader 等内部状态的只读入口 */
  get context(): ToolContext {
    return this.toolCtx
  }

  async handleUserMessage(text: string): Promise<void> {
    await this.systemReady
    if (this.inLoop) {
      // 用户随时插话：不中断进行中的 tool 轮次，排队到安全点吸收
      this.pendingNotices.push(text)
      return
    }
    this.messages.push({ role: 'user', content: text })
    return this.enqueueTurn()
  }

  private enqueueTurn(): Promise<void> {
    const turn = this.turnChain.then(() => this.runLoop())
    // 链本身永不 reject（runLoop 内部已把异常转成 error 事件），但调用方要拿到自己的回合
    this.turnChain = turn.catch(() => undefined)
    return turn
  }

  /** run 完成：通知注入 messages；若不在回合中则叫醒一个新回合让 agent 处理 */
  private onRunDone(record: RunRecord): void {
    const r = record.result
    const notice =
      `[后台任务完成] ${record.backend} run ${record.runId}：` +
      `exitCode=${r?.exitCode ?? '(无)'}，耗时 ${r?.durationMs ?? '?'}ms` +
      (r?.sessionId ? `，session=${r.sessionId}` : '') +
      (r?.warnings?.length ? `，warnings=${r.warnings.join('；')}` : '') +
      (record.error ? `，error=${record.error}` : '') +
      `。artifact: ${record.handle.artifactStdoutPath}` +
      `。当时派发的 prompt 开头：${record.prompt.slice(0, 100)}……` +
      `。请验收结果、继续传话链或向用户汇报；如果你在本回合已经通过 check_run 处理过这次完成，忽略本通知，不要重复汇报。`
    this.opts.onEvent({
      type: 'run_done',
      runId: record.runId,
      backend: record.backend,
      exitCode: r?.exitCode,
      error: record.error,
    })
    if (this.inLoop) {
      // loop 会在安全点 flush
      this.pendingNotices.push(notice)
    } else {
      this.messages.push({ role: 'user', content: notice })
      void this.enqueueTurn()
    }
  }

  private flushNotices(): void {
    for (const n of this.pendingNotices) {
      this.messages.push({ role: 'user', content: n })
    }
    this.pendingNotices = []
  }

  private async runLoop(): Promise<void> {
    await this.systemReady
    this.inLoop = true
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
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          // 纯文本收尾前，若期间有 run 完成通知排队，flush 后再走一轮让 agent 处理
          if (this.pendingNotices.length > 0) {
            this.flushNotices()
            continue
          }
          return
        }

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
        // 安全点：本轮全部 tool 响应已入列，flush 排队中的 run 完成通知
        this.flushNotices()
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
    } finally {
      this.inLoop = false
    }
  }
}
