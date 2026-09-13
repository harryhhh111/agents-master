import type { ParseResult, SessionMessage } from './types.js'

const SYSTEM_REMINDER = /^<system-reminder>/

/**
 * Claude Code persists sessions as ~/.claude/projects/<encoded-cwd>/<session>.jsonl.
 * Actual records use top-level type=user|assistant, ISO timestamp, and message.content:
 * user content is normally a string; assistant content is typed blocks. Keep only user text
 * and assistant type=text blocks, never thinking/tool payloads or metadata records.
 */
export function parseClaudeChunk(chunk: string): ParseResult {
  const messages: SessionMessage[] = []
  let warnings = 0

  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      warnings++
      continue
    }
    if (record.type !== 'user' && record.type !== 'assistant') continue

    const message = record.message
    if (!message || typeof message !== 'object') {
      warnings++
      continue
    }
    const messageRecord = message as Record<string, unknown>
    const expectedRole = record.type
    if (messageRecord.role !== expectedRole) {
      warnings++
      continue
    }

    const text = extractText(messageRecord.content, expectedRole).trim()
    if (!text || SYSTEM_REMINDER.test(text)) continue
    const parsedTs = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
    if (Number.isNaN(parsedTs)) warnings++
    messages.push({ ts: Number.isNaN(parsedTs) ? 0 : parsedTs, who: expectedRole, text })
  }
  return { messages, warnings }
}

function extractText(content: unknown, role: 'user' | 'assistant'): string {
  // Observed Claude session records store normal user prompts as a string.
  if (role === 'user' && typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const text: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const block = part as Record<string, unknown>
    // Whitelist only explicit text. This excludes thinking, tool_use and tool_result records.
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
  }
  return text.join('')
}
