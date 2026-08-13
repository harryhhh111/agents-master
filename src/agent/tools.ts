import { promises as fs } from 'node:fs'
import { execa } from 'execa'
import type OpenAI from 'openai'
import type { AgentBackend } from '../backends/AgentBackend.js'
import { findCodexSessionFile, findKimiSessionFile } from '../sessions/discovery.js'
import { parseCodexChunk } from '../sessions/codexParser.js'
import { parseKimiChunk } from '../sessions/kimiParser.js'
import type { SessionReader } from '../sessions/reader.js'
import type { SessionMessage } from '../sessions/types.js'
import type { Ledger } from '../state/ledger.js'
import type { CliName, PinStore } from '../state/pins.js'
import type { RunRegistry } from '../state/runs.js'

/** 工具执行需要的全部上下文，由 loop 组装注入（测试可整体替换）。 */
export interface ToolContext {
  projectName: string
  projectPath: string
  stateDir: string
  /** 全局 memory/ 目录（经验沉淀，跨项目共享） */
  memoryDir: string
  backends: Record<CliName, AgentBackend>
  runs: RunRegistry
  pins: PinStore
  ledger: Ledger
  reader: SessionReader
  askUser: (question: string, context?: string) => Promise<string>
}

export interface ToolResult {
  /** 回给模型的文本（JSON 字符串或错误信息） */
  text: string
  /** 大内容的落盘路径，供 loop 截断时注明"全文在哪" */
  fullPath?: string
}

export const toolDefinitions: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'run_kimi',
      description:
        '给 Kimi Code 派活/传话：detach 模式启动，立即返回 runId 和 artifact 路径，' +
        '长任务用 check_run 轮询。如有钉住的 session 会自动续接。',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string', description: '发给 Kimi 的完整 prompt' } },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_codex',
      description:
        '给 codex-cli 派活/传话：detach 模式启动，立即返回 runId 和 artifact 路径，' +
        '长任务用 check_run 轮询。如有钉住的 session 会自动续接。',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string', description: '发给 Codex 的完整 prompt' } },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_run',
      description:
        '查询 run_kimi/run_codex 启动的后台任务状态。进程一结束会立即返回（事件唤醒），' +
        'wait_ms 只是任务未结束时的兜底等待：默认 300000（5 分钟），上限 600000（10 分钟）。' +
        '任务未结束时不要密集调用，安心等。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'run_kimi/run_codex 返回的 runId' },
          wait_ms: { type: 'number', description: '兜底等待毫秒数，默认 300000，上限 600000' },
        },
        required: ['runId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session_updates',
      description:
        '增量读取某 CLI 的会话新消息。who=user 的消息带 origin 标注：' +
        'agent=你代发的，human=用户亲自介入（最高优先级输入，必须立即吸收）；' +
        'kind=notification 是后台任务通知，不是用户输入。',
      parameters: {
        type: 'object',
        properties: { cli: { type: 'string', enum: ['kimi', 'codex'] } },
        required: ['cli'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_artifact',
      description: '读 artifact 文件，默认只回末尾 200 行防超长；需要更多再调大 tail。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'artifact 文件绝对路径' },
          tail: { type: 'number', description: '只返回末尾多少行，默认 200' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '只读核实项目工作区：分支、脏文件数、未 push 提交数、最近 5 条 log。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '决策点：停下来问用户，拿到回答再继续。宁可多问不可擅断。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题' },
          context: { type: 'string', description: '背景信息（发生了什么、你的核实结果）' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_ledger',
      description: '追加传话台账：每次重要传话后记录方向、类型、摘要、锚点、待决项。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: '如 user->kimi、kimi->codex、codex->user' },
          kind: {
            type: 'string',
            description:
              'task_assignment / review_feedback / completion_report / doc_pointer / acceptance_request / user_decision',
          },
          summary: { type: 'string', description: '一句话摘要' },
          anchors: { type: 'array', items: { type: 'string' }, description: '可核查锚点：commit sha、产物路径、文档路径' },
          pending: { type: 'array', items: { type: 'string' }, description: '待决问题' },
        },
        required: ['direction', 'kind', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_memory',
      description:
        '任务结束后提议沉淀一条经验。必须先用 ask_user 获得用户批准，再调此工具落盘。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '经验标题（用于文件名）' },
          content: { type: 'string', description: '经验正文（markdown）' },
        },
        required: ['title', 'content'],
      },
    },
  },
]

const ARTIFACT_TAIL_CHARS = 2000
const DEFAULT_ARTIFACT_TAIL_LINES = 200

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

