import type { AgentEvent } from '../agent/loop.js'

/** TUI 对话区的一条渲染单元。事件流由 reduceChat 折成这个数组，组件只负责画。 */
export type ChatItem =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'agent'; text: string }
  | {
      id: number
      kind: 'tool'
      name: string
      args?: unknown
      done: boolean
      ok?: boolean
      summary?: string
    }
  | { id: number; kind: 'ask'; question: string; context?: string; answer?: string }
  | { id: number; kind: 'error'; text: string }
  | { id: number; kind: 'system'; text: string }

export type ChatAction =
  | { type: 'event'; event: AgentEvent }
  | { type: 'user'; text: string }
  | { type: 'answer'; text: string }
  | { type: 'system'; text: string }

function nextId(items: ChatItem[]): number {
  let max = 0
  for (const i of items) if (i.id > max) max = i.id
  return max + 1
}

/** 纯函数：把一个动作（agent 事件 / 用户输入 / 回答 / 系统输出）折进消息列表。
 * 约定：text 事件不合并（Static 组件只渲染一次，合并会丢更新）；
 * tool_start 插入 done=false 的条目，tool_end 原地补全同名最近一条未完成项。
 */
export function reduceChat(items: ChatItem[], action: ChatAction): ChatItem[] {
  const id = nextId(items)
  switch (action.type) {
    case 'user':
      return [...items, { id, kind: 'user', text: action.text }]
    case 'system':
      return [...items, { id, kind: 'system', text: action.text }]
    case 'answer': {
      // 填到最近一条未回答的 ask 卡片上
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'ask' && it.answer === undefined) {
          const copy = items.slice()
          copy[i] = { ...it, answer: action.text }
          return copy
        }
      }
      return [...items, { id, kind: 'user', text: action.text }]
    }
    case 'event': {
      const e = action.event
      switch (e.type) {
        case 'text':
          return [...items, { id, kind: 'agent', text: e.text }]
        case 'tool_start':
          return [...items, { id, kind: 'tool', name: e.name, args: e.args, done: false }]
        case 'tool_end': {
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i]
            if (it.kind === 'tool' && !it.done && it.name === e.name) {
              const copy = items.slice()
              copy[i] = { ...it, done: true, ok: e.ok, summary: e.summary }
              return copy
            }
          }
          // 没有配对的 tool_start（不应发生），补一条已完成条目
          return [...items, { id, kind: 'tool', name: e.name, done: true, ok: e.ok, summary: e.summary }]
        }
        case 'ask':
          return [...items, { id, kind: 'ask', question: e.question, context: e.context }]
        case 'run_done':
          return [
            ...items,
            {
              id,
              kind: 'system',
              text: `后台任务完成：${e.backend} run ${e.runId.slice(0, 8)} exit=${e.exitCode ?? '?'}${e.error ? ` error=${e.error}` : ''}`,
            },
          ]
        case 'error':
          return [...items, { id, kind: 'error', text: e.message }]
      }
    }
  }
}

/** 最近一条等待用户回答的 ask 卡片（决策点），没有则 undefined */
export function pendingAsk(items: ChatItem[]): Extract<ChatItem, { kind: 'ask' }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'ask') return it.answer === undefined ? it : undefined
  }
  return undefined
}

/** 拆成两块：已落定条目进 ink Static（只渲染一次），进行中的 tool 条目留在动态区实时刷新 */
export function splitLive(items: ChatItem[]): { settled: ChatItem[]; liveTools: ChatItem[] } {
  const settled: ChatItem[] = []
  const liveTools: ChatItem[] = []
  for (const it of items) {
    if (it.kind === 'tool' && !it.done) liveTools.push(it)
    else settled.push(it)
  }
  return { settled, liveTools }
}
