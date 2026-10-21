import { it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliDomainExecutor, RoutedDomainExecutor, type CliBackendFactory } from '../src/agent/cli-domain-executor.js'
import type { AgentBackend, AgentRunResult, DetachedRunHandle } from '../src/backends/AgentBackend.js'
import { defaultArtifactPaths, spawnDetachedCommand } from '../src/backends/runCommand.js'
import { SQLiteMainInboxStore } from '../src/main/inbox.js'
import { CoordinationHost } from '../src/main/coordination/model-host.js'
import { FakeBackgroundScheduler, HeldFakeExecutor, type FakeExecutor } from '../src/main/coordination/fake.js'
import type { CliDecision, CliExecutionRecord, FakeReceipt, Run } from '../src/main/coordination/store.js'
import type { ScopedModel } from '../src/agent/scoped-protocol.js'

const cliRun = (decision: unknown, id = 'run-1', extraContext: Record<string, unknown> = {}): Run => ({
  id, assignment_id: 'a1', conversation_id: 'fake-work', project_key: 'sandbox', version: 1,
  input_version: 1, executor: 'CLI', context: JSON.stringify({ decision, ...extraContext }), status: 'running',
  started_at: '2026-10-20T00:00:00.000Z', ended_at: null, result: null,
}) as Run

const cliDecision = { action: 'cli-task', objective: '创建一个说明文件', scope: ['project'], project: 'sandbox', backend: 'kimi', completionCriteria: ['文件存在'] }

const judgeFinish: ScopedModel = { complete: async () => ({ content: null, tool_calls: [{ id: 'j1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ body: '任务完成：文件已创建' }) } }] }) }
const judgeAsk: ScopedModel = { complete: async () => ({ content: null, tool_calls: [{ id: 'j1', type: 'function', function: { name: 'ask', arguments: JSON.stringify({ body: '需要用户确认' }) } }] }) }

const fakeResult: AgentRunResult = { stdout: 'CLI 最终答复文本', stderr: '', exitCode: 0, durationMs: 12, sessionId: 'sess-1', warnings: [] }
const fakeExecution: CliExecutionRecord = {
  backend: 'kimi', pid: 4321, sessionId: 'sess-1', exitCode: 0, durationMs: 12,
  artifactStdoutPath: '/tmp/artifact-out', artifactStderrPath: '/tmp/artifact-err',
}

function fakeBackendFactory(spy: { prompt?: string; envExclude?: string[]; signals?: unknown[] }, result: AgentRunResult = fakeResult, hang = false): CliBackendFactory {
  return name => {
    if (name === 'unknown') throw new Error('unknown backend')
    return {
      name,
      run: async () => result,
      runDetached: (prompt, options) => {
        spy.prompt = prompt
        spy.envExclude = options.envExclude
        const handle: DetachedRunHandle = {
          pid: 4321,
          artifactStdoutPath: '/tmp/artifact-out',
          artifactStderrPath: '/tmp/artifact-err',
          done: hang ? new Promise(() => {}) : Promise.resolve(result),
          cancel: (signal: NodeJS.Signals | number = 'SIGTERM') => { (spy.signals ??= []).push(signal) },
        }
        return handle
      },
    }
  }
}

const projects = { sandbox: '/home/vinci/projects/agents-sandbox' }

const tempDirs: string[] = []
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true }) })
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-executor-'))
  tempDirs.push(dir)
  return dir
}

it('CLI 任务：护栏 prompt + 白名单路径 + envExclude，判读 finish 映射 completed，execution 留痕入回执', async () => {
  const spy: { prompt?: string; envExclude?: string[] } = {}
  const executor = new CliDomainExecutor({ model: judgeFinish, backends: fakeBackendFactory(spy), projects })
  const receipt = (await executor.execute(cliRun(cliDecision))) as FakeReceipt
  expect(receipt.kind).toBe('completed')
  expect(receipt.body).toBe('任务完成：文件已创建')
  expect(receipt.execution).toEqual(fakeExecution)
  expect(spy.prompt).toContain('创建一个说明文件')
  expect(spy.prompt).toContain('不要 push')
  expect(spy.prompt).toContain('.agent-artifacts/')
  expect(spy.prompt).not.toContain('/tmp/artifact-err') // stderr 路径不进模型/CLI 输入
  expect(spy.envExclude).toEqual(['DEEPSEEK_API_KEY', 'DOTENV_CONFIG_PATH'])
})

