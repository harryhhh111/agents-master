import type { CliExecutionRecord, Run, FakeReceipt } from '../main/coordination/store.js'
import type { FakeExecutor } from '../main/coordination/fake.js'
import type { AgentBackend, AgentRunResult, DetachedRunHandle } from '../backends/AgentBackend.js'
import type { ScopedModel } from './scoped-protocol.js'
import { scopedTurn, type ScopedState, type ScopedTool } from './scoped-turn.js'

/** accept() 校验过的真实 CLI 任务 decision（store 层已按白名单拒绝越界 project）。 */
export interface CliTaskDecision {
  action: 'cli-task'
  objective: string
  scope: ['project']
  project: string
  backend?: string
  completionCriteria: string[]
}

/** store.answer 绑定的问答与追问 run 的既有回执（含执行留痕）。 */
export interface RunAnswer {
  question: string
  answer: string
  runId?: string
  priorResult?: unknown
}

export type CliBackendFactory = (name: string) => AgentBackend

export interface CliDomainExecutorOptions {
  model: ScopedModel
  backends: CliBackendFactory
  /** 项目白名单：name → 绝对路径。决策层与执行层各查一次（纵深防御）。 */
  projects: Record<string, string>
  /** 单次 CLI 执行预算，默认 10 分钟；超时取消子进程并判 failed。 */
  cliTimeoutMs?: number
  /** 判读回合总时限（真实模型明显慢于合成模型）。 */
  turnTimeoutMs?: number
  /** 取消/超时后等待进程退出的宽限；宽限内未退出升级 SIGKILL 再等一轮。 */
  cancelGraceMs?: number
  /** 不向 CLI 子进程透传的环境变量（无关凭据最小权限）。 */
  envExclude?: string[]
  systemPrompt?: string
  /** 执行留痕回调（worker 接线到 store.bindExecution）：启动时绑定 pid/产物，CLI 落定后、判读前再补全退出信息。 */
  onExecutionTrace?: (run: Readonly<Run>, info: Omit<CliExecutionRecord, 'sessionId' | 'exitCode' | 'durationMs'> & Partial<CliExecutionRecord>) => void
}

/** 存储保留完整执行记录；送进 CLI/判读模型的前次回执只保留白名单字段（stderr 路径等内部信息不透出）。 */
function modelVisiblePriorResult(prior: unknown): unknown {
  if (typeof prior !== 'object' || prior === null) return prior
  const p = prior as { kind?: unknown; body?: unknown; execution?: unknown }
  const visible: Record<string, unknown> = {}
  if (p.kind !== undefined) visible.kind = p.kind
  if (p.body !== undefined) visible.body = p.body
  if (typeof p.execution === 'object' && p.execution !== null) {
    const e = p.execution as Record<string, unknown>
    visible.execution = Object.fromEntries(
      ['backend', 'sessionId', 'exitCode', 'durationMs', 'artifactStdoutPath', 'cancelConfirmed']
        .filter(k => k in e)
        .map(k => [k, e[k]]),
    )
  }
  return visible
}

export const defaultCliEnvExclude = ['DEEPSEEK_API_KEY', 'DOTENV_CONFIG_PATH']

const cliJudgeSystemPrompt = [
  '工作项目 Agent。一次真实 CLI 任务已经执行完毕，你负责判读结果。',
  '对照目标与完成标准：结果充分时 finish（总结实际产出与证据路径）；信息不足或需要用户决定时 ask。',
  '不得虚构未发生的执行；CLI 失败或超时要如实说明。可用证据只有下面给出的执行摘要与产物路径。',
  '摘要中若含用户已回答的追问，判读必须考虑回答内容。',
].join('\n')

const cliGuardrails = [
  '约束：不要 push、不要 force、不删除工作目录之外的任何文件、不读取或复制凭据文件（.env、~/.config、~/.aws 等）、',
  '不对外发布内容。工作产物和说明写入当前目录的 .agent-artifacts/。',
].join('')

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** 合成执行器与 CLI 执行器按 run 的 decision.action 路由；identity 取 CLI（调度器只作白名单断言）。 */
export class RoutedDomainExecutor implements FakeExecutor {
  readonly identity = 'CLI' as const
  constructor(
    private readonly synthetic: FakeExecutor & { stop?(id: string): void },
    private readonly cli: CliDomainExecutor,
  ) {}
  stop(id: string): void { this.synthetic.stop?.(id); this.cli.stop(id) }
  execute(run: Readonly<Run>): Promise<FakeReceipt | { kind: 'stopped'; execution?: CliExecutionRecord }> {
    const decision = (JSON.parse(run.context) as { decision?: { action?: string } }).decision
    return decision?.action === 'cli-task' ? this.cli.execute(run) : this.synthetic.execute(run)
  }
}

