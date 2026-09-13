import { execa } from 'execa'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** A stdout line is deliberately capped: protocol input must never grow relay memory without bound. */
export const MAX_FILTERED_STDOUT_LINE_BYTES = 1024 * 1024

/** Receives complete stdout lines and returns only text safe to persist in the public artifact. */
export interface ArtifactStdoutLineFilter {
  onLine(line: string): string | null | undefined
  /** Called when an overlong protocol line was discarded without being retained in memory. */
  onDiscardedLine?(): void
}

/**
 * Converts chunked stdout into complete lines while retaining at most maxLineBytes of one raw line.
 * A Transform keeps normal pipe backpressure intact instead of buffering a detached process in JS.
 */
export class LineFilteringTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private pendingBytes = 0
  private discardingLine = false
  private wrotePublicText = false

  constructor(
    private readonly lineFilter: ArtifactStdoutLineFilter,
    private readonly maxLineBytes = MAX_FILTERED_STDOUT_LINE_BYTES,
  ) {
    super()
  }

  private append(fragment: string): void {
    if (this.discardingLine || !fragment) return
    const bytes = Buffer.byteLength(fragment)
    if (this.pendingBytes + bytes > this.maxLineBytes) {
      this.pending = ''
      this.pendingBytes = 0
      this.discardingLine = true
      this.lineFilter.onDiscardedLine?.()
      return
    }
    this.pending += fragment
    this.pendingBytes += bytes
  }

  private emitLine(): void {
    if (this.discardingLine) {
      this.discardingLine = false
      return
    }
    const line = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending
    this.pending = ''
    this.pendingBytes = 0
    const publicText = this.lineFilter.onLine(line)
    if (!publicText) return
    this.push((this.wrotePublicText ? '\n' : '') + publicText)
    this.wrotePublicText = true
  }

  private consume(text: string): void {
    let start = 0
    while (start < text.length) {
      const newline = text.indexOf('\n', start)
      if (newline === -1) {
        this.append(text.slice(start))
        return
      }
      this.append(text.slice(start, newline))
      this.emitLine()
      start = newline + 1
    }
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.consume(this.decoder.write(chunk))
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.consume(this.decoder.end())
      // stream-json normally ends in a newline, but a final complete event must not be dropped.
      if (!this.discardingLine && this.pending) this.emitLine()
      else if (this.discardingLine) this.discardingLine = false
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

export interface CommandOptions {
  cmd: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
  artifactStdoutPath?: string
  artifactStderrPath?: string
  /**
   * 在 stdout 落入 artifact 前进行转换。转换前的 stdout 仅保留在本次进程的内存中，
   * 仅适用于同步、有限输出的命令。后台长任务必须用 artifactStdoutLineFilter。
   */
  artifactStdoutTransform?: (stdout: string) => string
  /** 后台 stdout 的增量、逐行安全过滤器。 */
  artifactStdoutLineFilter?: ArtifactStdoutLineFilter
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface DetachedCommandHandle {
  pid: number
  artifactStdoutPath: string
  artifactStderrPath: string
  done: Promise<CommandResult>
  cancel(signal?: NodeJS.Signals | number): void
}

/** detach 模式未指定 artifact 路径时的默认落点：cwd 下的 .agent-artifacts/。 */
export function defaultArtifactPaths(
  cwd: string,
  name: string,
): { stdoutPath: string; stderrPath: string } {
  const dir = path.join(cwd, '.agent-artifacts')
  const stamp = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    stdoutPath: path.join(dir, `${stamp}.stdout.log`),
    stderrPath: path.join(dir, `${stamp}.stderr.log`),
  }
}

// process.env 的值类型含 undefined；execa 的 env 选项接受 undefined（表示删除该变量）。
function mergedEnv(env?: Record<string, string>): Record<string, string | undefined> {
  return env ? { ...process.env, ...env } : { ...process.env }
}

export async function runCommand(options: CommandOptions): Promise<CommandResult> {
  const start = Date.now()
  const {
    cmd,
    args = [],
    cwd,
    env,
    timeoutMs,
    input,
    artifactStdoutPath,
    artifactStderrPath,
    artifactStdoutTransform,
  } = options

  if (artifactStdoutPath) fs.mkdirSync(path.dirname(artifactStdoutPath), { recursive: true })
  if (artifactStderrPath) fs.mkdirSync(path.dirname(artifactStderrPath), { recursive: true })
  // 若调用方复用路径，先清除旧内容，避免运行期间暴露上一次的未过滤输出。
  if (artifactStdoutPath && artifactStdoutTransform) fs.writeFileSync(artifactStdoutPath, '')

  const result = await execa(cmd, args, {
    cwd,
    env: mergedEnv(env),
    input,
    timeout: timeoutMs,
    reject: false,
  })

  if (result.timedOut) {
    throw new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`)
  }

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const durationMs = Date.now() - start

  if (artifactStdoutPath) fs.writeFileSync(artifactStdoutPath, artifactStdoutTransform?.(stdout) ?? stdout)
  if (artifactStderrPath) fs.writeFileSync(artifactStderrPath, stderr)

  return {
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    exitCode: result.exitCode ?? 1,
    durationMs,
  }
}

/**
 * detach 模式：spawn 后立即返回，stdout/stderr 流式追加写入 artifact 文件。
 * 不设默认超时，适合小时级长任务；调用方通过 artifact 文件轮询进度。
 */
export function spawnDetachedCommand(options: CommandOptions): DetachedCommandHandle {
  const start = Date.now()
  const {
    cmd,
    args = [],
    cwd,
    env,
    timeoutMs,
    input,
    artifactStdoutPath,
    artifactStderrPath,
    artifactStdoutTransform,
    artifactStdoutLineFilter,
  } = options

  if (!artifactStdoutPath || !artifactStderrPath) {
    throw new Error('spawnDetachedCommand requires artifactStdoutPath and artifactStderrPath')
  }
  if (artifactStdoutTransform && artifactStdoutLineFilter) {
    throw new Error('spawnDetachedCommand accepts either artifactStdoutTransform or artifactStdoutLineFilter, not both')
  }
  fs.mkdirSync(path.dirname(artifactStdoutPath), { recursive: true })
  fs.mkdirSync(path.dirname(artifactStderrPath), { recursive: true })
  // 先清空再 spawn：即使路径被复用，调用方拿到 handle 时也只能读到安全的空内容。
  if (artifactStdoutTransform || artifactStdoutLineFilter) fs.writeFileSync(artifactStdoutPath, '')

  const subprocess = execa(cmd, args, {
    cwd,
    env: mergedEnv(env),
    input,
    timeout: timeoutMs,
    reject: false,
    buffer: false,
  })

  const stderrStream = fs.createWriteStream(artifactStderrPath, { flags: 'a' })
  subprocess.stderr?.pipe(stderrStream)

  const streamFinished = (stream: fs.WriteStream) =>
    new Promise<void>((resolve, reject) => {
      stream.once('finish', resolve)
      stream.once('error', reject)
    })
  const stderrFinished = streamFinished(stderrStream)

  // 有过滤器时绝不能先把原始 stdout 写到磁盘：它可能包含协议层的私有字段。
  // LineFilteringTransform 按行过滤并保持 pipe backpressure；它只保留有上限的一条未完行。
  const stdoutChunks: Buffer[] = []
  const stdoutFinished = artifactStdoutLineFilter
    ? (() => {
        const stdoutStream = fs.createWriteStream(artifactStdoutPath, { flags: 'a' })
        const lineFilter = new LineFilteringTransform(artifactStdoutLineFilter)
        subprocess.stdout?.pipe(lineFilter).pipe(stdoutStream)
        return streamFinished(stdoutStream)
      })()
    : artifactStdoutTransform
      ? new Promise<void>((resolve, reject) => {
          if (!subprocess.stdout) {
            resolve()
            return
          }
          subprocess.stdout.on('data', (chunk: Buffer | string) => {
            stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          })
          subprocess.stdout.once('end', resolve)
          subprocess.stdout.once('error', reject)
        })
      : (() => {
          const stdoutStream = fs.createWriteStream(artifactStdoutPath, { flags: 'a' })
          subprocess.stdout?.pipe(stdoutStream)
          return streamFinished(stdoutStream)
        })()

  const done: Promise<CommandResult> = (async () => {
    const result = await subprocess
    // 等文件流 flush 完再读 artifact，保证内容完整。
    await Promise.all([stdoutFinished, stderrFinished])
    if (result.timedOut) {
      throw new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`)
    }
    const stdout = artifactStdoutTransform
      ? Buffer.concat(stdoutChunks).toString('utf8')
      : fs.readFileSync(artifactStdoutPath, 'utf-8')
    if (artifactStdoutTransform) {
      fs.writeFileSync(artifactStdoutPath, artifactStdoutTransform(stdout))
    }
    return {
      stdout,
      stderr: fs.readFileSync(artifactStderrPath, 'utf-8'),
      exitCode: result.exitCode ?? 1,
      durationMs: Date.now() - start,
    }
  })()

  if (subprocess.pid === undefined) {
    // spawn 失败（如二进制不存在）：错误会通过 done 的 rejection 暴露，这里避免 unhandled rejection。
    done.catch(() => {})
    throw new Error(`Failed to spawn command (no pid): ${cmd} ${args.join(' ')}`)
  }

  return {
    pid: subprocess.pid,
    artifactStdoutPath,
    artifactStderrPath,
    done,
    cancel: (signal = 'SIGTERM') => {
      subprocess.kill(signal)
    },
  }
}
