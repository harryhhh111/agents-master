import { it, expect, vi } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

// 本机 /tmp 内存在 .git 探测标记;与既有协调测试一致,对该探测隐藏。
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === '/tmp/.git') throw Object.assign(new Error('fixture marker'), { code: 'ENOENT' })
    return fs.lstatSync(...args)
  } }
})
import { createCoordinationRuntime, createFreshPreviewDirectory, previewMarkerContent, previewMarkerFilename } from '../scripts/coordination-preview-runtime.js'
import { acquirePreviewInstanceLock, previewWorkerLockFilename, startPreviewWorker } from '../scripts/preview-worker.js'

const base = () => mkdtempSync('/tmp/preview-worker-test-')
const socketRequest = (socketPath: string, route: string, method = 'GET', body?: unknown) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  // agent:false:每次新建连接,避免 keep-alive 池跨 worker 实例复用已失效的 unix socket。
  const request = http.request({ socketPath, path: route, method, agent: false, headers: body ? { 'content-type': 'application/json' } : {} }, response => {
    let text = ''
    response.on('data', chunk => { text += chunk })
    response.on('end', () => resolve({ status: response.statusCode!, body: text }))
  })
  request.on('error', error => reject(new Error(`${method} ${route} -> ${(error as Error).message}`)))
  if (body) request.write(JSON.stringify(body))
  request.end()
})

class Response extends EventEmitter {
  status = 0; text = ''; headers: Record<string, string> = {}
  writeHead(s: number, h: Record<string, string>) { this.status = s; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v }
  write(v: string) { this.text += v }
  end(v = '') { this.text += v; this.emit('close') }
}
const runtimeRequest = async (handle: (req: IncomingMessage, res: ServerResponse, authorized: () => boolean) => Promise<boolean>, route: string, method = 'GET', body?: unknown) => {
  const request = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { url: route, method, headers: {} })
  const response = new Response()
  await handle(request as unknown as IncomingMessage, response as unknown as ServerResponse, () => true)
  return response
}

const spawnWorker = (dataDirectory: string, socketPath: string) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview-worker.ts', '--data-dir', dataDirectory, '--socket', socketPath], {
    cwd: process.cwd(),
    env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return { child, output: () => output }
}

const waitForExit = (child: ReturnType<typeof spawn>) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode })
  else child.once('exit', (code, signal) => resolve({ code, signal }))
})

const waitForWorker = async (socketPath: string): Promise<void> => {
  let lastError = ''
  for (let i = 0; i < 300; i += 1) {
    try { if ((await socketRequest(socketPath, '/healthz')).status === 200) return } catch (error) { lastError = (error as Error).message }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`worker did not become ready: ${lastError}`)
}

