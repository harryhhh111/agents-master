import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { MainConversationMessage } from '../src/main/index.js'
import {
  createMainWebServer,
  defaultMainWebPort,
  foregroundEventForWeb,
  generateMainWebAccessToken,
  listenMainWebServer,
  mainCheckpoint,
  MainWebEventBus,
  mainWebLoopbackAddress,
  parseMainWebArguments,
  type MainWebHost,
} from '../scripts/main-web.js'

describe('main web arguments', () => {
  it('uses a private data-directory default and a bounded loopback port', () => {
    expect(parseMainWebArguments([], '/home/example')).toEqual({
      dataDirectory: '/home/example/.local/share/agents-master/main-chat',
      port: defaultMainWebPort,
    })
    expect(parseMainWebArguments(['--data-dir', '/private/main', '--port', '32100'], '/home/example'))
      .toEqual({ dataDirectory: '/private/main', port: 32100 })
  })

  it('rejects malformed, repeated, unknown, and out-of-range options before startup', () => {
    for (const args of [
      ['--port'], ['--port', '0'], ['--port', '1.5'], ['--port', '1e3'], ['--port', '65536'],
      ['--port', '2', '--port', '3'], ['--data-dir', '/a', '--data-dir', '/b'], ['--host', '0.0.0.0'],
    ]) expect(() => parseMainWebArguments(args, '/home/example')).toThrow()
  })
})

describe('main web HTTP adapter', () => {
  let directory: string
  let server: Server | undefined
  let accessToken: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(process.platform === 'linux' ? '/dev/shm' : tmpdir(), 'main-web-test-'))
    accessToken = generateMainWebAccessToken()
  })

  afterEach(async () => {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })

  it('requires an in-memory local access token for every API endpoint and serves authorized data without provider calls', async () => {
    const submitted: Array<{ content: string; idempotencyKey: string }> = []
    const host: MainWebHost = {
      start: vi.fn(() => 0),
      submit: input => { submitted.push(input) },
      recover: vi.fn(() => undefined),
      setCheckpoint: vi.fn(),
    }
    const history: MainConversationMessage[] = [{
      id: 'stored-1', role: 'assistant', content: 'A durable reply.', createdAt: '2026-09-17T00:00:00.000Z',
    }]
    server = createMainWebServer({
      host, readHistory: () => history, dataDirectory: directory, events: new MainWebEventBus(), accessToken,
    })
    const port = await listenMainWebServer(server, 0)
    const base = `http://${mainWebLoopbackAddress}:${port}`

    expect((await fetch(`${base}/api/history`)).status).toBe(401)
    expect((await fetch(`${base}/api/does-not-exist`)).status).toBe(401)
    expect((await (await fetch(`${base}/api/history`, {
      headers: { 'X-Agents-Main-Web-Token': accessToken },
    })).json())).toEqual({ messages: history, cursor: 0 })
    expect((await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agents-Main-Web-Token': accessToken }, body: JSON.stringify({ content: '   ' }),
    })).status).toBe(400)
    expect((await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agents-Main-Web-Token': accessToken },
      body: JSON.stringify({
        content: 'A local message.', idempotencyKey: 'client-1', checkpointSnapshot: 'web callers cannot set this',
      }),
    })).status).toBe(202)
    expect(submitted).toEqual([{ content: 'A local message.', idempotencyKey: 'client-1' }])

    expect((await fetch(`${base}/api/owner-context`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Agents-Main-Web-Token': accessToken },
      body: JSON.stringify({ content: 'Explicit owner-maintained background.' }),
    })).status).toBe(200)
    expect(host.setCheckpoint).toHaveBeenCalledWith(mainCheckpoint('Explicit owner-maintained background.'))
    expect(await (await fetch(`${base}/api/owner-context`, {
      headers: { 'X-Agents-Main-Web-Token': accessToken },
    })).json()).toEqual({
      content: 'Explicit owner-maintained background.',
    })
    const page = await (await fetch(`${base}/`)).text()
    expect(page).toContain('location.hash')
    expect(page).toContain('启动终端提供的本地访问链接')
  })

  it('binds the listening helper to IPv4 loopback only', async () => {
    const host: MainWebHost = { start: () => 0, submit: () => {}, recover: () => undefined, setCheckpoint: () => {} }
    server = createMainWebServer({
      host, readHistory: () => [], dataDirectory: directory, events: new MainWebEventBus(), accessToken,
    })
    await listenMainWebServer(server, 0)
    expect(server.address()).toMatchObject({ address: mainWebLoopbackAddress })
  })

  it('maps host failures to a safe live-update payload without leaking a provider error', () => {
    expect(foregroundEventForWeb({ type: 'error', error: new Error('provider detail') })).toEqual({
      type: 'error', message: '模型请求失败；消息已保留，等待明确重试。',
    })
  })

  it('replays an event published after a history cursor exactly once when SSE subscribes', async () => {
    const host: MainWebHost = { start: () => 0, submit: () => {}, recover: () => undefined, setCheckpoint: () => {} }
    const events = new MainWebEventBus()
    server = createMainWebServer({ host, readHistory: () => [], dataDirectory: directory, events, accessToken })
    const port = await listenMainWebServer(server, 0)
    const base = `http://${mainWebLoopbackAddress}:${port}`
    const history = await (await fetch(`${base}/api/history`, {
      headers: { 'X-Agents-Main-Web-Token': accessToken },
    })).json() as { messages: MainConversationMessage[]; cursor: number }

    events.publish({ type: 'error', message: 'safe replay event' })
    const response = await fetch(`${base}/api/events?access_token=${encodeURIComponent(accessToken)}&cursor=${history.cursor}`)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    let stream = ''
    while (!stream.includes('safe replay event')) {
      const next = await reader.read()
      expect(next.done).toBe(false)
      stream += new TextDecoder().decode(next.value)
    }
    await reader.cancel()
    expect(stream.match(/safe replay event/g)).toHaveLength(1)
    expect(stream).toContain('id: 1')
  })
})
