/** 预览 worker:业务运行时 + 私有 Unix socket。无认证实例、无 TCP 旁路。
 *  --model demo(默认):合成剧本模型,无需凭据;--model real:真实模型(DeepSeek),
 *  凭据仅来自环境(DOTENV_CONFIG_PATH 指向的 0600 文件),缺 key 直接拒绝启动,不降级。 */
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { createCoordinationRuntime, createFreshPreviewDirectory, openPreviewDirectory, type CoordinationRuntime, type PreviewDirectoryMode, type PreviewWording } from './coordination-preview-runtime.js'
import { demoModel } from './main-web-coordination-demo.js'
import { coordinationPage } from '../src/main/coordination/web-page.js'
import { coordinationPreviewReleaseId, createMainWebPage, json, readPackagedReleaseId } from './main-web.js'
import type { ScopedModel } from '../src/agent/scoped-protocol.js'

export const previewWorkerLockFilename = '.preview-worker.lock.sqlite'
export const previewPreviewLabelReal = '预览版 · 真实模型（受限工具）'
export const previewPreviewLabelDemo = '预览版 · 模拟演示'

export interface PreviewWorkerModelOption {
  mode: 'demo' | 'real'
  /** real 模式由调用方注入已构造的真实模型;demo 模式忽略。 */
  realModel?: ScopedModel
  /** real 模式上报的模型名(如 config.llm.model)。 */
  modelName?: string
}

/** 在打开数据库/恢复运行之前取得数据目录的跨进程独占锁。进程退出由 OS 释放 SQLite 文件锁。 */
export function acquirePreviewInstanceLock(directory: string): { release(): void } {
  const file = path.join(directory, previewWorkerLockFilename)
  const db = new DatabaseSync(file)
  let locked = false
  try {
    db.exec('PRAGMA busy_timeout=0')
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch {
      throw new Error('该预览数据目录已有运行中的 worker（单实例锁生效），拒绝第二个 worker。')
    }
    locked = true
    db.exec('CREATE TABLE IF NOT EXISTS preview_worker_lock (id INTEGER PRIMARY KEY CHECK (id = 1)) STRICT')
    chmodSync(file, 0o600)
    let released = false
    return {
      release() {
        if (released) return
        released = true
        try { if (locked) db.exec('ROLLBACK') } finally { db.close() }
      },
    }
  } catch (error) {
    try { if (locked) db.exec('ROLLBACK') } catch { /* lock is already gone */ }
    db.close()
    throw error
  }
}

async function ensureReusableSocketPath(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return
  if (!lstatSync(socketPath).isSocket()) throw new Error('预览 socket 路径已被非 socket 文件占用')
  const live = await new Promise<boolean>((resolve, reject) => {
    const connection = net.createConnection({ path: socketPath })
    connection.once('connect', () => { connection.end(); resolve(true) })
    connection.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
  })
  if (live) throw new Error('预览 socket 已被运行中的服务使用，拒绝接管或删除。')
  unlinkSync(socketPath)
}

export interface PreviewWorker {
  directory: string
  socketPath: string
  server: http.Server
  runtime: CoordinationRuntime
  close(): Promise<void>
}

