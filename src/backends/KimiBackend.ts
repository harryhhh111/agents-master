import { AgentBackend, AgentRunOptions, AgentRunResult, DetachedRunHandle } from './AgentBackend.js'
import {
  CommandOptions,
  CommandResult,
  defaultArtifactPaths,
  runCommand,
  spawnDetachedCommand,
} from './runCommand.js'

function describeEvent(event: Record<string, unknown>): string {
  const role = typeof event.role === 'string' ? event.role : '?'
  const type = typeof event.type === 'string' ? event.type : '?'
  return `${role}/${type}`
}

export function extractKimiSessionId(stdout: string, warnings?: string[]): string | null {
  const seenEvents: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      seenEvents.push(describeEvent(event))
      if (
        event.role === 'meta' &&
        event.type === 'session.resume_hint' &&
        typeof event.session_id === 'string'
      ) {
        return event.session_id
      }
    } catch {
      // Ignore malformed JSON lines.
    }
  }
  warnings?.push(
    `kimi: session id 提取失败（未找到 role=meta, type=session.resume_hint 且带 session_id 的事件）;` +
      ` 实际看到的事件: ${seenEvents.length > 0 ? seenEvents.join(', ') : '(无)'}`,
  )
  return null
}

export function extractKimiAssistantText(stdout: string): string[] {
  const texts: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      if (event.role === 'assistant' && typeof event.content === 'string') {
        texts.push(event.content)
      }
    } catch {
      // Ignore malformed JSON lines.
    }
  }
  return texts
}

export class KimiBackend implements AgentBackend {
  name = 'kimi'

  constructor(private readonly defaultArgs: string[] = []) {}

  private buildCommand(prompt: string, options: AgentRunOptions): CommandOptions {
    const args: string[] = [...this.defaultArgs]

    if (options.sessionId) {
      args.push('--session', options.sessionId)
    }

    args.push('--prompt', prompt)
    args.push('--output-format', 'stream-json')
    // 注意：kimi 的 --prompt 与 --yolo 不兼容，不能加 --yolo；自治执行（自动批准）靠配置文件。

    const binary = process.env.CKRUNNER_KIMI_BINARY ?? 'kimi'
    return {
      cmd: binary,
      args,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
    }
  }

  private toResult(result: CommandResult): AgentRunResult {
    const warnings: string[] = []
    const sessionId = extractKimiSessionId(result.stdout, warnings)
    return { ...result, sessionId, warnings }
  }

  async run(prompt: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const command = this.buildCommand(prompt, options)
    const result = await runCommand({
      ...command,
      artifactStdoutPath: options.artifactStdoutPath,
      artifactStderrPath: options.artifactStderrPath,
    })
    return this.toResult(result)
  }

  runDetached(prompt: string, options: AgentRunOptions): DetachedRunHandle {
    const defaults = defaultArtifactPaths(options.cwd, this.name)
    const artifactStdoutPath = options.artifactStdoutPath ?? defaults.stdoutPath
    const artifactStderrPath = options.artifactStderrPath ?? defaults.stderrPath
    const command = this.buildCommand(prompt, options)
    const handle = spawnDetachedCommand({ ...command, artifactStdoutPath, artifactStderrPath })
    return {
      pid: handle.pid,
      artifactStdoutPath,
      artifactStderrPath,
      done: handle.done.then(result => this.toResult(result)),
      cancel: signal => handle.cancel(signal),
    }
  }
}
