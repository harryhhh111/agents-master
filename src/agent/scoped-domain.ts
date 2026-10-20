import type { Run, FakeReceipt } from '../main/coordination/store.js'
import type { FakeExecutor } from '../main/coordination/fake.js'
import type { ScopedModel } from './scoped-protocol.js'
import { scopedTurn, type ScopedState, type ScopedTool } from './scoped-turn.js'
export function domainTools(receive: (receipt: FakeReceipt) => void): Record<string, ScopedTool> {
  return {
    synthetic_inspect: { fields: {}, execute: () => ({ synthetic: true, evidence: '合成样本；未读取项目文件或运行 CLI' }) },
    ask: { fields: { body: 'text' }, terminal: true, execute: a => { const r = { kind: 'waiting_input' as const, body: String(a.body) }; receive(r); return r } },
    finish: { fields: { body: 'text' }, terminal: true, execute: a => { const r = { kind: 'completed' as const, body: String(a.body) }; receive(r); return r } },
  }
}
export const defaultDomainSystemPrompt = '工作项目 Agent。仅模拟联调；检查合成样本，需要信息时 ask，完成时 finish。不得声称真实执行。'
export interface ScopedDomainExecutorOptions {
  systemPrompt?: string
  /** 整个领域回合（含多轮工具调用）的总时限；真实模型需要显著大于默认 15s。 */
  turnTimeoutMs?: number
  noResultNote?: string
  failureNote?: string
  /** 真实模型模式：输出校验失败且本回合尚未执行任何工具时，允许模型修正一次。 */
  protocolCorrection?: boolean
}
const defaultDomainNotes = {
  noResultNote: '模拟领域回合未提交结果',
  failureNote: '模拟领域模型回合失败或超时；未执行真实项目',
}
/** Background run sees only the frozen domain checkpoint, never the main context. */
export class ScopedDomainExecutor implements FakeExecutor {
  readonly identity = 'FAKE' as const
  private readonly active = new Map<string, AbortController>()
  private readonly systemPrompt: string
  private readonly turnTimeoutMs?: number
  private readonly noResultNote: string
  private readonly failureNote: string
  private readonly protocolCorrection: boolean
  constructor(private readonly model: ScopedModel, systemPromptOrOptions: string | ScopedDomainExecutorOptions = defaultDomainSystemPrompt) {
    const options: ScopedDomainExecutorOptions = typeof systemPromptOrOptions === 'string' ? { systemPrompt: systemPromptOrOptions } : systemPromptOrOptions
    this.systemPrompt = options.systemPrompt ?? defaultDomainSystemPrompt
    this.turnTimeoutMs = options.turnTimeoutMs
    this.noResultNote = options.noResultNote ?? defaultDomainNotes.noResultNote
    this.failureNote = options.failureNote ?? defaultDomainNotes.failureNote
    this.protocolCorrection = options.protocolCorrection ?? false
  }
  stop(id: string): void { this.active.get(id)?.abort() }
  async execute(run: Readonly<Run>): Promise<FakeReceipt | { kind: 'stopped' }> {
    const controller = new AbortController(); this.active.set(run.id, controller)
    let state: ScopedState | undefined, receipt: FakeReceipt | undefined
    try {
      await scopedTurn({ model: this.model, signal: controller.signal, timeoutMs: this.turnTimeoutMs, protocolCorrection: this.protocolCorrection,
        initial: [{ role: 'system', content: this.systemPrompt }, { role: 'user', content: run.context }],
        tools: domainTools(r => { receipt = r }), load: () => state, save: s => { state = s }, commit: work => { state = work(); return state },
      })
      return receipt ?? { kind: 'failed', body: this.noResultNote }
    } catch { return controller.signal.aborted ? { kind: 'stopped' } : { kind: 'failed', body: this.failureNote } }
    finally { this.active.delete(run.id) }
  }
}