async function tailChars(filePath: string, chars: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return content.length <= chars ? content : content.slice(-chars)
  } catch {
    return '(artifact 暂不可读)'
  }
}

async function runBackend(ctx: ToolContext, cli: CliName, prompt: string): Promise<ToolResult> {
  const backend = ctx.backends[cli]
  const pin = await ctx.pins.getPin(ctx.projectName, cli)
  const handle = backend.runDetached(prompt, {
    cwd: ctx.projectPath,
    sessionId: pin?.sessionId,
  })
  const record = ctx.runs.register(cli, prompt, handle)
  // done 回收：钉住 sessionId、记录代发 prompt（供 human/agent 标注）、收集 warnings
  handle.done
    .then(async result => {
      record.status = 'done'
      record.result = result
      if (result.sessionId) {
        const prev = await ctx.pins.getPin(ctx.projectName, cli)
        await ctx.pins.setPin(ctx.projectName, cli, {
          sessionId: result.sessionId,
          sessionFile: prev?.sessionFile ?? null,
        })
        await ctx.pins.recordSentPrompt(result.sessionId, prompt)
      }
    })
    .catch((e: unknown) => {
      record.status = 'done'
      record.error = e instanceof Error ? e.message : String(e)
    })
  return {
    text: json({
      runId: record.runId,
      pid: handle.pid,
      artifactStdoutPath: handle.artifactStdoutPath,
      artifactStderrPath: handle.artifactStderrPath,
      resumedSession: pin?.sessionId ?? null,
      note: '任务已在后台运行；完成时会自动收到 [后台任务完成] 通知，无需轮询。只有你主动想看进度时才用 check_run。',
    }),
    fullPath: handle.artifactStdoutPath,
  }
}

async function checkRun(ctx: ToolContext, runId: string, waitMs?: number): Promise<ToolResult> {
  const record = ctx.runs.get(runId)
  if (!record) return { text: `错误: 未知 runId ${runId}` }
  // 长轮询：任务还在跑就等到结束或 wait_ms 兜底超时。done 一 resolve 立即返回，
  // 所以默认 5 分钟的等待只在任务挂死时才会真的等满
  if (record.status === 'running') {
    const wait = Math.min(Math.max(waitMs ?? 300_000, 0), 600_000)
    await Promise.race([
      record.handle.done.catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, wait)),
    ])
  }
  const artifactTail = await tailChars(record.handle.artifactStdoutPath, ARTIFACT_TAIL_CHARS)
  if (record.status === 'running') {
    return {
      text: json({
        status: 'running',
        pid: record.handle.pid,
        runningForMs: Date.now() - record.startedAt,
        artifactTail,
      }),
      fullPath: record.handle.artifactStdoutPath,
    }
  }
  return {
    text: json({
      status: 'done',
      exitCode: record.result?.exitCode,
      durationMs: record.result?.durationMs,
      sessionId: record.result?.sessionId ?? null,
      warnings: record.result?.warnings,
      error: record.error,
      artifactTail,
    }),
    fullPath: record.handle.artifactStdoutPath,
  }
}

/** 回给模型的标注消息：在 SessionMessage 基础上放开 kind（notification）并加 origin */
interface AnnotatedMessage {
  ts: number
  who: SessionMessage['who']
  kind?: 'steer' | 'notification'
  text: string
  origin?: 'agent' | 'human'
}

async function readSessionUpdates(ctx: ToolContext, cli: CliName): Promise<ToolResult> {
  const pin = await ctx.pins.getPin(ctx.projectName, cli)
  let sessionFile = pin?.sessionFile ?? null
  if (!sessionFile || !(await fs.stat(sessionFile).then(() => true, () => false))) {
    sessionFile =
      cli === 'kimi'
        ? await findKimiSessionFile(ctx.projectPath)
        : await findCodexSessionFile(ctx.projectPath)
    if (!sessionFile) {
      return { text: `未找到 ${cli} 的 session 文件（项目 ${ctx.projectPath} 还没有会话记录？）` }
    }
    if (pin) {
      await ctx.pins.setPin(ctx.projectName, cli, { ...pin, sessionFile })
    }
  }

  const parse = cli === 'kimi' ? parseKimiChunk : parseCodexChunk
  const { messages, warnings } = await ctx.reader.readMessages(sessionFile, parse)

  const sentPrompts = new Set<string>([
    ...(pin ? await ctx.pins.getSentPrompts(pin.sessionId) : []),
    // run 还在跑时 sessionId 未落定，prompt 只存在于注册表里
    ...ctx.runs.activePrompts(cli),
  ])

  const annotated: AnnotatedMessage[] = messages.map(m => {
    if (m.who !== 'user') return m
    // kimi 后台任务通知走 turn.steer，不是用户输入（origin.kind 细节 parser 不透出，
    // 按可观测特征判定：steer 且文本以 <notification 开头）
    if (cli === 'kimi' && m.kind === 'steer' && m.text.startsWith('<notification')) {
      return { ts: m.ts, who: m.who, kind: 'notification', text: m.text }
    }
    return { ...m, origin: sentPrompts.has(m.text) ? ('agent' as const) : ('human' as const) }
  })

  return {
    text: json({ sessionFile, parseWarnings: warnings, messages: annotated }),
    fullPath: sessionFile,
  }
}

