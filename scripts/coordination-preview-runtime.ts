/** 协调预览的业务运行时:数据目录、store、协调 host 与业务 handler。
 *  不实例化认证、不创建监听;由调用方(独立 demo 入口 / 预览 worker)组装认证与传输层。 */
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { initializeOwnerContext, readOwnerContext, ownerContextCheckpoint, saveOwnerContext } from '../src/main/owner-context.js'
import { CoordinationHost } from '../src/main/coordination/model-host.js'
import { ScopedDomainExecutor } from '../src/agent/scoped-domain.js'
import type { ScopedModel } from '../src/agent/scoped-protocol.js'
import type { FakeExecutor } from '../src/main/coordination/fake.js'
import { MainWebEventBus, json, readJson, validateMainWebMessage } from './main-web.js'

export const previewMarkerFilename = 'PREVIEW-v2'
export const previewMarkerContent = 'synthetic-only-v2\n'
export type PreviewDirectoryMode = 'preview-fresh' | 'preview-open'

export function previewCheckpoint(ownerContext: string): string {
  return [
    '协调预览检查点：仅模拟/联调。可以使用受限目录、状态、delegate、answer、cancel 工具协调合成工作。含糊需求先澄清；不得声称真实项目执行，不开放 shell、文件或真实后端。',
    ownerContextCheckpoint(ownerContext),
  ].join('\n\n')
}

/** 重开已有目录:必须是通过兼容标记创建的私有目录,否则拒绝且不改动任何内容。 */
export function openPreviewDirectory(directory: string): PreviewDirectoryMode {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() ||
      readFileSync(path.join(directory, previewMarkerFilename), 'utf8') !== previewMarkerContent) {
    throw new Error('Only private v2 preview directories may reopen')
  }
  return 'preview-open'
}

/** 显式创建新目录并打标记。仅用于确定不存在的目录(调用方负责区分)。 */
export function createFreshPreviewDirectory(directory: string): PreviewDirectoryMode {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  writeFileSync(path.join(directory, previewMarkerFilename), previewMarkerContent, { mode: 0o600 })
  return 'preview-fresh'
}

export function createCoordinationRuntime(options: {
  directory: string
  mode: PreviewDirectoryMode
  model: ScopedModel
  domainModel?: ScopedModel
  executor?: FakeExecutor & { stop?(id: string): void }
}) {
  const { directory } = options
  let openedStore: SQLiteMainInboxStore | undefined
  try {
    const store = new SQLiteMainInboxStore(path.join(directory, 'preview.sqlite'), { coordination: { mode: options.mode } })
    openedStore = store
    chmodSync(path.join(directory, 'preview.sqlite'), 0o600)
    initializeOwnerContext(directory)
    const buses = new Map(['main', 'fake-work'].map(c => [c, new MainWebEventBus()]))
    const emitted = new Set<string>()
    for (const c of buses.keys()) for (const m of store.coordination.history(c)) emitted.add(m.id)
    const host = new CoordinationHost(store.coordination, options.model, options.domainModel ?? options.model, options.executor ?? new ScopedDomainExecutor(options.domainModel ?? options.model), () => {
      for (const [c, bus] of buses) for (const m of store.coordination.history(c)) if (!emitted.has(m.id)) { emitted.add(m.id); bus.publish({ type: m.author === 'user' ? 'submitted' : 'reply', message: { ...m, createdAt: m.created_at } }) }
    })
    host.checkpoint = previewCheckpoint(readOwnerContext(directory))
    host.start()
    const closeConnections = () => { for (const bus of buses.values()) bus.close() }
    return {
      directory,
      mode: options.mode,
      store,
      host,
      closeConnections,
      async handle(request: IncomingMessage, response: ServerResponse, authorized: () => boolean): Promise<boolean> {
        const url = new URL(request.url!, 'http://localhost'), route = url.pathname, method = request.method
        if (route === '/api/conversations' && method === 'GET') { json(response, 200, { conversations: [{ id: 'main', pinned: true }, { id: 'fake-work', synthetic: true }] }); return true }
        if (route === '/api/owner-context') {
          if (method === 'GET') { json(response, 200, { content: readOwnerContext(directory) }); return true }
          if (method === 'PUT') {
            try {
              const body = await readJson(request)
              if (Object.keys(body).join() !== 'content' || typeof body.content !== 'string') throw new Error('Unexpected fields')
              saveOwnerContext(directory, body.content)
              host.checkpoint = previewCheckpoint(readOwnerContext(directory))
              json(response, 200, { saved: true })
            } catch { json(response, 400, { error: '主人上下文未接受：内容为空、过大或请求无效。' }) }
            return true
          }
          json(response, 405, { error: '方法不可用。' }); return true
        }
        if (!['/api/history','/api/status','/api/events','/api/messages','/api/control','/api/recover'].includes(route)) return false
        const c = url.searchParams.get('conversation') ?? 'main', bus = buses.get(c)
        if (!bus) { json(response, 400, { error: '未知会话。' }); return true }
        try {
          if (method === 'GET' && route === '/api/history') { const s = bus.snapshot(() => store.coordination.history(c).map(m => ({ ...m, createdAt: m.created_at }))); json(response, 200, { messages: s.value, cursor: s.cursor }); return true }
          if (method === 'GET' && route === '/api/status') { json(response, 200, { state: host.status(c), message: host.status(c) === 'blocked' ? '模拟模型回合失败，请显式重试。' : undefined, synthetic: true, assignments: store.coordination.assignments('fake-work').map(a => ({ id: a.id, status: a.status, version: a.version })), questions: store.coordination.questions('fake-work') }); return true }
          if (method === 'GET' && route === '/api/events') {
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); response.write(': connected\n\n')
            const raw = request.headers['last-event-id'] ?? url.searchParams.get('cursor')
            if (request.headers['last-event-id']) response.write('event: reset\ndata: {}\n\n')
            bus.subscribe(response, Number(raw) || 0, authorized)
            const timer = setInterval(() => { if (!authorized()) response.end() }, 1000); timer.unref(); response.once('close', () => clearInterval(timer)); return true
          }
          if (method === 'POST') {
            const body = await readJson(request)
            if (route === '/api/recover') { host.retry(c); json(response, 200, { started: true }); return true }
            const fields = route === '/api/control' ? ['content','id','idempotencyKey','kind'] : ['content','idempotencyKey']
            if (Object.keys(body).sort().join() !== fields.sort().join()) throw new Error('Unexpected fields')
            validateMainWebMessage(body.content)
            if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) throw new Error('Invalid key')
            if (route === '/api/messages') host.submit(c, body.idempotencyKey, body.content)
            else if (route === '/api/control' && (body.kind === 'answer' || body.kind === 'cancel') && typeof body.id === 'string') { store.coordination.control(c, body.idempotencyKey, body.content, body.kind, body.id); host.pump() }
            else throw new Error('Invalid action')
            json(response, 202, { accepted: true, synthetic: true }); return true
          }
          json(response, 405, { error: '方法不可用。' }); return true
        } catch { json(response, 400, { error: '模拟操作未接受：参数、来源或问题状态无效。' }); return true }
      },
      async close() { closeConnections(); await host.close(); store.close() },
    }
  } catch (error) {
    openedStore?.close()
    if (options.mode === 'preview-fresh') rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export type CoordinationRuntime = ReturnType<typeof createCoordinationRuntime>
