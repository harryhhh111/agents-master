import type { MainConversationMessage } from '../main/types.js'
import type { FrontBrainMessage } from './types.js'

export interface FrontBrainContextInput {
  /** Stable system instructions. Must be non-empty and is passed through verbatim. */
  instructions: string
  /** Optional stable checkpoint, appended verbatim right after the instructions. */
  checkpoint?: string
  /**
   * Persisted main conversation messages, e.g. from
   * MainConversationStore.readRecentContext(). Composition never mutates or
   * re-writes content; a stable sort by createdAt keeps the order
   * chronological while preserving caller order for equal timestamps.
   */
  messages?: readonly MainConversationMessage[]
}

/**
 * Deterministic context composition: the stable prefix (instructions, then
 * optional checkpoint) is emitted unchanged first, followed by the persisted
 * conversation in chronological order. Appending conversation history can
 * therefore never change the prefix bytes the provider sees first.
 */
export function composeFrontBrainContext(input: FrontBrainContextInput): FrontBrainMessage[] {
  if (!input.instructions.trim()) {
    throw new Error('instructions must not be empty')
  }
  const prefix: FrontBrainMessage[] = [{ role: 'system', content: input.instructions }]
  if (input.checkpoint !== undefined) {
    prefix.push({ role: 'system', content: input.checkpoint })
  }
  const history = [...(input.messages ?? [])].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  )
  return [...prefix, ...history.map(message => ({ role: message.role, content: message.content }))]
}
