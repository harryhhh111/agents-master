import { AgentBackend, AgentRunOptions, AgentRunResult, DetachedRunHandle } from './AgentBackend.js'
import {
  CommandOptions,
  CommandResult,
  defaultArtifactPaths,
  runCommand,
  spawnDetachedCommand,
} from './runCommand.js'

const DEFAULT_TIMEOUT_MS = 120000
const MAX_SEEN_EVENT_LABELS = 20

export interface ClaudeBackendOptions {
  /** PATH 中的命令名或绝对路径。CKRUNNER_CLAUDE_BINARY 环境变量优先。 */
  binary?: string
  /** 传给 Claude Code 的 --permission-mode。 */
  permissionMode?: string
}

/** 环境变量优先于配置，供执行器和 doctor 使用同一套二进制选择规则。 */
export function resolveClaudeBinary(options: ClaudeBackendOptions = {}): string {
  return process.env.CKRUNNER_CLAUDE_BINARY ?? options.binary ?? 'claude'
}

function eventLabel(event: Record<string, unknown>): string {
  const type = typeof event.type === 'string' ? event.type : '?'
  const subtype = typeof event.subtype === 'string' ? `/${event.subtype}` : ''
  return `${type}${subtype}`
}

/**
 * Incremental parser for Claude's line-delimited stream-json protocol. It retains only protocol
 * metadata needed to pin a session; assistant thinking and tool blocks are never retained.
 */
export class ClaudeStreamJsonParser {
  private initSessionId: string | null = null
  private resultSessionId: string | null = null
  private readonly seenEvents: string[] = []
  private seenEventCount = 0
  private discardedLines = 0

  /** Returns public assistant text from one event, or null for every private/non-message event. */
  consumeLine(line: string): string | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // A launcher diagnostic or malformed record is not public assistant text.
      return null
    }
    this.seenEventCount++
    if (this.seenEvents.length < MAX_SEEN_EVENT_LABELS) this.seenEvents.push(eventLabel(event))
    if (
      event.type === 'system' &&
      event.subtype === 'init' &&
      typeof event.session_id === 'string' &&
      event.session_id
    ) {
      this.initSessionId = event.session_id
    }
    if (event.type === 'result' && typeof event.session_id === 'string' && event.session_id) {
      this.resultSessionId = event.session_id
    }
    if (event.type !== 'assistant') return null

    const message = event.message as Record<string, unknown> | undefined
    if (!Array.isArray(message?.content)) return null
    const texts: string[] = []
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const textBlock = block as Record<string, unknown>
      // Deliberately whitelist only the public text block. thinking/tool_use/tool_result stay private.
      if (textBlock.type === 'text' && typeof textBlock.text === 'string' && textBlock.text) {
        texts.push(textBlock.text)
      }
    }
    return texts.length > 0 ? texts.join('\n') : null
  }

  noteDiscardedLine(): void {
    this.discardedLines++
  }

  sessionId(warnings: string[]): string | null {
    if (this.resultSessionId && this.initSessionId && this.resultSessionId !== this.initSessionId) {
      warnings.push(
        `claude: system/init session_id (${this.initSessionId}) 与 terminal result session_id (${this.resultSessionId}) 不一致；使用 result`,
      )
    }
    if (this.discardedLines > 0) {
      warnings.push(`claude: 丢弃 ${this.discardedLines} 条超过 1 MiB 的 stream-json 行（未写入 artifact）`)
    }
    const sessionId = this.resultSessionId ?? this.initSessionId
    if (sessionId) return sessionId

    warnings.push(
      `claude: session id 提取失败（未找到 type=system/subtype=init 或 type=result 的 session_id）;` +
        ` 实际看到的事件: ${this.seenEvents.length > 0 ? this.seenEvents.join(', ') : '(无)'}` +
        (this.seenEventCount > this.seenEvents.length ? `，另有 ${this.seenEventCount - this.seenEvents.length} 条未列出` : ''),
    )
    return null
  }
}

/**
 * Claude 的 stream-json 会在 system/init 与终止 result 中都给出 session_id。
 * result 是本次运行的终态记录，优先使用；旧输出没有 result 时兼容 init。
 */
export function extractClaudeSessionId(stdout: string, warnings?: string[]): string | null {
  const parser = new ClaudeStreamJsonParser()
  for (const line of stdout.split(/\r?\n/)) {
    parser.consumeLine(line)
  }
  return parser.sessionId(warnings ?? [])
}

/** 只收集 Claude assistant message 内明确标为 text 的 content block，绝不返回 thinking。 */
export function extractClaudeAssistantText(stdout: string): string[] {
  const parser = new ClaudeStreamJsonParser()
  const texts: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const text = parser.consumeLine(line)
    if (text) texts.push(text)
  }
  return texts
}

/** 公开以便命令协议可以在不启动真实 CLI 的测试中锁定。 */
export function buildClaudeCommand(
  prompt: string,
  options: AgentRunOptions,
  backendOptions: ClaudeBackendOptions = {},
): CommandOptions {
  const binary = resolveClaudeBinary(backendOptions)
  // acceptEdits is the safe noninteractive coding default: file edits can proceed without a TTY
  // prompt, while commands and broader permissions are still not blanket-approved (unlike bypassPermissions).
  const permissionMode = backendOptions.permissionMode ?? 'acceptEdits'
  const args = ['-p', '--verbose', '--output-format=stream-json', '--permission-mode', permissionMode]
  if (options.sessionId) args.push('--resume', options.sessionId)
  args.push(prompt)

  return {
    cmd: binary,
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  }
}

export class ClaudeBackend implements AgentBackend {
  name = 'claude'

  constructor(private readonly options: ClaudeBackendOptions = {}) {}

  private toResult(result: CommandResult, parser?: ClaudeStreamJsonParser): AgentRunResult {
    const warnings: string[] = []
    const sessionId = parser ? parser.sessionId(warnings) : extractClaudeSessionId(result.stdout, warnings)
    const publicText = parser ? result.stdout : extractClaudeAssistantText(result.stdout).join('\n')
    if (!publicText) {
      warnings.push('claude: assistant text 提取失败（未找到 type=assistant 的 type=text content block）')
    }
    return {
      ...result,
      stdout: publicText,
      sessionId,
      warnings,
    }
  }

  async run(prompt: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const command = buildClaudeCommand(prompt, {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }, this.options)
    const result = await runCommand({
      ...command,
      artifactStdoutPath: options.artifactStdoutPath,
      artifactStderrPath: options.artifactStderrPath,
      artifactStdoutTransform: stdout => extractClaudeAssistantText(stdout).join('\n'),
    })
    return this.toResult(result)
  }

  runDetached(prompt: string, options: AgentRunOptions): DetachedRunHandle {
    const defaults = defaultArtifactPaths(options.cwd, this.name)
    const artifactStdoutPath = options.artifactStdoutPath ?? defaults.stdoutPath
    const artifactStderrPath = options.artifactStderrPath ?? defaults.stderrPath
    const command = buildClaudeCommand(prompt, options, this.options)
    const parser = new ClaudeStreamJsonParser()
    const handle = spawnDetachedCommand({
      ...command,
      artifactStdoutPath,
      artifactStderrPath,
      artifactStdoutLineFilter: {
        onLine: line => parser.consumeLine(line),
        onDiscardedLine: () => parser.noteDiscardedLine(),
      },
    })
    return {
      pid: handle.pid,
      artifactStdoutPath,
      artifactStderrPath,
      done: handle.done.then(result => this.toResult(result, parser)),
      cancel: signal => handle.cancel(signal),
    }
  }
}
