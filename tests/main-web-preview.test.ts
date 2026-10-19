import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { it, expect } from 'vitest'
import { MainWebAuth } from '../src/main/web-auth.js'
import {
  MainWebEventBus,
  createMainWebServer,
  listenMainWebServer,
  parseMainWebArguments,
  type MainWebServerOptions,
} from '../scripts/main-web.js'
import { createMainWebPreviewChannel } from '../scripts/main-web-preview.js'
import { startPreviewWorker, type PreviewWorker } from '../scripts/preview-worker.js'

const parent = () => mkdtempSync('/dev/shm/main-web-preview-test-')

type RunningEntry = {
  base: string
  cookie: string
  options: MainWebServerOptions
  server: http.Server
  close(): Promise<void>
}

async function startEntry(parentDirectory: string, socketPath: string): Promise<RunningEntry> {
  const dataDirectory = path.join(parentDirectory, 'stable')
  mkdirSync(dataDirectory, { mode: 0o700 })
  const auth = new MainWebAuth(dataDirectory)
  const events = new MainWebEventBus()
  const previewChannel = createMainWebPreviewChannel({ socketPath, releaseId: 'test-preview-release' })
  const options: MainWebServerOptions = {
    host: { start: () => 0, submit: () => 0, recover: () => 0, setCheckpoint: () => {}, getStatus: () => 'idle' },
    readHistory: () => [{ id: 'stable-1', role: 'assistant', content: 'STABLE_PRIVATE_HISTORY', createdAt: '2026-10-19T00:00:00.000Z' }],
    dataDirectory,
    events,
    auth,
    previewChannel,
  }
  const server = createMainWebServer(options)
  const port = await listenMainWebServer(server, 0)
  const base = `http://127.0.0.1:${port}`
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password: 'synthetic-password', setupToken: auth.setupToken }),
  })
  expect(setup.status).toBe(200)
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!
  return {
    base,
    cookie,
    options,
    server,
    async close() {
      previewChannel.close()
      events.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) })
    },
  }
}

async function request(entry: RunningEntry, route: string, options: { method?: string; body?: unknown; authenticated?: boolean; origin?: string } = {}) {
  const method = options.method ?? 'GET'
  const authenticated = options.authenticated !== false
  const response = await fetch(entry.base + route, {
    method,
    headers: {
      ...(authenticated ? { cookie: entry.cookie } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json', origin: options.origin ?? entry.base } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, text: await response.text(), headers: response.headers }
}

function openSse(entry: RunningEntry, route: string): Promise<http.IncomingMessage> {
  const url = new URL(entry.base + route)
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { cookie: entry.cookie },
      agent: false,
    }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`SSE status ${response.statusCode}`))
      } else resolve(response)
    })
    request.on('error', reject)
  })
}

