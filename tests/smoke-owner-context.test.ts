import { describe, expect, it } from 'vitest'
import { isExpectedCity, isExpectedOwnerKnowledge, runOwnerContextSmoke } from '../scripts/smoke-owner-context.js'
import type { FrontBrain, FrontBrainRequest } from '../src/frontbrain/index.js'
import { defaultMainAgentInstructions } from '../src/main/foreground.js'
import { currentTurnGroundingReminder } from '../src/frontbrain/context.js'

const knownFacts = {
  city: '云岬市',
  occupation: '天文馆讲解员',
  project: '纸月观测日志',
  communicationPreference: '先结论后细节',
  priorDenialWasWrong: true,
}

describe('owner-context smoke', () => {
  it.each(['青岛', '青岛市', ' “青岛”。\n', '青 岛 市！'])('accepts only the expected city (%s)', text => {
    expect(isExpectedCity(text)).toBe(true)
  })

  it.each(['无法确认青岛', '青岛并不可靠', '不是青岛，是上海', '据资料是青岛', '北京', '', '青岛/上海'])(
    'rejects denials, other cities and extra explanation (%s)', text => {
      expect(isExpectedCity(text)).toBe(false)
    },
  )

  it('requires substantive structured facts and correction, rejecting denials even when every keyword appears', () => {
    expect(isExpectedOwnerKnowledge(JSON.stringify(knownFacts))).toBe(true)
    const invalidReplies = [
      '我不知道你是否住在云岬市、是否是天文馆讲解员、是否做纸月观测日志，或偏好先结论后细节。',
      JSON.stringify({ ...knownFacts, city: '无法确认云岬市' }),
      JSON.stringify({ ...knownFacts, occupation: null }),
      JSON.stringify({ ...knownFacts, project: '未知' }),
      JSON.stringify({ ...knownFacts, project: '纸月观测日志项目' }),
      JSON.stringify({ ...knownFacts, communicationPreference: '不是先结论后细节' }),
      JSON.stringify({ ...knownFacts, priorDenialWasWrong: false }),
      JSON.stringify({ ...knownFacts, priorDenialWasWrong: 'true' }),
      JSON.stringify({ ...knownFacts, denial: '但我没有收到背景' }),
      JSON.stringify({ city: knownFacts.city }),
      JSON.stringify(knownFacts) + '\n以上都无法确认。',
      'null', '[]', '',
    ]
    for (const reply of invalidReplies) expect(isExpectedOwnerKnowledge(reply), reply).toBe(false)
  })

  it('checks all scenarios without short-circuiting and preserves repeated incorrect history verbatim in order', async () => {
    const requests: FrontBrainRequest[] = []
    const replies = ['无法确认青岛', '青岛市', JSON.stringify(knownFacts), '合成自然回答，等待人工核验。']
    const brain: FrontBrain = {
      async complete(request) {
        requests.push(request)
        return { text: replies.shift()!, latencyMs: 0, usage: {} }
      },
    }
    const logs: string[] = []
    expect(await runOwnerContextSmoke(() => brain, line => logs.push(line))).toBe('fail')
    expect(requests).toHaveLength(4)
    expect(requests.map(request => request.maxOutputTokens)).toEqual([128, 128, 512, 512])
    expect(requests[0].messages.map(message => message.role)).toEqual(['system', 'system', 'user'])
    expect(requests[1].messages.map(message => message.role)).toEqual(['system', 'system', 'user', 'assistant', 'system', 'user'])
    expect(requests[0].messages[1].content).toContain('虚构主人')
    expect(requests[0].messages[1].content).toContain('青岛')
    expect(requests[1].messages[3].content).toBe('没有，我没有收到任何主人背景。')
    expect(requests[0].messages.at(-1)?.content).toContain('只输出城市名称，不加说明')
    expect(requests.every(request => request.messages[0].content === defaultMainAgentInstructions)).toBe(true)
    expect(requests[2].messages[1].content).toContain('显式主人上下文')
    expect(requests[2].messages[1].content).toContain('完全虚构主人')
    expect(requests[2].messages[1].content).toContain('项目名称：纸月观测日志。')
    for (const fact of Object.values(knownFacts).filter(value => typeof value === 'string')) {
      expect(requests[2].messages[1].content).toContain(fact)
    }
    expect(requests[2].messages.slice(2, -2)).toEqual([
      { role: 'user', content: '你对我有了解吗？' },
      { role: 'assistant', content: '没有，我没有收到任何主人背景。' },
      { role: 'user', content: '我之前提供的背景呢？' },
      { role: 'assistant', content: '我看不到任何关于你的背景，无法了解你的城市、工作或偏好。' },
      { role: 'user', content: '你再确认一下。' },
      { role: 'assistant', content: '确认过了，我仍然没有你的背景。请重新告诉我你的情况。' },
    ])
    expect(requests[2].messages.at(-1)?.content).toMatch(/^现在你对我有什么了解？/u)
    for (const request of requests.slice(1)) {
      expect(request.messages.at(-2)).toEqual({ role: 'system', content: currentTurnGroundingReminder })
    }
    expect(requests[3].messages.slice(0, -1)).toEqual(requests[2].messages.slice(0, -1))
    expect(requests[3].messages.at(-1)).toEqual({ role: 'user', content: '现在你对我有什么了解？' })
    expect(logs).toContain('fresh: FAIL | 无法确认青岛')
    expect(logs).toContain('prior-incorrect-assistant: PASS | 青岛市')
    expect(logs).toContain(`repeated-incorrect-assistant-broad: PASS | ${JSON.stringify(knownFacts)}`)
    expect(logs).toContain('repeated-incorrect-assistant-natural: NEEDS_REVIEW | 合成自然回答，等待人工核验。')
    expect(logs[0]).toContain('Natural answers require manual review')
  })

  it.each([true, false])('requires manual acceptance even when all automated checks pass (%s)', async broadPasses => {
    const replies = ['青岛', '青岛', JSON.stringify({ ...knownFacts, priorDenialWasWrong: broadPasses }), '我不知道你是否住在云岬市、是天文馆讲解员、做纸月观测日志或偏好先结论后细节。']
    const brain: FrontBrain = { async complete() { return { text: replies.shift()!, latencyMs: 0, usage: {} } } }
    const logs: string[] = []
    expect(await runOwnerContextSmoke(() => brain, line => logs.push(line))).toBe(broadPasses ? 'needs-review' : 'fail')
    expect(logs.some(line => line.startsWith('repeated-incorrect-assistant-natural: PASS'))).toBe(false)
    expect(logs.some(line => line.startsWith('repeated-incorrect-assistant-natural: NEEDS_REVIEW'))).toBe(true)
    expect(logs.some(line => line.includes('Keywords alone do not pass'))).toBe(true)
  })

  it('fails an empty natural reply even when the structured checks pass', async () => {
    const replies = ['青岛', '青岛', JSON.stringify(knownFacts), '  \n']
    const brain: FrontBrain = { async complete() { return { text: replies.shift()!, latencyMs: 0, usage: {} } } }
    expect(await runOwnerContextSmoke(() => brain, () => {})).toBe('fail')
  })

  it.each(['setup', 'provider', 'broad-provider', 'natural-provider'])('sanitizes %s errors and returns failure', async stage => {
    const secretError = new Error('SDK headers: Authorization: secret-test-sentinel')
    const logs: string[] = []
    let calls = 0
    const brain: FrontBrain = { async complete() {
      calls += 1
      if (stage === 'broad-provider' && calls < 3) return { text: '青岛', latencyMs: 0, usage: {} }
      if (stage === 'natural-provider' && calls < 4) return { text: calls === 3 ? JSON.stringify(knownFacts) : '青岛', latencyMs: 0, usage: {} }
      throw secretError
    } }
    const setup = () => {
      if (stage === 'setup') throw secretError
      return brain
    }
    expect(await runOwnerContextSmoke(setup, line => logs.push(line))).toBe('fail')
    expect(logs.at(-1)).toBe('FAIL: owner-context smoke setup or provider request failed.')
    expect(logs.join('\n')).not.toContain('secret-test-sentinel')
    expect(logs.join('\n')).not.toContain('Authorization')
  })
})
