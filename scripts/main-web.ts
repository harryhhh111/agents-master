#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config.js'
import { createFrontBrain } from '../src/frontbrain/index.js'
import {
  createMainAgentRuntime,
  defaultMainAgentCheckpoint,
  MainAgentForegroundHost,
  type ForegroundHostEvent,
  type MainConversationMessage,
} from '../src/main/index.js'
import {
  maxOwnerContextCharacters,
  ownerContextCheckpoint,
  initializeOwnerContext,
  readOwnerContext,
  saveOwnerContext,
} from '../src/main/owner-context.js'
import { MainWebAuth, sessionFromCookie, sessionCookie, validateWriteOrigin } from '../src/main/web-auth.js'
import { coordinationPage } from '../src/main/coordination/web-page.js'
import { createMainWebPreviewChannel, type MainWebPreviewChannel } from './main-web-preview.js'

export const mainWebLoopbackAddress = '127.0.0.1'
export const defaultMainWebPort = 31415
export const maxMainWebMessageCharacters = 8_000
const maxJsonBodyBytes = 32_000
const mainWebEventReplayLimit = 256
export const mainWebStableReleaseId = 'main-web-stable-local'
export const coordinationPreviewReleaseId = 'coordination-preview-step-b-local'

/** 从不可变发布目录的 release.json 读取真实发布标识；无 manifest（开发工作树）时退回常量。 */
export function readPackagedReleaseId(directory: string, fallback: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'release.json'), 'utf8')) as { releaseId?: unknown }
    if (typeof manifest.releaseId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(manifest.releaseId)) return manifest.releaseId
  } catch { /* 非发布目录或 manifest 不可读时使用回退标识 */ }
  return fallback
}

export interface MainWebArguments {
  dataDirectory: string
  port: number
  previewSocketPath?: string
}

export function parseMainWebArguments(args: readonly string[], homeDirectory = homedir()): MainWebArguments {
  let dataDirectory = path.join(homeDirectory, '.local', 'share', 'agents-master', 'main-chat')
  let port = defaultMainWebPort
  let previewSocketPath: string | undefined
  let sawDataDirectory = false
  let sawPort = false
  let sawPreviewSocket = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const value = args[index + 1]
    if (arg === '--data-dir') {
      if (sawDataDirectory) throw new Error('--data-dir 只能指定一次')
      if (!value || !value.trim()) throw new Error('--data-dir 需要一个非空目录')
      dataDirectory = value
      sawDataDirectory = true
      index += 1
      continue
    }
    if (arg === '--port') {
      if (sawPort) throw new Error('--port 只能指定一次')
      if (!value || !/^(?:[1-9]\d{0,4})$/.test(value)) throw new Error('--port 必须是 1 到 65535 的十进制整数')
      port = Number(value)
      if (port > 65_535) throw new Error('--port 必须是 1 到 65535 的十进制整数')
      sawPort = true
      index += 1
      continue
    }
    if (arg === '--preview-socket') {
      if (sawPreviewSocket) throw new Error('--preview-socket 只能指定一次')
      if (!value || !value.trim()) throw new Error('--preview-socket 需要一个非空路径')
      previewSocketPath = value
      sawPreviewSocket = true
      index += 1
      continue
    }
    throw new Error(`未知参数: ${arg ?? ''}`)
  }
  return previewSocketPath === undefined ? { dataDirectory, port } : { dataDirectory, port, previewSocketPath }
}

export function validateMainWebMessage(content: unknown): asserts content is string {
  if (typeof content !== 'string' || !content.trim()) throw new Error('消息不能为空')
  if (content.length > maxMainWebMessageCharacters) {
    throw new Error(`消息不能超过 ${maxMainWebMessageCharacters} 个字符`)
  }
}

function validateIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('消息标识无效')
  }
  return value
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && [
    '消息不能为空',
    `消息不能超过 ${maxMainWebMessageCharacters} 个字符`,
    '消息标识无效',
    '请求体必须是 JSON 对象',
    '请求体过大',
    'owner context must not be empty',
    `owner context must not exceed ${maxOwnerContextCharacters} characters`,
  ].includes(error.message)) return error.message
  return '请求无法完成。'
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

function html(response: ServerResponse, page = mainWebPage): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  })
  response.end(page)
}

/** 预览关闭时的入口兜底页：由稳定入口提供，不依赖 worker，始终给出返回稳定版的入口。 */
function previewDisabledPage(response: ServerResponse): void {
  response.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'",
  })
  response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>预览版未启用</title><main style="max-width:42rem;margin:4rem auto;font:16px/1.7 system-ui,sans-serif"><h1>预览版未启用</h1><p>当前站点未开启预览通道，稳定版仍可继续使用。</p><p><a href="/">返回稳定版</a></p></main></html>')
}

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new Error('请求体必须是 JSON 对象')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxJsonBodyBytes) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体必须是 JSON 对象')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
  return value as Record<string, unknown>
}

export type MainWebEvent =
  | { type: 'submitted'; message: MainConversationMessage }
  | { type: 'reply'; message: MainConversationMessage }
  | { type: 'error'; message: string }
  | { type: 'recovered'; count: number }

type MainWebEventRecord = { cursor: number; event: MainWebEvent }

/** Small fan-out seam: the foreground host remains the sole runtime owner. */
export class MainWebEventBus {
  readonly #clients = new Map<ServerResponse, () => boolean>()
  readonly #history: MainWebEventRecord[] = []
  #cursor = 0
  #failure: string | undefined

