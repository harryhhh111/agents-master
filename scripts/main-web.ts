#!/usr/bin/env tsx
import 'dotenv/config'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
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
import { defaultMainChatDataDirectory } from './main-chat.js'

export const mainWebLoopbackAddress = '127.0.0.1'
export const defaultMainWebPort = 31415
export const maxMainWebMessageCharacters = 8_000
const maxJsonBodyBytes = 32_000
const mainWebAccessTokenHeader = 'x-agents-main-web-token'
const mainWebEventReplayLimit = 256

export interface MainWebArguments {
  dataDirectory: string
  port: number
}

/** Fresh, in-memory bearer secret for one local Web-server lifetime. */
export function generateMainWebAccessToken(): string {
  return randomBytes(32).toString('base64url')
}

export function parseMainWebArguments(args: readonly string[], homeDirectory = homedir()): MainWebArguments {
  let dataDirectory = defaultMainChatDataDirectory(homeDirectory)
  let port = defaultMainWebPort
  let sawDataDirectory = false
  let sawPort = false
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
    throw new Error(`未知参数: ${arg ?? ''}`)
  }
  return { dataDirectory, port }
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

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

function html(response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  })
  response.end(mainWebPage)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
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
  readonly #clients = new Set<ServerResponse>()
  readonly #history: MainWebEventRecord[] = []
  #cursor = 0

  snapshot<T>(read: () => T): { value: T; cursor: number } {
    // Node runs this synchronous section without an interleaving publish, so
    // the cursor and durable history describe one client-observable point.
    return { value: read(), cursor: this.#cursor }
  }

  subscribe(response: ServerResponse, afterCursor?: number): void {
    const oldestCursor = this.#history[0]?.cursor
    if (afterCursor !== undefined && oldestCursor !== undefined && afterCursor < oldestCursor - 1) {
      response.write('event: reset\ndata: {"type":"reset"}\n\n')
      response.end()
      return
    }
    this.#clients.add(response)
    response.once('close', () => this.#clients.delete(response))
    if (afterCursor !== undefined) {
      for (const record of this.#history) {
        if (record.cursor > afterCursor) this.#write(response, record)
      }
    }
  }

  publish(event: MainWebEvent): void {
    const record = { cursor: ++this.#cursor, event }
    this.#history.push(record)
    if (this.#history.length > mainWebEventReplayLimit) this.#history.shift()
    for (const client of this.#clients) this.#write(client, record)
  }

  close(): void {
    for (const client of this.#clients) client.end()
    this.#clients.clear()
  }

  #write(response: ServerResponse, record: MainWebEventRecord): void {
    response.write(`id: ${record.cursor}\nevent: update\ndata: ${JSON.stringify(record.event)}\n\n`)
  }
}

export function foregroundEventForWeb(event: ForegroundHostEvent): MainWebEvent {
  switch (event.type) {
    case 'submitted': return { type: 'submitted', message: event.result.message }
    case 'reply': return { type: 'reply', message: event.result.message }
    case 'error': return { type: 'error', message: '模型请求失败；消息已保留，等待明确重试。' }
    case 'recovered': return { type: 'recovered', count: event.count }
  }
}

export interface MainWebHost {
  start(): number
  submit(input: { content: string; idempotencyKey: string }): unknown
  recover(): number | undefined
  setCheckpoint(checkpoint?: string): void
}

export interface MainWebServerOptions {
  host: MainWebHost
  readHistory(): MainConversationMessage[]
  dataDirectory: string
  events: MainWebEventBus
  /** In-memory secret generated once by the process entrypoint. */
  accessToken: string
}

export function createMainWebServer(options: MainWebServerOptions): Server {
  return createServer((request, response) => {
    void handleMainWebRequest(request, response, options).catch(() => {
      if (!response.headersSent) json(response, 500, { error: '服务器无法完成请求。' })
      else response.end()
    })
  })
}

async function handleMainWebRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: MainWebServerOptions,
): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  if (method === 'GET' && pathname === '/') return html(response)
  if (pathname.startsWith('/api/') && !isAuthorized(request, url, options.accessToken)) {
    return json(response, 401, { error: '未授权。' })
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
    options.events.subscribe(response, parseEventCursor(url.searchParams.get('cursor')))
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

function isAuthorized(request: IncomingMessage, url: URL, expectedToken: string): boolean {
  const provided = url.pathname === '/api/events'
    ? url.searchParams.get('access_token')
    : request.headers[mainWebAccessTokenHeader]
  if (typeof provided !== 'string') return false
  const expected = Buffer.from(expectedToken)
  const actual = Buffer.from(provided)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
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
  const { dataDirectory, port } = parseMainWebArguments(args)
  // Check this before creating SQLite so an accidentally selected repository
  // never receives either the private context or the Web runtime database.
  initializeOwnerContext(dataDirectory)
  const config = loadConfig()
  const resources = createMainAgentRuntime({ dataDirectory, frontBrain: createFrontBrain(config) })
  const events = new MainWebEventBus()
  const accessToken = generateMainWebAccessToken()
  const host = new MainAgentForegroundHost(resources.runtime, {
    checkpoint: mainCheckpoint(readOwnerContext(dataDirectory)),
    onEvent: event => events.publish(foregroundEventForWeb(event)),
  })
  const server = createMainWebServer({
    host,
    readHistory: () => resources.store.readRecentContext(100),
    dataDirectory,
    events,
    accessToken,
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
      if (server.listening) server.close(finalize)
      else finalize()
    })
    return closing
  }
  try {
    const actualPort = await listenMainWebServer(server, port)
    host.start()
    process.stdout.write(`本地 Web 主聊天已启动：http://${mainWebLoopbackAddress}:${actualPort}/#access_token=${accessToken}\n`)
    process.stdout.write('仅监听 127.0.0.1；远程使用必须通过 SSH 端口转发，绝不提供公网监听。\n')
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

const mainWebPage = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>主 Agent</title>
<style>
body{font:16px system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#202124}h1{font-size:1.25rem}.notice{color:#555}.messages{border:1px solid #ccc;min-height:18rem;padding:1rem;white-space:pre-wrap}.message{margin:.55rem 0}.role{font-weight:600}.status{min-height:1.5rem;margin:.75rem 0}.error{color:#a00}textarea,input,button{font:inherit}textarea{width:100%;box-sizing:border-box;min-height:6rem}.chat{display:flex;gap:.5rem}.chat input{flex:1}.owner{margin-top:2rem;border-top:1px solid #ccc;padding-top:1rem}
</style>
<main><h1>主 Agent</h1><p class="notice">私有本地入口。当前不能创建任务、记忆或认识，也不能执行外部动作。</p>
<div id="messages" class="messages" aria-live="polite"></div><p id="status" class="status">正在加载…</p><p id="error" class="error" role="alert"></p>
<form id="chat" class="chat"><input id="message" aria-label="消息" autocomplete="off" maxlength="8000"><button>发送</button></form><button id="recover" type="button">重试失败回合</button>
<section class="owner"><h2>显式主人上下文</h2><p>这是你明确维护的稳定背景，不是自动记忆。保存后仅影响未来回合。</p><textarea id="owner" aria-label="主人上下文" maxlength="12000"></textarea><button id="save-owner" type="button">明确保存主人上下文</button></section></main>
<script>
const messages=document.querySelector('#messages'),status=document.querySelector('#status'),error=document.querySelector('#error'),input=document.querySelector('#message'),owner=document.querySelector('#owner');
const accessToken=new URLSearchParams(location.hash.slice(1)).get('access_token');
const seen=new Set();
function add(message){if(seen.has(message.id))return;seen.add(message.id);const row=document.createElement('div'),role=document.createElement('span');row.className='message';role.className='role';role.textContent=(message.role==='assistant'?'主 Agent':'你')+'：';row.append(role,document.createTextNode(message.content));messages.append(row);messages.scrollTop=messages.scrollHeight}
async function request(url,options){const headers=new Headers(options&&options.headers);headers.set('${mainWebAccessTokenHeader}',accessToken);const response=await fetch(url,{...options,headers});const body=await response.json();if(!response.ok)throw new Error(body.error||'请求无法完成。');return body}
function openEvents(cursor){const stream=new EventSource('/api/events?access_token='+encodeURIComponent(accessToken)+'&cursor='+encodeURIComponent(cursor));stream.addEventListener('update',event=>{const update=JSON.parse(event.data);if(update.type==='submitted'){add(update.message);status.textContent='已排队，正在等待回复。'}if(update.type==='reply'){add(update.message);status.textContent='已回复。'}if(update.type==='error'){error.textContent=update.message;status.textContent='回复失败。'}if(update.type==='recovered'){status.textContent='已恢复 '+update.count+' 条消息。'}});stream.addEventListener('reset',()=>location.reload());stream.onerror=()=>{status.textContent='实时连接暂时断开；刷新可读取已持久化的历史。'}}
async function load(){try{const history=await request('/api/history');const context=await request('/api/owner-context');history.messages.forEach(add);owner.value=context.content;status.textContent='准备就绪。';openEvents(history.cursor)}catch(e){error.textContent=e.message;status.textContent='加载失败。'}}
document.querySelector('#chat').addEventListener('submit',async e=>{e.preventDefault();error.textContent='';const content=input.value;if(!content.trim()){error.textContent='消息不能为空';return}status.textContent='发送中；消息会先保存。';try{await request('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,idempotencyKey:crypto.randomUUID()})});input.value='';status.textContent='已排队，正在等待回复。'}catch(e){error.textContent=e.message;status.textContent='发送失败。'}});
document.querySelector('#save-owner').addEventListener('click',async()=>{error.textContent='';try{await request('/api/owner-context',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:owner.value})});status.textContent='主人上下文已明确保存；仅未来回合会使用它。'}catch(e){error.textContent=e.message}});
document.querySelector('#recover').addEventListener('click',async()=>{try{const body=await request('/api/recover',{method:'POST'});status.textContent=body.started?'已恢复，正在重试。':'当前没有可恢复的失败回合。'}catch(e){error.textContent=e.message}});
if(!accessToken){error.textContent='此页面需要从启动终端提供的本地访问链接打开。';status.textContent='未连接。';document.querySelectorAll('input,textarea,button').forEach(element=>{element.disabled=true})}else load();
</script>`

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