it('判读 ask 映射 waiting_input；CLI 非零退出如实进入判读摘要', async () => {
  const spy: { prompt?: string } = {}
  const executor = new CliDomainExecutor({ model: judgeAsk, backends: fakeBackendFactory(spy, { ...fakeResult, exitCode: 1 }), projects })
  const receipt = (await executor.execute(cliRun(cliDecision))) as FakeReceipt
  expect(receipt.kind).toBe('waiting_input')
  expect(receipt.body).toBe('需要用户确认')
  expect(receipt.execution).toEqual({ ...fakeExecution, exitCode: 1 })
})

it('白名单与 backend 在执行层再校验：名单外项目与未知 backend 直接 failed', async () => {
  const executor = new CliDomainExecutor({ model: judgeFinish, backends: fakeBackendFactory({}), projects })
  expect(await executor.execute(cliRun({ ...cliDecision, project: 'stock_data' }))).toEqual({ kind: 'failed', body: '项目不在白名单：stock_data' })
  expect(await executor.execute(cliRun({ ...cliDecision, backend: 'unknown' }))).toEqual({ kind: 'failed', body: '未知 backend：unknown' })
  expect(await executor.execute(cliRun({ action: 'fake-check', objective: 'x', scope: ['synthetic'], completionCriteria: ['y'] }))).toEqual({
    kind: 'failed', body: 'CLI 执行或判读失败：不是 CLI 任务 decision',
  })
})

