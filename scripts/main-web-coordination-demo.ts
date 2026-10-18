import type { ScopedModel } from '../src/agent/scoped-protocol.js'
/** Explicit deterministic demo only. Production adapter has no intent heuristic. */
export function demoModel(): ScopedModel {
  return { async complete(messages, tools) {
    const names = tools.map(t => t.function.name)
    if (names.includes('delegate')) return { content: null, tool_calls: [{ id: 'demo-delegate', type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ objective: '合成检查演示', completionCriteria: ['返回模拟证据'] }) } }] }
    const context = messages.at(-1)?.content ?? ''
    return { content: null, tool_calls: [{ id: 'demo-domain', type: 'function', function: { name: context.includes('"answers"') ? 'finish' : 'ask', arguments: JSON.stringify({ body: context.includes('"answers"') ? '合成检查完成；未读取真实文件' : '请选择合成样本 A 或 B' }) } }] }
  } }
}
