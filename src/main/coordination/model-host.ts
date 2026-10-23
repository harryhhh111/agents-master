import { ScopedProtocolError, ScopedTimeoutError, type ScopedModel, type WireMessage } from '../../agent/scoped-protocol.js'
import { defaultScopedTurnTexts, scopedTurn, type ScopedState, type ScopedTool } from '../../agent/scoped-turn.js'
import { CoordinationStore, FAKE_GROUP, type FrontTurn } from './store.js'
import { FakeBackgroundScheduler, type FakeExecutor } from './fake.js'

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
}
export const defaultCoordinationHostLabels: CoordinationHostLabels = {
  policy: '仅模拟联调，不能声称真实项目执行。仅明确工作委托使用 delegate；含糊需求用普通文本澄清，不创建任务。answer 只回答绑定待决问题，cancel 只取消指定任务。',
  deliverPrefix: '模拟/联调回传：',
  cancelNote: '模拟取消请求已记录：',
  recordedNote: defaultScopedTurnTexts.recorded,
  clarifyNote: defaultScopedTurnTexts.clarify,
  failedNote: defaultScopedTurnTexts.failed,
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
    private readonly onSuggestMemory?: (fact: string, sourceEvent: string) => unknown) {
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
      directory: { fields: {}, execute: () => ({ conversation: FAKE_GROUP, project: 'FAKE-project', scope: 'synthetic' }) },
      status: { fields: {}, execute: () => ({ assignments: this.store.assignments(FAKE_GROUP).map(a => ({ id: a.id, status: a.status })), questions: this.store.questions(FAKE_GROUP) }) },
      delegate: { fields: { objective: 'text', completionCriteria: 'texts' }, terminal: true, execute: a => this.store.accept(turn.conversation, turn.event.id, { action: 'fake-check', objective: String(a.objective), scope: ['synthetic'], completionCriteria: a.completionCriteria as string[] }) },
      // 真实 CLI 委派仅在组装方注入白名单时存在；store 侧再校验一次（纵深防御）。
      ...(this.cliProjects ? {
        delegate_cli: { fields: { project: 'text', backend: 'text', objective: 'text', completionCriteria: 'texts' }, terminal: true,
          description: `真实 CLI 委派。project 仅限白名单：${this.cliProjects.join('、')}；backend 仅限：${this.store.allowedBackends.join('、')}。`,
          execute: (a: Record<string, unknown>) => this.store.accept(turn.conversation, turn.event.id, { action: 'cli-task', objective: String(a.objective), scope: ['project'], project: String(a.project), backend: String(a.backend), completionCriteria: a.completionCriteria as string[] }) },
      } : {}),
      answer: { fields: { questionId: 'text' }, terminal: true, execute: a => this.store.answer(FAKE_GROUP, String(a.questionId), turn.conversation, turn.event.id) },
      cancel: { fields: { assignmentId: 'text' }, terminal: true, execute: a => this.store.cancel(FAKE_GROUP, String(a.assignmentId)) },
      // 提议制记忆：仅主对话、仅组装方注入接收器时存在；非终止工具，模型提议后继续回复。
      ...(this.onSuggestMemory && turn.conversation === 'main' ? {
        suggest_memory: { fields: { fact: 'text' }, description: '提议记住用户在对话中明示的关于其自身的稳定事实（如居住、偏好、长期计划）。仅复述用户明确说过的内容，不做推测；每回合至多一条；普通对话、临时事项、任务相关内容不要使用。',
          execute: a => ({ suggested: (this.onSuggestMemory!(String(a.fact), turn.event.id) as { id: string }).id }) },
      } : {}),
    }
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
      const policy = this.labels.policy + (this.cliProjects?.length ? `\ndelegate_cli 的 project 仅限白名单：${this.cliProjects.join('、')}；backend 仅限：${this.store.allowedBackends.join('、')}。` : '')
      const initial: WireMessage[] = [{ role: 'system', content: (main ? (c === 'main' ? this.checkpoint : '群内主 Agent，仅使用本群上下文。') : '工作项目 Agent，仅使用本群上下文；可通过受限协调工具委派合成工作。') + '\n' + policy + '\n' + contextFormatNote }, ...turn.context.map(m => renderContextMessage(m, author))]
      const current = turn
      const reply = await scopedTurn({ model: main ? this.mainModel : this.domainModel, initial, tools: this.tools(turn), signal: controller.signal, timeoutMs: this.turnTimeoutMs,
        texts: { recorded: this.labels.recordedNote, clarify: this.labels.clarifyNote, failed: this.labels.failedNote },
        protocolCorrection: this.protocolCorrection,
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
          const failed: ScopedState = state?.failure ? state : { ...(state ?? { messages: [], rounds: 0, ids: [] }), final: this.labels.failedNote, failure: { kind: 'provider', reason: 'Provider request failed or attempts exhausted' } }
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
