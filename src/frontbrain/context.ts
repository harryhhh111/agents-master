import type { MainConversationMessage } from '../main/types.js'
import type { FrontBrainMessage } from './types.js'

export interface FrontBrainContextInput {
  /** Stable system instructions. Must be non-empty and is passed through verbatim. */
  instructions: string
  /** Optional stable checkpoint, appended verbatim right after the instructions. */
  checkpoint?: string
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
 * can therefore never change the prefix bytes the provider sees first.
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
  return [...prefix, ...history.map(message => ({ role: message.role, content: message.content }))]
}
