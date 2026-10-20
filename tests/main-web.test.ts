import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainWebAuth } from '../src/main/web-auth.js'
import { handleMainWebRequest, listenMainWebServer, MainWebEventBus, mainCheckpoint, parseMainWebArguments, defaultMainWebPort, foregroundEventForWeb, safeProviderFailure, type MainWebServerOptions } from '../scripts/main-web.js'

// The execution sandbox places a virtual Git marker at /tmp/.git. Ignore only
// that marker for these disposable fixtures; keep all production path checks.
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === '/tmp/.git') throw Object.assign(new Error('fixture root'), { code: 'ENOENT' })
    return fs.lstatSync(...args)
  } }
})

class Response extends EventEmitter {
  status = 0
  headers: Record<string, unknown> = {}
  text = ''
  ended = false
  setHeader(name: string, value: unknown): void { this.headers[name.toLowerCase()] = value }
  writeHead(status: number, headers: Record<string, unknown>): void { this.status = status; Object.entries(headers).forEach(([key, value]) => this.setHeader(key, value)) }
  write(value: string): void { this.text += value }
  end(value = ''): void { this.text += value; this.ended = true; this.emit('close') }
}

function pendingResponse() {
  type BrowserResponse = { ok: boolean; status: number; json(): Promise<unknown> }
  let resolve!: (value: BrowserResponse) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<BrowserResponse>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const browserResponse = (status = 202, body: unknown = { accepted: true }) => ({ ok: status < 400, status, json: async () => body })

describe('main web', () => {
  let directory: string
  let options: MainWebServerOptions
  let cookie: string
  let now: number
  const origin = 'https://example.tail123.ts.net'
  async function call(url: string, method = 'GET', body?: unknown, overrides: Record<string, string | undefined> = {}): Promise<Response> {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
    request.url = url
    request.method = method
    request.headers = { host: 'example.tail123.ts.net', origin, 'content-type': 'application/json', cookie, ...overrides }
    const response = new Response()
    await handleMainWebRequest(request, response as unknown as ServerResponse, options)
    return response
  }
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'main-web-test-'))
    now = Date.now()
    cookie = ''
    options = {
      host: { start: () => 0, submit: vi.fn(), recover: () => 0, setCheckpoint: vi.fn(), getStatus: () => 'idle' },
      readHistory: () => [{ id: '1', role: 'assistant', content: 'Private reply', createdAt: new Date(now).toISOString() }],
      dataDirectory: directory, events: new MainWebEventBus(), auth: new MainWebAuth(directory, () => now),
    }
  })
  afterEach(() => { options?.events.close(); rmSync(directory, { recursive: true, force: true }) })
  async function setup(): Promise<void> {
    const response = await call('/api/auth/setup', 'POST', { password: 'a real password', setupToken: options.auth.setupToken })
    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict; Max-Age=2592000; Secure')
    cookie = (response.headers['set-cookie'] as string).split(';')[0]!
  }
  it('reports current blocked status after refresh only to logged-in clients', async () => {
    expect((await call('/api/status')).status).toBe(401)
    await setup()
    options.host.getStatus = () => 'blocked'
    const failure = foregroundEventForWeb({ type: 'error', error: { status: 401, message: 'private key' } })
    options.events.publish(failure)
    expect(JSON.parse((await call('/api/status')).text)).toEqual({ state: 'blocked', message: '模型服务认证失败；消息已保留，请点击“重试失败回合”。' })
    options.events.publish({ type: 'recovered', count: 1 })
    expect(JSON.parse((await call('/api/status')).text)).toEqual({ state: 'blocked' })
  })

  it('classifies safe provider errors without exposing raw diagnostics', () => {
    for (const [error, category] of [
      [{ name: 'APIConnectionTimeoutError' }, 'timeout'], [{ name: 'APIConnectionError' }, 'network'],
      [{ status: 401 }, 'authentication'], [{ status: 402 }, 'balance'], [{ status: 429 }, 'rate_limit'],
      [{ status: 503 }, 'provider'], [{ status: 400 }, 'unknown'],
    ] as const) {
      const failure = safeProviderFailure({ ...error, message: 'private secret', stack: 'private stack', headers: { authorization: 'private token' } })
      expect(failure.category).toBe(category)
      expect(JSON.stringify(failure)).not.toContain('private')
    }
  })
  async function bootBrowser(storage: Map<string, string>, hash = '', storageUnavailable = false, resizeObserverAvailable = true) {
    const timers: Array<() => Promise<void>> = []
    const clearTimer = vi.fn()
    const source = (await call('/')).text.split('<script>')[1]!.split('</script>')[0]!
    class Element {
      hidden = true
      disabled = false
      focused = false
      value = ''
      textContent = ''
      className = ''
      style = { height: '' }
      scrollHeight = 0
      clientWidth = 760
      clientHeight = 300
      scrollTop = 0
      children: Element[] = []
      listeners = new Map<string, (event: { preventDefault(): void; key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean }) => Promise<void> | void>()
      append(...values: Element[]): void { this.children.push(...values); this.scrollHeight += 100 * values.length }
      replaceChildren(): void { this.children = [] }
      focus(): void { this.focused = true }
      addEventListener(name: string, callback: (event: { preventDefault(): void }) => Promise<void>): void { this.listeners.set(name, callback) }
    }
    const elements = new Map<string, Element>()
    const element = (key: string): Element => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key)! }
    const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const response = await call(url, init?.method, init?.body ? JSON.parse(init.body) : undefined)
      const newCookie = response.headers['set-cookie'] as string | undefined
      if (newCookie) cookie = newCookie.split(';')[0]!
      return { ok: response.status < 400, status: response.status, json: async () => JSON.parse(response.text) }
    })
    const location = { hash, pathname: '/', search: '' }
    const replaceState = vi.fn(() => { location.hash = '' })
    const sessionStorage = {
      getItem: (key: string) => { if (storageUnavailable) throw new Error('unavailable'); return storage.get(key) ?? null },
      setItem: (key: string, value: string) => { if (storageUnavailable) throw new Error('unavailable'); storage.set(key, value) },
      removeItem: (key: string) => { if (storageUnavailable) throw new Error('unavailable'); storage.delete(key) },
    }
    const streams: FakeEvents[] = []
    class FakeEvents {
      closed = false
      listeners = new Map<string, (event: { data: string }) => Promise<void> | void>()
      onerror?: () => Promise<void>
      constructor(readonly url: string) { streams.push(this) }
      close(): void { this.closed = true }
      addEventListener(name: string, callback: (event: { data: string }) => Promise<void> | void): void { this.listeners.set(name, callback) }
      emit(name: string, value: unknown = {}): Promise<void> | void { return this.listeners.get(name)?.({ data: JSON.stringify(value) }) }
    }
    let nextKey = 0, browserTime = 1000, touch = false
    const resizeCallbacks: Array<() => void> = []
    const windowListeners = new Map<string, () => void>()
    const viewportListeners = new Map<string, () => void>()
    runInNewContext(source, {
      document: { querySelector: element, createElement: () => new Element(), createTextNode: (text: string) => text },
      fetch, URLSearchParams, location, history: { replaceState }, sessionStorage, setTimeout: (callback: () => Promise<void>) => { timers.push(callback); return timers.length }, clearTimeout: clearTimer,
      EventSource: FakeEvents, crypto: { randomUUID: () => 'client-' + ++nextKey },
      Date: { now: () => browserTime }, matchMedia: () => ({ matches: touch }),
      ResizeObserver: resizeObserverAvailable ? class {
        constructor(callback: () => void) { resizeCallbacks.push(callback) }
        observe(target: Element): void { expect(target).toBe(element('#messages')) }
      } : undefined,
      window: {
        addEventListener: (name: string, callback: () => void) => windowListeners.set(name, callback),
        visualViewport: { addEventListener: (name: string, callback: () => void) => viewportListeners.set(name, callback) },
      },
    })
    await vi.waitFor(() => expect(!element('#login-panel').hidden || !element('#private-panel').hidden).toBe(true))
    const fire = (selector: string, name: string, event = {}) => element(selector).listeners.get(name)!({ preventDefault() {}, ...event })
    const draft = (content: string) => { element('#message').value = content; return fire('#message', 'input') }
    return { element, fetch, location, replaceState, timers, clearTimer, streams, fire, draft, resize: () => resizeCallbacks.forEach(callback => callback()), resizeWindow: () => windowListeners.get('resize')!(), resizeViewport: () => viewportListeners.get('resize')!(), advance: (ms: number) => { browserTime += ms }, setTouch: () => { touch = true }, submit: () => fire('#login', 'submit'), submitChat: () => fire('#chat', 'submit') }
  }

  async function chatBrowser() {
    await setup()
    const browser = await bootBrowser(new Map())
    await vi.waitFor(() => expect(browser.timers.length).toBe(1))
    return browser
  }

  it('handles IME confirmation, desktop Enter, Shift+Enter and touch keyboards without accidental sends', async () => {
    const browser = await chatBrowser()
    const submissions = () => browser.fetch.mock.calls.filter(([url]) => url === '/api/messages')
    browser.draft('中文输入')
    const preventDefault = vi.fn()
    await browser.fire('#message', 'compositionstart')
    await browser.fire('#message', 'keydown', { key: 'Enter', preventDefault })
    await browser.submitChat()
    await browser.fire('#message', 'compositionend')
    await browser.fire('#message', 'keydown', { key: 'Enter', preventDefault })
    expect(submissions()).toHaveLength(0)
    browser.advance(100)
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
      await browser.fire('#message', 'keydown', { key: 'Enter', preventDefault, ...extra })
    }
    expect(submissions()).toHaveLength(0)
    expect(preventDefault).not.toHaveBeenCalled()
    await browser.fire('#message', 'keydown', { key: 'Enter', preventDefault })
    await vi.waitFor(() => expect(browser.element('#message').value).toBe(''))
    expect(submissions()).toHaveLength(1)
    expect(preventDefault).toHaveBeenCalledOnce()
    browser.setTouch()
    browser.draft('手机换行')
    await browser.fire('#message', 'keydown', { key: 'Enter', preventDefault })
    expect(submissions()).toHaveLength(1)
    await browser.submitChat()
    expect(submissions()).toHaveLength(2)
  })

  it('locks only the HTTP submit, preserves newer drafts and accepts another message while replying', async () => {
    const browser = await chatBrowser()
    browser.draft('   \n')
    expect(browser.element('#send').disabled).toBe(true)
    await browser.submitChat()
    expect(options.host.submit).not.toHaveBeenCalled()
    browser.draft('第一句')
    const pending = pendingResponse()
    browser.fetch.mockImplementationOnce(() => pending.promise)
    const first = browser.submitChat()
    expect(browser.element('#send').disabled).toBe(true)
    browser.draft('下一句话')
    await browser.submitChat()
    expect(browser.fetch.mock.calls.filter(([url]) => url === '/api/messages')).toHaveLength(1)
    pending.resolve(browserResponse())
    await first
    expect(browser.element('#message').value).toBe('下一句话')
    expect(browser.element('#send').disabled).toBe(false)
    expect(browser.element('#status').textContent).toBe('正在回复…')
    await browser.submitChat()
    expect(browser.element('#message').value).toBe('')
    expect(browser.element('#send').disabled).toBe(true)
    expect(options.host.submit).toHaveBeenCalledWith({ content: '下一句话', idempotencyKey: 'client-2' })
  })

  it('does not clear a newly edited identical draft when a send returns late', async () => {
    const browser = await chatBrowser()
    browser.draft('同一句')
    const pending = pendingResponse()
    browser.fetch.mockImplementationOnce(() => pending.promise)
    const submit = browser.submitChat()
    browser.draft('别的内容')
    browser.draft('同一句')
    pending.resolve(browserResponse())
    await submit
    expect(browser.element('#message').value).toBe('同一句')
  })

  it('retains uncertain sends across polls and retries the original key, then gives deliberate repeats a new key', async () => {
    const browser = await chatBrowser()
    browser.draft('可能已经送达')
    browser.fetch.mockRejectedValueOnce(new Error('connection lost'))
    await browser.submitChat()
    expect(browser.element('#message').value).toBe('可能已经送达')
    expect(browser.element('#send-errors').children[0]!.children[0]!.textContent).toContain('尚未确认是否送达')
    await browser.timers[0]!()
    expect(browser.element('#send-errors').children).toHaveLength(1)
    await browser.submitChat()
    const payloads = () => browser.fetch.mock.calls.filter(([url]) => url === '/api/messages').map(([, init]) => JSON.parse(init!.body!))
    expect(payloads()[0].idempotencyKey).toBe(payloads()[1].idempotencyKey)
    expect(browser.element('#send-errors').children).toHaveLength(0)
    expect(browser.element('#message').value).toBe('')
    browser.draft('可能已经送达')
    await browser.submitChat()
    expect(payloads()[2].idempotencyKey).not.toBe(payloads()[1].idempotencyKey)
  })

  it('retries a failed original separately from the new draft and prevents duplicate retry clicks', async () => {
    const browser = await chatBrowser()
    browser.draft('原消息')
    browser.fetch.mockResolvedValueOnce(browserResponse(503))
    await browser.submitChat()
    browser.draft('保留的新草稿')
    const retry = browser.element('#send-errors').children[0]!.children[1]!.listeners.get('click')!
    const pending = pendingResponse()
    browser.fetch.mockImplementationOnce(() => pending.promise)
    const retrying = retry({ preventDefault() {} })
    await retry({ preventDefault() {} })
    expect(browser.fetch.mock.calls.filter(([url]) => url === '/api/messages')).toHaveLength(2)
    pending.resolve(browserResponse())
    await retrying
    expect(browser.element('#message').value).toBe('保留的新草稿')
    expect(browser.element('#send-errors').children).toHaveLength(0)
  })

  it('distinguishes explicit rejection from uncertain delivery and treats a 202 with a lost body as accepted', async () => {
    const browser = await chatBrowser()
    browser.draft('原消息')
    browser.fetch.mockResolvedValueOnce(browserResponse(400, { error: '消息无法提交' }))
    await browser.submitChat()
    expect(browser.element('#send-errors').children[0]!.children[0]!.textContent).toContain('发送失败')
    expect(browser.element('#message').value).toBe('原消息')
    browser.fetch.mockResolvedValueOnce({ ok: true, status: 202, json: async () => { throw new Error('body lost') } })
    await browser.submitChat()
    expect(browser.element('#message').value).toBe('')
    expect(browser.element('#send-errors').children).toHaveLength(0)
  })

  it('follows replies near the bottom, leaves history readers in place and safely renders text', async () => {
    const browser = await chatBrowser()
    const messages = browser.element('#messages'), stream = browser.streams[0]!
    messages.scrollHeight = 1200; messages.clientHeight = 400; browser.resize(); messages.scrollTop = 200
    await browser.fire('#messages', 'scroll')
    expect(browser.element('#latest').hidden).toBe(false)
    const content = '<img src=x onerror=alert(1)>\n' + 'https://example.com/' + 'long'.repeat(500)
    await stream.emit('update', { type: 'reply', message: { id: 'new', role: 'assistant', content } })
    expect(messages.scrollTop).toBe(200)
    expect(browser.element('#latest').textContent).toContain('有新消息')
    expect(messages.children.at(-1)!.children[1]!.textContent).toBe(content)
    expect(messages.children.at(-1)!.className).toBe('message assistant')
    await stream.emit('update', { type: 'reply', message: { id: 'new', role: 'assistant', content } })
    expect(messages.children).toHaveLength(2)
    await browser.fire('#latest', 'click')
    expect(messages.scrollTop).toBe(messages.scrollHeight)
    expect(browser.element('#latest').hidden).toBe(true)
    messages.scrollTop = messages.scrollHeight - messages.clientHeight - 20
    await stream.emit('update', { type: 'submitted', message: { id: 'mine', role: 'user', content: '你好' } })
    expect(messages.scrollTop).toBe(messages.scrollHeight)
    expect(messages.children.at(-1)!.className).toBe('message user')
  })

  it.each(['resize-first', 'scroll-first'])('keeps following latest through reflow with %s notifications', async order => {
    const browser = await chatBrowser(), messages = browser.element('#messages')
    messages.scrollHeight = 1400
    await browser.fire('#latest', 'click')
    // Narrowing wraps existing messages, placing the old bottom far above the new one.
    messages.clientWidth = 390; messages.scrollHeight = 2600
    if (order === 'scroll-first') await browser.fire('#messages', 'scroll')
    browser.resize()
    expect(messages.scrollTop).toBe(2600)
    expect(browser.element('#latest').hidden).toBe(true)
    await browser.fire('#messages', 'scroll')
    // The same observer covers space taken by a growing composer or open settings.
    for (const height of [220, 150, 300]) {
      messages.clientHeight = height
      messages.scrollTop = messages.scrollHeight - 300
      browser.resize()
      expect(messages.scrollTop).toBe(messages.scrollHeight)
      expect(browser.element('#latest').hidden).toBe(true)
    }
    // An extra observer delivery does not create a new scroll or resize cycle.
    browser.resize()
    expect(messages.scrollTop).toBe(2600)
  })

  it('keeps history readers in place on resize and honors scrolling away before a pending observer callback', async () => {
    const browser = await chatBrowser(), messages = browser.element('#messages')
    messages.scrollHeight = 1600
    await browser.fire('#latest', 'click')
    messages.scrollTop = 300
    await browser.fire('#messages', 'scroll')
    messages.clientWidth = 390; messages.scrollHeight = 2800; messages.clientHeight = 200
    browser.resize()
    expect(messages.scrollTop).toBe(300)
    expect(browser.element('#latest').hidden).toBe(false)
    await browser.streams[0]!.emit('update', { type: 'reply', message: { id: 'resized', role: 'assistant', content: '新回复' } })
    browser.resize()
    expect(messages.scrollTop).toBe(300)
    expect(browser.element('#latest').textContent).toContain('有新消息')
    await browser.fire('#latest', 'click')
    messages.clientHeight = 160
    await browser.fire('#messages', 'wheel', { deltaY: -250 })
    messages.scrollTop = 900
    // A user scroll can reach the DOM before its scroll event is dispatched.
    browser.resize()
    await browser.fire('#messages', 'scroll')
    browser.resize()
    expect(messages.scrollTop).toBe(900)
    expect(browser.element('#latest').hidden).toBe(false)
  })

  it('handles viewport, textarea and settings size changes without ResizeObserver', async () => {
    await setup()
    const browser = await bootBrowser(new Map(), '', false, false)
    await vi.waitFor(() => expect(browser.timers).toHaveLength(1))
    const messages = browser.element('#messages')
    messages.scrollHeight = 1500
    await browser.fire('#latest', 'click')
    messages.clientWidth = 390; messages.scrollHeight = 2500
    browser.resizeWindow()
    expect(messages.scrollTop).toBe(2500)
    messages.clientHeight = 240; messages.scrollTop = 2100
    browser.resizeViewport()
    expect(messages.scrollTop).toBe(2500)
    messages.clientHeight = 180; messages.scrollTop = 2200
    browser.draft('多行\n草稿')
    expect(messages.scrollTop).toBe(2500)
    messages.clientHeight = 120; messages.scrollTop = 2300
    await browser.fire('#settings', 'toggle')
    expect(messages.scrollTop).toBe(2500)
    messages.scrollTop = 300
    await browser.fire('#messages', 'scroll')
    messages.clientHeight = 200
    await browser.fire('#settings', 'toggle')
    expect(messages.scrollTop).toBe(300)
    expect(browser.element('#latest').hidden).toBe(false)
  })

  it.each([
    [{ name: 'APIConnectionTimeoutError' }, '模型请求超时（30 秒）'],
    [{ status: 401 }, '模型服务认证失败'],
    [{ status: 402 }, '模型服务返回余额不足'],
  ])('preserves safe failure reasons from polling and SSE: %j', async (providerError, reason) => {
    const message = safeProviderFailure(providerError).message
    options.host.getStatus = () => 'blocked'
    options.events.publish({ type: 'error', message })
    const browser = await chatBrowser()
    expect(browser.element('#error').textContent).toContain(reason)
    expect(browser.element('#error').textContent).toContain('重试回复')
    expect(browser.element('#error').textContent).not.toContain('重试失败回合')
    await browser.streams[0]!.emit('update', { type: 'recovered', count: 1 })
    expect(browser.element('#error').textContent).toBe('')
    await browser.streams[0]!.emit('update', { type: 'error', message })
    expect(browser.element('#error').textContent).toBe(message.replaceAll('重试失败回合', '重试回复'))
    expect(browser.element('#recover').hidden).toBe(false)
  })

  it('retains a friendly fallback when polling or SSE provides no failure reason', async () => {
    options.host.getStatus = () => 'blocked'
    const browser = await chatBrowser()
    expect(browser.element('#error').textContent).toContain('回复暂时失败，消息已保留')
    await browser.streams[0]!.emit('update', { type: 'error', message: ' ' })
    expect(browser.element('#error').textContent).toContain('回复暂时失败，消息已保留')
    expect(browser.element('#error').textContent).toContain('重试回复')
  })

  it.each([202, 401, 503])('isolates an old send returning %s after logout and a fresh login', async status => {
    const browser = await chatBrowser()
    browser.draft('旧会话消息')
    const pending = pendingResponse()
    browser.fetch.mockImplementationOnce(() => pending.promise)
    const oldSend = browser.submitChat()
    await browser.fire('#logout', 'click')
    browser.element('#password').value = 'a real password'
    await browser.submit()
    browser.draft('新会话草稿')
    pending.resolve(browserResponse(status))
    await oldSend
    expect(browser.element('#private-panel').hidden).toBe(false)
    expect(browser.element('#message').value).toBe('新会话草稿')
    expect(browser.element('#send').disabled).toBe(false)
    expect(browser.element('#send-errors').children).toHaveLength(0)
    expect(browser.element('#status').textContent).toBe('在线')
  })

  it('clears private drafts and pending retries on current 401 and ignores stale stream callbacks', async () => {
    const browser = await chatBrowser()
    const oldStream = browser.streams[0]!
    browser.draft('私有草稿')
    browser.fetch.mockResolvedValueOnce(browserResponse(401))
    await browser.submitChat()
    expect(browser.element('#private-panel').hidden).toBe(true)
    expect(browser.element('#message').value).toBe('')
    expect(browser.element('#send-errors').children).toHaveLength(0)
    expect(browser.element('#messages').children).toHaveLength(0)
    expect(oldStream.closed).toBe(true)
    await oldStream.emit('update', { type: 'reply', message: { id: 'stale', content: '旧消息' } })
    await oldStream.emit('reset')
    expect(browser.element('#messages').children).toHaveLength(0)
    expect(browser.element('#login-error').textContent).toBe('请重新登录。')
  })

  it('shows empty and disconnected states, recovers via polling and preserves drafts across SSE reset', async () => {
    options.readHistory = () => []
    const browser = await chatBrowser()
    expect(browser.element('#empty-state').hidden).toBe(false)
    expect(browser.element('#empty-state').textContent).toContain('从一句话开始')
    expect(browser.element('#recover').hidden).toBe(true)
    browser.fetch.mockRejectedValueOnce(new Error('offline'))
    await browser.timers[0]!()
    expect(browser.element('#status').textContent).toContain('连接中断')
    await browser.timers[1]!()
    expect(browser.element('#status').textContent).toBe('在线')
    browser.draft('未发送的草稿')
    await browser.streams[0]!.onerror!()
    expect(browser.element('#status').textContent).toContain('重连')
    await browser.streams[0]!.emit('open')
    expect(browser.element('#status').textContent).toBe('在线')
    await browser.streams[0]!.emit('reset')
    expect(browser.streams).toHaveLength(2)
    expect(browser.streams[0]!.closed).toBe(true)
    expect(browser.element('#message').value).toBe('未发送的草稿')
  })

  it('keeps a newer SSE failure when an older status poll completes', async () => {
    const browser = await chatBrowser()
    const pending = pendingResponse()
    browser.fetch.mockImplementationOnce(() => pending.promise)
    const poll = browser.timers[0]!()
    await browser.streams[0]!.emit('update', { type: 'error', message: 'provider details' })
    pending.resolve(browserResponse(200, { state: 'idle' }))
    await poll
    expect(browser.element('#recover').hidden).toBe(false)
    expect(browser.element('#error').textContent).toBe('provider details')
  })

  it('offers a working load retry after initial failure and keeps the composer disabled until ready', async () => {
    await setup()
    options.readHistory = vi.fn().mockImplementationOnce(() => { throw new Error('offline') }).mockReturnValue([])
    const browser = await bootBrowser(new Map())
    await vi.waitFor(() => expect(browser.element('#reload-chat').hidden).toBe(false))
    expect(browser.element('#status').textContent).toBe('聊天加载失败')
    browser.draft('加载期间编辑的草稿')
    expect(browser.element('#send').disabled).toBe(true)
    await browser.submitChat()
    expect(options.host.submit).not.toHaveBeenCalled()
    await browser.fire('#reload-chat', 'click')
    expect(browser.element('#reload-chat').hidden).toBe(true)
    expect(browser.element('#send').disabled).toBe(false)
    expect(browser.element('#message').value).toBe('加载期间编辑的草稿')
    expect(browser.element('#empty-state').textContent).toContain('从一句话开始')
    expect(browser.streams).toHaveLength(1)
    expect(browser.timers).toHaveLength(1)
  })

  it('reopens SSE through polling after a reset snapshot fails, keeping the uncertain attempt', async () => {
    const browser = await chatBrowser()
    browser.draft('待确认的消息')
    browser.fetch.mockRejectedValueOnce(new Error('offline'))
    await browser.submitChat()
    browser.fetch.mockRejectedValueOnce(new Error('offline'))
    await browser.streams[0]!.emit('reset')
    expect(browser.element('#status').textContent).toContain('重连')
    await browser.timers[0]!()
    expect(browser.streams).toHaveLength(2)
    expect(browser.element('#send-errors').children).toHaveLength(1)
    expect(browser.element('#message').value).toBe('待确认的消息')
    await browser.submitChat()
    const sends = browser.fetch.mock.calls.filter(([url]) => url === '/api/messages')
    expect(JSON.parse(sends[0]![1]!.body!).idempotencyKey).toBe(JSON.parse(sends[1]![1]!.body!).idempotencyKey)
  })

  it('does not unlock a new in-flight submission when an old session request fails', async () => {
    const browser = await chatBrowser()
    browser.draft('旧请求')
    const old = pendingResponse()
    browser.fetch.mockImplementationOnce(() => old.promise)
    const oldSend = browser.submitChat()
    await browser.fire('#logout', 'click')
    browser.element('#password').value = 'a real password'
    await browser.submit()
    browser.draft('新请求')
    const next = pendingResponse()
    browser.fetch.mockImplementationOnce(() => next.promise)
    const newSend = browser.submitChat()
    old.reject(new Error('late disconnect'))
    await oldSend
    expect(browser.element('#send').disabled).toBe(true)
    expect(browser.element('#send-errors').children).toHaveLength(0)
    next.resolve(browserResponse())
    await newSend
    expect(browser.element('#message').value).toBe('')
  })

  it('only offers reply recovery after failure, guards repeat clicks and allows composing during recovery', async () => {
    const browser = await chatBrowser()
    await browser.streams[0]!.emit('update', { type: 'error' })
    expect(browser.element('#recover').hidden).toBe(false)
    const pending = pendingResponse()
    browser.fetch.mockImplementationOnce(() => pending.promise)
    const retry = browser.fire('#recover', 'click')
    await browser.fire('#recover', 'click')
    expect(browser.fetch.mock.calls.filter(([url]) => url === '/api/recover')).toHaveLength(1)
    browser.draft('继续聊天')
    expect(browser.element('#send').disabled).toBe(false)
    pending.resolve(browserResponse(200, { started: true }))
    await retry
    expect(browser.element('#recover').hidden).toBe(true)
    expect(browser.element('#error').textContent).toBe('')
    expect(browser.element('#status').textContent).toBe('正在回复…')
    expect(browser.element('#message').value).toBe('继续聊天')
  })

  it('restores failure on refresh and stops status polling after session expires', async () => {
    await setup()
    options.host.getStatus = () => 'blocked'
    options.events.publish(foregroundEventForWeb({ type: 'error', error: { name: 'APIConnectionTimeoutError' } }))
    const browser = await bootBrowser(new Map())
    await vi.waitFor(() => expect(browser.timers.length).toBe(1))
    expect(browser.element('#error').textContent).toContain('模型请求超时（30 秒）')
    expect(browser.element('#recover').disabled).toBe(false)
    cookie = ''
    await browser.timers[0]!()
    expect(browser.element('#private-panel').hidden).toBe(true)
    expect(browser.element('#owner').value).toBe('')
    expect(browser.element('#messages').children).toHaveLength(0)
    expect(browser.timers).toHaveLength(1)
  })

  it('ignores a stale polling 401 after logout and a new login', async () => {
    await setup()
    const browser = await bootBrowser(new Map())
    await vi.waitFor(() => expect(browser.timers.length).toBe(1))
    let resolve!: (value: { ok: boolean; status: number; json(): Promise<unknown> }) => void
    browser.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const oldPoll = browser.timers[0]!()
    await browser.element('#logout').listeners.get('click')!({ preventDefault() {} })
    browser.element('#password').value = 'a real password'
    await browser.submit()
    expect(browser.element('#private-panel').hidden).toBe(false)
    resolve({ ok: false, status: 401, json: async () => ({ error: '未授权。' }) })
    await oldPoll
    expect(browser.element('#private-panel').hidden).toBe(false)
    expect(browser.element('#owner').value).not.toBe('')
  })

  it('retains setup credential across refresh and new explicit fragment replaces the saved value', async () => {
    const storage = new Map([['agents-main-web-pending-setup', 'old-token']])
    const token = options.auth.setupToken!
    const first = await bootBrowser(storage, '#setup_token=' + token)
    expect(first.location.hash).toBe('')
    expect(storage.get('agents-main-web-pending-setup')).toBe(token)
    expect(first.element('#login-button').disabled).toBe(false)
    const refreshed = await bootBrowser(storage)
    expect(refreshed.element('#setup-credential').value).toBe(token)
    refreshed.element('#password').value = 'a real password'
    await refreshed.submit()
    expect(options.auth.configured).toBe(true)
    expect(refreshed.element('#private-panel').hidden).toBe(false)
    expect(refreshed.element('#login-button').disabled).toBe(false)
    expect(storage.has('agents-main-web-pending-setup')).toBe(false)
    expect(refreshed.element('#setup-credential').value).toBe('')
  })
  it('allows missing setup credential to be entered, focuses on missing input and respects backend validation', async () => {
    const browser = await bootBrowser(new Map())
    expect(browser.element('#setup-credential-panel').hidden).toBe(false)
    expect(browser.element('#login-button').disabled).toBe(false)
    browser.element('#password').value = 'a real password'
    await browser.submit()
    expect(browser.element('#setup-credential').focused).toBe(true)
    expect(browser.element('#login-error').textContent).toContain('复制初始化凭据')
    expect(browser.fetch.mock.calls.some(([url]) => url === '/api/auth/setup')).toBe(false)
    expect(browser.element('#login-button').disabled).toBe(false)
    browser.element('#setup-credential').value = 'wrong secret'
    await browser.submit()
    expect(options.auth.configured).toBe(false)
    expect(browser.element('#login-error').textContent).toBe('设置凭据无效或已失效。')
    expect(browser.element('#login-button').disabled).toBe(false)
    browser.element('#setup-credential').value = options.auth.setupToken!
    await browser.submit()
    expect(options.auth.configured).toBe(true)
    expect(browser.element('#private-panel').hidden).toBe(false)
  })
  it('clears pending setup credential when configured whether authenticated or awaiting login', async () => {
    await setup()
    for (const authenticated of [true, false]) {
      if (!authenticated) cookie = ''
      const storage = new Map([['agents-main-web-pending-setup', 'stale-token']])
      const browser = await bootBrowser(storage)
      expect(storage.size).toBe(0)
      expect(browser.element('#setup-credential').value).toBe('')
      expect(browser.element('#setup-credential-panel').hidden).toBe(true)
      if (!authenticated) {
        browser.element('#password').value = 'a real password'
        await browser.submit()
        expect(browser.element('#private-panel').hidden).toBe(false)
        const login = browser.fetch.mock.calls.find(([url]) => url === '/api/auth/login')
        expect(login?.[1]?.body).toBe(JSON.stringify({ password: 'a real password' }))
      }
    }
  })
  it('still sets up from the current fragment when sessionStorage is unavailable', async () => {
    const browser = await bootBrowser(new Map(), '#setup_token=' + options.auth.setupToken, true)
    expect(browser.element('#login-button').disabled).toBe(false)
    browser.element('#password').value = 'a real password'
    await browser.submit()
    expect(options.auth.configured).toBe(true)
    expect(browser.element('#private-panel').hidden).toBe(false)
    expect(browser.element('#login-button').disabled).toBe(false)
  })
  it('allows manual initialization when storage is unavailable and no fragment remains', async () => {
    const browser = await bootBrowser(new Map(), '', true)
    browser.element('#password').value = 'a real password'
    await browser.submit()
    expect(browser.element('#setup-credential').focused).toBe(true)
    expect(browser.element('#login-button').disabled).toBe(false)
    browser.element('#setup-credential').value = options.auth.setupToken!
    await browser.submit()
    expect(options.auth.configured).toBe(true)
    expect(browser.element('#private-panel').hidden).toBe(false)
  })

  it('uses private defaults and rejects invalid arguments', () => {
    expect(parseMainWebArguments([], '/home/example')).toEqual({ dataDirectory: '/home/example/.local/share/agents-master/main-chat', port: defaultMainWebPort })
    for (const args of [['--port'], ['--port', '0'], ['--port', '1.5'], ['--port', '1e3'], ['--port', '65536'], ['--data-dir'], ['--data-dir', '/a', '--data-dir', '/b'], ['--host', '0.0.0.0'], ['--port', '2', '--port', '3']]) expect(() => parseMainWebArguments(args)).toThrow()
  })
  it('asks the server to listen on IPv4 loopback only', async () => {
    const fake = Object.assign(new EventEmitter(), {
      listen: vi.fn(() => queueMicrotask(() => fake.emit('listening'))),
      address: () => ({ address: '127.0.0.1', port: 31415, family: 'IPv4' }),
    })
    expect(await listenMainWebServer(fake as unknown as Server, 31415)).toBe(31415)
    expect(fake.listen).toHaveBeenCalledWith(31415, '127.0.0.1')
  })
  it('预览未启用时 /preview/ 返回带返回稳定版入口的 404 页面', async () => {
    for (const url of ['/preview', '/preview/']) {
      const response = await call(url)
      expect(response.status).toBe(404)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.text).toContain('预览版未启用')
      expect(response.text).toContain('返回稳定版')
      expect(response.text).toContain('href="/"')
      expect(response.text).not.toContain('Private reply')
    }
  })
  it('requires setup capability, rejects old bearer tokens, authenticates private APIs', async () => {
    for (const url of ['/api/history', '/api/owner-context', '/api/events?access_token=old', '/api/unknown']) {
      expect((await call(url, 'GET', undefined, { 'x-agents-main-web-token': 'old' })).status).toBe(401)
    }
    expect((await call('/api/auth/setup', 'POST', { password: 'a real password' })).status).toBe(400)
    await setup()
    expect((await call('/api/history')).text).toContain('Private reply')
    expect((await call('/api/auth/setup', 'POST', { password: 'new password', setupToken: 'old' })).status).toBe(400)
    expect((await call('/api/messages', 'POST', { content: 'hello', idempotencyKey: 'client-1', checkpointSnapshot: 'ignored' })).status).toBe(202)
    expect(options.host.submit).toHaveBeenCalledWith({ content: 'hello', idempotencyKey: 'client-1' })
    expect((await call('/api/owner-context', 'PUT', { content: 'Explicit background' })).status).toBe(200)
    expect(options.host.setCheckpoint).toHaveBeenCalledWith(mainCheckpoint('Explicit background'))
    expect((await call('/api/recover', 'POST', {})).status).toBe(200)
    expect((await call('/api/messages', 'POST', { content: ' ' })).status).toBe(400)
  })
  it('rejects cross-origin writes including setup/login/logout and forwarded-header spoofing', async () => {
    for (const url of ['/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/messages', '/api/recover', '/api/owner-context']) {
      expect((await call(url, 'POST', {}, { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example' })).status).toBe(403)
      expect((await call(url, 'POST', {}, { origin: undefined })).status).toBe(403)
      expect((await call(url, 'POST', {}, { 'content-type': 'text/plain' })).status).toBe(400)
    }
    expect((await call('/api/auth/login', 'POST', { password: 'a real password' }, { origin: 'http://example.tail123.ts.net' })).status).toBe(403)
  })
  it('retains login across restart, supports login/logout and closes active streams', async () => {
    await setup()
    options.auth = new MainWebAuth(directory, () => now)
    expect((await call('/api/history')).status).toBe(200)
    const stream = await call('/api/events?cursor=0')
    expect(stream.status).toBe(200)
    options.events.publish({ type: 'error', message: 'safe event' })
    expect(stream.text).toContain('safe event')
    const logout = await call('/api/auth/logout', 'POST', {})
    expect(logout.status).toBe(200)
    expect(logout.headers['set-cookie']).toContain('Max-Age=0')
    expect(stream.ended).toBe(true)
    expect((await call('/api/history')).status).toBe(401)
    options.auth = new MainWebAuth(directory, () => now)
    expect((await call('/api/history')).status).toBe(401)
    expect((await call('/api/auth/login', 'POST', { password: 'wrong password' })).status).toBe(400)
    expect((await call('/api/auth/login', 'POST', { password: 'a real password' })).status).toBe(200)
  })
  it('never emits private events to expired sessions', async () => {
    await setup()
    const stream = await call('/api/events')
    now += 30 * 24 * 60 * 60 * 1000
    options.events.publish({ type: 'error', message: 'must not leak' })
    expect(stream.text).not.toContain('must not leak')
    expect(stream.ended).toBe(true)
    expect((await call('/api/history')).status).toBe(401)
  })
  it('replays events after history cursor exactly once', async () => {
    await setup()
    const history = JSON.parse((await call('/api/history')).text) as { cursor: number }
    options.events.publish({ type: 'error', message: 'replayed event' })
    const stream = await call(`/api/events?cursor=${history.cursor}`)
    expect(stream.text.match(/replayed event/g)).toHaveLength(1)
    expect(stream.text).toContain('id: 1')
  })
  it('allows loopback HTTP development cookies without Secure', async () => {
    const result = await call('/api/auth/setup', 'POST', { password: 'a real password', setupToken: options.auth.setupToken }, { host: '127.0.0.1:31415', origin: 'http://127.0.0.1:31415' })
    expect(result.status).toBe(200)
    expect(result.headers['set-cookie']).not.toContain('Secure')
  })
  it('uses cookie UI and clears setup URL/private state on 401', async () => {
    const page = (await call('/')).text
    expect(page).toContain("history.replaceState(null,'',location.pathname+location.search)")
    expect(page).toContain("credentials:'same-origin'")
    expect(page).toContain('messages.replaceChildren();seen.clear();owner.value=')
    expect(page).not.toContain('access_token')
    expect(foregroundEventForWeb({ type: 'error', error: new Error('secret') })).toEqual({ type: 'error', message: '模型请求失败；消息已保留，请点击“重试失败回合”。' })
  })
  it('runs the browser script: 401 closes SSE, removes private content and shows login', async () => {
    const page = (await call('/')).text
    const source = page.split('<script>')[1]!.split('</script>')[0]!
    class Element {
      hidden = true
      value = ''
      textContent = ''
      style = { height: '' }
      scrollHeight = 0
      scrollTop = 0
      clientHeight = 300
      children: unknown[] = []
      listeners = new Map<string, (event: { preventDefault(): void }) => Promise<void>>()
      append(...values: unknown[]): void { this.children.push(...values) }
      replaceChildren(): void { this.children = [] }
      addEventListener(name: string, callback: (event: { preventDefault(): void }) => Promise<void>): void { this.listeners.set(name, callback) }
    }
    const elements = new Map<string, Element>()
    const element = (key: string): Element => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key)! }
    const streams: Array<{ closed: boolean }> = []
    class FakeEvents {
      closed = false
      constructor() { streams.push(this) }
      close(): void { this.closed = true }
      addEventListener(): void {}
    }
    const fetch = vi.fn(async (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => ({
      ok: true, status: 200,
      json: async () => url === '/api/auth' ? { configured: true, authenticated: true }
        : url === '/api/history' ? { messages: [{ id: '1', role: 'assistant', content: 'secret history' }], cursor: 0 }
          : { content: 'secret owner context' },
    }))
    runInNewContext(source, {
      document: { querySelector: element, createElement: () => new Element(), createTextNode: (text: string) => text },
      fetch, URLSearchParams, location: { hash: '', pathname: '/', search: '' }, history: { replaceState: vi.fn() }, setTimeout: vi.fn(), clearTimeout: vi.fn(),
      EventSource: FakeEvents, crypto: { randomUUID: () => 'client-1' },
    })
    await vi.waitFor(() => expect(element('#owner').value).toBe('secret owner context'))
    expect(element('#owner').value).toBe('secret owner context')
    expect(element('#messages').children.length).toBe(1)
    fetch.mockImplementation(async () => ({ ok: false, status: 401, json: async () => ({ error: '未授权。' }) }))
    element('#message').value = 'hello'
    await element('#chat').listeners.get('submit')!({ preventDefault() {} })
    expect(element('#private-panel').hidden).toBe(true)
    expect(element('#login-panel').hidden).toBe(false)
    expect(element('#owner').value).toBe('')
    expect(element('#messages').children).toHaveLength(0)
    expect(streams[0]!.closed).toBe(true)
  })
})
