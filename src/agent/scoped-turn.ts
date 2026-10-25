import { boundedRounds, deadline, pairedToolResult, strictArgs, validateCalls, ScopedProtocolError, type ModelReply, type ScopedModel, type ToolCall, type WireMessage, tool } from './scoped-protocol.js'
export const safeFailedTurn = '模拟/联调：本轮未能完成，未接受新的操作。请重新说明需求。'
export type ScopedTurnTexts = { recorded: string; clarify: string; failed: string; partial: string }
export const defaultScopedTurnTexts: ScopedTurnTexts = {
  recorded: '模拟/联调：已记录受限操作。',
  clarify: '模拟/联调：请补充具体需求。',
  failed: safeFailedTurn,
  /** 回合失败但此前已执行过非终止工具（ids 非空）时的诚实文案：不能声称"未接受新的操作"。 */
  partial: '模拟/联调：本轮回复未能完成；此前的查询或操作可能已生效，请以当前状态为准。',
}
export type ScopedState = { messages: WireMessage[]; rounds: number; ids: string[]; pending?: ModelReply; final?: string; failure?: { kind: 'protocol' | 'provider'; reason: string }
  /** 本回合已用的协议修正次数与每次被拒的原始输出；持久化以保证重启后不重复给修正机会、不丢证据。 */
  corrections?: number; rejected?: ModelReply[] }
export type ScopedTool = { fields: Record<string, 'text' | 'texts'>; execute(args: Record<string, unknown>, signal?: AbortSignal): unknown | Promise<unknown>; terminal?: boolean; /** 模型可见的工具说明（含允许取值）；缺省为工具名。 */ description?: string
  /** 只读工具（文件/搜索/状态查询）：在 commit 写事务外执行（可异步，受回合信号约束），
   *  结果仍随事务落账；不改变任何状态。仅只读工具允许返回 Promise。 */ readonly?: boolean }
/** 模型可见的修正反馈；协议校验失败发生在任何工具执行之前，给一次修正机会不等于重放操作。 */
export const scopedCorrectionPrompt = '上一次输出未通过协议校验，未执行任何操作。请严格按工具定义修正后重新输出。原因：'
/** Bounded scoped runner sharing only AgentCore's iteration/pairing primitives.
 * This is not a persisted adaptation of the full legacy AgentCore loop.
 * No legacy default tool context exists. */
