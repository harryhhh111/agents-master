import { execa } from 'execa'
import fs from 'node:fs'
import path from 'node:path'

export interface CommandOptions {
  cmd: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
  artifactStdoutPath?: string
  artifactStderrPath?: string
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
  const { cmd, args = [], cwd, env, timeoutMs, input, artifactStdoutPath, artifactStderrPath } = options

  if (artifactStdoutPath) fs.mkdirSync(path.dirname(artifactStdoutPath), { recursive: true })
  if (artifactStderrPath) fs.mkdirSync(path.dirname(artifactStderrPath), { recursive: true })

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

  if (artifactStdoutPath) fs.writeFileSync(artifactStdoutPath, stdout)
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
  const { cmd, args = [], cwd, env, timeoutMs, input, artifactStdoutPath, artifactStderrPath } = options

  if (!artifactStdoutPath || !artifactStderrPath) {
    throw new Error('spawnDetachedCommand requires artifactStdoutPath and artifactStderrPath')
  }
  fs.mkdirSync(path.dirname(artifactStdoutPath), { recursive: true })
  fs.mkdirSync(path.dirname(artifactStderrPath), { recursive: true })

  const subprocess = execa(cmd, args, {
    cwd,
    env: mergedEnv(env),
    input,
    timeout: timeoutMs,
    reject: false,
    buffer: false,
  })

  const stdoutStream = fs.createWriteStream(artifactStdoutPath, { flags: 'a' })
  const stderrStream = fs.createWriteStream(artifactStderrPath, { flags: 'a' })
  subprocess.stdout?.pipe(stdoutStream)
  subprocess.stderr?.pipe(stderrStream)

  const streamFinished = (stream: fs.WriteStream) =>
    new Promise<void>((resolve, reject) => {
      stream.once('finish', resolve)
      stream.once('error', reject)
    })
  const stdoutFinished = streamFinished(stdoutStream)
  const stderrFinished = streamFinished(stderrStream)

  const done: Promise<CommandResult> = (async () => {
    const result = await subprocess
    // 等文件流 flush 完再读 artifact，保证内容完整。
    await Promise.all([stdoutFinished, stderrFinished])
    if (result.timedOut) {
      throw new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`)
    }
    return {
      stdout: fs.readFileSync(artifactStdoutPath, 'utf-8'),
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
