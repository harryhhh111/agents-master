import { ScopedProtocolError, ScopedTimeoutError, type ScopedModel, type WireMessage } from '../../agent/scoped-protocol.js'
import { defaultScopedTurnTexts, scopedTurn, type ScopedState, type ScopedTool } from '../../agent/scoped-turn.js'
import { CoordinationStore, FAKE_GROUP, type Assignment, type FrontTurn, type Run } from './store.js'
import { FakeBackgroundScheduler, type FakeExecutor } from './fake.js'
import type { Workspace } from './workspace.js'

export function addressedMain(conversation: string, content: string): boolean {
  return conversation === 'main' || content.startsWith('@main ') || content.startsWith('@主 Agent ')
}

/** 早期上下文以 {author,text} 信封喂给模型，真实模型会模仿该格式回复（2026-10-22 线上事故）。
 *  新上下文改用 lorca 式渲染（见 renderContextMessage）；此函数保留作兜底：
 *  存储与展示前剥掉信封，仅当全文恰是单个 JSON 对象、只有 author/text 两键且均为字符串时。
 *  仅 {text} 的 JSON 不算信封——用户可能本来就在讨论 JSON（2026-10-23 复核 C2）。 */
export function unwrapAuthorEnvelope(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return content
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && typeof parsed.author === 'string' && typeof parsed.text === 'string'
        && Object.keys(parsed).every(k => k === 'author' || k === 'text')) return parsed.text
  } catch { /* 非信封，按原文处理 */ }
  return content
}
/** 发言者显示名，与 web 页面（web-page.ts 的 name 映射）保持一致。 */
const speakerNames: Record<string, string> = { user: '你', 'main-agent': '主 Agent', 'fake-work-agent': '工作项目 Agent' }
export function speakerName(author: string): string { return speakerNames[author] ?? author }
/** 上下文渲染（lorca 式，依据 docs/open-agent-reference-study-2026-10-22.md 第四节）：
 *  自己的历史是 assistant 原文——模型没有信封模板可模仿；其他 Agent 消息以 user 角色携带
 *  `[名字]: ` 前缀，存量 JSON 信封内容先剥壳；行首 [ 转义为 ［，防止伪造归属行。
 *  用户消息保持原文：用户可能本来就在发送 JSON，剥壳会改掉用户输入（2026-10-23 复核 C2）。 */