export async function scopedTurn(options: {
  model: ScopedModel; initial: WireMessage[]; tools: Record<string, ScopedTool>; signal?: AbortSignal; timeoutMs?: number;
  texts?: Partial<ScopedTurnTexts>;
  /** 真实模型模式：输出校验失败且本回合尚未执行任何工具时，允许模型修正一次。 */
  protocolCorrection?: boolean;
  load(): ScopedState | undefined; save(state: ScopedState): void;
  commit(work: () => ScopedState): ScopedState;
  /** 本回合最大模型调用次数（默认 3）。只读研究流（发现→搜索→读取→总结）需要更高预算。 */
  maxRounds?: number;
}): Promise<string> {
  const texts: ScopedTurnTexts = { ...defaultScopedTurnTexts, ...options.texts }
  const maxRounds = options.maxRounds ?? 3
  return deadline(async signal => {
    let state = options.load() ?? { messages: options.initial, rounds: 0, ids: [] }
    options.save(state)
    if (state.final) return state.final
    const reject = (reason: string): never => {
      // 已执行过工具（ids 非空）时如实说明部分操作可能已生效，不谎报"未接受新的操作"。
      state = { ...state, failure: { kind: 'protocol', reason }, final: state.ids.length ? texts.partial : texts.failed }
      options.save(state)
      throw new ScopedProtocolError(reason)
    }
    const names = Object.keys(options.tools)
    for (const _ of boundedRounds(maxRounds + 1)) {
      if (signal.aborted) throw new Error('Aborted')
      if (!state.pending) {
        if (state.rounds >= maxRounds) reject('Round budget exceeded')
        // Persist attempts before calling so restarts cannot reset budgets.
        state.rounds++; options.save(state)
        const reply = await options.model.complete(state.messages, names.map(n => tool(n, options.tools[n]!.fields, options.tools[n]!.description)), signal)
        if (signal.aborted) throw new Error('Aborted')
        state.pending = reply; options.save(state)
      }
      const reply = state.pending
      let calls: ToolCall[] = [], parsed: Record<string, unknown>[] = []
      try {
        if (!reply || typeof reply !== 'object') throw new Error('Invalid model reply')
        calls = reply.tool_calls ?? []
        if (!Array.isArray(calls)) throw new Error('Invalid tool calls')
        validateCalls(calls, names, state.ids, 6 - state.ids.length)
        if (reply.content !== null && (typeof reply.content !== 'string' || reply.content.length > 12000)) throw new Error('Invalid model content')
        parsed = calls.map(c => strictArgs(c, options.tools[c.function.name]!.fields))
        if (calls.filter(c => options.tools[c.function.name]!.terminal).length > 1) throw new Error('Multiple terminal actions forbidden')
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Invalid protocol'
        // 校验失败发生在执行之前；仅当本回合尚未执行任何工具时给一次修正机会。
        // 修正次数与被拒原始输出都写入持久状态：重启后不得再次获得修正机会，证据不丢。
        if (options.protocolCorrection && (state.corrections ?? 0) === 0 && state.ids.length === 0) {
          state = { ...state, pending: undefined, corrections: 1, rejected: [...(state.rejected ?? []), reply!],
            messages: [...state.messages, { role: 'user' as const, content: scopedCorrectionPrompt + reason }] }
          options.save(state)
          continue
        }
        reject(reason)
      }
      // A terminal action ends this foreground turn; no subsequent model poll.
      try {
        // 只读工具在 SQLite 写事务外异步执行：文件搜索/读取/Git 查询不阻塞事件循环、不进事务，
        // 并接收回合取消/超时信号；其结果与状态变更工具的落账仍在同一 commit 内，顺序与 calls 一致。
        const preResults = new Map<string, unknown>()
        for (const [i, c] of calls.entries()) {
          const t = options.tools[c.function.name]!
          if (t.readonly) preResults.set(c.id, await t.execute(parsed[i]!, signal))
        }
        state = options.commit(() => {
        const next: ScopedState = { messages: [...state.messages, { role: 'assistant', content: reply!.content, ...(calls.length ? { tool_calls: calls } : {}) }], rounds: state.rounds, ids: [...state.ids], ...(state.corrections !== undefined ? { corrections: state.corrections } : {}), ...(state.rejected !== undefined ? { rejected: state.rejected } : {}) }
        let terminal: unknown
        calls.forEach((c: ToolCall, i) => {
          const result = preResults.has(c.id) ? preResults.get(c.id) : options.tools[c.function.name]!.execute(parsed[i]!, signal)
          next.messages.push(pairedToolResult(c.id, JSON.stringify(result)))
          next.ids.push(c.id)
          if (options.tools[c.function.name]!.terminal) terminal = result
        })
        if (terminal !== undefined) next.final = texts.recorded + JSON.stringify(terminal)
        else if (!calls.length) next.final = reply.content?.trim() || texts.clarify
        return next
      }) } catch (error) {
        // commit 事务回滚保证未写入任何操作；与校验失败同等对待：未执行过工具的回合给一次修正。
        const reason = error instanceof Error ? error.message : 'Tool action rejected'
        if (options.protocolCorrection && (state.corrections ?? 0) === 0 && state.ids.length === 0) {
          state = { ...state, pending: undefined, corrections: 1, rejected: [...(state.rejected ?? []), reply!],
            messages: [...state.messages, { role: 'user' as const, content: scopedCorrectionPrompt + reason }] }
          options.save(state)
          continue
        }
        reject('Tool action rejected; transaction rolled back')
      }
      if (state.final) return state.final
    }
    return reject('Round budget exceeded')
  }, options.timeoutMs ?? 15000, options.signal)
}