it('超时预算：确认退出期间不释放，SIGTERM 无响应升级 SIGKILL 后判 failed', async () => {
  const spy: { signals?: unknown[] } = {}
  const executor = new CliDomainExecutor({ model: judgeFinish, backends: fakeBackendFactory(spy, fakeResult, true), projects, cliTimeoutMs: 20, cancelGraceMs: 20 })
  const receipt = (await executor.execute(cliRun(cliDecision))) as FakeReceipt
  expect(spy.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(receipt.kind).toBe('failed')
  expect(receipt.body).toContain('预算')
  expect(receipt.body).toContain('未确认')
  expect(receipt.execution?.cancelConfirmed).toBe(false)
})

it('stop 中断进行中的 CLI：确认进程退出后才返回 stopped 且不判读', async () => {
  const spy: { signals?: unknown[] } = {}
  const executor = new CliDomainExecutor({ model: judgeFinish, backends: fakeBackendFactory(spy, fakeResult, true), projects, cancelGraceMs: 20 })
  const pending = executor.execute(cliRun(cliDecision))
  await new Promise(resolve => setTimeout(resolve, 10))
  executor.stop('run-1')
  const receipt = await pending
  expect(receipt.kind).toBe('stopped')
  expect((receipt as { execution?: CliExecutionRecord }).execution?.cancelConfirmed).toBe(false)
  expect(spy.signals).toEqual(['SIGTERM', 'SIGKILL'])
})

function rawNodeBackend(script: string): AgentBackend {
  return {
    name: 'raw-node',
    run: async () => { throw new Error('unused') },
    runDetached: (_prompt, options): DetachedRunHandle => {
      const paths = defaultArtifactPaths(options.cwd, 'raw-node')
      const handle = spawnDetachedCommand({
        cmd: process.execPath, args: ['-e', script], cwd: options.cwd,
        artifactStdoutPath: paths.stdoutPath, artifactStderrPath: paths.stderrPath,
        envExclude: options.envExclude,
      })
      return {
        pid: handle.pid,
        artifactStdoutPath: handle.artifactStdoutPath,
        artifactStderrPath: handle.artifactStderrPath,
        done: handle.done.then(r => ({ ...r, sessionId: null, warnings: [] })),
        cancel: signal => handle.cancel(signal),
        groupAlive: () => handle.groupAlive(),
      }
    },
  }
}

it('取消覆盖进程组：忽略 SIGTERM 的父进程被 SIGKILL 终止，其派生的工作子进程也不会残留写文件', async () => {
  const dir = tempDir()
  const marker = join(dir, 'late-write.txt')
  // 父进程忽略 SIGTERM 并派生普通子进程（同进程组、不忽略信号），子进程 300ms 后写文件。
  // 旧实现只杀父进程：子进程残留并写出 marker；组信号实现下两个进程都不会留下写入。
  const grandchild = `setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'late')},300); setInterval(()=>{},1000)`
  const script = `process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'}); setInterval(()=>{},1000)`
  const traces: unknown[] = []
  const traced = new CliDomainExecutor({ model: judgeFinish, backends: () => rawNodeBackend(script), projects: { sandbox: dir }, cancelGraceMs: 120, onExecutionTrace: (_run, info) => traces.push(info) })
  const pending = traced.execute(cliRun(cliDecision))
  await new Promise(resolve => setTimeout(resolve, 50))
  traced.stop('run-1')
  const receipt = (await pending) as { kind: string; execution?: CliExecutionRecord }
  expect(receipt.kind).toBe('stopped')
  expect(receipt.execution?.cancelConfirmed).toBe(true)
  expect(receipt.execution?.pid).toBeGreaterThan(0)
  // 父进程与其派生的工作子进程都已终止：300ms 的残留写文件不会发生
  await new Promise(resolve => setTimeout(resolve, 400))
  expect(existsSync(marker)).toBe(false)
  expect(traces).toHaveLength(1)
  expect((traces[0] as { backend: string }).backend).toBe('kimi') // decision 请求的 backend 名
  expect(existsSync((traces[0] as { artifactStdoutPath: string }).artifactStdoutPath)).toBe(true)
}, 15000)

it('父进程响应 SIGTERM 退出后仍确认整组：忽略信号的子进程被补杀后才返回 stopped', async () => {
  const dir = tempDir()
  const marker = join(dir, 'grandchild-write.txt')
  // 父进程响应 SIGTERM 立即退出；派生的子进程忽略 SIGTERM、300ms 后写文件。
  // 只看父进程 done 的旧实现会立即返回 stopped 并释放占用，marker 随后被写出。
  const grandchild = `process.on('SIGTERM',()=>{}); setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'late')},300); setInterval(()=>{},1000)`
  const script = `process.on('SIGTERM',()=>process.exit(0)); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'}); setInterval(()=>{},1000)`
  const traced = new CliDomainExecutor({ model: judgeFinish, backends: () => rawNodeBackend(script), projects: { sandbox: dir }, cancelGraceMs: 120 })
  const pending = traced.execute(cliRun(cliDecision))
  await new Promise(resolve => setTimeout(resolve, 50))
  traced.stop('run-1')
  const receipt = (await pending) as { kind: string; execution?: CliExecutionRecord }
  expect(receipt.kind).toBe('stopped')
  expect(receipt.execution?.cancelConfirmed).toBe(true)
  // 子进程已被组 SIGKILL 补杀：300ms 的写文件不会发生
  await new Promise(resolve => setTimeout(resolve, 400))
  expect(existsSync(marker)).toBe(false)
}, 15000)

it('进程组无法清空（groupAlive 持续为真）：cancelConfirmed=false，交由调度层保留占用', async () => {
  const spy: { signals?: unknown[] } = {}
  const backend: CliBackendFactory = () => ({
    name: 'stuck-group',
    run: async () => fakeResult,
    runDetached: (): DetachedRunHandle => ({
      pid: 777,
      artifactStdoutPath: '/tmp/stuck-out',
      artifactStderrPath: '/tmp/stuck-err',
      done: new Promise(resolve => setTimeout(() => resolve(fakeResult), 30)),
      cancel: (signal: NodeJS.Signals | number = 'SIGTERM') => { (spy.signals ??= []).push(signal) },
      groupAlive: () => true,
    }),
  })
  const executor = new CliDomainExecutor({ model: judgeFinish, backends: backend, projects, cancelGraceMs: 30 })
  const pending = executor.execute(cliRun(cliDecision))
  await new Promise(resolve => setTimeout(resolve, 10))
  executor.stop('run-1')
  const receipt = (await pending) as { kind: string; execution?: CliExecutionRecord }
  expect(receipt.kind).toBe('stopped')
  expect(receipt.execution?.cancelConfirmed).toBe(false)
  expect(spy.signals).toEqual(['SIGTERM', 'SIGKILL'])
})

it('追问被回答后：续作 prompt 与判读摘要都带问答与前次回执，不盲重放原 prompt', async () => {
  const spy: { prompt?: string } = {}
  let judgeInput = ''
  const judge: ScopedModel = {
    complete: async messages => {
      judgeInput = String(messages[messages.length - 1]!.content)
      return { content: null, tool_calls: [{ id: 'j1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ body: '完成' }) } }] }
    },
  }
  const executor = new CliDomainExecutor({ model: judge, backends: fakeBackendFactory(spy), projects })
  await executor.execute(cliRun(cliDecision))
  const firstPrompt = spy.prompt!
  const resumed = cliRun(cliDecision, 'run-2', {
    answers: [{
      questionId: 'q1', runId: 'run-1', question: '用哪个文件名？', answer: '用 ANSWER-MARKER.md',
      priorResult: {
        kind: 'waiting_input', body: '用哪个文件名？',
        execution: {
          backend: 'kimi', sessionId: 's0', exitCode: 0, durationMs: 9,
          artifactStdoutPath: '/tmp/prior-out', artifactStderrPath: '/tmp/PRIOR-STDERR-SECRET',
        },
      },
    }],
  })
  await executor.execute(resumed)
  expect(spy.prompt).not.toBe(firstPrompt)
  expect(spy.prompt).toContain('续作上下文')
  expect(spy.prompt).toContain('ANSWER-MARKER.md')
  expect(spy.prompt).toContain('用哪个文件名？')
  expect(spy.prompt).toContain('/tmp/prior-out')
  expect(judgeInput).toContain('ANSWER-MARKER.md')
  // 存储里的完整 execution 原样保留，但 stderr 路径等内部字段不透给 CLI 与判读模型
  expect(spy.prompt).not.toContain('PRIOR-STDERR-SECRET')
  expect(judgeInput).not.toContain('PRIOR-STDERR-SECRET')
  expect(judgeInput).toContain('/tmp/prior-out')
})

it('判读抛错：failed 回执仍带完整 execution，且判读前已补绑完整留痕', async () => {
  const judgeThrows: ScopedModel = { complete: async () => { throw new Error('judge exploded') } }
  const traces: unknown[] = []
  const executor = new CliDomainExecutor({ model: judgeThrows, backends: fakeBackendFactory({}), projects, onExecutionTrace: (_run, info) => traces.push(info) })
  const receipt = (await executor.execute(cliRun(cliDecision))) as FakeReceipt
  expect(receipt.kind).toBe('failed')
  expect(receipt.body).toContain('judge exploded')
  expect(receipt.execution).toEqual(fakeExecution)
  // 启动绑定一次、判读前补绑一次（含 sessionId/退出码）
  expect(traces).toHaveLength(2)
  expect((traces[1] as CliExecutionRecord).sessionId).toBe('sess-1')
  expect((traces[1] as CliExecutionRecord).exitCode).toBe(0)
})

it('路由执行器：cli-task 走 CLI、fake-check 走合成，stop 广播两侧', async () => {
  const calls: string[] = []
  const synthetic = { identity: 'FAKE' as const, execute: async () => { calls.push('synthetic'); return { kind: 'completed' as const, body: 'synthetic done' } }, stop: (id: string) => { calls.push(`stop-synthetic:${id}`) } }
  const cli = new CliDomainExecutor({ model: judgeFinish, backends: fakeBackendFactory({}), projects })
  const routed = new RoutedDomainExecutor(synthetic, cli)
  expect((await routed.execute(cliRun(cliDecision, 'run-cli'))).kind).toBe('completed')
  const syntheticRun = cliRun({ action: 'fake-check', objective: 'x', scope: ['synthetic'], completionCriteria: ['y'] }, 'run-fake')
  expect((await routed.execute(syntheticRun)).kind).toBe('completed')
  expect(calls).toEqual(['synthetic'])
  routed.stop('run-1')
  expect(calls).toContain('stop-synthetic:run-1')
})

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

function admitCliTask(s: SQLiteMainInboxStore['coordination'], key: string): { assignmentId: string; run: Run } {
  s.allowedProjects = ['sandbox']
  const cli: CliDecision = { action: 'cli-task', objective: '检查沙箱', scope: ['project'], project: 'sandbox', backend: 'kimi', completionCriteria: ['有结论'] }
  const input = s.admit('main', key, '请检查 sandbox')
  const accepted = s.accept('main', input.event.id, cli)
  const run = s.claim('fake-work')!
  return { assignmentId: accepted.assignmentId, run }
}

it('store：cli-task 白名单校验、真实 project_key 与 CLI run 记录，形状伪造被拒', () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } })
  const s = owner.coordination
  try {
    const cli: CliDecision = { action: 'cli-task', objective: '检查沙箱', scope: ['project'], project: 'sandbox', backend: 'kimi', completionCriteria: ['有结论'] }
    const first = s.admit('main', 'cli-1', '请检查 sandbox')
    expect(() => s.accept('main', first.event.id, cli)).toThrow(/whitelist/i)
    s.allowedProjects = ['sandbox']
    const accepted = s.accept('main', first.event.id, cli)
    const assignment = s.assignments('fake-work').find(a => a.id === accepted.assignmentId)!
    expect(assignment.project_key).toBe('sandbox')
    const run = s.claim('fake-work')!
    expect(run.executor).toBe('CLI')
    expect(run.project_key).toBe('sandbox')

    const second = s.admit('main', 'cli-2', '再来一个')
    expect(() => s.accept('main', second.event.id, { ...cli, backend: 'unknown' })).toThrow(/Backend/)
    const third = s.admit('main', 'cli-3', '伪造形状')
    expect(() => s.accept('main', third.event.id, { ...cli, extra: 'x' } as never)).toThrow(/shape/)
    const fourth = s.admit('main', 'syn-1', '合成检查')
    const synthetic = s.accept('main', fourth.event.id, { action: 'fake-check', objective: '合成', scope: ['synthetic'], completionCriteria: ['样本'] })
    const synAssignment = s.assignments('fake-work').find(a => a.id === synthetic.assignmentId)!
    expect(synAssignment.project_key).toBe('FAKE-project')
    // CLI run 活跃时同项目串行；合成项目不受影响
    expect(s.claim('fake-work')!.project_key).toBe('FAKE-project')
  } finally {
    owner.close()
  }
})

