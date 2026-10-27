import { it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createCoordinationPreview } from '../scripts/main-web-coordination.js'
import { demoModel } from '../scripts/main-web-coordination-demo.js'
import { CoordinationHost, type HostEnvironment, type PermissionLevel } from '../src/main/coordination/model-host.js'
import type { ScopedModel } from '../src/agent/scoped-protocol.js'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { HeldFakeExecutor } from '../src/main/coordination/fake.js'
import { loadConfig } from '../src/config.js'

const until = async (condition: () => boolean) => { for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error('condition timeout') }

const facts = {
  releaseId: 'synthetic-release-1',
  modelName: 'deepseek-flash',
  projects: [{ name: 'proj', summary: '合成项目', delegable: true }],
  discoveryRoots: ['/dev/shm'],
  cliProjects: ['proj'],
  sourceWorkspace: '/home/vinci/projects/agents-master',
  configuredLevel: 'supervised' as PermissionLevel,
}

it('宿主环境快照：独立 user 消息注入主对话，含档位与实际工具清单；群聊不注入', async () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } }), s = owner.coordination
  let level: PermissionLevel = 'supervised'
  const hostEnv: HostEnvironment = {
    permissionLevel: () => level,
    snapshot: (tools, lvl) => 'SYNTHETIC_SNAPSHOT level=' + lvl + ' tools=' + tools.join(','),
  }
  const seen: Array<{ tools: string[]; snapshot?: string; system: string }> = []
  const model: ScopedModel = { complete: async (messages, tools) => {
    seen.push({
      tools: tools.map(t => t.function.name),
      snapshot: messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('SYNTHETIC_SNAPSHOT'))?.content as string | undefined,
      system: String(messages[0]?.content ?? ''),
    })
    return { content: '好' }
  } }
  const host = new CoordinationHost(s, model, demoModel(), new HeldFakeExecutor(), undefined, undefined, undefined, undefined, ['proj'], undefined, undefined, undefined, hostEnv)
  try {
    host.start(); host.submit('main', 'env-1', '你在哪里')
    await until(() => s.history('main').some(m => m.presentation === 'chat'))
    expect(seen[0]!.snapshot).toContain('level=supervised')
    expect(seen[0]!.snapshot).toContain('delegate_cli')
    expect(seen[0]!.tools).toContain('delegate_cli')
    // 群聊回合不注入快照（@main 寻址的群内主 Agent 回合同样不注入）
    host.submit('fake-work', 'env-2', '@main 群里问')
    await until(() => s.history('fake-work').length > 1)
    expect(seen.at(-1)!.snapshot).toBeUndefined()

    // 切到 readonly：delegate_cli 从工具清单与快照中消失，policy 不含白名单说明
    level = 'readonly'
    host.submit('main', 'env-3', '现在呢')
    await until(() => s.history('main').filter(m => m.presentation === 'chat').length > 1)
    expect(seen.at(-1)!.snapshot).toContain('level=readonly')
    expect(seen.at(-1)!.tools).not.toContain('delegate_cli')
    expect(seen.at(-1)!.system).toContain('只读权限档位')
    expect(seen.at(-1)!.system).not.toContain('delegate_cli 的 project 仅限白名单')
  } finally { await host.close(); owner.close() }
})

it('权限档位端点：默认读取、切换持久化、重开沿用、非法值 400、未认证 401；页面含档位控件', async () => {
  const app = createCoordinationPreview({ model: demoModel(), newDirectoryParent: '/dev/shm', hostEnvironment: facts })
  const directory = app.directory
  const base = 'http://127.0.0.1:31417'
  let cookie = ''
  const request = async (url: string, body?: unknown, method?: string) => {
    const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { url, method: method ?? (body ? 'POST' : 'GET'), headers: { host: '127.0.0.1:31417', cookie, ...(body ? { 'content-type': 'application/json', origin: base } : {}) } })
    let status = 0, text = ''; const headers = new Headers()
    const response = Object.assign(new EventEmitter(), { setHeader: (n: string, v: string) => headers.set(n, v), writeHead: (s: number, h: Record<string, string>) => { status = s; for (const [k, v] of Object.entries(h)) headers.set(k, v) }, write: (v: string) => { text += v }, end: (v = '') => { text += v; response.emit('close') } })
    await app.handle(req as unknown as IncomingMessage, response as unknown as ServerResponse)
    return { status, headers, text: async () => text }
  }
  try {
    expect((await request('/api/permission-level')).status).toBe(401)
    cookie = (await request('/api/auth/setup', { password: 'synthetic-password', setupToken: app.auth.setupToken })).headers.get('set-cookie')!.split(';')[0]!
    const initial = JSON.parse(await (await request('/api/permission-level')).text())
    expect(initial.level).toBe('supervised')
    expect(initial.configured).toBe('supervised')
    expect((await request('/api/permission-level', { level: 'yolo' }, 'PUT')).status).toBe(400)
    expect((await request('/api/permission-level', { level: 'workspace' }, 'PUT')).status).toBe(200)
    expect((JSON.parse(await (await request('/api/permission-level')).text())).level).toBe('workspace')
    expect(readFileSync(path.join(directory, 'permission-level.txt'), 'utf8').trim()).toBe('workspace')
    const page = await (await request('/')).text()
    expect(page).toContain('perm-level')
    expect(page).toContain('权限档位')
  } finally { await app.close() }
  // 重开同一数据目录：覆盖档位沿用（同目录认证数据仍在，沿用首次设置的 cookie）
  const reopened = createCoordinationPreview({ model: demoModel(), reopen: directory, hostEnvironment: facts })
  try {
    let status = 0, text = ''
    const req = Object.assign(Readable.from([]), { url: '/api/permission-level', method: 'GET', headers: { host: '127.0.0.1:31417', cookie } })
    const response = Object.assign(new EventEmitter(), { setHeader: () => {}, writeHead: (s: number) => { status = s }, write: (v: string) => { text += v }, end: (v = '') => { text += v; response.emit('close') } })
    await reopened.handle(req as unknown as IncomingMessage, response as unknown as ServerResponse)
    expect(status).toBe(200)
    expect(JSON.parse(text).level).toBe('workspace')
  } finally { await reopened.close(); rmSync(directory, { recursive: true }) }
})

it('config：delegation.level 新枚举可解析，仓库配置保持 supervised 默认', () => {
  const config = loadConfig()
  expect(config.delegation.level).toBe('supervised')
})
