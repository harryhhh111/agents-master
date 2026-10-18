import type { MainConversationMessage } from '../main/types.js'
import type { FrontBrainMessage } from './types.js'

/** Request-only reminder: contains no owner facts and is never persisted. */
export const currentTurnGroundingReminder = '本轮回答前，请读取开头检查点中实际提供的用户背景，并结合用户消息回答；事实以用户当前陈述和纠正为先。历史 assistant 自述不证明当前上下文缺失，也不能覆盖可见事实；不要一概否定旧回答。若旧回答与可见事实冲突，简短承认回答不准确并纠正，不要编造“之前没传来”等原因。空模板或未提供的事实仍是未知，不得推断已有背景。本提示不增加记忆、任务或外部行动能力及授权。'

export interface FrontBrainContextInput {
  /** Stable system instructions. Must be non-empty and is passed through verbatim. */
  instructions: string
  /** Optional stable checkpoint, appended verbatim right after the instructions. */
  checkpoint?: string
  /** Foreground opt-in; conditionally remind just before the final user anchor. */
  groundCurrentTurn?: boolean
  /**
   * Persisted main conversation messages, e.g. from
   * MainConversationStore.readRecentContext(). Composition never mutates,
   * re-writes, or reorders content: the store supplies durable admission
   * order, which is canonical even when timestamps are backfilled.
   */
  messages?: readonly MainConversationMessage[]
}

/**
 * Deterministic context composition: the stable prefix (instructions, then
 * optional checkpoint) is emitted unchanged first, followed by the persisted
 * conversation in the supplied durable order. Appending conversation history
 * can therefore never change the prefix bytes the provider sees first. The
 * optional grounding message is inserted only near the final user anchor;
 * it does not duplicate checkpoint data or accumulate in persisted history.
 */
export function composeFrontBrainContext(input: FrontBrainContextInput): FrontBrainMessage[] {
  if (!input.instructions.trim()) {
    throw new Error('instructions must not be empty')
  }
  const prefix: FrontBrainMessage[] = [{ role: 'system', content: input.instructions }]
  if (input.checkpoint !== undefined) {
    prefix.push({ role: 'system', content: input.checkpoint })
  }
  const history = input.messages ?? []
  const conversation = history.map(message => ({ role: message.role, content: message.content }))
  if (
    input.groundCurrentTurn
    && input.checkpoint?.trim()
    && history.at(-1)?.role === 'user'
    && history.some(message => message.role === 'assistant')
  ) {
    conversation.splice(conversation.length - 1, 0, { role: 'system', content: currentTurnGroundingReminder })
  }
  return [...prefix, ...conversation]
}
