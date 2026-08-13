export interface AgentRunOptions {
  cwd: string
  sessionId?: string
  env?: Record<string, string>
  timeoutMs?: number
  artifactStdoutPath?: string
  artifactStderrPath?: string
  outputLastMessageFile?: string
  outputSchemaFile?: string
}

export interface AgentRunResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  sessionId: string | null
  /** 解析阶段的显式告警（session id / last message 提取失败等），成功时为空数组。 */
  warnings: string[]
}

/** detach 模式句柄：进程已在后台运行，stdout/stderr 流式写入 artifact 文件。 */
export interface DetachedRunHandle {
  pid: number
  artifactStdoutPath: string
  artifactStderrPath: string
  /** 进程结束后 resolve 为完整结果（含 sessionId / warnings）。 */
  done: Promise<AgentRunResult>
  /** 取消运行（默认 SIGTERM）。 */
  cancel(signal?: NodeJS.Signals | number): void
}

export interface AgentBackend {
  name: string
  /** 同步运行：等待进程结束后返回结果。 */
  run(prompt: string, options: AgentRunOptions): Promise<AgentRunResult>
  /** detach 运行：立即返回句柄，适合小时级长任务，调用方轮询 artifact 文件看进度。 */
  runDetached(prompt: string, options: AgentRunOptions): DetachedRunHandle
}
