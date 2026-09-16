import { formatUsageLine, parseProbeArgs } from '../scripts/probe-frontbrain.js'
import { describe, expect, it } from 'vitest'
import type { MainConversationMessage } from '../src/main/index.js'
import { composeFrontBrainContext } from '../src/frontbrain/index.js'
import {
  DeepSeekFrontBrain,
  probeMaxOutputTokens,
  probeStablePrefixFixture,
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
  it('keeps the stable prefix verbatim and preserves supplied durable message order', () => {
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
      { role: 'assistant', content: '早于用户消息' },
      { role: 'user', content: '早上的问题' },
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
  it('uses a substantial deterministic synthetic prefix and preserves measured request shapes', async () => {
    const { brain, requests } = makeFakeBrain()
    const events: string[] = []
    const responses: FrontBrainResponse[] = []
    const result = await runFrontBrainProbe({ async complete(request) {
      events.push(`call-${requests.length + 1}`)
      const response = await brain.complete(request)
      responses.push(response)
      return response
    } }, { instructions, checkpoint, sleep: async ms => {
      events.push(`sleep-${ms}`)
      expect(requests).toHaveLength(3)
      await Promise.resolve()
      events.push('settled')
    } })
    expect(events).toEqual(['call-1', 'call-2', 'call-3', 'sleep-2000', 'settled', 'call-4', 'call-5'])
    expect(probeStablePrefixFixture).toContain('Not a product prompt')
    expect(probeStablePrefixFixture.split('Checkpoint section ')).toHaveLength(13)
    // Structural source-size check, deliberately not a tokenizer estimate.
    expect(probeStablePrefixFixture.split(/\s+/).length).toBeGreaterThan(700)
    for (const request of requests) {
      expect(request.maxOutputTokens).toBe(probeMaxOutputTokens)
      expect(request.messages.slice(0, 3)).toEqual([
        { role: 'system', content: instructions },
        { role: 'system', content: checkpoint },
        { role: 'system', content: probeStablePrefixFixture },
      ])
    }
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0].messages).toHaveLength(4)
    expect(requests[3].messages).toEqual([
      ...requests[1].messages,
      { role: 'assistant', content: 'fake-2' },
      { role: 'user', content: '能力探测续：再回复一个词"完成"。' },
    ])
    expect(requests[4].messages).toHaveLength(4)
    expect(requests[2].messages.slice(0, 3)).toEqual(requests[4].messages.slice(0, 3))
    expect(new Set([requests[0], requests[2], requests[4]].map(r => r.messages.at(-1)!.content)).size).toBe(3)
    expect(result.turns.map(t => t.phase)).toEqual([
      'warmup-initial', 'warmup-repeat', 'warmup-prefix-detection', 'measurement-continuation', 'measurement-common-prefix',
    ])
    result.turns.forEach((turn, i) => {
      expect(turn.response).toBe(responses[i])
      const line = formatUsageLine(turn.phase, turn.response)
      expect(line).toContain(`${turn.phase}: latency=${10 * (i + 1)}.0ms`)
      expect(line).toContain('in=30 out=2 total=32')
      expect(line).toContain('below target')
      expect(line).toContain(`finish=stop | text="fake-${i + 1}"`)
      expect(line).toContain(i === 1 ? 'cache hit=28 miss=未上报' : 'cache: 未上报')
    })
    expect(result.targetInputTokens).toBe(512)
    expect(result.settleMs).toBe(2000)
    expect(result.maxOutputTokens).toBe(16)
  })

  it('awaits an injected delay before measurement and permits zero without sleeping', async () => {
    const { brain, requests } = makeFakeBrain()
    let release!: () => void
    let reached!: () => void
    const sleeping = new Promise<void>(resolve => { reached = resolve })
    const pending = runFrontBrainProbe(brain, { instructions, settleMs: 17, sleep: ms => {
      expect(ms).toBe(17)
      reached()
      return new Promise<void>(resolve => { release = resolve })
    } })
    await sleeping
    expect(requests).toHaveLength(3)
    release()
    await pending
    expect(requests).toHaveLength(5)
    await runFrontBrainProbe(brain, { instructions, settleMs: 0, sleep: async () => {
      throw new Error('zero must not sleep')
    } })
    expect(requests[5].messages[1].content).toBe(probeStablePrefixFixture)
  })

  it('rejects invalid library delays before calls', async () => {
    const { brain, requests } = makeFakeBrain()
    for (const settleMs of [-1, 0.5, NaN, Infinity, 30001, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runFrontBrainProbe(brain, { instructions, settleMs })).rejects.toThrow('settle-ms')
    }
    expect(requests).toHaveLength(0)
  })
})

describe('probe CLI helpers (import has no network side effects)', () => {
  it('strictly parses bounded nonnegative integer milliseconds', () => {
    expect(parseProbeArgs([])).toEqual({ settleMs: 2000 })
    for (const value of ['0', '17', '30000']) {
      expect(parseProbeArgs(['--settle-ms', value])).toEqual({ settleMs: Number(value) })
    }
    for (const value of ['', '-1', '+1', '1.5', '2e3', '0x10', ' 2', '2 ', 'NaN', 'Infinity', '30001', '9007199254740993']) {
      expect(() => parseProbeArgs(['--settle-ms', value])).toThrow()
    }
    for (const args of [['--settle-ms'], ['--unknown', '2'], ['--settle-ms=2'], ['--settle-ms', '2', 'extra'], ['--settle-ms', '2', '--settle-ms', '3']]) {
      expect(() => parseProbeArgs(args)).toThrow()
    }
  })

  it('reports actual counts, target boundary, zero cache hits and missing telemetry', () => {
    for (const inputTokens of [511, 512, 700, undefined]) {
      const line = formatUsageLine('phase', {
        text: '', latencyMs: 1, usage: { inputTokens, cachedInputTokens: 0, uncachedInputTokens: inputTokens },
      })
      expect(line).toContain(`in=${inputTokens ?? '?'}`)
      expect(line).toContain(inputTokens === undefined ? 'unknown' : inputTokens < 512 ? 'below target' : 'at target (or above)')
      expect(line).toContain('cache hit=0')
    }
  })
})