/** 真实 CLI 执行器：模板拼 prompt（事务外同步等待 CLI）→ 领域模型判读 → receipt。 */
export class CliDomainExecutor implements FakeExecutor {
  readonly identity = 'CLI' as const
  private readonly active = new Map<string, { controller: AbortController }>()
  constructor(private readonly options: CliDomainExecutorOptions) {}

  /** 只发中断信号；SIGTERM/SIGKILL 升级由 execute 的 confirmExit 统一负责，避免重复发信号。 */
  stop(id: string): void {
    this.active.get(id)?.controller.abort()
  }

  private context(run: Readonly<Run>): { decision: CliTaskDecision; answers: RunAnswer[] } {
    const context = JSON.parse(run.context) as { decision?: unknown; answers?: unknown }
    const decision = context.decision as CliTaskDecision
    if (!decision || decision.action !== 'cli-task' || typeof decision.project !== 'string') {
      throw new Error('不是 CLI 任务 decision')
    }
    const answers = (Array.isArray(context.answers) ? context.answers : [])
      .filter((a): a is RunAnswer => typeof a === 'object' && a !== null
        && typeof (a as RunAnswer).question === 'string' && typeof (a as RunAnswer).answer === 'string')
    return { decision, answers }
  }

  /** 取消/超时后确认进程真实退出：SIGTERM 宽限一轮，未退出升级 SIGKILL 再等一轮。占用在确认前不释放。 */
  private async confirmExit(
    settled: Promise<{ ok: boolean; result?: AgentRunResult }>,
    handle: DetachedRunHandle,
  ): Promise<{ confirmed: boolean; result?: AgentRunResult }> {
    const graceMs = this.options.cancelGraceMs ?? 5000
    handle.cancel()
    const first = await Promise.race([settled, delay(graceMs).then(() => undefined)])
    const direct = first ?? await (async () => {
      handle.cancel('SIGKILL')
      return Promise.race([settled, delay(graceMs).then(() => undefined)])
    })()
    if (!direct) return { confirmed: false }
    // 直接子进程落定还不够：组内的工作子进程可能忽略了 SIGTERM 仍在运行。
    return { confirmed: await this.confirmGroupCleared(handle, graceMs), result: direct.result }
  }

  /** 父进程退出后确认进程组无残留成员；仍有存活则对整组补 SIGKILL 再等一轮。 */
  private async confirmGroupCleared(handle: DetachedRunHandle, graceMs: number): Promise<boolean> {
    if (!handle.groupAlive) return true // backend 未暴露组信息：退化为直接子进程语义
    const waitCleared = async (): Promise<boolean> => {
      const deadline = Date.now() + graceMs
      while (handle.groupAlive!()) {
        if (Date.now() >= deadline) return false
        await delay(20)
      }
      return true
    }
    if (await waitCleared()) return true
    handle.cancel('SIGKILL')
    return waitCleared()
  }

  private executionRecord(
    backend: string,
    handle: DetachedRunHandle,
    result?: AgentRunResult,
    cancelConfirmed?: boolean,
  ): CliExecutionRecord {
    return {
      backend,
      pid: handle.pid,
      sessionId: result?.sessionId ?? null,
      exitCode: result?.exitCode ?? -1,
      durationMs: result?.durationMs ?? 0,
      artifactStdoutPath: handle.artifactStdoutPath,
      artifactStderrPath: handle.artifactStderrPath,
      ...(cancelConfirmed !== undefined ? { cancelConfirmed } : {}),
    }
  }

