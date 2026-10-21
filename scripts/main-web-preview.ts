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
  synthetic: boolean
  execution?: string
  previewLabel?: string
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

const previewCapabilities = ['synthetic-coordination-chat', 'synthetic-delegation', 'synthetic-question-answer']

function previewStatusFallback(options: { releaseId: string }): PreviewChannelStatus {
  return { enabled: true, available: false, releaseId: options.releaseId, capabilities: previewCapabilities, synthetic: true }
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
        let settled = false
        const finish = (status: PreviewChannelStatus) => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          resolve(status)
        }
        const request = http.get({ socketPath: options.socketPath, path: '/healthz', agent: false, timeout: 500 }, response => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', chunk => { if (body.length < 8_192) body += chunk })
          response.once('error', () => finish(previewStatusFallback(options)))
          response.once('end', () => {
            // 以 worker 实际上报的发布标识为准，入口配置只作不可用时的回退。
            let releaseId = options.releaseId
            let synthetic = true
            let previewLabel: string | undefined
            let execution: string | undefined
            try {
              const parsed = JSON.parse(body) as { releaseId?: unknown; synthetic?: unknown; previewLabel?: unknown; execution?: unknown }
              if (typeof parsed.releaseId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(parsed.releaseId)) releaseId = parsed.releaseId
              if (typeof parsed.synthetic === 'boolean') synthetic = parsed.synthetic
              if (typeof parsed.previewLabel === 'string' && parsed.previewLabel.length <= 80 && !/[<>\u0000-\u001f]/.test(parsed.previewLabel)) previewLabel = parsed.previewLabel
              if (parsed.execution === 'synthetic' || parsed.execution === 'cli') execution = parsed.execution
            } catch { /* 健康响应不可解析时保留回退标识 */ }
            finish({ enabled: true, available: response.statusCode === 200, releaseId,
              capabilities: execution === 'cli' ? [...previewCapabilities, 'cli-execution'] : previewCapabilities,
              synthetic, execution, previewLabel })
          })
        })
        // 总时限：healthz 持续流式输出会不断重置 socket 空闲超时，必须有整体 deadline。
        const deadline = setTimeout(() => request.destroy(new Error('preview health deadline')), 1_000)
        deadline.unref()
        request.once('timeout', () => request.destroy(new Error('preview health timeout')))
        request.once('error', () => finish(previewStatusFallback(options)))
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
