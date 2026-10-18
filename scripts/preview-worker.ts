/** 预览 worker:业务运行时 + 私有 Unix socket。无认证实例、无 TCP 旁路、无 .env/模型凭据。 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCoordinationRuntime, createFreshPreviewDirectory, openPreviewDirectory, type CoordinationRuntime, type PreviewDirectoryMode } from './coordination-preview-runtime.js'
import { demoModel } from './main-web-coordination-demo.js'
import { HeldFakeExecutor } from '../src/main/coordination/fake.js'
import { json } from './main-web.js'

const lockFilename = '.preview-worker.lock'

function processStartTime(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21] } catch { return undefined }
}

/** pid 存活且 starttime 一致才视为同进程,防止 pid 复用误判。 */
function lockHeldByLiveProcess(saved: { pid?: unknown; start?: unknown }): boolean {
  if (typeof saved.pid !== 'number' || typeof saved.start !== 'string') return false
  const start = processStartTime(saved.pid)
  return start !== undefined && start === saved.start
}

/** 在打开数据库/恢复运行之前取得数据目录的跨进程独占锁。 */
export function acquirePreviewInstanceLock(directory: string): { release(): void } {
  const file = path.join(directory, lockFilename)
  if (existsSync(file)) {
    let held = false
    try { held = lockHeldByLiveProcess(JSON.parse(readFileSync(file, 'utf8'))) } catch { /* 读不了的锁按过期处理 */ }
    if (held) throw new Error('该预览数据目录已有运行中的 worker（单实例锁生效），拒绝第二个 worker。')
    try { unlinkSync(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法清理过期的单实例锁')
    }
  }
  const start = processStartTime(process.pid)
  if (start === undefined) throw new Error('无法确定本进程标识，拒绝获取单实例锁')
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, start })) } finally { closeSync(fd) }
  let released = false
  return { release() { if (released) return; released = true; try { unlinkSync(file) } catch { /* 已不存在 */ } } }
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
    const server = http.createServer((request, response) => {
      if (request.url === '/healthz') { json(response, 200, { ok: true, synthetic: true }); return }
      void runtime.handle(request, response, () => true).then(handled => { if (!handled) json(response, 404, { error: '未知端点。' }) })
    })
    if (existsSync(socketPath)) unlinkSync(socketPath)
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
  const data = args[args.indexOf('--data-dir') + 1], socket = args[args.indexOf('--socket') + 1]
  if (args.length !== 4 || !data || !socket || args[0] !== '--data-dir') throw new Error('Use --data-dir PRIVATE_V2_DIRECTORY --socket PRIVATE_SOCKET_PATH')
  const worker = await startPreviewWorker({ dataDirectory: data, socketPath: socket })
  console.log(`preview worker ready（模拟演示，非真实智能对话）: socket=${worker.socketPath} data=${worker.directory}`)
  const stop = () => { void worker.close().then(() => { process.exitCode = 0 }) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPreviewWorker(process.argv.slice(2)).catch(error => { console.error(`Preview worker startup failed: ${(error as Error).message}`); process.exitCode = 1 })
}
