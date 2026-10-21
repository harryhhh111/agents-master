export interface AgentRunOptions {
  cwd: string
  sessionId?: string
  env?: Record<string, string>
  /** 合并进程环境后要删除的键（最小权限：不向 CLI 子进程透传无关凭据）。 */
  envExclude?: string[]
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
  /** 取消运行（默认 SIGTERM，作用于整个进程组）。 */
  cancel(signal?: NodeJS.Signals | number): void
  /** 进程组是否仍有存活成员（父进程退出后用于确认无残留工作子进程）；未实现时退化为直接子进程语义。 */
  groupAlive?(): boolean
}

export interface AgentBackend {
  name: string
  /** 同步运行：等待进程结束后返回结果。 */
  run(prompt: string, options: AgentRunOptions): Promise<AgentRunResult>
  /** detach 运行：立即返回句柄，适合小时级长任务，调用方轮询 artifact 文件看进度。 */
  runDetached(prompt: string, options: AgentRunOptions): DetachedRunHandle
}
