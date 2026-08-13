import { describe, expect, it } from 'vitest'
import { extractKimiAssistantText, extractKimiSessionId } from '../src/backends/KimiBackend.js'
import { extractLastMessageFromJsonl, extractSessionIdFromJsonl } from '../src/backends/CodexBackend.js'

// ---- Kimi: session id 提取 ----

describe('extractKimiSessionId', () => {
  it('正常格式：从 meta/session.resume_hint 事件提取 session id', () => {
    const stdout = [
      JSON.stringify({ role: 'assistant', content: 'hello' }),
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'sess-abc-123' }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractKimiSessionId(stdout, warnings)).toBe('sess-abc-123')
    expect(warnings).toEqual([])
  })

  it('格式变动：没有 resume_hint 事件时返回 null 并产生 warning（列出实际事件）', () => {
    // 模拟上游改了事件名 / 结构的输出
    const stdout = [
      JSON.stringify({ role: 'meta', type: 'session.started', id: 'sess-xyz' }),
      JSON.stringify({ role: 'assistant', content: 'working...' }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractKimiSessionId(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('session id 提取失败')
    expect(warnings[0]).toContain('meta/session.started')
    expect(warnings[0]).toContain('assistant/?')
  })

  it('缺字段：resume_hint 存在但没有 session_id 时返回 null 并告警', () => {
    const stdout = JSON.stringify({ role: 'meta', type: 'session.resume_hint' })
    const warnings: string[] = []
    expect(extractKimiSessionId(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('meta/session.resume_hint')
  })

  it('跳过空行和非法 JSON 行', () => {
    const stdout = [
      '',
      'not json at all',
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 's1' }),
    ].join('\n')
    expect(extractKimiSessionId(stdout)).toBe('s1')
  })
})

// ---- Kimi: assistant 文本提取 ----

describe('extractKimiAssistantText', () => {
  it('收集所有 role=assistant 的字符串 content', () => {
    const stdout = [
      JSON.stringify({ role: 'assistant', content: '第一段' }),
      JSON.stringify({ role: 'user', content: '忽略我' }),
      JSON.stringify({ role: 'assistant', content: '第二段' }),
    ].join('\n')
    expect(extractKimiAssistantText(stdout)).toEqual(['第一段', '第二段'])
  })

  it('content 不是字符串时跳过；非法 JSON 行跳过', () => {
    const stdout = [
      JSON.stringify({ role: 'assistant', content: { text: '结构化内容' } }),
      '{broken',
      JSON.stringify({ role: 'assistant', content: 'ok' }),
    ].join('\n')
    expect(extractKimiAssistantText(stdout)).toEqual(['ok'])
  })

  it('没有 assistant 事件时返回空数组', () => {
    expect(extractKimiAssistantText('')).toEqual([])
  })
})

// ---- Codex: session id 提取 ----

describe('extractSessionIdFromJsonl', () => {
  it('正常格式：thread.started 事件的 thread.thread_id', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread: { thread_id: 'thr-1' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractSessionIdFromJsonl(stdout, warnings)).toBe('thr-1')
    expect(warnings).toEqual([])
  })

  it('兼容格式：顶层 thread_id 兜底', () => {
    const stdout = JSON.stringify({ type: 'thread.started', thread_id: 'thr-2' })
    expect(extractSessionIdFromJsonl(stdout)).toBe('thr-2')
  })

  it('格式变动：没有 thread.started 事件时返回 null 并产生 warning（列出实际事件类型）', () => {
    const stdout = [
      JSON.stringify({ type: 'session.initiated', session: { id: 'thr-3' } }),
      JSON.stringify({ type: 'item.completed', item: { text: 'done' } }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractSessionIdFromJsonl(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('session id 提取失败')
    expect(warnings[0]).toContain('session.initiated')
    expect(warnings[0]).toContain('item.completed')
  })

  it('缺字段：thread.started 存在但没有 thread_id 时返回 null 并告警', () => {
    const stdout = JSON.stringify({ type: 'thread.started', thread: {} })
    const warnings: string[] = []
    expect(extractSessionIdFromJsonl(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('thread.started')
  })
})

// ---- Codex: last message 提取 ----

describe('extractLastMessageFromJsonl', () => {
  it('正常格式：从最后一行倒序找到候选字段（item.text）', () => {
    const stdout = [
      JSON.stringify({ type: 'item.completed', item: { text: '较早的消息' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
      JSON.stringify({ type: 'item.completed', item: { text: '最后的消息' } }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractLastMessageFromJsonl(stdout, warnings)).toBe('最后的消息')
    expect(warnings).toEqual([])
  })

  it('兼容格式：message.content / output / result / content / text 候选字段', () => {
    expect(
      extractLastMessageFromJsonl(JSON.stringify({ message: { content: 'via message.content' } })),
    ).toBe('via message.content')
    expect(extractLastMessageFromJsonl(JSON.stringify({ output: 'via output' }))).toBe('via output')
    expect(extractLastMessageFromJsonl(JSON.stringify({ result: 'via result' }))).toBe('via result')
    expect(extractLastMessageFromJsonl(JSON.stringify({ text: 'via text' }))).toBe('via text')
  })

  it('格式变动：所有候选字段都不命中时返回 null 并产生 warning（列出实际事件类型）', () => {
    // 模拟上游把文本挪到未知字段的输出
    const stdout = [
      JSON.stringify({ type: 'item.completed', item: { message: '搬家了' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractLastMessageFromJsonl(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('last message 提取失败')
    expect(warnings[0]).toContain('item.completed')
    expect(warnings[0]).toContain('turn.completed')
  })

  it('缺字段/空白：空 stdout 返回 null 并告警；空白字符串候选不命中', () => {
    const warningsEmpty: string[] = []
    expect(extractLastMessageFromJsonl('', warningsEmpty)).toBeNull()
    expect(warningsEmpty).toHaveLength(1)

    const warningsBlank: string[] = []
    expect(
      extractLastMessageFromJsonl(JSON.stringify({ content: '   ' }), warningsBlank),
    ).toBeNull()
    expect(warningsBlank).toHaveLength(1)
  })

  it('跳过非法 JSON 行，继续向更早的行找', () => {
    const stdout = [
      JSON.stringify({ item: { text: '找到了' } }),
      '{not json',
    ].join('\n')
    expect(extractLastMessageFromJsonl(stdout)).toBe('找到了')
  })
})
