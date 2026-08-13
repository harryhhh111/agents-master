import fs from 'node:fs'
import path from 'node:path'
import { AgentBackend, AgentRunOptions, AgentRunResult, DetachedRunHandle } from './AgentBackend.js'
import {
  CommandOptions,
  CommandResult,
  defaultArtifactPaths,
  runCommand,
  spawnDetachedCommand,
} from './runCommand.js'

const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']

const DEFAULT_TIMEOUT_MS = 120000

export interface CodexBackendOptions {
  /**
   * codex 沙箱模式，exec 和 resume 两条路径共用。
   * 默认 workspace-write（本 agent 是给执行方派活，需要写权限）。
   */
  sandboxMode?: string
}

/** 二进制解析顺序：CKRUNNER_CODEX_BINARY 环境变量 → PATH 里的 codex。 */
function findCodexBinary(): string {
  return process.env.CKRUNNER_CODEX_BINARY ?? 'codex'
}

/** 透传代理环境变量（本机直连用不到，但保留给需要代理的机器）。 */
function buildAgentEnv(optionsEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PROXY_VARS) {
    const value = optionsEnv?.[key] ?? process.env[key]
    if (value !== undefined && value !== '') {
      env[key] = value
    }
  }
  // Allow non-proxy env overrides from options to take precedence.
  if (optionsEnv) {
    for (const [key, value] of Object.entries(optionsEnv)) {
      env[key] = value
    }
  }
  return env
}

function seenEventTypes(stdout: string): string[] {
  const types: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      types.push(typeof event.type === 'string' ? event.type : '(无 type 字段)')
    } catch {
      // Ignore malformed JSON lines.
    }
  }
  return types
}

export function extractSessionIdFromJsonl(stdout: string, warnings?: string[]): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'thread.started') {
        const thread = event.thread as Record<string, unknown> | undefined
        const id = thread?.thread_id ?? event.thread_id
        if (typeof id === 'string' && id) {
          return id
        }
      }
    } catch {
      // Ignore malformed JSON lines.
    }
  }
  warnings?.push(
    `codex: session id 提取失败（未找到带 thread_id 的 type=thread.started 事件）;` +
      ` 实际看到的事件类型: ${seenEventTypes(stdout).join(', ') || '(无)'}`,
  )
  return null
}

function readLastMessageFile(filePath: string): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null
  const content = fs.readFileSync(filePath, 'utf-8')
  return content.trim() || null
}

const LAST_MESSAGE_CANDIDATE_FIELDS = [
  'message.content',
  'item.text',
  'output',
  'result',
  'content',
  'text',
]

export function extractLastMessageFromJsonl(stdout: string, warnings?: string[]): string | null {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]) as Record<string, unknown>
      const message = event.message as Record<string, unknown> | undefined
      const item = event.item as Record<string, unknown> | undefined
      const candidates = [
        message?.content,
        item?.text,
        event.output,
        event.result,
        event.content,
        event.text,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim()
        }
      }
    } catch {
      // Ignore malformed JSON lines.
    }
  }
  warnings?.push(
    `codex: last message 提取失败（候选字段 ${LAST_MESSAGE_CANDIDATE_FIELDS.join('/')} 均未命中）;` +
      ` 实际看到的事件类型: ${seenEventTypes(stdout).join(', ') || '(无)'}`,
  )
  return null
}

export class CodexBackend implements AgentBackend {
  name = 'codex'

  private readonly sandboxMode: string

  constructor(options: CodexBackendOptions = {}) {
    this.sandboxMode = options.sandboxMode ?? 'workspace-write'
  }

  private buildCommand(
    prompt: string,
    options: AgentRunOptions,
    timeoutMs: number | undefined,
  ): { command: CommandOptions; outputLastMessageFile?: string } {
    const cwd = options.cwd

    const outputLastMessageFile = options.outputLastMessageFile
      ?? (options.env?.CKRUNNER_CODEX_OUTPUT_LAST_MESSAGE
        ? path.resolve(cwd, options.env.CKRUNNER_CODEX_OUTPUT_LAST_MESSAGE)
        : undefined)
    const outputSchemaFile = options.outputSchemaFile
      ?? (options.env?.CKRUNNER_CODEX_OUTPUT_SCHEMA
        ? path.resolve(cwd, options.env.CKRUNNER_CODEX_OUTPUT_SCHEMA)
        : undefined)

    let args: string[]
    if (options.sessionId) {
      args = ['exec', 'resume', '--json', '-c', `sandbox_mode="${this.sandboxMode}"`, options.sessionId, '-']
    } else {
      args = ['exec', '--json', '--sandbox', this.sandboxMode, '-']
      if (outputLastMessageFile) {
        args.push('--output-last-message', outputLastMessageFile)
      }
      if (outputSchemaFile) {
        args.push('--output-schema', outputSchemaFile)
      }
    }

    return {
      command: {
        cmd: findCodexBinary(),
        args,
        cwd,
        env: buildAgentEnv(options.env),
        timeoutMs,
        input: prompt,
      },
      outputLastMessageFile,
    }
  }

  private toResult(result: CommandResult, outputLastMessageFile?: string): AgentRunResult {
    const warnings: string[] = []
    const sessionId = extractSessionIdFromJsonl(result.stdout, warnings)

    let lastMessage: string | null = null
    if (outputLastMessageFile) {
      lastMessage = readLastMessageFile(outputLastMessageFile)
    }
    if (!lastMessage) {
      lastMessage = extractLastMessageFromJsonl(result.stdout, warnings)
    }

    return {
      stdout: lastMessage ?? result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      sessionId,
      warnings,
    }
  }

  async run(prompt: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const { command, outputLastMessageFile } = this.buildCommand(
      prompt,
      options,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    const result = await runCommand({
      ...command,
      artifactStdoutPath: options.artifactStdoutPath,
      artifactStderrPath: options.artifactStderrPath,
    })
    return this.toResult(result, outputLastMessageFile)
  }

  runDetached(prompt: string, options: AgentRunOptions): DetachedRunHandle {
    // detach 面向小时级长任务，不设默认超时；调用方显式传 timeoutMs 才会生效。
    const { command, outputLastMessageFile } = this.buildCommand(prompt, options, options.timeoutMs)
    const defaults = defaultArtifactPaths(options.cwd, this.name)
    const artifactStdoutPath = options.artifactStdoutPath ?? defaults.stdoutPath
    const artifactStderrPath = options.artifactStderrPath ?? defaults.stderrPath
    const handle = spawnDetachedCommand({ ...command, artifactStdoutPath, artifactStderrPath })
    return {
      pid: handle.pid,
      artifactStdoutPath,
      artifactStderrPath,
      done: handle.done.then(result => this.toResult(result, outputLastMessageFile)),
      cancel: signal => handle.cancel(signal),
    }
  }
}
