import { boundedRounds, deadline, pairedToolResult, strictArgs, validateCalls, ScopedProtocolError, type ModelReply, type ScopedModel, type ToolCall, type WireMessage, tool } from './scoped-protocol.js'
export const safeFailedTurn = '模拟/联调：本轮未能完成，未接受新的操作。请重新说明需求。'
export type ScopedState = { messages: WireMessage[]; rounds: number; ids: string[]; pending?: ModelReply; final?: string; failure?: { kind: 'protocol' | 'provider'; reason: string } }
export type ScopedTool = { fields: Record<string, 'text' | 'texts'>; execute(args: Record<string, unknown>): unknown; terminal?: boolean }
/** Bounded scoped runner sharing only AgentCore's iteration/pairing primitives.
 * This is not a persisted adaptation of the full legacy AgentCore loop.
 * No legacy default tool context exists. */
export async function scopedTurn(options: {
  model: ScopedModel; initial: WireMessage[]; tools: Record<string, ScopedTool>; signal?: AbortSignal; timeoutMs?: number;
  load(): ScopedState | undefined; save(state: ScopedState): void;
  commit(work: () => ScopedState): ScopedState;
}): Promise<string> {
  return deadline(async signal => {
    let state = options.load() ?? { messages: options.initial, rounds: 0, ids: [] }
    options.save(state)
    if (state.final) return state.final
    const reject = (reason: string): never => {
      state = { ...state, failure: { kind: 'protocol', reason }, final: safeFailedTurn }
      options.save(state)
      throw new ScopedProtocolError(reason)
    }
    const names = Object.keys(options.tools)
    for (const _ of boundedRounds(4)) {
      if (signal.aborted) throw new Error('Aborted')
      if (!state.pending) {
        if (state.rounds >= 3) reject('Round budget exceeded')
        // Persist attempts before calling so restarts cannot reset budgets.
        state.rounds++; options.save(state)
        const reply = await options.model.complete(state.messages, names.map(n => tool(n, options.tools[n]!.fields)), signal)
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
      } catch (error) { reject(error instanceof Error ? error.message : 'Invalid protocol') }
      // A terminal action ends this foreground turn; no subsequent model poll.
      try { state = options.commit(() => {
        const next: ScopedState = { messages: [...state.messages, { role: 'assistant', content: reply!.content, ...(calls.length ? { tool_calls: calls } : {}) }], rounds: state.rounds, ids: [...state.ids] }
        let terminal: unknown
        calls.forEach((c: ToolCall, i) => {
          const result = options.tools[c.function.name]!.execute(parsed[i]!)
          next.messages.push(pairedToolResult(c.id, JSON.stringify(result)))
          next.ids.push(c.id)
          if (options.tools[c.function.name]!.terminal) terminal = result
        })
        if (terminal !== undefined) next.final = '模拟/联调：已记录受限操作。' + JSON.stringify(terminal)
        else if (!calls.length) next.final = reply.content?.trim() || '模拟/联调：请补充具体需求。'
        return next
      }) } catch { reject('Tool action rejected; transaction rolled back') }
      if (state.final) return state.final
    }
    return reject('Round budget exceeded')
  }, options.timeoutMs ?? 15000, options.signal)
}