export function renderContextMessage(m: { author: string; content: string }, self: string): WireMessage {
  if (m.author === 'user') return { role: 'user', content: m.content.replace(/^(\s*)\[/gm, '$1［') }
  const text = unwrapAuthorEnvelope(m.content)
  if (m.author === self) return { role: 'assistant', content: text }
  return { role: 'user', content: `[${speakerName(m.author)}]: ${text.replace(/^(\s*)\[/gm, '$1［')}` }
}
/** 系统提示中声明上下文格式，配合 renderContextMessage。 */
const contextFormatNote = '上下文中其他成员的发言以 [名字]: 前缀出现在 user 消息里；你的历史回复是 assistant 原文。回复只说正文，不要加任何前缀或 JSON 包装。'
export interface CoordinationHostLabels {
  policy: string
  deliverPrefix: string
  cancelNote: string
  recordedNote: string
  clarifyNote: string
  failedNote: string
  /** 回合失败但此前已执行过非终止工具（如记忆操作已落库）时的诚实文案：不能再说"未接受新的操作"。 */
  partialNote: string
}
export const defaultCoordinationHostLabels: CoordinationHostLabels = {
  policy: '仅模拟联调，不能声称真实项目执行。仅明确工作委托使用 delegate；含糊需求用普通文本澄清，不创建任务。answer 只回答绑定待决问题，cancel 只取消指定任务。',
  deliverPrefix: '模拟/联调回传：',
  cancelNote: '模拟取消请求已记录：',
  recordedNote: defaultScopedTurnTexts.recorded,
  clarifyNote: defaultScopedTurnTexts.clarify,
  failedNote: defaultScopedTurnTexts.failed,
  partialNote: '模拟回合回复未完成，但此前的查询或记忆操作可能已生效；请询问当前状态以实际情况为准。',
}
/** 主对话记忆工具的服务端桥接（docs/main-agent-memory-repair-plan-2026-10-24.md）：
 *  查询/写入的事件来源与操作标识由宿主绑定（turn.event.id），模型不能伪造用户指令来源。 */
export interface MemoryToolSink {
  suggest(fact: string, sourceEvent: string): unknown
  read(): unknown
  manage(action: 'confirm' | 'correct' | 'forget', id: string, newFact: string | undefined, operationId: string, sourceEvent: string): unknown
}
/** 权限档位（与 config.ts delegation.level 同源）。readonly 档不暴露真实执行委派。 */
export type PermissionLevel = 'readonly' | 'supervised' | 'workspace'
/** 宿主环境与权限的每回合实时来源（docs/main-agent-workspace-plan-2026-10-24.md 2026-10-27 约束）：
 *  快照作为独立 user 消息注入主对话上下文，不写进 system checkpoint（保前缀稳定）；
 *  工具清单、可委派范围、档位均来自本轮实际配置，不允许第二份手写名单。 */
export interface HostEnvironment {
  /** 生成本回合宿主环境快照文本；toolNames 为本回合实际注册的工具名。 */
  snapshot(toolNames: readonly string[], level: PermissionLevel): string
  /** 当前有效权限档位；每回合读取，界面切档后下一回合生效。 */
  permissionLevel(): PermissionLevel
}
export class CoordinationHost {
  private readonly busy = new Set<string>()
  private readonly blocked = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private readonly background: FakeBackgroundScheduler
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private foregroundActive = false
  private nextScope = 0
  checkpoint = '模拟/联调主 Agent；仅受限合成任务，不能声称真实检查。含糊需求先澄清。'
  constructor(readonly store: CoordinationStore, private readonly mainModel: ScopedModel, private readonly domainModel: ScopedModel,
    private readonly executor: FakeExecutor & { stop?(id: string): void }, private readonly changed: () => void = () => {},
    private readonly labels: CoordinationHostLabels = defaultCoordinationHostLabels, private readonly turnTimeoutMs?: number,
    private readonly protocolCorrection = false, private readonly cliProjects?: readonly string[],
    private readonly memory?: MemoryToolSink,
    /** 主对话只读工作区视野（项目/文件/搜索/Git/任务产物）；undefined 时工具不暴露。 */
    private readonly workspace?: Workspace,
    /** 主对话回合的模型调用预算（默认 3）；研究流需要更高预算，群聊保持默认。 */
    private readonly mainMaxRounds?: number,
    /** 宿主环境快照与权限档位来源；undefined 时不注入快照、不做档位门控（合成/测试默认）。 */
    private readonly hostEnv?: HostEnvironment) {
    this.background = new FakeBackgroundScheduler(store, executor, changed)
  }
  start(): void {
    for (const c of ['main', FAKE_GROUP]) this.store.recover(c)
    this.timer = setInterval(() => this.pump(), 25); this.timer.unref(); this.pump()
  }
  status(c: string): 'idle' | 'processing' | 'blocked' { return this.blocked.has(c) ? 'blocked' : this.busy.has(c) ? 'processing' : 'idle' }
  submit(c: string, key: string, text: string): unknown { const r = this.store.admit(c, key, text); if (!r.duplicate) this.changed(); this.pump(); return r }
  retry(c: string): void { this.blocked.delete(c); this.pump() }
  cancel(c: string, eventId: string, id: string): unknown {
    // Source-bound cancellation is committed through the same protocol path.
    const turn = { conversation: c, event: { id: eventId } } as FrontTurn
    const prior = this.store.protocol<ScopedState>(turn)
    if (prior?.final) return prior.final
    return this.store.commitProtocol(turn, () => this.store.cancel(FAKE_GROUP, id), result => ({ messages: [], rounds: 0, ids: [], final: this.labels.cancelNote + result.status }))
  }
  private tools(turn: FrontTurn): Record<string, ScopedTool> {
    return {
      // 注入工作区后 directory 返回真实项目目录（替换 FAKE-project 合成事实）；合成/demo 模式保持原样。
      directory: { fields: {}, readonly: true, description: this.workspace ? '列出当前工作区的真实项目目录（注册项目与授权根目录下发现的项目）。' : undefined,
        execute: async () => this.workspace ? { projects: await this.workspace.listProjects() } : { conversation: FAKE_GROUP, project: 'FAKE-project', scope: 'synthetic' } },
      status: { fields: {}, execute: () => ({ assignments: this.store.assignments(FAKE_GROUP).map(a => ({ id: a.id, status: a.status })), questions: this.store.questions(FAKE_GROUP) }) },
      delegate: { fields: { objective: 'text', completionCriteria: 'texts' }, terminal: true, execute: a => this.store.accept(turn.conversation, turn.event.id, { action: 'fake-check', objective: String(a.objective), scope: ['synthetic'], completionCriteria: a.completionCriteria as string[] }) },
      // 真实 CLI 委派仅在组装方注入白名单时存在；store 侧再校验一次（纵深防御）。
      // readonly 档位不暴露真实执行委派（宿主层门控，不依赖模型自觉）。
      ...(this.cliProjects && this.hostEnv?.permissionLevel() !== 'readonly' ? {
        delegate_cli: { fields: { project: 'text', backend: 'text', objective: 'text', completionCriteria: 'texts' }, terminal: true,
          description: `真实 CLI 委派。project 仅限白名单：${this.cliProjects.join('、')}；backend 仅限：${this.store.allowedBackends.join('、')}。`,
          execute: (a: Record<string, unknown>) => this.store.accept(turn.conversation, turn.event.id, { action: 'cli-task', objective: String(a.objective), scope: ['project'], project: String(a.project), backend: String(a.backend), completionCriteria: a.completionCriteria as string[] }) },
      } : {}),
      answer: { fields: { questionId: 'text' }, terminal: true, execute: a => this.store.answer(FAKE_GROUP, String(a.questionId), turn.conversation, turn.event.id) },
      cancel: { fields: { assignmentId: 'text' }, terminal: true, execute: a => this.store.cancel(FAKE_GROUP, String(a.assignmentId)) },
      // 提议制记忆：仅主对话、仅组装方注入桥接时存在；均为非终止工具，模型操作后继续回复。
      // 事件来源与 correct 操作标识由宿主绑定（turn.event.id），模型不能伪造用户指令来源。
      ...(this.memory && turn.conversation === 'main' ? {
        suggest_memory: { fields: { fact: 'text' }, description: '提议记住用户在对话中明示的关于其自身的稳定事实（如居住、偏好、长期计划）。仅复述用户明确说过的内容，不做推测；每回合至多一条；普通对话、临时事项、任务相关内容不要使用。',
          execute: a => this.memory!.suggest(String(a.fact), turn.event.id) },
        read_memories: { fields: {}, description: '读取当前记忆列表（记录 ID、内容、状态、来源、更新时间）。回答"你记住了什么""刚才确认成功了吗"等状态问题前调用自查，以返回结果为准。',
          execute: () => this.memory!.read() },
        confirm_memory: { fields: { id: 'text' }, description: '用户明确说确认某条记忆提议时调用，id 为记录 ID。仅在返回 applied=true 或记录已是 confirmed 时说已确认。',
          execute: a => this.memory!.manage('confirm', String(a.id), undefined, '', turn.event.id) },
        correct_memory: { fields: { id: 'text', newFact: 'text' }, description: '用户明确说把某条记忆改成新内容时调用：旧记录作废，newFact 成为当前事实。普通讨论、假设或你的推测都不是修改授权；目标不清时先用普通文本询问。',
          execute: a => this.memory!.manage('correct', String(a.id), String(a.newFact), `${turn.event.id}:${String(a.id)}:${String(a.newFact)}`, turn.event.id) },
        forget_memory: { fields: { id: 'text' }, description: '用户明确说忘记/不再使用某条记忆时调用，id 为记录 ID。忘记后该事实不再作为当前事实使用，但原始聊天记录不受影响。',
          execute: a => this.memory!.manage('forget', String(a.id), undefined, '', turn.event.id) },
      } : {}),
      // 只读工作区视野（docs/main-agent-workspace-plan-2026-10-24.md）：仅主对话、仅组装方注入工作区时存在。
      // 全部 readonly：在写事务外执行；未找到/截断/超时以错误对象如实返回，不抛协议错误。
      ...(this.workspace && turn.conversation === 'main' ? {
        list_projects: { fields: {}, readonly: true, description: '列出工作区项目：名称、路径、一句话说明、是否可委派真实执行。包含注册项目与授权根目录下发现的项目目录；当前系统本身就是 agents-master 项目（本产品）。',
          execute: () => this.workspace!.listProjects() },
        list_files: { fields: { project: 'text', path: 'text' }, readonly: true, description: '列出项目内目录内容（名称、大小、修改时间）；project 为项目名，path 为项目内相对路径，填 "." 表示项目根。',
          execute: a => this.workspace!.listFiles(String(a.project), String(a.path)) },
        read_file: { fields: { project: 'text', path: 'text', startLine: 'text' }, readonly: true, description: '按行读取项目内文本文件（返回带行号，每次至多 400 行，截断会注明）；startLine 填 "1" 表示从头读。凭据与密钥文件、CLI 原始日志不可读。',
          execute: a => this.workspace!.readFile(String(a.project), String(a.path), Number.parseInt(String(a.startLine), 10) || 1) },
        search_files: { fields: { project: 'text', query: 'text' }, readonly: true, description: '在项目内搜索文件名与文本内容（跳过依赖目录、Git 对象库与 CLI 原始日志），返回匹配文件、行号与摘录；结果截断会注明。',
          execute: (a, signal) => this.workspace!.searchFiles(String(a.project), String(a.query), signal) },
        project_status: { fields: { project: 'text' }, readonly: true, description: '读取项目的 Git 状态：当前分支、HEAD、未提交改动数、近期 5 条提交，附读取时间。',
          execute: (a, signal) => this.workspace!.projectStatus(String(a.project), signal) },
        task_detail: { fields: { id: 'text' }, readonly: true, description: '按任务 ID 或 run ID（可唯一前缀）查询工作群任务：目标、项目、状态、待答问题、执行留痕与结果摘要。',
          execute: a => this.taskDetail(String(a.id)) },
        read_artifact: { fields: { id: 'text', path: 'text' }, readonly: true, description: '读取任务绑定的公开产物核对实际输出；id 为任务或 run ID，path 为产物目录内相对路径，填 "stdout" 取 CLI 标准输出。stderr 原始日志不开放。',
          execute: a => this.runArtifact(String(a.id), String(a.path)) },
      } : {}),
    }
  }
  /** 任务/run 的唯一前缀解析（模型会回用自己展示过的短 ID，与记忆工具同规则）。 */
  private resolveTaskId(id: string): { assignment?: Assignment; run?: Run } | { error: string } {
    const match = <T extends { id: string }>(items: T[]): T | undefined =>
      items.find(x => x.id === id) ?? (items.filter(x => x.id.startsWith(id)).length === 1 ? items.find(x => x.id.startsWith(id)) : undefined)
    const run = match(this.store.runs(FAKE_GROUP))
    const assignment = match(this.store.assignments(FAKE_GROUP)) ?? (run ? this.store.assignments(FAKE_GROUP).find(a => a.id === run.assignment_id) : undefined)
    if (!assignment) return { error: '未找到该任务或 run；任务列表可用 status 工具查看。' }
    return { assignment, run }
  }
  private taskDetail(id: string): unknown {
    const r = this.resolveTaskId(id)
    if ('error' in r) return r
    const a = r.assignment!
    const decision = JSON.parse(a.decision) as { action: string; objective: string; project?: string; backend?: string; completionCriteria?: string[] }
    const runs = this.store.runs(FAKE_GROUP).filter(x => x.assignment_id === a.id).map(run => {
      const execution = (JSON.parse(run.context) as { execution?: Record<string, unknown> }).execution
      const result = run.result ? JSON.parse(run.result) as { kind?: string; body?: string } : null
      return {
        id: run.id, status: run.status, executor: run.executor,
        execution: execution ? { backend: execution.backend, sessionId: execution.sessionId, exitCode: execution.exitCode, durationMs: execution.durationMs, artifactStdoutPath: execution.artifactStdoutPath, cancelConfirmed: execution.cancelConfirmed } : undefined,
        result: result ? { kind: result.kind, body: typeof result.body === 'string' ? result.body.slice(0, 2000) : undefined } : undefined,
      }
    })
    const questions = this.store.questions(FAKE_GROUP).filter(q => q.assignment_id === a.id)
      .map(q => ({ id: q.id, status: q.status, body: q.body.slice(0, 500), answer: q.answer?.slice(0, 500) }))
    return { id: a.id, status: a.status, version: a.version, objective: decision.objective, action: decision.action,
      project: decision.project ?? a.project_key, backend: decision.backend, completionCriteria: decision.completionCriteria, runs, questions }
  }
  private async runArtifact(id: string, rel: string): Promise<unknown> {
    const r = this.resolveTaskId(id)
    if ('error' in r) return r
    const run = r.run ?? this.store.runs(FAKE_GROUP).filter(x => x.assignment_id === r.assignment!.id).at(-1)
    if (!run) return { error: '该任务还没有执行记录。' }
    const execution = (JSON.parse(run.context) as { execution?: { artifactStdoutPath?: string; artifactStderrPath?: string } }).execution
    if (!execution?.artifactStdoutPath) return { error: '该任务没有产物记录（可能不是 CLI 执行或执行未启动）。' }
    const target = rel === 'stdout' ? execution.artifactStdoutPath.split('/').pop()! : rel
    return this.workspace!.readArtifact(execution.artifactStdoutPath, execution.artifactStderrPath, target)
  }
  private async step(c: string): Promise<boolean> {
    let turn: FrontTurn | undefined
    let progressed = false
    let author = c === 'main' ? 'main-agent' : 'fake-work-agent'
    const controller = new AbortController(); this.controllers.add(controller)
    try {
      const deliver = () => { for (const o of this.store.pendingOutbox(c)) if (this.store.deliver(c, o.id, this.labels.deliverPrefix + o.body)) { progressed = true; return true }; return false }
      if (this.store.userTurnCount(c) >= 3 && deliver()) return true
      turn = this.store.beginChat(c)
      if (!turn) return deliver()
      this.busy.add(c); this.changed()
      const main = addressedMain(c, turn.context.at(-1)?.content ?? '')
      author = main ? 'main-agent' : 'fake-work-agent'
      const tools = this.tools(turn)
      const level = this.hostEnv?.permissionLevel()
      const policy = this.labels.policy
        + (this.cliProjects?.length && level !== 'readonly' ? `\ndelegate_cli 的 project 仅限白名单：${this.cliProjects.join('、')}；backend 仅限：${this.store.allowedBackends.join('、')}。` : '')
        + (level === 'readonly' ? '\n当前为只读权限档位：不能发起真实执行委派，只能查询与讨论；如需执行请让用户在设置中调整档位。' : '')
      // 宿主环境快照：独立 user 消息（动态事实不进 system checkpoint，保前缀稳定），仅主对话注入；
      // 含本回合实际注册工具清单——能力说明以实际注册为准，不维护第二份手写名单。
      const snapshot = c === 'main' && this.hostEnv && level
        ? [{ role: 'user' as const, content: this.hostEnv.snapshot(Object.keys(tools), level) }]
        : []
      const initial: WireMessage[] = [{ role: 'system', content: (main ? (c === 'main' ? this.checkpoint : '群内主 Agent，仅使用本群上下文。') : '工作项目 Agent，仅使用本群上下文；可通过受限协调工具委派合成工作。') + '\n' + policy + '\n' + contextFormatNote }, ...snapshot, ...turn.context.map(m => renderContextMessage(m, author))]
      const current = turn
      const reply = await scopedTurn({ model: main ? this.mainModel : this.domainModel, initial, tools, signal: controller.signal, timeoutMs: this.turnTimeoutMs,
        texts: { recorded: this.labels.recordedNote, clarify: this.labels.clarifyNote, failed: this.labels.failedNote, partial: this.labels.partialNote },
        protocolCorrection: this.protocolCorrection,
        maxRounds: turn.conversation === 'main' ? this.mainMaxRounds : undefined,
        load: () => this.store.protocol<ScopedState>(current), save: s => this.store.saveProtocol(current, s),
        commit: work => this.store.commitProtocol(current, work, s => s),
      })
      if (!this.stopped) this.store.finishChat(turn, unwrapAuthorEnvelope(reply), author)
    } catch (error) {
      if (turn) {
        const state = this.store.protocol<ScopedState>(turn)
        const e = error as { name?: string; status?: number }
        const transient = error instanceof ScopedTimeoutError || ['APIConnectionError','APIConnectionTimeoutError'].includes(e?.name ?? '') || [408,429,500,502,503,504].includes(e?.status ?? 0)
        if (state?.final && !state.failure) {
          // Reply persistence failed after an accepted decision. Keep its
          // durable result intact; retry only the reply, never the action.
          this.store.releaseChat(turn); if (!this.stopped) this.blocked.add(c)
        } else if (!this.stopped && (error instanceof ScopedProtocolError || !transient || (state?.rounds ?? 0) >= 3)) {
          // 已执行过非终止工具（ids 非空，如记忆操作已落库）时不能声称"未接受新的操作"。
          const note = (state?.ids.length ?? 0) > 0 ? this.labels.partialNote : this.labels.failedNote
          const failed: ScopedState = state?.failure ? state : { ...(state ?? { messages: [], rounds: 0, ids: [] }), final: note, failure: { kind: 'provider', reason: 'Provider request failed or attempts exhausted' } }
          this.store.commitProtocol(turn, () => this.store.finishChat(turn!, failed.final!, author), () => failed)
        } else { this.store.releaseChat(turn); if (!this.stopped) this.blocked.add(c) }
      }
    } finally { this.controllers.delete(controller); this.busy.delete(c); if (turn || progressed) this.changed() }
    return !!turn || progressed
  }
  /** One foreground writer across both scopes; rotate after actual progress.
   * Background claiming/execution and input admission do not enter this queue. */
  private async foregroundSafePoint(): Promise<void> {
    this.foregroundActive = true
    const scopes = ['main', FAKE_GROUP]
    try {
      for (let offset = 0; offset < scopes.length && !this.stopped; offset++) {
        const index = (this.nextScope + offset) % scopes.length, c = scopes[index]!
        if (this.blocked.has(c)) continue
        if (await this.step(c)) { this.nextScope = (index + 1) % scopes.length; break }
      }
    } finally { this.foregroundActive = false }
  }
  pump(): void {
    if (this.stopped) return
    for (const r of this.store.runs(FAKE_GROUP)) if (r.status === 'cancel_requested') this.executor.stop?.(r.id)
    this.background.startNext(FAKE_GROUP)
    if (!this.foregroundActive) void this.foregroundSafePoint()
  }
  async close(): Promise<void> {
    this.stopped = true; clearInterval(this.timer)
    for (const c of this.controllers) c.abort()
    for (const r of this.store.runs(FAKE_GROUP)) this.executor.stop?.(r.id)
    while (this.foregroundActive) await new Promise(resolve => setTimeout(resolve, 1))
    this.background.close()
  }
}