async function waitForText(read: () => string, expected: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (read().includes(expected)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${expected}; got ${read()}`)
}

it('同站一次登录访问稳定版与预览版,页面 API 前缀与业务数据隔离', async () => {
  const root = parent()
  let worker: PreviewWorker | undefined
  let entry: RunningEntry | undefined
  try {
    const socketPath = path.join(root, 'run', 'preview.sock')
    worker = await startPreviewWorker({ dataDirectory: path.join(root, 'preview'), socketPath })
    entry = await startEntry(root, socketPath)

    expect((await request(entry, '/api/versions', { authenticated: false })).status).toBe(401)
    const versions = await request(entry, '/api/versions')
    expect(versions.status).toBe(200)
    expect(versions.text).toContain('test-preview-release')
    expect(versions.text).toContain('"available":true')

    const stablePage = await request(entry, '/')
    expect(stablePage.status).toBe(200)
    expect(stablePage.text).toContain('"businessApiBase":"/api"')
    expect(stablePage.text).toContain('/preview/')

    const anonymousPreview = await request(entry, '/preview/', { authenticated: false })
    expect(anonymousPreview.status).toBe(200)
    expect(anonymousPreview.text).toContain('"businessApiBase":"/preview/api"')
    expect(anonymousPreview.text).toContain('登录')

    const previewPage = await request(entry, '/preview/')
    expect(previewPage.status).toBe(200)
    expect(previewPage.text).toContain('模拟 / 联调 · 无真实项目执行')
    expect(previewPage.text).toContain('"businessApiBase":"/preview/api"')

    expect((await request(entry, '/api/owner-context', { method: 'PUT', body: { content: 'STABLE_OWNER_MARKER' } })).status).toBe(200)
    expect((await request(entry, '/preview/api/owner-context', { method: 'PUT', body: { content: 'PREVIEW_OWNER_MARKER' } })).status).toBe(200)
    expect((await request(entry, '/api/owner-context')).text).toContain('STABLE_OWNER_MARKER')
    expect((await request(entry, '/preview/api/owner-context')).text).toContain('PREVIEW_OWNER_MARKER')
    expect((await request(entry, '/api/owner-context')).text).not.toContain('PREVIEW_OWNER_MARKER')
    expect((await request(entry, '/preview/api/owner-context')).text).not.toContain('STABLE_OWNER_MARKER')

    const accepted = await request(entry, '/preview/api/messages?conversation=main', { method: 'POST', body: { content: 'PREVIEW_ONLY_MESSAGE', idempotencyKey: 'preview-only' } })
    expect(accepted.status).toBe(202)
    let previewHistory = await request(entry, '/preview/api/history?conversation=main')
    for (let i = 0; i < 100 && !previewHistory.text.includes('PREVIEW_ONLY_MESSAGE'); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      previewHistory = await request(entry, '/preview/api/history?conversation=main')
    }
    const stableHistory = await request(entry, '/api/history')
    expect(stableHistory.text).toContain('STABLE_PRIVATE_HISTORY')
    expect(stableHistory.text).not.toContain('PREVIEW_ONLY_MESSAGE')
    expect(previewHistory.text).toContain('PREVIEW_ONLY_MESSAGE')
    expect(previewHistory.text).not.toContain('STABLE_PRIVATE_HISTORY')

    expect((await request(entry, '/preview/api/auth/login', { method: 'POST', body: { password: 'wrong-password' } })).status).toBe(404)
    expect((await request(entry, '/preview/api/messages', { method: 'POST', body: { content: 'bad origin', idempotencyKey: 'bad-origin' }, origin: 'https://other.invalid' })).status).toBe(403)
    expect((await request(entry, '/preview/api/%2e%2e/history')).status).toBe(404)
    expect(existsSync(path.join(worker.directory, 'web-auth.json'))).toBe(false)
  } finally {
    await entry?.close()
    await worker?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('预览 SSE 增量转发,退出登录立即关闭预览流并拒绝后续请求', async () => {
  const root = parent()
  let worker: PreviewWorker | undefined
  let entry: RunningEntry | undefined
  try {
    const socketPath = path.join(root, 'run', 'preview.sock')
    worker = await startPreviewWorker({ dataDirectory: path.join(root, 'preview'), socketPath })
    entry = await startEntry(root, socketPath)
    const stream = await openSse(entry, '/preview/api/events?conversation=main&cursor=0')
    let text = ''
    stream.on('data', chunk => { text += chunk })
    await waitForText(() => text, ': connected')
    const accepted = await request(entry, '/preview/api/messages?conversation=main', { method: 'POST', body: { content: 'SSE_PREVIEW_MESSAGE', idempotencyKey: 'sse-preview' } })
    expect(accepted.status).toBe(202)
    await waitForText(() => text, 'SSE_PREVIEW_MESSAGE')

    const closed = new Promise<void>(resolve => stream.once('close', resolve))
    expect((await request(entry, '/api/auth/logout', { method: 'POST', body: {} })).status).toBe(200)
    await closed
    expect((await request(entry, '/preview/api/history?conversation=main', { authenticated: true })).status).toBe(401)
    expect((await request(entry, '/api/history', { authenticated: true })).status).toBe(401)
  } finally {
    await entry?.close()
    await worker?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('worker 停止后稳定版继续可用,预览页面和 API 明确 503 而不回退稳定数据', async () => {
  const root = parent()
  let worker: PreviewWorker | undefined
  let entry: RunningEntry | undefined
  try {
    const socketPath = path.join(root, 'run', 'preview.sock')
    worker = await startPreviewWorker({ dataDirectory: path.join(root, 'preview'), socketPath })
    entry = await startEntry(root, socketPath)
    await worker.close()
    worker = undefined

    const page = await request(entry, '/preview/')
    expect(page.status).toBe(503)
    expect(page.text).toContain('返回稳定版')
    expect(page.text).not.toContain('STABLE_PRIVATE_HISTORY')
    const api = await request(entry, '/preview/api/history?conversation=main')
    expect(api.status).toBe(503)
    expect(api.text).toContain('预览版暂不可用')
    expect((await request(entry, '/api/history')).text).toContain('STABLE_PRIVATE_HISTORY')
    const versions = await request(entry, '/api/versions')
    expect(versions.status).toBe(200)
    expect(versions.text).toContain('"available":false')
  } finally {
    await entry?.close()
    await worker?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('代理不向 worker 转发 cookie、Authorization 或客户端内部身份头', async () => {
  const root = parent()
  const socketPath = path.join(root, 'echo.sock')
  let seen: http.IncomingHttpHeaders = {}
  const echo = http.createServer((request, response) => {
    seen = request.headers
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  let entry: RunningEntry | undefined
  try {
    await new Promise<void>(resolve => echo.listen(socketPath, resolve))
    entry = await startEntry(root, socketPath)
    const response = await fetch(`${entry.base}/preview/api/history`, {
      headers: { cookie: entry.cookie, authorization: 'Bearer browser-secret', 'x-internal-identity': 'spoofed' },
    })
    expect(response.status).toBe(200)
    expect(seen.cookie).toBeUndefined()
    expect(seen.authorization).toBeUndefined()
    expect(seen['x-internal-identity']).toBeUndefined()
  } finally {
    await entry?.close()
    await new Promise<void>(resolve => echo.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

it('稳定入口默认不启用预览,显式参数只接受一次 socket 路径', () => {
  expect(parseMainWebArguments([], '/home/synthetic')).toEqual({
    dataDirectory: '/home/synthetic/.local/share/agents-master/main-chat',
    port: 31415,
  })
  expect(parseMainWebArguments(['--data-dir', '/data', '--port', '31416', '--preview-socket', '/run/preview.sock'], '/home/synthetic')).toEqual({
    dataDirectory: '/data',
    port: 31416,
    previewSocketPath: '/run/preview.sock',
  })
  expect(() => parseMainWebArguments(['--preview-socket', '/a', '--preview-socket', '/b'], '/home/synthetic')).toThrow('只能指定一次')
})
