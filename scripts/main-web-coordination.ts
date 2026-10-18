import { mkdtempSync, chmodSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { MainWebAuth } from '../src/main/web-auth.js'
import { initializeOwnerContext, readOwnerContext, ownerContextCheckpoint } from '../src/main/owner-context.js'
import { CoordinationHost } from '../src/main/coordination/model-host.js'
import { coordinationPage } from '../src/main/coordination/web-page.js'
import { ScopedDomainExecutor } from '../src/agent/scoped-domain.js'
import type { ScopedModel } from '../src/agent/scoped-protocol.js'
import type { FakeExecutor } from '../src/main/coordination/fake.js'
import { createMainWebServer, handleMainWebRequest, type MainWebServerOptions, mainWebPage, MainWebEventBus, readJson, json, validateMainWebMessage, listenMainWebServer } from './main-web.js'

export function previewCheckpoint(ownerContext: string): string {
  return [
    '协调预览检查点：仅模拟/联调。可以使用受限目录、状态、delegate、answer、cancel 工具协调合成工作。含糊需求先澄清；不得声称真实项目执行，不开放 shell、文件或真实后端。',
    ownerContextCheckpoint(ownerContext),
  ].join('\n\n')
}

export function createCoordinationPreview(options: { model: ScopedModel; domainModel?: ScopedModel; executor?: FakeExecutor & { stop?(id: string): void }; reopen?: string; newDirectoryParent?: string }) {
  // Do not inherit TMPDIR: test runners may point it inside the Git worktree.
  const directory = options.reopen ?? mkdtempSync(path.join(options.newDirectoryParent ?? '/tmp', 'coordination-web-preview-'))
  let openedStore: SQLiteMainInboxStore | undefined
  try {
  if (options.reopen) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || readFileSync(path.join(directory, 'PREVIEW-v2'), 'utf8') !== 'synthetic-only-v2\n') throw new Error('Only private v2 preview directories may reopen')
  } else { chmodSync(directory, 0o700); writeFileSync(path.join(directory, 'PREVIEW-v2'), 'synthetic-only-v2\n', { mode: 0o600 }) }
  const store = new SQLiteMainInboxStore(path.join(directory, 'preview.sqlite'), { coordination: { mode: options.reopen ? 'preview-open' : 'preview-fresh' } })
  openedStore = store
  chmodSync(path.join(directory, 'preview.sqlite'), 0o600)
  initializeOwnerContext(directory)
  const auth = new MainWebAuth(directory), events = new MainWebEventBus()
  const buses = new Map(['main', 'fake-work'].map(c => [c, new MainWebEventBus()]))
  const emitted = new Set<string>()
  for (const c of buses.keys()) for (const m of store.coordination.history(c)) emitted.add(m.id)
  const host = new CoordinationHost(store.coordination, options.model, options.domainModel ?? options.model, options.executor ?? new ScopedDomainExecutor(options.domainModel ?? options.model), () => {
    for (const [c, bus] of buses) for (const m of store.coordination.history(c)) if (!emitted.has(m.id)) { emitted.add(m.id); bus.publish({ type: m.author === 'user' ? 'submitted' : 'reply', message: { ...m, createdAt: m.created_at } }) }
  })
  host.checkpoint = previewCheckpoint(readOwnerContext(directory))
  const preview = {
    page: coordinationPage(mainWebPage), close: () => { for (const bus of buses.values()) bus.close() },
    async handle(request: IncomingMessage, response: ServerResponse, authorized: () => boolean): Promise<boolean> {
      const url = new URL(request.url!, 'http://localhost'), route = url.pathname, method = request.method
      if (route === '/api/conversations' && method === 'GET') { json(response, 200, { conversations: [{ id: 'main', pinned: true }, { id: 'fake-work', synthetic: true }] }); return true }
      if (!['/api/history','/api/status','/api/events','/api/messages','/api/control','/api/recover'].includes(route)) return false
      const c = url.searchParams.get('conversation') ?? 'main', bus = buses.get(c)
      if (!bus) { json(response, 400, { error: '未知会话。' }); return true }
      try {
        if (method === 'GET' && route === '/api/history') { const s = bus.snapshot(() => store.coordination.history(c).map(m => ({ ...m, createdAt: m.created_at }))); json(response, 200, { messages: s.value, cursor: s.cursor }); return true }
        if (method === 'GET' && route === '/api/status') { json(response, 200, { state: host.status(c), message: host.status(c) === 'blocked' ? '模拟模型回合失败，请显式重试。' : undefined, synthetic: true, assignments: store.coordination.assignments('fake-work').map(a => ({ id: a.id, status: a.status, version: a.version })), questions: store.coordination.questions('fake-work') }); return true }
        if (method === 'GET' && route === '/api/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); response.write(': connected\n\n')
          // On restart/reconnect send a reset: history is the durable truth.
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
  }
  const serverOptions: MainWebServerOptions = { preview, auth, events, dataDirectory: directory, readHistory: () => [], host: {
    start: () => 0, submit: () => { throw new Error('Scoped route required') }, recover: () => 0, getStatus: () => host.status('main'),
    // The shared owner PUT already saved the file. Ignore its legacy no-tools
    // composition and rebuild this preview's capabilities from durable text.
    setCheckpoint: () => { host.checkpoint = previewCheckpoint(readOwnerContext(directory)) },
  } }
  const server = createMainWebServer(serverOptions)
  host.start()
  return { directory, store, host, server, auth, handle: (request: IncomingMessage, response: ServerResponse) => handleMainWebRequest(request, response, serverOptions), async close() { preview.close(); events.close(); await host.close(); await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) }); store.close() } }
  } catch (error) {
    openedStore?.close()
    if (!options.reopen) rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export async function runCoordinationPreview(args: string[]): Promise<void> {
  if (!['--preview-demo', '--preview-model'].includes(args[0] ?? '') || args.length > 3 || (args.length > 1 && (!['--reopen-preview','--preview-parent'].includes(args[1]!) || !args[2]))) throw new Error('Use --preview-demo or --preview-model [--reopen-preview PRIVATE_V2_DIRECTORY | --preview-parent PARENT]')
  // Real model creation is lazy and explicit. No real backend is ever constructed.
  if (args[0] === '--preview-model') await import('dotenv/config')
  const model = args[0] === '--preview-demo' ? (await import('./main-web-coordination-demo.js')).demoModel() : (await import('../src/frontbrain/coordination-model.js')).createCoordinationModel((await import('../src/config.js')).loadConfig())
  const app = createCoordinationPreview({ model, ...(args[1] === '--reopen-preview' ? { reopen: args[2] } : { newDirectoryParent: args[2] }) })
  let port: number
  try { port = await listenMainWebServer(app.server, 0) } catch (error) { await app.close(); throw error }
  console.log(`模拟/联调 only: http://127.0.0.1:${port}/ storage=${app.directory}`)
  const token = app.auth.setupToken
  if (token) console.log(`Setup: http://127.0.0.1:${port}/#setup_token=${token}`)
  const stop = () => { void app.close() }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) runCoordinationPreview(process.argv.slice(2)).catch(() => { console.error('Preview startup failed'); process.exitCode = 1 })