it('store：执行留痕先绑定 pid/产物、receipt 补全退出信息并持久化进 run.result', () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } })
  const s = owner.coordination
  try {
    const { run } = admitCliTask(s, 'trace-1')
    s.bindExecution('fake-work', run.id, { backend: 'kimi', pid: 99, artifactStdoutPath: '/a/out', artifactStderrPath: '/a/err' })
    const bound = JSON.parse(s.runs('fake-work').find(r => r.id === run.id)!.context) as { execution: { pid: number; artifactStderrPath: string } }
    expect(bound.execution.pid).toBe(99)
    expect(bound.execution.artifactStderrPath).toBe('/a/err')
    const accepted = s.receipt('fake-work', run.id, { kind: 'completed', body: '完成', execution: fakeExecution })
    expect(accepted.accepted).toBe(true)
    const result = JSON.parse(s.runs('fake-work').find(r => r.id === run.id)!.result!) as { kind: string; execution: CliExecutionRecord }
    expect(result.kind).toBe('completed')
    expect(result.execution).toEqual(fakeExecution)
  } finally {
    owner.close()
  }
})

it('store：confirmStopped 持久化取消执行留痕', () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } })
  const s = owner.coordination
  try {
    const { assignmentId, run } = admitCliTask(s, 'trace-2')
    s.cancel('fake-work', assignmentId)
    s.confirmStopped('fake-work', run.id, { ...fakeExecution, exitCode: 143, cancelConfirmed: true })
    const cancelled = s.runs('fake-work').find(r => r.id === run.id)!
    expect(cancelled.status).toBe('cancelled')
    const result = JSON.parse(cancelled.result!) as { kind: string; execution: CliExecutionRecord }
    expect(result.kind).toBe('cancelled')
    expect(result.execution.cancelConfirmed).toBe(true)
  } finally {
    owner.close()
  }
})

