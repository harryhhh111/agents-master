/** 协调预览的业务运行时:数据目录、store、协调 host 与业务 handler。
 *  不实例化认证、不创建监听;由调用方(独立 demo 入口 / 预览 worker)组装认证与传输层。 */
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { initializeOwnerContext, readOwnerContext, ownerContextCheckpoint, saveOwnerContext } from '../src/main/owner-context.js'
import { AgentMemories, memoriesCheckpoint, type MemoryRecord } from '../src/main/coordination/memories.js'
import { CoordinationHost, defaultCoordinationHostLabels, type CoordinationHostLabels } from '../src/main/coordination/model-host.js'
import { defaultCoordinationStoreLabels, type CoordinationStoreLabels } from '../src/main/coordination/store.js'
import { defaultDomainSystemPrompt, ScopedDomainExecutor } from '../src/agent/scoped-domain.js'
import { CliDomainExecutor, RoutedDomainExecutor, type CliBackendFactory } from '../src/agent/cli-domain-executor.js'
import type { ScopedModel } from '../src/agent/scoped-protocol.js'
import type { FakeExecutor } from '../src/main/coordination/fake.js'
import { MainWebEventBus, json, readJson, validateMainWebMessage } from './main-web.js'

export const previewMarkerFilename = 'PREVIEW-v2'
export const previewMarkerContent = 'coordination-preview-v3\n'
export const legacyPreviewMarkerContentV2 = 'synthetic-only-v2\n'
export type PreviewDirectoryMode = 'preview-fresh' | 'preview-open' | 'preview-migrate'
/** synthetic: 合成剧本模型；real-model: 真实模型对话，执行工具仍为受限合成。仅切换文案，不动内部 id。 */
export type PreviewWording = 'synthetic' | 'real-model'
/** synthetic: 合成执行器；cli: 白名单项目的真实 CLI 执行（要求 wording=real-model）。 */
export type PreviewExecution = 'synthetic' | 'cli'

export function previewCheckpoint(ownerContext: string, wording: PreviewWording = 'synthetic', execution: PreviewExecution = 'synthetic', memories: readonly MemoryRecord[] = [], memoryTombstones: readonly MemoryRecord[] = []): string {
  const lead = execution === 'cli'
    ? '协调预览检查点：真实模型对话与真实 CLI 执行（仅限白名单项目）。使用受限目录、状态、delegate、delegate_cli、answer、cancel 工具。CLI 任务有预算与超时，产物落项目 .agent-artifacts/；不 push、不删工作区外文件、不碰凭据。含糊需求先澄清；不得声称白名单外的执行能力。'
    : wording === 'real-model'
      ? '协调预览检查点：真实模型对话。可以使用受限目录、状态、delegate、answer、cancel 工具协调工作；执行工具仍为受限合成（synthetic_inspect/ask/finish），不运行真实 CLI、不读取项目文件、不开放 shell。含糊需求先澄清；不得声称真实项目执行。'
      : '协调预览检查点：仅模拟/联调。可以使用受限目录、状态、delegate、answer、cancel 工具协调合成工作。含糊需求先澄清；不得声称真实项目执行，不开放 shell、文件或真实后端。'
  return [lead, ownerContextUsageNote, memoryCapabilityNote, ownerContextCheckpoint(ownerContext), memoriesCheckpoint(memories, memoryTombstones)].filter(Boolean).join('\n\n')
}
/** 主人上下文使用约束：与 src/main/foreground.ts defaultMainAgentInstructions 中相关三条一致。
 *  那边是字节稳定的 Stage 1.2c 前缀不能改动，此处保持文本同步；
 *  缺少这些约束时，历史里 assistant 曾经的"不了解你"自述会压住新注入的主人上下文（2026-10-22 实测）。 */