/** 显式持久目录 + 固定私有 socket + 单实例锁。存在目录必须带兼容标记,绝不清理已有数据。 */
export async function startPreviewWorker(options: { dataDirectory: string; socketPath: string; model?: PreviewWorkerModelOption }): Promise<PreviewWorker> {
  const directory = path.resolve(options.dataDirectory)
  const socketPath = path.resolve(options.socketPath)
  const modelOption: PreviewWorkerModelOption = options.model ?? { mode: 'demo' }
  const wording: PreviewWording = modelOption.mode === 'real' ? 'real-model' : 'synthetic'
  if (modelOption.mode === 'real' && !modelOption.realModel) throw new Error('real 模式必须提供真实模型实例。')
  await ensureReusableSocketPath(socketPath)
  const stat = existsSync(directory) ? lstatSync(directory) : undefined
  if (stat?.isSymbolicLink()) throw new Error('预览数据目录不能是符号链接')
  const mode: PreviewDirectoryMode = stat ? openPreviewDirectory(directory) : createFreshPreviewDirectory(directory)
  const lock = acquirePreviewInstanceLock(directory)
  let runtime: CoordinationRuntime
  try {
    // 默认 ScopedDomainExecutor(demoModel)：identity 同为 FAKE，只运行合成工具
    // （synthetic_inspect/ask/finish），绝不触发真实 CLI 或子进程；它能完成 ask→回答→finish
    // 的合成闭环。HeldFakeExecutor 会无限挂起任务，仅限单元测试显式驱动，不能用于常驻 worker。
    // real 模式换用真实模型实例,执行工具保持不变。
    runtime = createCoordinationRuntime({ directory, mode, model: modelOption.mode === 'real' ? modelOption.realModel! : demoModel(), wording })
  } catch (error) {
    lock.release()
    throw error
  }
  try {
    const socketDir = path.dirname(socketPath)
    mkdirSync(socketDir, { recursive: true, mode: 0o700 })
    chmodSync(socketDir, 0o700)
    const releaseId = readPackagedReleaseId(process.cwd(), coordinationPreviewReleaseId)
    const previewLabel = modelOption.mode === 'real' ? previewPreviewLabelReal : previewPreviewLabelDemo
    const page = coordinationPage(createMainWebPage({
      channel: 'preview',
      businessApiBase: '/preview/api',
      releaseId,
      previewEnabled: true,
      previewLabel,
    }), wording)
    const server = http.createServer((request, response) => {
      if (request.url === '/healthz') {
        if (request.method !== 'GET') json(response, 405, { error: '方法不可用。' })
        else json(response, 200, { ok: true, synthetic: modelOption.mode !== 'real', model: modelOption.mode === 'real' ? modelOption.modelName : undefined, previewLabel, releaseId })
        return
      }
      if (request.url === '/preview/') {
        if (!['GET', 'HEAD'].includes(request.method ?? '')) json(response, 405, { error: '方法不可用。' })
        else {
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          })
          response.end(request.method === 'HEAD' ? undefined : page)
        }
        return
      }
      void runtime.handle(request, response, () => true)
        .then(handled => { if (!handled) json(response, 404, { error: '未知端点。' }) })
        .catch(() => {
          if (!response.headersSent) json(response, 500, { error: '预览 worker 无法完成请求。' })
          else response.end()
        })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()) })
    chmodSync(socketPath, 0o600)
    return {
      directory,
      socketPath,
      server,
      runtime,
      async close() {
        await runtime.close()
        await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) })
        lock.release()
      },
    }
  } catch (error) {
    await runtime.close()
    lock.release()
    throw error
  }
}

export interface PreviewWorkerArgs {
  dataDirectory: string
  socketPath: string
  modelMode: 'demo' | 'real'
}
export function parsePreviewWorkerArgs(args: string[]): PreviewWorkerArgs {
  if (args.length !== 4 && args.length !== 6) throw new Error('Use --data-dir PRIVATE_V2_DIRECTORY --socket PRIVATE_SOCKET_PATH [--model demo|real]')
  if (args[0] !== '--data-dir' || !args[1] || args[2] !== '--socket' || !args[3]) throw new Error('Use --data-dir PRIVATE_V2_DIRECTORY --socket PRIVATE_SOCKET_PATH [--model demo|real]')
  let modelMode: 'demo' | 'real' = 'demo'
  if (args.length === 6) {
    if (args[4] !== '--model' || (args[5] !== 'demo' && args[5] !== 'real')) throw new Error('--model 只接受 demo 或 real')
    modelMode = args[5]
  }
  return { dataDirectory: args[1], socketPath: args[3], modelMode }
}

export async function runPreviewWorker(args: string[]): Promise<void> {
  const parsed = parsePreviewWorkerArgs(args)
  let model: PreviewWorkerModelOption = { mode: 'demo' }
  if (parsed.modelMode === 'real') {
    await import('dotenv/config')
    const { loadConfig } = await import('../src/config.js')
    const { createCoordinationModel } = await import('../src/frontbrain/coordination-model.js')
    const config = loadConfig()
    // createLlmClient 在缺 DEEPSEEK_API_KEY 时抛出;此处不捕获,启动直接失败,不静默降级 demo。
    model = { mode: 'real', realModel: createCoordinationModel(config, { timeoutMs: 45_000 }), modelName: config.llm.model }
  }
  const worker = await startPreviewWorker({ dataDirectory: parsed.dataDirectory, socketPath: parsed.socketPath, model })
  const note = parsed.modelMode === 'real' ? `真实模型（受限工具）: model=${(model as { modelName?: string }).modelName}` : '模拟演示，非真实智能对话'
  console.log(`preview worker ready（${note}）: socket=${worker.socketPath} data=${worker.directory}`)
  const stop = () => { void worker.close().then(() => { process.exitCode = 0 }) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPreviewWorker(process.argv.slice(2)).catch(error => { console.error(`Preview worker startup failed: ${(error as Error).message}`); process.exitCode = 1 })
}