it('scheduler：退出未确认时 run 保持占用、assignment 失败，recover 后才放行同项目', async () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } })
  const s = owner.coordination
  try {
    s.allowedProjects = ['sandbox']
    const cli: CliDecision = { action: 'cli-task', objective: '检查沙箱', scope: ['project'], project: 'sandbox', backend: 'kimi', completionCriteria: ['有结论'] }
    // 执行器返回 stopped 但进程退出未确认（cancelConfirmed=false）
    const executor: FakeExecutor = { identity: 'CLI', execute: async () => ({ kind: 'stopped', execution: { ...fakeExecution, cancelConfirmed: false } }) }
    const scheduler = new FakeBackgroundScheduler(s, executor)
    const first = s.admit('main', 'hold-1', '任务一')
    s.accept('main', first.event.id, cli)
    const run = scheduler.startNext('fake-work')!
    await waitFor(() => s.assignments('fake-work')[0]?.status === 'failed')
    const held = s.runs('fake-work').find(r => r.id === run.id)!
    // run 不终结：唯一索引继续占用 sandbox，result 记录未确认留痕
    expect(['starting', 'running', 'cancel_requested']).toContain(held.status)
    expect((JSON.parse(held.result!) as { kind: string }).kind).toBe('uncertain-exit')
    // 同项目第二个任务不能启动，合成项目不受影响
    const second = s.admit('main', 'hold-2', '任务二')
    s.accept('main', second.event.id, cli)
    expect(scheduler.startNext('fake-work')).toBeUndefined()
    // worker 重启走既有 recover：滞留 run 恢复为 unknown/interrupted，同项目放行
    expect(s.recover('fake-work')).toBe(1)
    expect(s.runs('fake-work').find(r => r.id === run.id)!.status).toBe('unknown')
    expect(scheduler.startNext('fake-work')).toBeTruthy()
  } finally {
    owner.close()
  }
})

