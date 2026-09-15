import { describe, expect, it } from 'vitest'
import type { MainConversationMessage } from '../src/main/index.js'
import { composeFrontBrainContext } from '../src/frontbrain/index.js'
import {
  DeepSeekFrontBrain,
  probeMaxOutputTokens,
  runFrontBrainProbe,
} from '../src/frontbrain/index.js'
import type {
  FrontBrain,
  FrontBrainClient,
  FrontBrainCompletion,
  FrontBrainCreateParams,
  FrontBrainMessage,
  FrontBrainRequest,
  FrontBrainResponse,
} from '../src/frontbrain/index.js'

const instructions = '你是前台 Agent。回复要短。'
const checkpoint = '检查点 v1：先确认上下文再回答。'

function message(role: MainConversationMessage['role'], content: string, createdAt: string): MainConversationMessage {
  return { id: `${role}-${createdAt}`, role, content, createdAt }
}

describe('composeFrontBrainContext', () => {
  it('keeps the stable prefix verbatim and appends messages in chronological order', () => {
    const context = composeFrontBrainContext({
      instructions,
      checkpoint,
      messages: [
        message('assistant', '早于用户消息', '2026-09-15T09:01:00.000Z'),
        message('user', '早上的问题', '2026-09-15T09:00:00.000Z'),
        message('assistant', '补充', '2026-09-15T09:02:00.000Z'),
      ],
    })
    expect(context).toEqual([
      { role: 'system', content: instructions },
      { role: 'system', content: checkpoint },
      { role: 'user', content: '早上的问题' },
      { role: 'assistant', content: '早于用户消息' },
      { role: 'assistant', content: '补充' },
    ])
  })

  it('is deterministic and never rewrites prefix bytes when conversation grows', () => {
    const shared = { instructions, checkpoint }
    const history = [
      message('user', '第一条', '2026-09-15T09:00:00.000Z'),
      message('assistant', '回复', '2026-09-15T09:01:00.000Z'),
    ]
    const first = composeFrontBrainContext({ ...shared, messages: history })
    const longer = composeFrontBrainContext({
      ...shared,
      messages: [...history, message('user', '追问', '2026-09-15T09:02:00.000Z')],
    })
    // The stable prefix is identical no matter how much history follows it.
    expect(longer.slice(0, 2)).toEqual(first.slice(0, 2))
    // Deterministic: identical inputs produce identical outputs.
    expect(composeFrontBrainContext({ ...shared, messages: history })).toEqual(first)
  })

  it('preserves caller order for equal timestamps and omits the checkpoint when absent', () => {
    const sameTime = '2026-09-15T09:00:00.000Z'
    const context = composeFrontBrainContext({
      instructions,
      messages: [
        message('user', '先追加', sameTime),
        message('assistant', '后追加', sameTime),
      ],
    })
    expect(context.map(m => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(context.map(m => m.content)).toEqual([instructions, '先追加', '后追加'])
  })

  it('rejects empty instructions', () => {
    expect(() => composeFrontBrainContext({ instructions: '   ' })).toThrow('instructions must not be empty')
  })
})

function makeFakeClient(responses: FrontBrainCompletion[]): { client: FrontBrainClient; calls: FrontBrainCreateParams[] } {
  const calls: FrontBrainCreateParams[] = []
  const client: FrontBrainClient = {
    chat: {
      completions: {
        async create(params: FrontBrainCreateParams): Promise<FrontBrainCompletion> {
          calls.push(params)
          const response = responses.shift()
          if (!response) throw new Error('fake client ran out of responses')
          return response
        },
      },
    },
  }
  return { client, calls }
}

const completion: FrontBrainCompletion = {
  choices: [{ message: { content: '收到' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 8,
    total_tokens: 128,
    prompt_tokens_details: { cached_tokens: 100 },
  },
}

describe('DeepSeekFrontBrain', () => {
  it('sends thinking disabled, non-streaming, capped output and maps reported telemetry', async () => {
    const { client, calls } = makeFakeClient([completion])
    const brain = new DeepSeekFrontBrain({ client, model: 'deepseek-flash' })
    const messages: FrontBrainMessage[] = [{ role: 'user', content: '你好' }]
    const response = await brain.complete({ messages, maxOutputTokens: 64 })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      model: 'deepseek-flash',
      messages,
      max_tokens: 64,
      stream: false,
      thinking: { type: 'disabled' },
    })
    expect(response.text).toBe('收到')
    expect(response.finishReason).toBe('stop')
    expect(response.latencyMs).toBeGreaterThanOrEqual(0)
    expect(response.usage).toEqual({
      inputTokens: 120,
      outputTokens: 8,
      totalTokens: 128,
      cachedInputTokens: 100,
    })
  })

  it('maps DeepSeek cache fields and leaves cache undefined when nothing is reported', async () => {
    const deepseek: FrontBrainCompletion = {
      choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 4,
        total_tokens: 54,
        prompt_cache_hit_tokens: 40,
        prompt_cache_miss_tokens: 10,
      },
    }
    const { client } = makeFakeClient([deepseek])
    const response = await new DeepSeekFrontBrain({ client, model: 'deepseek-flash' }).complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 16,
    })
    expect(response.usage).toEqual({
      inputTokens: 50,
      outputTokens: 4,
      totalTokens: 54,
      cachedInputTokens: 40,
      uncachedInputTokens: 10,
    })

    const bare: FrontBrainCompletion = { choices: [{ message: { content: '' }, finish_reason: null }] }
    const { client: bareClient } = makeFakeClient([bare])
    const bareResponse = await new DeepSeekFrontBrain({ client: bareClient, model: 'deepseek-flash' }).complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 16,
    })
    expect(bareResponse.usage).toEqual({})
    expect(bareResponse.finishReason).toBeUndefined()
    expect(bareResponse.text).toBe('')
  })

  it('throws on empty choices and on out-of-range output caps', async () => {
    const { client } = makeFakeClient([{ choices: [] }])
    const brain = new DeepSeekFrontBrain({ client, model: 'deepseek-flash' })
    await expect(brain.complete({ messages: [], maxOutputTokens: 16 })).rejects.toThrow(
      'FrontBrain provider returned no choices',
    )
    for (const bad of [0, -1, 1.5, 8193]) {
      await expect(brain.complete({ messages: [], maxOutputTokens: bad })).rejects.toThrow(
        'maxOutputTokens must be an integer between 1 and 8192',
      )
    }
  })
})

