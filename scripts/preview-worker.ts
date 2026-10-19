/** 预览 worker:业务运行时 + 私有 Unix socket。无认证实例、无 TCP 旁路、无 .env/模型凭据。 */
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { createCoordinationRuntime, createFreshPreviewDirectory, openPreviewDirectory, type CoordinationRuntime, type PreviewDirectoryMode } from './coordination-preview-runtime.js'
import { demoModel } from './main-web-coordination-demo.js'
import { HeldFakeExecutor } from '../src/main/coordination/fake.js'
import { coordinationPage } from '../src/main/coordination/web-page.js'
import { coordinationPreviewReleaseId, createMainWebPage, json } from './main-web.js'

export const previewWorkerLockFilename = '.preview-worker.lock.sqlite'

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
export async function startPreviewWorker(options: { dataDirectory: string; socketPath: string }): Promise<PreviewWorker> {
  const directory = path.resolve(options.dataDirectory)
  const socketPath = path.resolve(options.socketPath)
  await ensureReusableSocketPath(socketPath)
  const stat = existsSync(directory) ? lstatSync(directory) : undefined
  if (stat?.isSymbolicLink()) throw new Error('预览数据目录不能是符号链接')
  const mode: PreviewDirectoryMode = stat ? openPreviewDirectory(directory) : createFreshPreviewDirectory(directory)
  const lock = acquirePreviewInstanceLock(directory)
  let runtime: CoordinationRuntime
  try {
    // 只执行显式 FAKE 执行器:worker 绝不触发真实 CLI/子进程副作用。
    runtime = createCoordinationRuntime({ directory, mode, model: demoModel(), executor: new HeldFakeExecutor() })
  } catch (error) {
    lock.release()
    throw error
  }
  try {
    const socketDir = path.dirname(socketPath)
    mkdirSync(socketDir, { recursive: true, mode: 0o700 })
    chmodSync(socketDir, 0o700)
    const page = coordinationPage(createMainWebPage({
      channel: 'preview',
      businessApiBase: '/preview/api',
      releaseId: coordinationPreviewReleaseId,
      previewEnabled: true,
    }))
    const server = http.createServer((request, response) => {
      if (request.url === '/healthz') {
        if (request.method !== 'GET') json(response, 405, { error: '方法不可用。' })
        else json(response, 200, { ok: true, synthetic: true })
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

export async function runPreviewWorker(args: string[]): Promise<void> {
  if (args.length !== 4 || args[0] !== '--data-dir' || !args[1] || args[2] !== '--socket' || !args[3]) {
    throw new Error('Use --data-dir PRIVATE_V2_DIRECTORY --socket PRIVATE_SOCKET_PATH')
  }
  const worker = await startPreviewWorker({ dataDirectory: args[1], socketPath: args[3] })
  console.log(`preview worker ready（模拟演示，非真实智能对话）: socket=${worker.socketPath} data=${worker.directory}`)
  const stop = () => { void worker.close().then(() => { process.exitCode = 0 }) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPreviewWorker(process.argv.slice(2)).catch(error => { console.error(`Preview worker startup failed: ${(error as Error).message}`); process.exitCode = 1 })
}