it('store：回答把追问 run 的既有回执（含执行留痕）绑进续作 context', () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } })
  const s = owner.coordination
  try {
    const { assignmentId, run } = admitCliTask(s, 'trace-3')
    s.receipt('fake-work', run.id, { kind: 'waiting_input', body: '用哪个文件名？', execution: fakeExecution })
    const question = s.questions('fake-work').find(q => q.assignment_id === assignmentId)!
    const answerInput = s.admit('main', 'ans-1', '用 ANSWER.md')
    s.answer('fake-work', question.id, 'main', answerInput.event.id)
    const assignment = s.assignments('fake-work').find(a => a.id === assignmentId)!
    const answers = (JSON.parse(assignment.context) as { answers: { answer: string; runId: string; priorResult: unknown }[] }).answers
    expect(answers).toHaveLength(1)
    expect(answers[0]!.answer).toBe('用 ANSWER.md')
    expect(answers[0]!.runId).toBe(run.id)
    expect(answers[0]!.priorResult).toEqual({ kind: 'waiting_input', body: '用哪个文件名？', execution: fakeExecution })
  } finally {
    owner.close()
  }
})

it('host：注入白名单后模型可用 delegate_cli 工具创建真实任务', async () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } })
  const s = owner.coordination
  s.allowedProjects = ['sandbox']
  const delegateCli: ScopedModel = { complete: async () => ({ content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'delegate_cli', arguments: JSON.stringify({ project: 'sandbox', backend: 'kimi', objective: '真实任务', completionCriteria: ['完成'] }) } }] }) }
  const textModel: ScopedModel = { complete: async () => ({ content: 'ok' }) }
  const host = new CoordinationHost(s, delegateCli, textModel, new HeldFakeExecutor(), () => {}, undefined, undefined, false, ['sandbox'])
  try {
    s.admit('main', 'host-cli-1', '请在 sandbox 里做个真实任务')
    host.start()
    await waitFor(() => s.assignments('fake-work').length === 1)
    const assignment = s.assignments('fake-work')[0]!
    expect(JSON.parse(assignment.decision).action).toBe('cli-task')
    expect(assignment.project_key).toBe('sandbox')
  } finally {
    await host.close()
    owner.close()
  }
})