function makeFakeBrain(): { brain: FrontBrain; requests: FrontBrainRequest[] } {
  const requests: FrontBrainRequest[] = []
  let call = 0
  const brain: FrontBrain = {
    async complete(request: FrontBrainRequest): Promise<FrontBrainResponse> {
      requests.push(request)
      call += 1
      return {
        text: `fake-${call}`,
        finishReason: 'stop',
        latencyMs: 10 * call,
        usage: { inputTokens: 30, outputTokens: 2, totalTokens: 32, cachedInputTokens: call === 2 ? 28 : undefined },
      }
    },
  }
  return { brain, requests }
}

describe('runFrontBrainProbe', () => {
  it('runs baseline, true continuation, then common-prefix branch, with accurate phase labels', async () => {
    const { brain, requests } = makeFakeBrain()
    const result = await runFrontBrainProbe(brain, { instructions, checkpoint })

    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(request.maxOutputTokens).toBe(probeMaxOutputTokens)
      expect(request.messages.slice(0, 2)).toEqual([
        { role: 'system', content: instructions },
        { role: 'system', content: checkpoint },
      ])
    }

    // baseline: shared prefix + one short divergent user tail.
    expect(requests[0].messages).toHaveLength(3)
    expect(requests[0].messages[2].role).toBe('user')

    // continuation: the exact prior request transcript retained verbatim,
    // including the baseline assistant response, then one appended user turn.
    expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages)
    expect(requests[1].messages[requests[0].messages.length]).toEqual({
      role: 'assistant',
      content: 'fake-1',
    })
    expect(requests[1].messages.at(-1)!.role).toBe('user')
    expect(requests[1].messages.at(-1)).not.toEqual(requests[0].messages.at(-1))

    // common-prefix branch: same shared prefix, divergent tail, after the two
    // divergent requests.
    expect(requests[2].messages).toHaveLength(3)
    expect(requests[2].messages[2].role).toBe('user')
    expect(requests[2].messages[2]).not.toEqual(requests[0].messages[2])

    // Phases are labeled accurately, in call order, with telemetry reported as-is.
    expect(result.maxOutputTokens).toBe(probeMaxOutputTokens)
    expect(result.turns.map(turn => turn.phase)).toEqual(['baseline', 'continuation', 'common-prefix'])
    expect(result.turns.map(turn => turn.response.text)).toEqual(['fake-1', 'fake-2', 'fake-3'])
    expect(result.turns[0].response.latencyMs).toBe(10)
    expect(result.turns[1].response.usage.cachedInputTokens).toBe(28)
  })
})
