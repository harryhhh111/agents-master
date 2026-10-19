import http, { type IncomingMessage, type ServerResponse } from 'node:http'

const previewApiRoutes = new Set([
  '/api/conversations',
  '/api/history',
  '/api/status',
  '/api/events',
  '/api/messages',
  '/api/control',
  '/api/recover',
  '/api/owner-context',
])
const hopByHopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export interface PreviewChannelStatus {
  enabled: true
  available: boolean
  releaseId: string
  capabilities: string[]
  synthetic: true
}

export interface MainWebPreviewChannel {
  readonly releaseId: string
  handle(request: IncomingMessage, response: ServerResponse, authorized: () => boolean): Promise<boolean>
  status(): Promise<PreviewChannelStatus>
  close(): void
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}

function unavailablePage(response: ServerResponse): void {
  response.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'",
  })
  response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>预览版暂不可用</title><main style="max-width:42rem;margin:4rem auto;font:16px/1.7 system-ui,sans-serif"><h1>预览版暂不可用</h1><p>预览 worker 当前不可用。稳定版仍可继续使用。</p><p><a href="/">返回稳定版</a></p></main></html>')
}

function redirected(response: ServerResponse, location: string): void {
  response.writeHead(308, { Location: location, 'Cache-Control': 'no-store' })
  response.end()
}

function forwardedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of ['accept', 'content-type', 'content-length']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  return headers
}

function responseHeaders(upstream: http.IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase())) continue
    headers[name] = value
  }
  return headers
}

/** Authenticated, narrow reverse proxy from the stable entry to the private preview worker socket. */
export function createMainWebPreviewChannel(options: { socketPath: string; releaseId: string }): MainWebPreviewChannel {
  const activeRequests = new Set<http.ClientRequest>()
  const activeResponses = new Set<ServerResponse>()

  async function proxy(request: IncomingMessage, response: ServerResponse, targetPath: string, page: boolean, authorized: () => boolean): Promise<void> {
    const isEvents = targetPath.startsWith('/api/events')
    await new Promise<void>(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        activeRequests.delete(upstreamRequest)
        activeResponses.delete(response)
        resolve()
      }
      const unavailable = () => {
        if (response.headersSent) response.end()
        else if (page) unavailablePage(response)
        else json(response, 503, { error: '预览版暂不可用，请返回稳定版。' })
        finish()
      }
      const upstreamRequest = http.request({
        socketPath: options.socketPath,
        path: targetPath,
        method: request.method,
        headers: forwardedHeaders(request),
        agent: false,
      }, upstream => {
        response.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream))
        activeResponses.add(response)
        if (request.method === 'HEAD') {
          upstream.resume()
          response.end()
          finish()
          return
        }
        upstream.on('error', unavailable)
        response.once('close', finish)
        upstream.pipe(response)
      })
      activeRequests.add(upstreamRequest)
      response.once('close', () => {
        upstreamRequest.destroy()
        finish()
      })
      upstreamRequest.on('error', unavailable)
      if (!isEvents) upstreamRequest.setTimeout(5_000, () => upstreamRequest.destroy(new Error('preview worker timeout')))
      else {
        const expiryCheck = setInterval(() => {
          if (!authorized()) {
            response.end()
            upstreamRequest.destroy()
          }
        }, 30_000)
        expiryCheck.unref()
        response.once('close', () => clearInterval(expiryCheck))
      }
      request.pipe(upstreamRequest)
    })
  }

  return {
    releaseId: options.releaseId,
    async handle(request, response, authorized) {
      const rawPath = request.url ?? ''
      if (/%2e|%2f|%5c|\0/i.test(rawPath)) {
        json(response, 400, { error: '预览路径无效。' })
        return true
      }
      const url = new URL(rawPath, 'http://localhost')
      const pathname = url.pathname
      if (pathname === '/preview') {
        redirected(response, '/preview/')
        return true
      }
      if (pathname === '/preview/') {
        if (!['GET', 'HEAD'].includes(request.method ?? '')) json(response, 405, { error: '方法不可用。' })
        else await proxy(request, response, '/preview/', true, authorized)
        return true
      }
      if (!pathname.startsWith('/preview/api/')) return false
      const target = pathname.slice('/preview'.length)
      if (!previewApiRoutes.has(target)) {
        json(response, 404, { error: '未找到此预览地址。' })
        return true
      }
      await proxy(request, response, target + url.search, false, authorized)
      return true
    },
    status() {
      return new Promise(resolve => {
        const request = http.get({ socketPath: options.socketPath, path: '/healthz', agent: false, timeout: 500 }, response => {
          response.resume()
          response.once('end', () => resolve({ enabled: true, available: response.statusCode === 200, releaseId: options.releaseId, capabilities: ['synthetic-coordination-chat', 'synthetic-delegation', 'synthetic-question-answer'], synthetic: true }))
        })
        request.once('timeout', () => request.destroy(new Error('preview health timeout')))
        request.once('error', () => resolve({ enabled: true, available: false, releaseId: options.releaseId, capabilities: ['synthetic-coordination-chat', 'synthetic-delegation', 'synthetic-question-answer'], synthetic: true }))
      })
    },
    close() {
      for (const response of activeResponses) response.end()
      for (const request of activeRequests) request.destroy()
      activeResponses.clear()
      activeRequests.clear()
    },
  }
}
