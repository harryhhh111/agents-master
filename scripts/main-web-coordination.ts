import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MainWebAuth } from '../src/main/web-auth.js'
import { readOwnerContext } from '../src/main/owner-context.js'
import { coordinationPage } from '../src/main/coordination/web-page.js'
import type { ScopedModel } from '../src/agent/scoped-protocol.js'
import type { FakeExecutor } from '../src/main/coordination/fake.js'
import { createCoordinationRuntime, createFreshPreviewDirectory, openPreviewDirectory, previewCheckpoint } from './coordination-preview-runtime.js'
import { createMainWebServer, handleMainWebRequest, type MainWebServerOptions, mainWebPage, MainWebEventBus, listenMainWebServer } from './main-web.js'

export { previewCheckpoint } from './coordination-preview-runtime.js'

/** 独立合成演示入口:临时/显式私有目录 + 独立认证 + TCP 监听。常驻 worker 请用 preview-worker。 */
export function createCoordinationPreview(options: { model: ScopedModel; domainModel?: ScopedModel; executor?: FakeExecutor & { stop?(id: string): void }; reopen?: string; newDirectoryParent?: string }) {
  // Do not inherit TMPDIR: test runners may point it inside the Git worktree.
  const directory = options.reopen ?? mkdtempSync(path.join(options.newDirectoryParent ?? '/tmp', 'coordination-web-preview-'))
  const mode = options.reopen ? openPreviewDirectory(directory) : createFreshPreviewDirectory(directory)
  const runtime = createCoordinationRuntime({ directory, mode, model: options.model, domainModel: options.domainModel, executor: options.executor })
  const auth = new MainWebAuth(directory), events = new MainWebEventBus()
  const serverOptions: MainWebServerOptions = { preview: { page: coordinationPage(mainWebPage), close: runtime.closeConnections, handle: runtime.handle }, auth, events, dataDirectory: directory, readHistory: () => [], host: {
    start: () => 0, submit: () => { throw new Error('Scoped route required') }, recover: () => 0, getStatus: () => runtime.host.status('main'),
    // The shared owner PUT already saved the file. Ignore its legacy no-tools
    // composition and rebuild this preview's capabilities from durable text.
    setCheckpoint: () => { runtime.host.checkpoint = previewCheckpoint(readOwnerContext(directory)) },
  } }
  const server = createMainWebServer(serverOptions)
  return { directory, store: runtime.store, host: runtime.host, server, auth, handle: (request: IncomingMessage, response: ServerResponse) => handleMainWebRequest(request, response, serverOptions), async close() { events.close(); await runtime.close(); await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) }) } }
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