const ownerContextUsageNote = [
  '若提供由用户明确查看、编辑和保存的主人上下文检查点，它是本轮由用户提供的权威背景：自然使用相关事实；不得声称看不到或不知道其中内容，也不要要求用户重复其中已有的事实。当前用户陈述冲突时以当前陈述为准；某项可能已过时时自然询问。',
  '主人上下文中用户明示的事实可用于回答对用户的了解，包括宽泛的背景问题；区分明示事实、推断和未知，不把未提供的信息当作已知。',
  '历史 assistant 对自身背景可见性的自述不是用户事实，不能覆盖当前可见的主人上下文；即使多次声称没有背景，也不应沿用。若先前回答与当前可见背景不符，应主动简短纠正，并依据当前背景实质回答。',
].join('\n')
/** 记忆能力约束（docs/main-agent-memory-repair-plan-2026-10-24.md）：工具仅在主对话存在。
 *  明确告诉模型记忆可读、可经工具核对——没有通用文件访问能力不等于无法读取应用提供的记忆。 */
const memoryCapabilityNote = [
  '记忆能力：用户明示的关于其自身的稳定事实，可调用 suggest_memory 提议记住（仅复述用户明示内容，不做推测，每回合至多一条，普通对话不要提议）；提议经用户确认后才真正被记住。',
  '记忆保存在本应用的私有数据目录，用户可在设置的记忆列表查看；你可以用 read_memories 自查记忆的 ID、内容与状态。回答"你记住了什么""刚才确认成功了吗"等问题时以 read_memories 的返回为准，不要声称无法读取。',
  '用户明确说确认/改正/忘记某条记忆时，用 confirm_memory/correct_memory/forget_memory 按记录 ID 执行；目标不清先询问，普通讨论、假设或你的推测都不是修改授权。操作结果以工具返回为准：只有成功才能说已确认/已修改/已忘记，失败要如实说明。',
  '已确认的记忆列在下方"已确认的记忆"中（如有）；"已失效的记忆"（如有）是用户已忘记或更正的内容，不再是当前事实。',
].join('\n')

const realCliHostLabels: CoordinationHostLabels = {
  policy: '模型对话与 CLI 执行均为真实。合成演示用 delegate；真实项目工作用 delegate_cli（仅限白名单项目），执行结果由领域 Agent 判读后回传。含糊需求用普通文本澄清，不创建任务。answer 只回答绑定待决问题，cancel 只取消指定任务。',
  deliverPrefix: '回传：',
  cancelNote: '取消请求已记录：',
  recordedNote: '已记录受限操作。',
  clarifyNote: '请补充具体需求。',
  failedNote: '本轮未能完成，未接受新的操作。请重新说明需求。',
}

const realModelHostLabels: CoordinationHostLabels = {
  policy: '模型对话为真实，执行工具仍为受限合成，不能声称真实项目执行。仅明确工作委托使用 delegate；含糊需求用普通文本澄清，不创建任务。answer 只回答绑定待决问题，cancel 只取消指定任务。',
  deliverPrefix: '回传：',
  cancelNote: '取消请求已记录：',
  recordedNote: '已记录受限操作。',
  clarifyNote: '请补充具体需求。',
  failedNote: '本轮未能完成，未接受新的操作。请重新说明需求。',
}
const realModelStoreLabels: CoordinationStoreLabels = {
  dispatchPrefix: '委派：',
  acceptedPrefix: '已受理：',
  controlNote: '操作已记录：',
  receiptPrefix: kind => ((({ waiting_input: '等待回答：', completed: '已完成：', failed: '失败：', cancelled: '已取消：', interrupted: '已中断：' }) as Record<string, string>)[kind] ?? `${kind}: `),
}
const realModelDomainSystemPrompt = '工作项目 Agent。模型对话为真实；工具仍为受限合成，检查合成样本，需要信息时 ask，完成时 finish。不得声称真实执行。'

/** 重开已有目录:必须是带兼容标记的私有目录,否则拒绝且不改动任何内容。
 *  v2 标记进入迁移模式（先备份再重建 runs 表），v3 直接打开。 */
