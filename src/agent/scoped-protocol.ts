/** Shared AgentCore protocol primitives; no legacy tools, config or state imports. */
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type WireMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export type ToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type ModelReply = { content: string | null; tool_calls?: ToolCall[] }
export interface ScopedModel { complete(messages: readonly WireMessage[], tools: readonly ToolDefinition[], signal: AbortSignal): Promise<ModelReply> }
export class ScopedProtocolError extends Error {}
export class ScopedTimeoutError extends Error {}
export function* boundedRounds(limit: number): Generator<number> { for (let i = 0; i < limit; i++) yield i }
export function pairedToolResult(id: string, content: string): WireMessage & { role: 'tool'; content: string; tool_call_id: string } {
  return { role: 'tool', tool_call_id: id, content }
}
export async function deadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work(controller.signal), new Promise<never>((_, reject) => {
      const fail = () => reject(new ScopedTimeoutError('Scoped turn aborted or timed out'))
      controller.signal.addEventListener('abort', fail, { once: true })
      if (controller.signal.aborted) fail()
      timer = setTimeout(() => controller.abort(), ms)
    })])
  } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort) }
}
export function validateCalls(calls: ToolCall[], allowed: readonly string[], seen: readonly string[], remaining: number): void {
  if (calls.length > remaining) throw new Error('Tool call budget exceeded')
  const ids = new Set(seen)
  for (const c of calls) {
    if (!c || c.type !== 'function' || typeof c.id !== 'string' || !c.id || c.id.length > 200 || ids.has(c.id)) throw new Error('Duplicate or invalid tool ID')
    ids.add(c.id)
    if (!allowed.includes(c.function?.name) || typeof c.function.arguments !== 'string' || c.function.arguments.length > 8000) throw new Error('Forbidden tool or oversized arguments')
  }
}
export function strictArgs(call: ToolCall, fields: Record<string, 'text' | 'texts'>): Record<string, unknown> {
  const a: unknown = JSON.parse(call.function.arguments)
  if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).sort().join() !== Object.keys(fields).sort().join()) throw new Error('Invalid tool schema')
  const args = a as Record<string, unknown>
  for (const [key, type] of Object.entries(fields)) {
    const text = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 4000
    if (type === 'text' ? !text(args[key]) : !Array.isArray(args[key]) || !(args[key] as unknown[]).length || (args[key] as unknown[]).length > 10 || !(args[key] as unknown[]).every(text)) throw new Error('Invalid tool schema')
  }
  return args
}
export function tool(name: string, fields: Record<string, 'text' | 'texts'>): ToolDefinition {
  return { type: 'function', function: { name, description: 'Simulation only: ' + name, parameters: { type: 'object', additionalProperties: false, required: Object.keys(fields), properties: Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, type === 'text' ? { type: 'string', maxLength: 4000 } : { type: 'array', items: { type: 'string' }, maxItems: 10 }])) } } }
}