async function readArtifact(filePath: string, tail: number | undefined): Promise<ToolResult> {
  const lines = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/)
  const n = tail ?? DEFAULT_ARTIFACT_TAIL_LINES
  const sliced = lines.slice(-n)
  const header = lines.length > n ? `[仅显示末尾 ${n} 行，共 ${lines.length} 行]\n` : ''
  return { text: header + sliced.join('\n'), fullPath: filePath }
}

async function gitStatus(ctx: ToolContext): Promise<ToolResult> {
  const cwd = ctx.projectPath
  const g = (args: string[]) => execa('git', args, { cwd, reject: false })
  const branch = (await g(['branch', '--show-current'])).stdout.trim()
  const porcelain = (await g(['status', '--porcelain'])).stdout
  const dirtyFiles = porcelain.split('\n').filter(l => l.trim()).length
  const ahead = await g(['rev-list', '--count', '@{u}..HEAD'])
  const unpushedCommits = ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.trim(), 10) : null
  const log = (await g(['log', '--oneline', '-5'])).stdout.trim().split('\n').filter(Boolean)
  return {
    text: json({
      branch,
      dirtyFiles,
      unpushedCommits: unpushedCommits ?? '(无 upstream，无法统计)',
      recentCommits: log,
    }),
  }
}

/** 工具执行分发：任何错误都转成文本回给模型，绝不抛出打崩 loop。 */
export async function executeTool(ctx: ToolContext, name: string, argsJson: string): Promise<ToolResult> {
  let args: Record<string, unknown>
  try {
    args = (argsJson ? JSON.parse(argsJson) : {}) as Record<string, unknown>
  } catch {
    return { text: `错误: 工具参数不是合法 JSON: ${argsJson}` }
  }

  try {
    switch (name) {
      case 'run_kimi':
        return await runBackend(ctx, 'kimi', String(args.prompt ?? ''))
      case 'run_codex':
        return await runBackend(ctx, 'codex', String(args.prompt ?? ''))
      case 'check_run':
        return await checkRun(
          ctx,
          String(args.runId ?? ''),
          typeof args.wait_ms === 'number' ? args.wait_ms : undefined,
        )
      case 'read_session_updates': {
        const cli = args.cli === 'kimi' || args.cli === 'codex' ? args.cli : null
        if (!cli) return { text: `错误: cli 必须是 "kimi" 或 "codex"，收到 ${String(args.cli)}` }
        return await readSessionUpdates(ctx, cli)
      }
      case 'read_artifact':
        return await readArtifact(
          String(args.path ?? ''),
          typeof args.tail === 'number' ? args.tail : undefined,
        )
      case 'git_status':
        return await gitStatus(ctx)
      case 'ask_user':
        return {
          text: await ctx.askUser(
            String(args.question ?? ''),
            typeof args.context === 'string' ? args.context : undefined,
          ),
        }
      case 'update_ledger':
        await ctx.ledger.append({
          direction: String(args.direction ?? ''),
          kind: String(args.kind ?? ''),
          summary: String(args.summary ?? ''),
          anchors: Array.isArray(args.anchors) ? args.anchors.map(String) : undefined,
          pending: Array.isArray(args.pending) ? args.pending.map(String) : undefined,
        })
        return { text: '已记录到台账' }
      case 'propose_memory': {
        const { appendMemory } = await import('../state/memory.js')
        const filePath = await appendMemory(
          ctx.memoryDir,
          String(args.title ?? ''),
          String(args.content ?? ''),
        )
        return { text: `已写入 memory: ${filePath}`, fullPath: filePath }
      }
      default:
        return { text: `错误: 未知工具 ${name}` }
    }
  } catch (e) {
    return { text: `错误: ${name} 执行失败: ${e instanceof Error ? e.message : String(e)}` }
  }
}