it('host：未注入白名单时不存在 delegate_cli 工具', async () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } })
  const s = owner.coordination
  let seenTools: string[] = []
  const spy: ScopedModel = { complete: async (_m, tools) => { seenTools = tools.map(t => t.function.name); return { content: 'plain' } } }
  const host = new CoordinationHost(s, spy, spy, new HeldFakeExecutor())
  try {
    s.admit('main', 'host-no-cli', '你好')
    host.start()
    await waitFor(() => s.history('main').some(m => m.content === 'plain'))
    expect(seenTools).not.toContain('delegate_cli')
  } finally {
    await host.close()
    owner.close()
  }
})

it('commit 拒绝（白名单/Backend 校验）同样给一次有界修正，事务回滚不产生重复任务', async () => {
  const owner = new SQLiteMainInboxStore(':memory:', { coordination: { mode: 'preview-fresh' } })
  const s = owner.coordination
  s.allowedProjects = ['sandbox']
  let calls = 0
  const model: ScopedModel = { complete: async () => ++calls === 1
    ? { content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'delegate_cli', arguments: JSON.stringify({ project: 'sandbox', backend: 'claude-code', objective: '任务', completionCriteria: ['完成'] }) } }] }
    : { content: null, tool_calls: [{ id: 'd2', type: 'function', function: { name: 'delegate_cli', arguments: JSON.stringify({ project: 'sandbox', backend: 'kimi', objective: '任务', completionCriteria: ['完成'] }) } }] } }
  const host = new CoordinationHost(s, model, { complete: async () => ({ content: 'ok' }) }, new HeldFakeExecutor(), () => {}, undefined, undefined, true, ['sandbox'])
  try {
    const input = s.admit('main', 'commit-correct-1', '请在 sandbox 委派真实任务')
    host.start()
    await waitFor(() => s.assignments('fake-work').length === 1)
    expect(calls).toBe(2)
    expect(s.assignments('fake-work')).toHaveLength(1)
    const state = s.protocol<{ corrections?: number; rejected?: unknown[]; failure?: unknown }>({ conversation: 'main', event: input.event, context: [] })!
    expect(state.corrections).toBe(1)
    expect(state.rejected).toHaveLength(1)
    expect(state.failure).toBeUndefined()
  } finally {
    await host.close()
    owner.close()
  }
})