  async execute(run: Readonly<Run>): Promise<FakeReceipt | { kind: 'stopped'; execution?: CliExecutionRecord }> {
    const entry = { controller: new AbortController() }
    this.active.set(run.id, entry)
    // 已拿到的执行信息必须带出所有后续出口（含判读抛错/超时），不能只在判读成功时落库。
    let execution: CliExecutionRecord | undefined
    try {
      const { decision, answers } = this.context(run)
      const projectPath = this.options.projects[decision.project]
      if (!projectPath) return { kind: 'failed', body: `项目不在白名单：${decision.project}` }
      const backendName = decision.backend ?? 'kimi'
      let backend: AgentBackend
      try {
        backend = this.options.backends(backendName)
      } catch {
        return { kind: 'failed', body: `未知 backend：${backendName}` }
      }

      // 续作：追问已被回答时必须带上问答与前次回执，明确“在已有进展上继续”，
      // 不能用与首轮完全相同的 prompt 盲重放（可能重复修改文件）。
      // priorResult 走模型可见白名单：存储里的 stderr 路径等内部字段不透给 CLI。
      const continuation = answers.flatMap((a, i) => [
        `追问 ${i + 1}：${a.question}`,
        `用户回答：${a.answer}`,
        ...(a.priorResult ? [`前次执行回执：${JSON.stringify(modelVisiblePriorResult(a.priorResult)).slice(0, 2000)}`] : []),
      ])
      const prompt = [
        `任务目标：${decision.objective}`,
        `完成标准：${decision.completionCriteria.map((c, i) => `${i + 1}. ${c}`).join('；')}`,
        ...(continuation.length
          ? ['续作上下文：本任务此前已执行并向你追问，用户已作答。在已有进展上继续；此前已完成且回答未要求变更的工作不要重做。', ...continuation]
          : []),
        cliGuardrails,
      ].join('\n')

      const handle = backend.runDetached(prompt, {
        cwd: projectPath,
        envExclude: this.options.envExclude ?? defaultCliEnvExclude,
      })
      this.options.onExecutionTrace?.(run, {
        backend: backendName,
        pid: handle.pid,
        artifactStdoutPath: handle.artifactStdoutPath,
        artifactStderrPath: handle.artifactStderrPath,
      })
      // 单次挂接 catch，之后所有 race 共用，避免晚到的 rejection 变 unhandled。
      const settled: Promise<{ ok: boolean; result?: AgentRunResult }> = handle.done.then(
        result => ({ ok: true as const, result }),
        () => ({ ok: false as const }),
      )
      const cliTimeoutMs = this.options.cliTimeoutMs ?? 600_000
      let timeout!: () => void
      const timeoutPromise = new Promise<{ kind: 'timeout' }>(resolve => { timeout = () => resolve({ kind: 'timeout' }) })
      const timer = setTimeout(timeout, cliTimeoutMs)
      timer.unref?.()
      const outcome = await Promise.race([
        settled.then(s => (s.ok ? { kind: 'done' as const, result: s.result! } : { kind: 'error' as const })),
        timeoutPromise,
        new Promise<{ kind: 'aborted' }>(resolve => {
          entry.controller.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true })
        }),
      ])
      clearTimeout(timer)

      if (outcome.kind === 'aborted' || outcome.kind === 'timeout') {
        const exit = await this.confirmExit(settled, handle)
        execution = this.executionRecord(backendName, handle, exit.result, exit.confirmed)
        if (outcome.kind === 'aborted') return { kind: 'stopped', execution }
        return {
          kind: 'failed',
          body: `CLI 执行超过 ${Math.round(cliTimeoutMs / 1000)}s 预算，已取消（进程退出${exit.confirmed ? '已确认' : '未确认，已升级 SIGKILL 仍未退出'}）；任务未确认完成`,
          execution,
        }
      }
      if (outcome.kind === 'error') {
        execution = this.executionRecord(backendName, handle)
        if (entry.controller.signal.aborted) return { kind: 'stopped', execution }
        return { kind: 'failed', body: 'CLI 执行进程异常结束（详见 stderr artifact）', execution }
      }
      const result = outcome.result
      execution = this.executionRecord(backendName, handle, result)
      // 判读前把含 sessionId/退出码的完整记录补绑进运行记录：即使判读失败，CLI 实际结局也不丢。
      this.options.onExecutionTrace?.(run, execution)
      if (entry.controller.signal.aborted) return { kind: 'stopped', execution }

      // 判读回合：模型只看到执行摘要，不看完整 stdout（全文在 artifact 文件里）。
      // stderr 路径与 execution 留痕只进存储，不进模型输入。
      const summary = {
        objective: decision.objective,
        completionCriteria: decision.completionCriteria,
        ...(answers.length ? { answers: answers.map(a => ({ question: a.question, answer: a.answer, priorResult: a.priorResult ? modelVisiblePriorResult(a.priorResult) : null })) } : {}),
        backend: backendName,
        project: decision.project,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
        warnings: result.warnings,
        lastMessage: result.stdout.slice(-4000),
        artifactStdoutPath: handle.artifactStdoutPath,
      }
      let state: ScopedState | undefined, receipt: FakeReceipt | undefined
      const tools: Record<string, ScopedTool> = {
        ask: { fields: { body: 'text' }, terminal: true, execute: a => { const r = { kind: 'waiting_input' as const, body: String(a.body), execution }; receipt = r; return r } },
        finish: { fields: { body: 'text' }, terminal: true, execute: a => { const r = { kind: 'completed' as const, body: String(a.body), execution }; receipt = r; return r } },
      }
      await scopedTurn({
        model: this.options.model, signal: entry.controller.signal, timeoutMs: this.options.turnTimeoutMs,
        protocolCorrection: true,
        initial: [
          { role: 'system', content: this.options.systemPrompt ?? cliJudgeSystemPrompt },
          { role: 'user', content: JSON.stringify(summary) },
        ],
        tools,
        load: () => state, save: s => { state = s }, commit: work => { state = work(); return state },
      })
      return receipt ?? { kind: 'failed', body: '判读回合未提交结论', execution }
    } catch (error) {
      if (entry.controller.signal.aborted) return { kind: 'stopped', ...(execution ? { execution } : {}) }
      return { kind: 'failed', body: `CLI 执行或判读失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 2000), ...(execution ? { execution } : {}) }
    } finally {
      this.active.delete(run.id)
    }
  }
}
