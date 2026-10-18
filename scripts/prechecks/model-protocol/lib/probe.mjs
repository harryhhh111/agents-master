// Probe：场景与传输层之间的唯一通道。每次 call()：
//   1. 检查 max_tokens 预算与运行时预算；
//   2. 在传输层调用之前向共享 ledger 预留尝试额度（失败尝试同样计数）；
//   3. 成功/失败都记录 latencyMs；失败的 usage 记为 null + usageUnknown
//      （服务端消耗未知，绝不按零计——修复 2026-10-15 复核发现 8）；
//   4. 错误消息经 redactText 后才落盘；绝不写 headers。
import fs from 'node:fs'
import { BudgetExceededError } from './ledger.mjs'

export class RuntimeBudgetExceededError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuntimeBudgetExceededError'
  }
}

function summarizeCompletion(completion, latencyMs) {
  const choice = completion?.choices?.[0]
  return {
    choices: (completion?.choices ?? []).map(c => ({
      index: c.index,
      finish_reason: c.finish_reason ?? null,
      message: {
        role: c.message?.role ?? null,
        content: c.message?.content ?? null,
        refusal: c.message?.refusal ?? null,
        tool_calls: (c.message?.tool_calls ?? []).map(tc => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function?.name, arguments: tc.function?.arguments },
        })),
      },
    })),
    usage: completion?.usage ?? null,
    latencyMs,
    finishReason: choice?.finish_reason ?? null,
  }
}

export function createProbe({ scenarioTag, transport, ledger, redactor, transcriptPath, combo, budget, deadlineMs }) {
  function nextSeq() {
    try {
      return fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').filter(Boolean).length + 1
    } catch {
      return 1
    }
  }

  function appendTranscript(record) {
    fs.appendFileSync(transcriptPath, JSON.stringify(redactor.redactValue(record)) + '\n')
  }

  async function call({ messages, maxTokens = 1024, tools = null, toolChoice = 'auto', timeoutMs = combo.timeoutMs }) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > budget.maxTokensPerCall) {
      throw new Error(`max_tokens 超预算: ${maxTokens} > ${budget.maxTokensPerCall}`)
    }
    if (Date.now() >= deadlineMs) {
      throw new RuntimeBudgetExceededError(`运行时预算已耗尽（deadline ${new Date(deadlineMs).toISOString()}）`)
    }
    const attempt = ledger.reserve({ scenario: scenarioTag, note: 'reserved-before-sdk-call' })
    timeoutMs = Math.min(timeoutMs, combo.timeoutMs, deadlineMs - Date.now())
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeBudgetExceededError('No time remaining')
    const startedAt = performance.now()
    let completion = null
    let rawError = null
    let timer
    const controller = new AbortController()
    try {
      const out = await Promise.race([
        Promise.resolve().then(() => transport({ model: combo.model, messages, maxTokens, stream: combo.stream, thinking: combo.thinking, tools, toolChoice, timeoutMs, signal: controller.signal })),
        new Promise(resolve => { timer = setTimeout(() => {
          controller.abort()
          resolve({ error: { name: 'APIConnectionTimeoutError', message: 'Probe deadline exceeded', retriable: false } })
        }, timeoutMs) }),
      ])
      completion = out.completion ?? null
      rawError = out.error ?? null
      if (!rawError && (!completion?.choices?.[0]?.message ||
          (!(completion.choices[0].message.content?.trim()) && !(completion.choices[0].message.tool_calls?.length)))) {
        rawError = { name: 'InvalidResponseError', message: 'Missing completion message', retriable: false }
      }
    } catch (error) {
      rawError = { name: error?.name ?? 'Error', message: String(error?.message ?? error) }
    } finally { clearTimeout(timer) }
    const latencyMs = Math.round(performance.now() - startedAt)
    const error = rawError
      ? {
          name: redactor.redactText(String(rawError.name ?? 'Error')),
          type: redactor.redactText(String(rawError.type ?? 'Error')),
          status: typeof rawError.status === 'number' ? rawError.status : null,
          message: redactor.redactText(String(rawError.message ?? '')),
          // 超时错误不可重试（修复旧实现中"status 未知即可重试"会把超时纳入重试的缺陷）。
          retriable: rawError.name === 'APIConnectionTimeoutError' ? false : (rawError.retriable ?? (rawError.status === undefined || rawError.status === null || rawError.status >= 500)),
        }
      : null
    const record = {
      seq: nextSeq(),
      scenario: scenarioTag,
      attempt,
      timestamp: new Date().toISOString(),
      request: {
        model: combo.model,
        stream: combo.stream,
        thinking: combo.thinking,
        max_tokens: maxTokens,
        timeoutMs,
        tools: tools ?? undefined,
        tool_choice: tools ? toolChoice : undefined,
        messages,
      },
      response: error
        ? { error, usage: null, usageUnknown: true, usageNote: '未获响应：服务端 usage 未知，不按零计', latencyMs }
        : summarizeCompletion(completion, latencyMs),
    }
    appendTranscript(record)
    return { completion, error, record, latencyMs, attempt }
  }

  /** 异常（网络/5xx）自动重试同一请求，最多 maxRetriesPerRequest 次；超时与 4xx 不重试。 */
  async function callWithRetry(args) {
    let last = null
    for (let i = 0; i <= budget.maxRetriesPerRequest; i += 1) {
      const result = await call(args)
      last = result
      if (!result.error) return result
      if (!result.error.retriable) return result
    }
    return last
  }

  return { call, callWithRetry, scenarioTag }
}