  getFailure(): string | undefined { return this.#failure }

  snapshot<T>(read: () => T): { value: T; cursor: number } {
    // Node runs this synchronous section without an interleaving publish, so
    // the cursor and durable history describe one client-observable point.
    return { value: read(), cursor: this.#cursor }
  }

  subscribe(response: ServerResponse, afterCursor?: number, authorized = () => true): void {
    const oldestCursor = this.#history[0]?.cursor
    if (afterCursor !== undefined && oldestCursor !== undefined && afterCursor < oldestCursor - 1) {
      response.write('event: reset\ndata: {"type":"reset"}\n\n')
      response.end()
      return
    }
    this.#clients.set(response, authorized)
    response.once('close', () => this.#clients.delete(response))
    if (afterCursor !== undefined) {
      for (const record of this.#history) {
        if (record.cursor > afterCursor) this.#write(response, record)
      }
    }
  }

  publish(event: MainWebEvent): void {
    if (event.type === 'error') this.#failure = event.message
    if (event.type === 'recovered' || event.type === 'reply') this.#failure = undefined
    const record = { cursor: ++this.#cursor, event }
    this.#history.push(record)
    if (this.#history.length > mainWebEventReplayLimit) this.#history.shift()
    for (const client of this.#clients.keys()) this.#write(client, record)
  }

  close(): void {
    for (const client of this.#clients.keys()) client.end()
    this.#clients.clear()
  }

  #write(response: ServerResponse, record: MainWebEventRecord): void {
    if (!this.#clients.get(response)?.()) { response.end(); return }
    response.write(`id: ${record.cursor}\nevent: update\ndata: ${JSON.stringify(record.event)}\n\n`)
  }
}

/** Deliberately exclude provider messages, URLs, headers and request bodies. */
export function safeProviderFailure(error: unknown): { category: string; status?: number; message: string } {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const status = typeof source.status === 'number' && Number.isInteger(source.status) && source.status >= 400 && source.status <= 599 ? source.status : undefined
  const name = source.name
  const category = name === 'APIConnectionTimeoutError' ? 'timeout'
    : name === 'APIConnectionError' ? 'network'
      : status === 401 ? 'authentication' : status === 402 ? 'balance'
        : status === 429 ? 'rate_limit' : status && status >= 500 ? 'provider' : 'unknown'
  const labels: Record<string, string> = {
    timeout: '模型请求超时（30 秒）', network: '无法连接模型服务',
    authentication: '模型服务认证失败', balance: '模型服务返回余额不足',
    rate_limit: '模型服务请求受限', provider: '模型服务暂时出错', unknown: '模型请求失败',
  }
  return { category, ...(status === undefined ? {} : { status }), message: labels[category] + '；消息已保留，请点击“重试失败回合”。' }
}

export function foregroundEventForWeb(event: ForegroundHostEvent): MainWebEvent {
  switch (event.type) {
    case 'submitted': return { type: 'submitted', message: event.result.message }
    case 'reply': return { type: 'reply', message: event.result.message }
    case 'error': return { type: 'error', message: safeProviderFailure(event.error).message }
    case 'recovered': return { type: 'recovered', count: event.count }
  }
}

export interface MainWebHost {
  start(): number
  submit(input: { content: string; idempotencyKey: string }): unknown
  recover(): number | undefined
  setCheckpoint(checkpoint?: string): void
  getStatus(): 'idle' | 'processing' | 'blocked'
}

export interface MainWebServerOptions {
  preview?: { page: string; handle(request: IncomingMessage, response: ServerResponse, authorized: () => boolean): Promise<boolean>; close(): void }
  previewChannel?: MainWebPreviewChannel
  stableReleaseId?: string
  host: MainWebHost
  readHistory(): MainConversationMessage[]
  dataDirectory: string
  events: MainWebEventBus
  auth: MainWebAuth
}

export function createMainWebServer(options: MainWebServerOptions): Server {
  return createServer((request, response) => {
    void handleMainWebRequest(request, response, options).catch(() => {
      if (!response.headersSent) json(response, 500, { error: '服务器无法完成请求。' })
      else response.end()
    })
  })
}

export async function handleMainWebRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: MainWebServerOptions,
): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  if (method === 'GET' && pathname === '/') {
    // 导航链接展示预览实际能力标识；status() 有总时限，worker 不可用时回退默认文案。
    const previewStatus = options.previewChannel ? await options.previewChannel.status() : undefined
    return html(response, options.preview?.page ?? createMainWebPage({
      previewEnabled: options.previewChannel !== undefined,
      releaseId: options.stableReleaseId ?? mainWebStableReleaseId,
      previewLabel: previewStatus?.previewLabel,
    }))
  }
  const session = sessionFromCookie(request.headers.cookie)
  const writeOrigin = validateWriteOrigin(request.headers.origin, request.headers.host)
  const apiPath = pathname.startsWith('/api/') || pathname.startsWith('/preview/api/')
  if (apiPath && !['GET', 'HEAD'].includes(method)) {
    if (!writeOrigin) return json(response, 403, { error: '请从本站页面提交请求。' })
    if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return json(response, 400, { error: '请求体必须是 JSON 对象' })
    }
  }
  if (method === 'GET' && pathname === '/api/auth') {
    return json(response, 200, { configured: options.auth.configured, authenticated: options.auth.authorized(session) })
  }
  if (method === 'POST' && (pathname === '/api/auth/login' || pathname === '/api/auth/setup')) {
    try {
      const body = await readJson(request)
      const newSession = pathname.endsWith('/setup')
        ? await options.auth.setup(body.password, body.setupToken)
        : await options.auth.login(body.password)
      response.setHeader('Set-Cookie', sessionCookie(newSession, writeOrigin!.secure))
      return json(response, 200, { authenticated: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const allowed = ['设置凭据无效或已失效。', '尝试过于频繁，请稍后再试。', '密码不正确。', '密码必须为 8 到 256 个字符。', '请求体必须是 JSON 对象', '请求体过大']
      return json(response, message === '尝试过于频繁，请稍后再试。' ? 429 : 400, { error: allowed.includes(message) ? message : '登录失败。' })
    }
  }
  if ((pathname === '/preview' || pathname === '/preview/') && options.previewChannel === undefined) {
    return previewDisabledPage(response)
  }
  if (pathname === '/preview' && options.previewChannel) {
    if (await options.previewChannel.handle(request, response, () => options.auth.authorized(session))) return
  }
  if (pathname === '/preview/' && options.previewChannel) {
    if (!options.auth.authorized(session)) {
      // 直达预览的登录页也展示 worker 实际发布标识；status() 有总时限，worker 不可用时回退配置值。
      const previewStatus = await options.previewChannel.status()
      return html(response, coordinationPage(createMainWebPage({
        channel: 'preview',
        businessApiBase: '/preview/api',
        releaseId: previewStatus.releaseId,
        previewEnabled: true,
        previewLabel: previewStatus.previewLabel,
      }), previewStatus.synthetic ? 'synthetic' : previewStatus.execution === 'cli' ? 'real-cli' : 'real-model'))
    }
    if (await options.previewChannel.handle(request, response, () => options.auth.authorized(session))) return
  }
  if (apiPath && !options.auth.authorized(session)) {
    return json(response, 401, { error: '未授权。' })
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    options.auth.logout(session)
    options.events.close()
    options.preview?.close()
    options.previewChannel?.close()
    response.setHeader('Set-Cookie', sessionCookie('', writeOrigin!.secure, true))
    return json(response, 200, { authenticated: false })
  }
  if (method === 'GET' && pathname === '/api/versions') {
    const preview = options.previewChannel
      ? await options.previewChannel.status()
      : { enabled: false, available: false, releaseId: undefined, capabilities: [], synthetic: true }
    return json(response, 200, {
      stable: { enabled: true, available: true, releaseId: options.stableReleaseId ?? mainWebStableReleaseId, capabilities: ['main-chat'], synthetic: false },
      preview,
    })
  }
  if (pathname.startsWith('/preview/api/') && options.previewChannel) {
    if (await options.previewChannel.handle(request, response, () => options.auth.authorized(session))) return
  }
  if (options.preview && await options.preview.handle(request, response, () => options.auth.authorized(session))) return
  if (method === 'GET' && pathname === '/api/status') {
    return json(response, 200, { state: options.host.getStatus(), message: options.events.getFailure() })
  }
  if (method === 'GET' && pathname === '/api/history') {
    const history = options.events.snapshot(options.readHistory)
    return json(response, 200, { messages: history.value, cursor: history.cursor })
  }
  if (method === 'GET' && pathname === '/api/owner-context') {
    return json(response, 200, { content: readOwnerContext(options.dataDirectory) })
  }
  if (method === 'GET' && pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })
    response.write(': connected\n\n')
    options.events.subscribe(response, parseEventCursor(url.searchParams.get('cursor')), () => options.auth.authorized(session))
    const expiryCheck = setInterval(() => {
      if (!options.auth.authorized(session)) response.end()
    }, 30_000)
    expiryCheck.unref()
    response.once('close', () => clearInterval(expiryCheck))
    return
  }
  if (method === 'POST' && pathname === '/api/messages') {
    try {
      const body = await readJson(request)
      validateMainWebMessage(body.content)
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey) ?? randomUUID()
      options.host.submit({ content: body.content, idempotencyKey })
      return json(response, 202, { accepted: true })
    } catch (error) {
      return json(response, 400, { error: safeErrorMessage(error) })
    }
  }
  if (method === 'PUT' && pathname === '/api/owner-context') {
    try {
      const body = await readJson(request)
      if (typeof body.content !== 'string') throw new Error('owner context must not be empty')
      saveOwnerContext(options.dataDirectory, body.content)
      options.host.setCheckpoint(mainCheckpoint(readOwnerContext(options.dataDirectory)))
      return json(response, 200, { saved: true })
    } catch (error) {
      return json(response, 400, { error: safeErrorMessage(error) })
    }
  }
  if (method === 'POST' && pathname === '/api/recover') {
    const count = options.host.recover()
    return json(response, 200, { recovered: count ?? 0, started: count !== undefined })
  }
  return json(response, 404, { error: '未找到此地址。' })
}

function parseEventCursor(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) ? cursor : undefined
}

export function mainCheckpoint(ownerContext: string): string {
  return [defaultMainAgentCheckpoint, ownerContextCheckpoint(ownerContext)].join('\n\n')
}

export async function listenMainWebServer(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, mainWebLoopbackAddress)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local Web server did not report a TCP address')
  return address.port
}

export async function runMainWeb(args = process.argv.slice(2)): Promise<void> {
  await import('dotenv/config')
  const { dataDirectory, port, previewSocketPath } = parseMainWebArguments(args)
  // Check this before creating SQLite so an accidentally selected repository
  // never receives either the private context or the Web runtime database.
  initializeOwnerContext(dataDirectory)
  const config = loadConfig()
  const resources = createMainAgentRuntime({ dataDirectory, frontBrain: createFrontBrain(config) })
  const events = new MainWebEventBus()
  const auth = new MainWebAuth(dataDirectory)
  const host = new MainAgentForegroundHost(resources.runtime, {
    checkpoint: mainCheckpoint(readOwnerContext(dataDirectory)),
    onEvent: event => {
      if (event.type === 'error') {
        const failure = safeProviderFailure(event.error)
        process.stderr.write(`[main-web] provider_failure category=${failure.category}${failure.status === undefined ? '' : ` status=${failure.status}`}\n`)
      }
      events.publish(foregroundEventForWeb(event))
    },
  })
  const previewChannel = previewSocketPath === undefined
    ? undefined
    : createMainWebPreviewChannel({ socketPath: previewSocketPath, releaseId: coordinationPreviewReleaseId })
  const server = createMainWebServer({
    host,
    readHistory: () => resources.store.readRecentContext(100),
    dataDirectory,
    events,
    auth,
    stableReleaseId: readPackagedReleaseId(process.cwd(), mainWebStableReleaseId),
    ...(previewChannel ? { previewChannel } : {}),
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= new Promise(resolve => {
      const finalize = (): void => {
        void host.waitForIdle().catch(() => {}).finally(() => {
          resources.close()
          resolve()
        })
      }
      events.close()
      previewChannel?.close()
      if (server.listening) server.close(finalize)
      else finalize()
    })
    return closing
  }
  try {
    const actualPort = await listenMainWebServer(server, port)
    host.start()
    const fragment = auth.setupToken ? `#setup_token=${auth.setupToken}` : ''
    process.stdout.write(`本地 Web 主聊天已启动：http://${mainWebLoopbackAddress}:${actualPort}/${fragment}\n`)
    process.stdout.write(auth.configured ? '使用密码登录，登录状态保持 30 天。\n' : '首次使用：请从上面的设置链接创建登录密码。\n')
    await new Promise<void>(resolve => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    await close()
  } catch (error) {
    await close()
    throw error
  }
}

const mainWebPageTemplate = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>主 Agent</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}body{font:16px/1.6 system-ui,sans-serif;color:#202c32;background:#edf1f3}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #cbd5da;border-radius:12px;padding:.5rem .85rem;background:#fff;color:inherit;touch-action:manipulation}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #087d69;outline-offset:2px}[hidden]{display:none!important}main{height:100vh;height:100dvh;max-width:860px;margin:auto;background:#f7f9fa;display:flex;flex-direction:column;overflow:hidden}h1,h2,p{margin:0}h1{font-size:1.05rem}h2{font-size:1rem;margin-bottom:.5rem}.app-header{padding:.65rem 1rem;border-bottom:1px solid #dee5e8;background:#fff;flex:none}.status{font-size:.8rem;color:#63737b;min-height:1.3em}.private-panel{display:flex;flex:1;min-height:0;flex-direction:column;position:relative}.conversation{position:relative;flex:1;min-height:0}.messages{height:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;overflow-anchor:none;padding:1rem}.message{display:flex;flex-direction:column;align-items:flex-start;margin:0 0 1rem;min-width:0}.message.user{align-items:flex-end}.bubble{max-width:85%;min-width:0;padding:.65rem .85rem;border-radius:16px 16px 16px 4px;background:#fff;border:1px solid #e2e8eb;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}.user .bubble{background:#d9f3e9;border-color:#c3e7da;border-radius:16px 16px 4px 16px}.role{font-size:.72rem;color:#63737b;margin:0 .3rem .2rem}.empty-state{position:absolute;top:30%;left:1rem;right:1rem;text-align:center;color:#63737b;pointer-events:none}.latest{position:absolute;bottom:.75rem;left:50%;transform:translateX(-50%);box-shadow:0 2px 10px #20303020;white-space:nowrap;font-size:.85rem}.composer{flex:none;background:#fff;border-top:1px solid #dee5e8;padding:.65rem 1rem max(.65rem,env(safe-area-inset-bottom))}.chat{display:flex;align-items:flex-end;gap:.6rem;min-width:0}.chat textarea{display:block;flex:1;min-width:0;width:0;resize:none;min-height:46px;max-height:160px;overflow-y:auto;border:1px solid #cbd5da;border-radius:14px;padding:.6rem .75rem;line-height:1.5}.chat button{background:#087d69;color:#fff;border-color:#087d69;min-height:46px}.hint{font-size:.72rem;color:#63737b;margin-top:.25rem}.feedback{flex:none;padding:0 1rem;background:#fff;max-height:25vh;overflow:auto;font-size:.85rem}.error{color:#a12525;overflow-wrap:anywhere}.error:not(:empty){padding:.4rem 0}.send-failure{padding:.5rem 0;border-bottom:1px solid #edf1f3;overflow-wrap:anywhere}.send-failure button{font-size:.8rem;padding:.2rem .5rem;margin-left:.5rem}.settings{flex:none;border-bottom:1px solid #dee5e8;background:#fff;max-height:50%;overflow:auto}.settings summary{cursor:pointer;padding:.4rem 1rem;font-size:.85rem;color:#52636c}.settings-body{padding:.5rem 1rem 1rem;font-size:.85rem}.settings-body p{color:#63737b;margin:.5rem 0}.settings textarea{display:block;width:100%;min-height:8rem;resize:vertical;max-height:24vh;padding:.6rem;border:1px solid #cbd5da;border-radius:10px}.settings button{margin-top:.5rem}.login-panel{padding:1.5rem;overflow:auto}.login-panel form{display:grid;gap:.8rem;max-width:400px}.login-panel input{display:block;width:100%;min-width:0;border:1px solid #cbd5da;padding:.6rem;border-radius:10px}.login-panel p{margin-top:.75rem;font-size:.85rem}#login-error{padding:0 1rem}#reload-chat{align-self:center;margin:.5rem}.titlebar{display:flex;align-items:center;justify-content:space-between;gap:1rem}.version-switch{display:flex;align-items:center;gap:.4rem;font-size:.78rem;white-space:nowrap}.version-switch a{color:#087d69;text-decoration:none;border:1px solid #b8d9d1;border-radius:999px;padding:.15rem .55rem}.version-current{color:#63737b}@media(max-width:600px){.messages{padding:.8rem}.composer{padding-left:.65rem;padding-right:.65rem}.bubble{max-width:92%}.hint{display:none}.titlebar{align-items:flex-start;flex-direction:column;gap:.35rem}}@media(pointer:coarse){.hint{display:none}}
</style>
<main><header class="app-header"><div class="titlebar"><h1>主 Agent</h1><nav id="version-switch" class="version-switch" hidden><span id="version-current" class="version-current"></span><a id="to-stable" href="/">稳定版</a><a id="to-preview" href="/preview/">预览版</a></nav></div><p id="status" class="status" role="status">正在连接…</p></header>
<section id="login-panel" class="login-panel" hidden><h2 id="login-title">登录</h2><form id="login"><label id="setup-credential-panel" hidden>初始化凭据<input id="setup-credential" type="password" aria-label="初始化凭据" autocomplete="off" maxlength="200"></label><input id="password" type="password" aria-label="密码" autocomplete="current-password" minlength="8" maxlength="256" required><button id="login-button">登录</button></form><p id="login-notice"></p></section>
<section id="private-panel" class="private-panel" hidden>
<details id="settings" class="settings"><summary>设置</summary><div class="settings-body"><h2>主人上下文</h2><p>你明确维护的稳定背景，不是自动记忆。保存后仅影响未来回合。</p><textarea id="owner" aria-label="主人上下文" maxlength="12000"></textarea><button id="save-owner" type="button">明确保存主人上下文</button><p id="owner-status" role="status"></p><p>当前支持持续聊天。还不能创建任务、自动记忆或执行外部动作。</p><button id="logout" type="button">退出登录</button></div></details>
<div class="conversation"><div id="messages" class="messages" role="log" aria-label="聊天记录" aria-live="polite" tabindex="0"></div><p id="empty-state" class="empty-state">正在加载聊天…</p><button id="latest" class="latest" type="button" hidden>回到最新</button></div>
<div class="feedback"><p id="error" class="error" role="alert"></p><button id="recover" type="button" hidden>重试回复</button><div id="send-errors" aria-live="polite"></div></div><button id="reload-chat" type="button" hidden>重新加载聊天</button>
<div class="composer"><form id="chat" class="chat"><textarea id="message" rows="1" aria-label="消息" placeholder="聊点什么…" autocomplete="off" maxlength="8000" enterkeyhint="enter"></textarea><button id="send" disabled>发送</button></form><p class="hint">Enter 发送 · Shift + Enter 换行</p></div></section><p id="login-error" class="error" role="alert"></p></main>
<script>
const appConfig=__MAIN_WEB_CONFIG__;
function channelUrl(url){const base=url.startsWith('/api/auth')?appConfig.authApiBase:appConfig.businessApiBase;return base==='/api'?url:base+url.slice('/api'.length)}
const messages=document.querySelector('#messages'),status=document.querySelector('#status'),error=document.querySelector('#error'),input=document.querySelector('#message'),owner=document.querySelector('#owner');
const setupStorageKey='agents-main-web-pending-setup';
const fragmentSetupToken=new URLSearchParams(location.hash.slice(1)).get('setup_token');
let setupToken=fragmentSetupToken;
try{if(fragmentSetupToken!==null){if(fragmentSetupToken)sessionStorage.setItem(setupStorageKey,fragmentSetupToken);else sessionStorage.removeItem(setupStorageKey)}else setupToken=sessionStorage.getItem(setupStorageKey)}catch(e){}
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
let stream,pollTimer,viewGeneration=0,eventRevision=0;
const loginPanel=document.querySelector('#login-panel'),privatePanel=document.querySelector('#private-panel'),password=document.querySelector('#password'),loginError=document.querySelector('#login-error');
const sendButton=document.querySelector('#send'),recoverButton=document.querySelector('#recover'),latest=document.querySelector('#latest'),emptyState=document.querySelector('#empty-state'),sendErrors=document.querySelector('#send-errors'),reloadButton=document.querySelector('#reload-chat'),ownerStatus=document.querySelector('#owner-status');
let loaded=false,loading=false,connectionLost=false,liveDisconnected=false,replyState='idle',replyError='',sending=false,recovering=false,composing=false,compositionEndedAt=-Infinity,draftRevision=0,unread=0;
let failedSends=[];
let savedOwnerContent='';
let followingLatest=true,scrollWidth=messages.clientWidth,scrollHeight=messages.clientHeight,touchY;
const seen=new Set();
function clearSetupToken(){setupToken=null;document.querySelector('#setup-credential').value='';try{sessionStorage.removeItem(setupStorageKey)}catch(e){}}
function stopPolling(){if(pollTimer!==undefined)clearTimeout(pollTimer);pollTimer=undefined}
function active(generation){return generation===viewGeneration&&!privatePanel.hidden}
function resizeInput(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight+2,160)+'px';syncChatSize()}
function updateSend(){sendButton.disabled=!loaded||sending||!input.value.trim();sendButton.textContent=sending?'发送中…':'发送'}
function replyFailure(message){return typeof message==='string'&&message.trim()?message.replaceAll('重试失败回合','重试回复'):'回复暂时失败，消息已保留。点击「重试回复」继续。'}
function renderState(){
  status.textContent=loading?'正在加载聊天…':!loaded?'聊天加载失败':connectionLost?'连接中断，正在重连…':liveDisconnected?'实时连接重连中…':replyState==='blocked'?'回复失败':replyState==='processing'?'正在回复…':'在线';
  error.textContent=replyState==='blocked'?(replyError||'回复暂时失败，消息已保留。'):(typeof extraErrorText==='function'?extraErrorText():'');
  recoverButton.hidden=replyState!=='blocked';recoverButton.disabled=recovering;
  emptyState.hidden=seen.size>0;emptyState.textContent=loading?'正在加载聊天…':loaded?'从一句话开始聊天吧。':'聊天未能加载，请重试。';updateSend();
}
function renderSendErrors(){
  sendErrors.replaceChildren();
  for(const attempt of failedSends){
    const row=document.createElement('div'),label=document.createElement('span'),button=document.createElement('button');row.className='send-failure';
    label.textContent=(attempt.uncertain?'尚未确认是否送达':'发送失败')+'：「'+attempt.content.slice(0,60)+(attempt.content.length>60?'…':'')+'」。'+attempt.error;
    button.type='button';button.textContent='重试发送';button.disabled=sending;button.addEventListener('click',()=>send(attempt));row.append(label,button);sendErrors.append(row);
  }
}
function showLogin(configured=true){
  viewGeneration++;stopPolling();if(stream){stream.close();stream=null}
  messages.replaceChildren();seen.clear();owner.value='';savedOwnerContent='';input.value='';error.textContent='';status.textContent='';privatePanel.hidden=true;loginPanel.hidden=false;
  loaded=false;loading=false;sending=false;recovering=false;composing=false;compositionEndedAt=-Infinity;draftRevision++;failedSends=[];replyState='idle';replyError='';connectionLost=false;liveDisconnected=false;unread=0;followingLatest=true;
  latest.hidden=true;reloadButton.hidden=true;ownerStatus.textContent='';document.querySelector('#settings').open=false;document.querySelector('#save-owner').disabled=false;document.querySelector('#login-button').disabled=false;
  renderSendErrors();resizeInput();updateSend();if(configured)clearSetupToken();
  document.querySelector('#setup-credential-panel').hidden=configured;document.querySelector('#setup-credential').value=setupToken||'';document.querySelector('#login-title').textContent=configured?'登录':'设置登录密码';document.querySelector('#login-button').textContent=configured?'登录':'设置密码';password.autocomplete=configured?'current-password':'new-password';
  document.querySelector('#login-notice').textContent=configured?'登录状态保持 30 天。':'请设置至少 8 个字符的密码。若没有初始化凭据，请从服务器本次启动日志中的 #setup_token= 后复制凭据并填入上方。';
}
async function pollStatus(generation){
  const revision=eventRevision;
  try{
    const current=await request('/api/status');if(!active(generation))return;
    const history=await request('/api/history');if(!active(generation))return;
    history.messages.forEach(add);connectionLost=false;if(!stream)openEvents(history.cursor);
    if(revision===eventRevision){replyState=current.state;replyError=current.state==='blocked'?replyFailure(current.message):''}
    renderState();
  }catch(e){if(active(generation)){connectionLost=true;renderState()}}
  finally{if(active(generation))pollTimer=setTimeout(()=>pollStatus(generation),3000)}
}
function nearBottom(){return messages.scrollHeight-messages.scrollTop-messages.clientHeight<80}
function showLatest(){latest.hidden=nearBottom();latest.textContent=unread?'有新消息 · 回到最新':'回到最新'}
function sizeChanged(){return scrollWidth!==messages.clientWidth||scrollHeight!==messages.clientHeight}
function rememberSize(){scrollWidth=messages.clientWidth;scrollHeight=messages.clientHeight}
function goLatest(){followingLatest=true;rememberSize();messages.scrollTop=messages.scrollHeight;unread=0;latest.hidden=true}
function syncChatSize(){
  if(privatePanel.hidden||!sizeChanged())return;
  rememberSize();if(followingLatest)goLatest();else showLatest();
}
messages.addEventListener('scroll',()=>{
  // Reflow can itself dispatch scroll before ResizeObserver runs. Preserve the
  // previous intent in that case instead of treating it as reading history.
  if(sizeChanged()){syncChatSize();return}
  followingLatest=nearBottom();if(followingLatest)unread=0;showLatest();
});
// An explicit move towards history wins even if a resize notification is pending.
messages.addEventListener('wheel',event=>{if(event.deltaY<0)followingLatest=false},{passive:true});
messages.addEventListener('touchstart',event=>{touchY=event.touches[0]?.clientY},{passive:true});
messages.addEventListener('touchmove',event=>{const y=event.touches[0]?.clientY;if(y>touchY)followingLatest=false;touchY=y},{passive:true});
messages.addEventListener('keydown',event=>{if(['ArrowUp','PageUp','Home'].includes(event.key)||(event.key===' '&&event.shiftKey))followingLatest=false});
if(typeof ResizeObserver==='function')new ResizeObserver(syncChatSize).observe(messages);
if(typeof window!=='undefined'){
  window.addEventListener('resize',syncChatSize);
  window.visualViewport?.addEventListener('resize',syncChatSize);
}
document.querySelector('#settings').addEventListener('toggle',syncChatSize);
latest.addEventListener('click',goLatest);
function add(message){
  if(seen.has(message.id))return;const follow=sizeChanged()?followingLatest:nearBottom();followingLatest=follow;seen.add(message.id);
  const row=document.createElement('div'),role=document.createElement('span'),body=document.createElement('div');
  row.className='message '+(message.role==='assistant'?'assistant':'user');role.className='role';role.textContent=message.role==='assistant'?'主 Agent':'你';body.className='bubble';body.textContent=message.content;
  row.append(role,body);messages.append(row);emptyState.hidden=true;
  if(follow)goLatest();else{unread++;showLatest()}
}
async function request(url,options){
  const generation=viewGeneration;
  // 应用层 deadline：请求超时按“接收状态未知”处理，进入可重试确认流程，而不是无限 pending。
  const timeout=typeof AbortSignal==='function'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(30000):undefined;
  const response=await fetch(channelUrl(url),{...options,credentials:'same-origin',...(timeout?{signal:timeout}:{})});
  if(generation!==viewGeneration)throw new Error('会话已切换');
  if(response.status===401){showLogin();loginError.textContent='请重新登录。';throw new Error('请重新登录。')}
  // The status already confirms acceptance even if the response body is lost.
  if(url==='/api/messages'&&response.ok)return {};
  let body;try{body=await response.json()}catch(e){if(response.ok)throw new Error('无法读取服务器响应。');body={}}
  if(generation!==viewGeneration)throw new Error('会话已切换');
  if(!response.ok){const failure=new Error(body.error||'请求无法完成。');failure.status=response.status;throw failure}return body;
}
function openEvents(cursor){
  if(stream)stream.close();stream=new EventSource(channelUrl('/api/events?cursor='+encodeURIComponent(cursor)));const current=stream,generation=viewGeneration;
  const isCurrent=()=>stream===current&&active(generation);
  current.addEventListener('open',()=>{if(isCurrent()){liveDisconnected=false;renderState()}});
  current.addEventListener('update',event=>{
    if(!isCurrent())return;const update=JSON.parse(event.data);eventRevision++;
    if(update.type==='submitted'){add(update.message);if(replyState!=='blocked')replyState='processing'}
    if(update.type==='reply'){add(update.message);replyState='idle';replyError=''}
    if(update.type==='error'){replyError=replyFailure(update.message);replyState='blocked'}
    if(update.type==='recovered'){replyState=update.count?'processing':'idle';replyError=''}renderState();
  });
  // Reload only the chat snapshot: a replay reset must not discard a draft or uncertain send.
  current.addEventListener('reset',async()=>{
    if(!isCurrent())return;current.close();
    try{const history=await request('/api/history');if(!isCurrent())return;history.messages.forEach(add);openEvents(history.cursor)}catch(e){if(isCurrent()){liveDisconnected=true;renderState();current.close();stream=null}}
  });
  current.onerror=async()=>{
    if(!isCurrent())return;liveDisconnected=true;renderState();
    try{const auth=await request('/api/auth');if(!isCurrent())return;if(!auth.authenticated){showLogin();loginError.textContent='请重新登录。'}}catch(e){if(isCurrent()){liveDisconnected=true;renderState()}}
  };
}
async function load(){
  stopPolling();if(stream){stream.close();stream=null}const generation=++viewGeneration;loading=true;loaded=false;loginError.textContent='';loginPanel.hidden=true;privatePanel.hidden=false;reloadButton.hidden=true;renderState();
  try{
    const history=await request('/api/history');if(!active(generation))return;
    const context=await request('/api/owner-context');if(!active(generation))return;
    history.messages.forEach(add);goLatest();owner.value=context.content;savedOwnerContent=context.content;loaded=true;loading=false;renderState();resizeInput();openEvents(history.cursor);await pollStatus(generation);
  }catch(e){if(active(generation)){loading=false;reloadButton.hidden=false;renderState()}}
}
reloadButton.addEventListener('click',load);
async function initialize(){try{const auth=await request('/api/auth');if(auth.configured)clearSetupToken();if(auth.authenticated)await load();else showLogin(auth.configured)}catch(e){showLogin(false);loginError.textContent='无法连接服务器，请稍后刷新。'}}
document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();loginError.textContent='';const button=document.querySelector('#login-button');if(button.disabled)return;button.disabled=true;try{const auth=await request('/api/auth');if(auth.configured)clearSetupToken();const credential=document.querySelector('#setup-credential').value.trim()||setupToken;if(!auth.configured&&!credential){loginError.textContent='请从服务器本次启动日志的 #setup_token= 后复制初始化凭据，填入上方后再设置密码。';document.querySelector('#setup-credential-panel').hidden=false;document.querySelector('#setup-credential').focus();return}await request(auth.configured?'/api/auth/login':'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:password.value,...(!auth.configured?{setupToken:credential}:{})})});clearSetupToken();password.value='';await load()}catch(e){loginError.textContent=e.message}finally{button.disabled=false}});
document.querySelector('#logout').addEventListener('click',async()=>{
  showLogin();const generation=viewGeneration,button=document.querySelector('#login-button');button.disabled=true;
  try{await request('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(generation===viewGeneration)loginError.textContent='已退出登录。'}
  catch(e){if(generation===viewGeneration)loginError.textContent='退出请求未确认，请刷新页面后再次退出。'}finally{if(generation===viewGeneration)button.disabled=false}
});
input.addEventListener('input',()=>{draftRevision++;resizeInput();updateSend()});
input.addEventListener('compositionstart',()=>{composing=true});
input.addEventListener('compositionend',()=>{composing=false;compositionEndedAt=Date.now()});
function isComposing(event){return composing||event.isComposing||event.keyCode===229||Date.now()-compositionEndedAt<60}
input.addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.shiftKey||isComposing(event))return;
  if(typeof matchMedia==='function'&&matchMedia('(pointer: coarse)').matches)return;
  event.preventDefault();if(!event.repeat)void send();
});
document.querySelector('#chat').addEventListener('submit',event=>{event.preventDefault();if(!isComposing(event))return send()});
async function send(retry){
  if(!loaded||privatePanel.hidden||sending||composing)return;
  const content=retry?retry.content:input.value;if(!content.trim())return;
  // Reuse a failed attempt even when resubmitted from the composer. A successful
  // attempt is removed, so intentionally sending the same text again gets a new key.
  const attempt=retry||failedSends.find(item=>item.content===content)||{content,idempotencyKey:crypto.randomUUID(),revision:draftRevision};
  const generation=viewGeneration,revision=eventRevision;sending=true;updateSend();renderSendErrors();
  try{
    await request('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:attempt.content,idempotencyKey:attempt.idempotencyKey})});
    if(!active(generation))return;
    failedSends=failedSends.filter(item=>item!==attempt);
    if(input.value===attempt.content&&draftRevision===attempt.revision){input.value='';draftRevision++;resizeInput()}
    if(eventRevision===revision&&replyState!=='blocked')replyState='processing';
    eventRevision++;
  }catch(e){
    if(!active(generation))return;
    attempt.uncertain=!e.status||e.status>=500||e.status===408;
    attempt.error=attempt.uncertain?'可重试确认，同一条消息不会重复保存。':e.message;
    if(!failedSends.includes(attempt))failedSends.push(attempt);
  }finally{if(active(generation)){sending=false;renderState();renderSendErrors()}}
}
document.querySelector('#save-owner').addEventListener('click',async()=>{
  const generation=viewGeneration,button=document.querySelector('#save-owner');if(button.disabled)return;button.disabled=true;ownerStatus.textContent='正在保存…';
  try{await request('/api/owner-context',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:owner.value})});if(active(generation)){savedOwnerContent=owner.value;ownerStatus.textContent='已明确保存，仅未来回合会使用。'}}
  catch(e){if(active(generation))ownerStatus.textContent=e.message}finally{if(active(generation))button.disabled=false}
});
recoverButton.addEventListener('click',async()=>{
  if(recovering||replyState!=='blocked')return;const generation=viewGeneration;recovering=true;eventRevision++;renderState();const revision=eventRevision;
  try{const body=await request('/api/recover',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!active(generation))return;if(eventRevision===revision){replyState=body.started?'processing':'idle';replyError=''}eventRevision++}
  catch(e){if(active(generation)){replyState='blocked';replyError='暂时无法重试，请稍后再试。'}}finally{if(active(generation)){recovering=false;renderState()}}
});
function setupVersionSwitch(){
  const nav=document.querySelector('#version-switch');nav.hidden=!appConfig.previewEnabled;
  document.querySelector('#version-current').textContent=appConfig.channel==='preview'?'当前：'+appConfig.previewLabel:'当前：稳定版';
  document.querySelector('#to-preview').textContent=appConfig.previewLabel;
  // extraSwitchBlock/extraSwitchDirty 由预览页注入：覆盖回答草稿、其他会话草稿与待确认控制提交。
  const guard=event=>{
    const blocked=sending?'发送尚未确认，请完成或超时后再切换。':(typeof extraSwitchBlock==='function'?extraSwitchBlock():undefined);
    if(blocked){event.preventDefault();status.textContent=blocked;return}
    const dirty=input.value.trim()||failedSends.length||owner.value!==savedOwnerContent||(typeof extraSwitchDirty==='function'&&extraSwitchDirty());
    if(dirty&&!confirm('切换将丢弃未提交内容。'))event.preventDefault()
  };
  document.querySelector('#to-stable').addEventListener('click',guard);document.querySelector('#to-preview').addEventListener('click',guard);
}
setupVersionSwitch();
initialize();
</script>`

export interface MainWebPageConfig {
  channel: 'stable' | 'preview'
  businessApiBase: '/api' | '/preview/api'
  authApiBase: '/api'
  releaseId: string
  previewEnabled: boolean
  previewLabel: string
}

const defaultMainWebPageConfig: MainWebPageConfig = {
  channel: 'stable',
  businessApiBase: '/api',
  authApiBase: '/api',
  releaseId: mainWebStableReleaseId,
  previewEnabled: false,
  previewLabel: '预览版 · 模拟演示',
}

function serializedPageConfig(config: MainWebPageConfig): string {
  return JSON.stringify(config).replace(/</g, '\\u003c')
}

export function createMainWebPage(overrides: Partial<MainWebPageConfig> = {}): string {
  const config = { ...defaultMainWebPageConfig }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (config as unknown as Record<string, unknown>)[key] = value
  }
  return mainWebPageTemplate.replace('__MAIN_WEB_CONFIG__', serializedPageConfig(config))
}

export const mainWebPage = createMainWebPage()

function isMainEntry(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url
}

if (isMainEntry()) {
  runMainWeb().catch(() => {
    process.stderr.write('无法启动本地 Web 主聊天。\n')
    process.exitCode = 1
  })
}
