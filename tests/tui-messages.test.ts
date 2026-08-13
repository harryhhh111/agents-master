import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/agent/loop.js'
import { pendingAsk, reduceChat, splitLive, type ChatAction, type ChatItem } from '../src/tui/messages.js'

function fold(actions: ChatAction[]): ChatItem[] {
  return actions.reduce<ChatItem[]>((items, a) => reduceChat(items, a), [])
}

const ev = (e: AgentEvent): ChatAction => ({ type: 'event', event: e })

describe('reduceChat', () => {
  it('用户消息、agent 文字、error 各成一条，id 递增', () => {
    const items = fold([
      { type: 'user', text: '把 M4 做完' },
      ev({ type: 'text', text: '好的，先派给 kimi' }),
      ev({ type: 'error', message: 'boom' }),
    ])
    expect(items.map(i => i.kind)).toEqual(['user', 'agent', 'error'])
    expect(items.map(i => i.id)).toEqual([1, 2, 3])
    expect(items[1]).toMatchObject({ text: '好的，先派给 kimi' })
    expect(items[2]).toMatchObject({ text: 'boom' })
  })

  it('tool_start 插入未完成条目，tool_end 原地补全同名最近一条', () => {
    const items = fold([
      ev({ type: 'tool_start', name: 'run_kimi', args: { prompt: 'x' } }),
      ev({ type: 'tool_start', name: 'check_run', args: { runId: 'r1' } }),
      ev({ type: 'tool_end', name: 'run_kimi', ok: true, summary: 'runId=abc' }),
    ])
    const [runKimi, checkRun] = items
    expect(runKimi).toMatchObject({ kind: 'tool', name: 'run_kimi', done: true, ok: true, summary: 'runId=abc' })
    expect(checkRun).toMatchObject({ kind: 'tool', name: 'check_run', done: false })
  })

  it('tool_end 找不到配对的 tool_start 时补一条已完成条目', () => {
    const items = fold([ev({ type: 'tool_end', name: 'git_status', ok: false, summary: '错误: x' })])
    expect(items[0]).toMatchObject({ kind: 'tool', done: true, ok: false })
  })

  it('ask 事件生成决策点卡片，answer 填到最近未回答的卡片上', () => {
    const items = fold([
      ev({ type: 'ask', question: 'push 吗？', context: '2 个提交未推' }),
      { type: 'answer', text: '推' },
    ])
    expect(items[0]).toMatchObject({ kind: 'ask', question: 'push 吗？', context: '2 个提交未推', answer: '推' })
  })

  it('没有待答 ask 时 answer 退化为普通用户消息', () => {
    const items = fold([{ type: 'answer', text: '自言自语' }])
    expect(items[0]).toMatchObject({ kind: 'user', text: '自言自语' })
  })

  it('reducer 不改动传入数组（纯函数）', () => {
    const before = fold([{ type: 'user', text: 'hi' }])
    const snapshot = structuredClone(before)
    reduceChat(before, ev({ type: 'text', text: 'hello' }))
    expect(before).toEqual(snapshot)
  })
})

describe('pendingAsk', () => {
  it('最近一条 ask 未回答时返回它，已回答则 undefined', () => {
    const open = fold([ev({ type: 'ask', question: '选哪个？' })])
    expect(pendingAsk(open)).toMatchObject({ question: '选哪个？' })
    const answered = reduceChat(open, { type: 'answer', text: 'A' })
    expect(pendingAsk(answered)).toBeUndefined()
  })
})

describe('splitLive', () => {
  it('未完成的 tool 进动态区，其余进 Static 历史区', () => {
    const items = fold([
      { type: 'user', text: '干活' },
      ev({ type: 'tool_start', name: 'run_codex', args: {} }),
      ev({ type: 'tool_end', name: 'run_codex', ok: true, summary: 'done' }),
      ev({ type: 'tool_start', name: 'check_run', args: {} }),
    ])
    const { settled, liveTools } = splitLive(items)
    expect(settled.map(i => i.kind)).toEqual(['user', 'tool'])
    expect(liveTools).toHaveLength(1)
    expect(liveTools[0]).toMatchObject({ name: 'check_run', done: false })
  })
})
