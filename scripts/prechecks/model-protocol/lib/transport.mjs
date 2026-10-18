// 传输层：live（显式 opt-in，端点白名单，出站秘密扫描，错误脱敏）与
// scripted（离线可注入，测试与零网络演示用）。两者返回统一形状：
//   { completion } —— OpenAI chat.completion 形状（choices/usage）
//   { error }      —— { name, type?, status?, message, retriable? }（无 headers，已脱敏）
import OpenAI from 'openai'
import { COMBO } from './combo.mjs'

const ALLOWLISTED_BASE_URLS = [COMBO.baseUrl]

/** live 传输层：只允许配置过的端点；maxRetries=0；SDK timeout + AbortController 双保险。 */
export function createLiveTransport({ combo = COMBO, apiKey, redactor }) {
  if (!apiKey) throw new Error('live transport 需要 apiKey（runner 在缺省时记录 BLOCKED，不进入这里）')
  if (!ALLOWLISTED_BASE_URLS.includes(combo.baseUrl)) {
    throw new Error(`端点不在白名单，拒绝连接: ${combo.baseUrl}（允许: ${ALLOWLISTED_BASE_URLS.join(', ')}）`)
  }
  redactor.registerSecret(apiKey)
  const client = new OpenAI({ baseURL: combo.baseUrl, apiKey, maxRetries: 0 })
  return async function liveTransport(args) {
    const { model, messages, maxTokens, thinking, tools, toolChoice, timeoutMs, signal } = args
    // 出站前扫描：拒绝把任何秘密材料（尤其 API key）发往端点，防任意数据外带。
    const params = { model, messages, max_tokens: maxTokens, stream: false, thinking }
    if (tools) {
      params.tools = tools
      params.tool_choice = toolChoice
    }
    redactor.assertClean(JSON.stringify(params), 'request')
    const controller = new AbortController()
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const deadline = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const completion = await client.chat.completions.create(params, {
        timeout: timeoutMs,
        maxRetries: 0,
        signal: requestSignal,
      })
      return { completion }
    } catch (error) {
      if (requestSignal.aborted) {
        return { error: { name: 'APIConnectionTimeoutError', type: 'Error', message: 'Foreground request deadline exceeded', retriable: false } }
      }
      return { error: toSafeError(error, redactor) }
    } finally {
      clearTimeout(deadline)
    }
  }
}

function toSafeError(error, redactor) {
  const status = typeof error?.status === 'number' ? error.status : undefined
  return {
    name: redactor.redactText(String(error?.name ?? 'Error')),
    type: redactor.redactText(String(error?.constructor?.name ?? 'Error')),
    status,
    // 只保留 redact 后的 message；绝不落盘 headers/request/response 原文。
    message: redactor.redactText(String(error?.message ?? error)),
    retriable: status === undefined || status >= 500,
  }
}

/**
 * 离线可注入传输层：handler(args, callIndex) 返回 completion 形状或 { error }。
 * 用于无网络跑通全部场景（演示 + 自动化测试）。
 */
export function createScriptedTransport(handler) {
  let calls = 0
  return async function scriptedTransport(args) {
    calls += 1
    const out = await handler(args, calls)
    if (out && out.error) return { error: out.error }
    return { completion: out }
  }
}

/** FIFO 剧本传输层：每次调用消费一条；耗尽即抛错（测试失败会更显眼）。 */
export function queueTransport(queue) {
  return createScriptedTransport(() => {
    const item = queue.shift()
    if (!item) throw new Error('scripted queue 已耗尽（剧本与场景调用次数不匹配）')
    return item
  })
}