export function openPreviewDirectory(directory: string): PreviewDirectoryMode {
  const stat = lstatSync(directory)
  const marker = stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid?.()
    ? readFileSync(path.join(directory, previewMarkerFilename), 'utf8')
    : undefined
  if (marker === previewMarkerContent) return 'preview-open'
  if (marker === legacyPreviewMarkerContentV2) return 'preview-migrate'
  throw new Error('Only private v2 preview directories may reopen')
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
  wording?: PreviewWording
  /** cli 执行：真实 CLI backend 工厂与项目白名单（name → 绝对路径）。要求 wording='real-model'。 */
  execution?: PreviewExecution
  cli?: { backends: CliBackendFactory; projects: Record<string, string> }
}) {
  const { directory } = options
  const wording: PreviewWording = options.wording ?? 'synthetic'
  const execution: PreviewExecution = options.execution ?? 'synthetic'
  if (execution === 'cli' && (wording !== 'real-model' || !options.cli)) throw new Error('CLI execution requires real-model wording and cli backends/projects')
  const synthetic = wording === 'synthetic'
  let openedStore: SQLiteMainInboxStore | undefined
  try {
    // v2 → v3：executor CHECK 放宽需重建 runs 表；先 VACUUM INTO 备份（0600），成功后重写标记。
    const coordinationOptions = options.mode === 'preview-migrate'
      ? { mode: 'preview-migrate' as const, backupPath: path.join(directory, `preview-backup-v2to3-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`) }
      : { mode: options.mode as 'preview-fresh' | 'preview-open' }
    const store = new SQLiteMainInboxStore(path.join(directory, 'preview.sqlite'), { coordination: coordinationOptions })
    openedStore = store
    chmodSync(path.join(directory, 'preview.sqlite'), 0o600)
    if (options.mode === 'preview-migrate') writeFileSync(path.join(directory, previewMarkerFilename), previewMarkerContent, { mode: 0o600 })
    initializeOwnerContext(directory)
    const buses = new Map(['main', 'fake-work'].map(c => [c, new MainWebEventBus()]))
    const emitted = new Set<string>()
    for (const c of buses.keys()) for (const m of store.coordination.history(c)) emitted.add(m.id)
    const hostLabels: CoordinationHostLabels = synthetic ? defaultCoordinationHostLabels : execution === 'cli' ? realCliHostLabels : realModelHostLabels
    store.coordination.labels = synthetic ? { ...defaultCoordinationStoreLabels } : { ...realModelStoreLabels }
    if (execution === 'cli') store.coordination.allowedProjects = Object.keys(options.cli!.projects)
    // 真实模型单回合延迟明显高于合成模型：前台与领域回合总时限放宽到 45s，合成模式保持默认。
    const turnTimeoutMs = synthetic ? undefined : 45_000
    // 真实模型偶发协议瑕疵：校验失败且未执行任何工具时允许修正一次；合成模式保持立即判负。
    const protocolCorrection = !synthetic
    const syntheticExecutor = () => new ScopedDomainExecutor(options.domainModel ?? options.model, synthetic
      ? defaultDomainSystemPrompt
      : { systemPrompt: realModelDomainSystemPrompt, turnTimeoutMs, noResultNote: '领域回合未提交结果', failureNote: '领域模型回合失败或超时；未执行真实项目', protocolCorrection })
    const executor = options.executor ?? (execution === 'cli'
      ? new RoutedDomainExecutor(syntheticExecutor(), new CliDomainExecutor({
          model: options.domainModel ?? options.model,
          backends: options.cli!.backends,
          projects: options.cli!.projects,
          turnTimeoutMs,
          onExecutionTrace: (run, info) => store.coordination.bindExecution(run.conversation_id, run.id, { ...info }),
        }))
      : syntheticExecutor())
    const memories = new AgentMemories(directory)
    const refreshCheckpoint = () => { host.checkpoint = previewCheckpoint(readOwnerContext(directory), wording, execution, memories.confirmed(), memories.tombstones()) }
    const host = new CoordinationHost(store.coordination, options.model, options.domainModel ?? options.model,
      executor,
      () => {
      for (const [c, bus] of buses) for (const m of store.coordination.history(c)) if (!emitted.has(m.id)) { emitted.add(m.id); bus.publish({ type: m.author === 'user' ? 'submitted' : 'reply', message: { ...m, createdAt: m.created_at } }) }
    }, hostLabels, turnTimeoutMs, protocolCorrection, execution === 'cli' ? Object.keys(options.cli!.projects) : undefined,
      {
        suggest: (fact, sourceEvent) => memories.suggest(fact, sourceEvent),
        read: () => memories.active().map(m => ({ id: m.id, fact: m.fact, status: m.status, sourceEvent: m.sourceEvent, updatedAt: m.updatedAt })),
        manage: (action, id, newFact, operationId, sourceEvent) => {
          const result = action === 'confirm' ? memories.confirm(id) : action === 'correct' ? memories.correct(id, newFact!, operationId, sourceEvent) : memories.forget(id)
          refreshCheckpoint()
          return result
        },
      })
    refreshCheckpoint()
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
        if (route === '/api/conversations' && method === 'GET') { json(response, 200, { conversations: [{ id: 'main', pinned: true }, { id: 'fake-work', synthetic }] }); return true }
        if (route === '/api/owner-context') {
          if (method === 'GET') { json(response, 200, { content: readOwnerContext(directory) }); return true }
          if (method === 'PUT') {
            try {
              const body = await readJson(request)
              if (Object.keys(body).join() !== 'content' || typeof body.content !== 'string') throw new Error('Unexpected fields')
              saveOwnerContext(directory, body.content)
              refreshCheckpoint()
              json(response, 200, { saved: true })
            } catch { json(response, 400, { error: '主人上下文未接受：内容为空、过大或请求无效。' }) }
            return true
          }
          json(response, 405, { error: '方法不可用。' }); return true
        }
        if (route === '/api/memories') {
          if (method === 'GET') { json(response, 200, { memories: memories.list() }); return true }
          if (method === 'POST') {
            try {
              const body = await readJson(request)
              if (Object.keys(body).sort().join() !== 'action,id' || typeof body.id !== 'string') throw new Error('Unexpected fields')
              // forget 即界面"忘记/不再使用"：墓碑化，不物理删除；结果携带真实最终状态。
              const op = body.action === 'confirm' ? memories.confirm(body.id)
                : body.action === 'dismiss' ? memories.dismiss(body.id)
                : body.action === 'forget' ? memories.forget(body.id)
                : undefined
              if (!op) throw new Error('Invalid action')
              refreshCheckpoint()
              json(response, 200, { ok: true, applied: op.applied, record: op.record })
            } catch { json(response, 400, { error: '记忆操作未接受：记录不存在或状态无效。' }) }
            return true
          }
          json(response, 405, { error: '方法不可用。' }); return true
        }
        if (!['/api/history','/api/status','/api/events','/api/messages','/api/control','/api/recover','/api/clear'].includes(route)) return false
        const c = url.searchParams.get('conversation') ?? 'main', bus = buses.get(c)
        if (!bus) { json(response, 400, { error: '未知会话。' }); return true }
        if (route === '/api/clear') {
          if (method !== 'POST') { json(response, 405, { error: '方法不可用。' }); return true }
          if (host.status(c) !== 'idle') { json(response, 409, { error: '对话正在处理中，请等待完成后再清空。' }); return true }
          try { store.coordination.clearConversation(c); bus.publish({ type: 'cleared' }); json(response, 200, { cleared: true }) }
          catch { json(response, 409, { error: '对话正在处理中，请等待完成后再清空。' }) }
          return true
        }
        try {
          if (method === 'GET' && route === '/api/history') { const s = bus.snapshot(() => store.coordination.history(c).map(m => ({ ...m, createdAt: m.created_at }))); json(response, 200, { messages: s.value, cursor: s.cursor }); return true }
          if (method === 'GET' && route === '/api/status') { json(response, 200, { state: host.status(c), message: host.status(c) === 'blocked' ? (synthetic ? '模拟模型回合失败，请显式重试。' : '模型回合失败，请显式重试。') : undefined, synthetic, execution, assignments: store.coordination.assignments('fake-work').map(a => ({ id: a.id, status: a.status, version: a.version })), questions: store.coordination.questions('fake-work'), memorySuggestions: memories.pending().map(m => ({ id: m.id, fact: m.fact })) }); return true }
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
            json(response, 202, { accepted: true, synthetic }); return true
          }
          json(response, 405, { error: '方法不可用。' }); return true
        } catch { json(response, 400, { error: synthetic ? '模拟操作未接受：参数、来源或问题状态无效。' : '操作未接受：参数、来源或问题状态无效。' }); return true }
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