it('runtime 不创建认证实例:业务 handler 可用且目录无 web-auth.json', async () => {
  const parent = base()
  const directory = path.join(parent, 'data')
  const mode = createFreshPreviewDirectory(directory)
  const runtime = createCoordinationRuntime({ directory, mode, model: { complete: async () => ({ content: 'synthetic reply' }) } })
  try {
    expect((await runtimeRequest(runtime.handle, '/api/conversations')).status).toBe(200)
    expect((await runtimeRequest(runtime.handle, '/api/history')).status).toBe(200)
    expect(existsSync(path.join(directory, 'web-auth.json'))).toBe(false)
    expect(existsSync(path.join(directory, 'preview.sqlite'))).toBe(true)
  } finally {
    await runtime.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

it('worker:私有 socket 权限、无 TCP 旁路、健康检查与业务请求可用', async () => {
  const parent = base()
  const worker = await startPreviewWorker({ dataDirectory: path.join(parent, 'data'), socketPath: path.join(parent, 'run', 'preview.sock') })
  try {
    expect(typeof worker.server.address()).toBe('string')
    expect((lstatSync(worker.directory).mode & 0o777)).toBe(0o700)
    expect((lstatSync(worker.socketPath).mode & 0o777)).toBe(0o600)
    expect((lstatSync(path.dirname(worker.socketPath)).mode & 0o777) & 0o077).toBe(0)
    expect((await socketRequest(worker.socketPath, '/healthz')).status).toBe(200)
    const conversations = await socketRequest(worker.socketPath, '/api/conversations')
    expect(conversations.status).toBe(200)
    expect(conversations.body).toContain('synthetic')
    expect((await socketRequest(worker.socketPath, '/nope')).status).toBe(404)
    expect(existsSync(path.join(worker.directory, 'web-auth.json'))).toBe(false)
  } finally {
    await worker.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

it('重复启动保护:第二个 worker 在打开数据前被拒,原进程与其 socket 不受干扰', async () => {
  const parent = base()
  const data = path.join(parent, 'data'), socketPath = path.join(parent, 'run', 'preview.sock')
  const first = await startPreviewWorker({ dataDirectory: data, socketPath })
  try {
    await expect(startPreviewWorker({ dataDirectory: data, socketPath: path.join(parent, 'run', 'other.sock') }))
      .rejects.toThrow(/单实例锁/)
    expect((await socketRequest(socketPath, '/healthz')).status).toBe(200)
    const unrelated = path.join(parent, 'unrelated')
    mkdirSync(unrelated)
    const second = acquirePreviewInstanceLock(unrelated)
    expect(() => acquirePreviewInstanceLock(unrelated)).toThrow(/单实例锁/)
    second.release()
  } finally {
    await first.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

it('持久重启:同一目录历史与标记保留,SQLite 锁文件可安全重开', async () => {
  const parent = base()
  const data = path.join(parent, 'data'), socketPath = path.join(parent, 'run', 'preview.sock')
  const first = await startPreviewWorker({ dataDirectory: data, socketPath })
  await socketRequest(socketPath, '/api/messages?conversation=main', 'POST', { content: 'persistent hello', idempotencyKey: 'k1' })
  await new Promise(resolve => setTimeout(resolve, 50))
  await first.close()
  expect(existsSync(path.join(data, previewWorkerLockFilename))).toBe(true)
  expect(readFileSync(path.join(data, previewMarkerFilename), 'utf8')).toBe(previewMarkerContent)
  const second = await startPreviewWorker({ dataDirectory: data, socketPath })
  try {
    const history = await socketRequest(socketPath, '/api/history?conversation=main')
    expect(history.status).toBe(200)
    expect(history.body).toContain('persistent hello')
  } finally {
    await second.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

it('目录边界:无标记的已有目录与符号链接目录都被拒绝,内容不被改动', async () => {
  const parent = base()
  const foreign = path.join(parent, 'foreign')
  mkdirSync(foreign)
  writeFileSync(path.join(foreign, 'keep.txt'), 'do not touch')
  await expect(startPreviewWorker({ dataDirectory: foreign, socketPath: path.join(parent, 'a.sock') })).rejects.toThrow(/reopen/)
  expect(readFileSync(path.join(foreign, 'keep.txt'), 'utf8')).toBe('do not touch')
  expect(existsSync(path.join(foreign, 'preview.sqlite'))).toBe(false)
  const link = path.join(parent, 'linked')
  symlinkSync(foreign, link)
  await expect(startPreviewWorker({ dataDirectory: link, socketPath: path.join(parent, 'b.sock') })).rejects.toThrow(/符号链接/)
  rmSync(parent, { recursive: true, force: true })
})

it('真实跨进程:重复启动与活跃 socket 接管被拒,停止或崩溃后同目录恢复历史', async () => {
  const parent = mkdtempSync('/dev/shm/preview-worker-process-')
  const data = path.join(parent, 'data'), socketPath = path.join(parent, 'run', 'preview.sock')
  const children: ReturnType<typeof spawnWorker>[] = []
  const stop = async (worker: ReturnType<typeof spawnWorker>) => {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
    await waitForExit(worker.child)
  }
  try {
    const first = spawnWorker(data, socketPath); children.push(first)
    await waitForWorker(socketPath)

    const duplicate = spawnWorker(data, path.join(parent, 'run', 'other.sock')); children.push(duplicate)
    expect((await waitForExit(duplicate.child)).code).toBe(1)
    expect(duplicate.output()).toContain('单实例锁')
    expect((await socketRequest(socketPath, '/healthz')).status).toBe(200)

    const otherData = path.join(parent, 'other-data')
    const takeover = spawnWorker(otherData, socketPath); children.push(takeover)
    expect((await waitForExit(takeover.child)).code).toBe(1)
    expect(takeover.output()).toContain('预览 socket')
    expect(existsSync(otherData)).toBe(false)
    expect((await socketRequest(socketPath, '/healthz')).status).toBe(200)

    await socketRequest(socketPath, '/api/messages?conversation=main', 'POST', { content: 'process persistent hello', idempotencyKey: 'process-k1' })
    await stop(first)
    expect(first.child.exitCode).toBe(0)

    const reopened = spawnWorker(data, socketPath); children.push(reopened)
    await waitForWorker(socketPath)
    const history = await socketRequest(socketPath, '/api/history?conversation=main')
    expect(history.status).toBe(200)
    expect(history.body).toContain('process persistent hello')

    reopened.child.kill('SIGKILL')
    expect((await waitForExit(reopened.child)).signal).toBe('SIGKILL')
    const afterCrash = spawnWorker(data, socketPath); children.push(afterCrash)
    await waitForWorker(socketPath)
    expect((await socketRequest(socketPath, '/api/history?conversation=main')).body).toContain('process persistent hello')
    await stop(afterCrash)
    expect(afterCrash.child.exitCode).toBe(0)
  } finally {
    await Promise.all(children.map(async worker => {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL')
        await waitForExit(worker.child)
      }
    }))
    rmSync(parent, { recursive: true, force: true })
  }
})

it('demo 目录规则:兼容标记缺失的新建目录按 fresh 创建,重开必须带标记', async () => {
  const parent = base()
  const fresh = path.join(parent, 'fresh')
  expect(createFreshPreviewDirectory(fresh)).toBe('preview-fresh')
  expect(readFileSync(path.join(fresh, previewMarkerFilename), 'utf8')).toBe(previewMarkerContent)
  rmSync(parent, { recursive: true, force: true })
})
