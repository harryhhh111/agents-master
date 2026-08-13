import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type OpenAI from 'openai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore, type AgentEvent } from '../src/agent/loop.js'
import { executeTool, type ToolContext } from '../src/agent/tools.js'
import type { AgentBackend, DetachedRunHandle } from '../src/backends/AgentBackend.js'
import type { Config } from '../src/config.js'
import { SessionReader } from '../src/sessions/reader.js'
import { Ledger } from '../src/state/ledger.js'
import { PinStore } from '../src/state/pins.js'
import { RunRegistry } from '../src/state/runs.js'

// 不接真 API、不跑真 CLI：LLM 用脚本化假响应，backend 用假句柄，文件系统用临时目录。

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-m3-'))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

function testConfig(): Config {
  return {
    llm: { base_url: 'https://fake.example', model: 'fake-model' },
    delegation: { level: 'supervised' },
    projects: [{ name: 'proj', path: tmp }],
    backends: { codex: { sandbox_mode: 'workspace-write' }, kimi: {} },
  }
}

interface FakeReply {
  content?: string | null
  toolCalls?: Array<{ id: string; name: string; args: string }>
}

/** 脚本化假 LLM：按队列依次返回响应，记录每次请求的 messages */
function fakeLlm(replies: Array<FakeReply | (() => FakeReply)>) {
  const calls: OpenAI.Chat.ChatCompletionCreateParams[] = []
  const client = {
    chat: {
      completions: {
        create: async (req: OpenAI.Chat.ChatCompletionCreateParams) => {
          calls.push(structuredClone(req))
          const entry = replies.shift()
          const reply = typeof entry === 'function' ? entry() : entry
          if (!reply) throw new Error('假 LLM 的响应队列已空')
          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: reply.content ?? null,
                  tool_calls: reply.toolCalls?.map(t => ({
                    id: t.id,
                    type: 'function',
                    function: { name: t.name, arguments: t.args },
                  })),
                },
              },
            ],
          }
        },
      },
    },
  }
  return { client: client as unknown as OpenAI, calls }
}

function fakeBackend(name: string, sessionId: string | null, artifactDir: string): AgentBackend {
  const stdoutPath = path.join(artifactDir, `${name}-stdout.log`)
  const stderrPath = path.join(artifactDir, `${name}-stderr.log`)
  return {
    name,
    run: async () => {
      throw new Error('测试只用 runDetached')
    },
    runDetached: (): DetachedRunHandle => ({
      pid: 4321,
      artifactStdoutPath: stdoutPath,
      artifactStderrPath: stderrPath,
      done: Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 7,
        sessionId,
        warnings: [],
      }),
      cancel: () => {},
    }),
  }
}

function makeToolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectName: 'proj',
    projectPath: tmp,
    stateDir: tmp,
    memoryDir: tmp,
    backends: {
      kimi: fakeBackend('kimi', null, tmp),
      codex: fakeBackend('codex', null, tmp),
    },
    runs: new RunRegistry(),
    pins: new PinStore(tmp),
    ledger: new Ledger(tmp),
    reader: new SessionReader(tmp),
    askUser: async () => '',
    ...overrides,
  }
}

/** 等 done 回调链（钉 sessionId、记 prompt）跑完 */
async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 20))
}

describe('AgentCore loop', () => {
  it('tool_calls → 工具分发 → 事件流 → 纯文本收尾', async () => {
    const { client, calls } = fakeLlm([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'update_ledger',
            args: JSON.stringify({
              direction: 'user->kimi',
              kind: 'task_assignment',
              summary: '派活：摸底项目',
              anchors: ['docs/plan.md'],
            }),
          },
        ],
      },
      { content: '已派活并记账' },
    ])
    const events: AgentEvent[] = []
    const core = new AgentCore({
      config: testConfig(),
      projectName: 'proj',
      llm: client,
      stateDir: tmp,
      backends: {
        kimi: fakeBackend('kimi', null, tmp),
        codex: fakeBackend('codex', null, tmp),
      },
      askUser: async () => '',
      onEvent: e => events.push(e),
    })

    await core.handleUserMessage('给 kimi 派个活')

    // 事件流：tool_start → tool_end(ok) → text，无 error
    expect(events.map(e => e.type)).toEqual(['tool_start', 'tool_end', 'text'])
    expect(events[0]).toMatchObject({ name: 'update_ledger' })
    expect(events[1]).toMatchObject({ name: 'update_ledger', ok: true })
    expect(events[2]).toMatchObject({ text: '已派活并记账' })

    // 第二次 LLM 请求里带着 role=tool 的结果
    const toolMsgs = (calls[1]!.messages as Array<{ role: string; content?: unknown }>).filter(
      m => m.role === 'tool',
    )
    expect(toolMsgs).toHaveLength(1)
    expect(String(toolMsgs[0]!.content)).toContain('已记录到台账')

    // 台账真的落盘了
    const ledger = await fs.readFile(path.join(tmp, 'ledger.jsonl'), 'utf8')
    const entry = JSON.parse(ledger.trim())
    expect(entry).toMatchObject({
      direction: 'user->kimi',
      kind: 'task_assignment',
      summary: '派活：摸底项目',
      anchors: ['docs/plan.md'],
    })
    expect(typeof entry.ts).toBe('string')
  })

  it('ask_user 触发 ask 事件并把用户回答回给模型', async () => {
    const { client, calls } = fakeLlm([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'ask_user',
            args: JSON.stringify({ question: '验收不通过，退回返工？', context: 'codex 报了 3 个 issue' }),
          },
        ],
      },
      { content: '好的，退回返工' },
    ])
    const events: AgentEvent[] = []
    const core = new AgentCore({
      config: testConfig(),
      projectName: 'proj',
      llm: client,
      stateDir: tmp,
      backends: {
        kimi: fakeBackend('kimi', null, tmp),
        codex: fakeBackend('codex', null, tmp),
      },
      askUser: async () => '退回返工',
      onEvent: e => events.push(e),
    })

    await core.handleUserMessage('看看验收结果')

    const askEvent = events.find(e => e.type === 'ask')
    expect(askEvent).toMatchObject({ question: '验收不通过，退回返工？', context: 'codex 报了 3 个 issue' })
    const toolMsgs = (calls[1]!.messages as Array<{ role: string; content?: unknown }>).filter(
      m => m.role === 'tool',
    )
    expect(String(toolMsgs[0]!.content)).toBe('退回返工')
  })

  it('单条 tool 结果超过 8000 字符被截断并注明全文路径', async () => {
    const bigFile = path.join(tmp, 'big.log')
    await fs.writeFile(bigFile, 'x'.repeat(12000))
    const { client, calls } = fakeLlm([
      {
        toolCalls: [
          { id: 'c1', name: 'read_artifact', args: JSON.stringify({ path: bigFile, tail: 5 }) },
        ],
      },
      { content: '读完了' },
    ])
    const core = new AgentCore({
      config: testConfig(),
      projectName: 'proj',
      llm: client,
      stateDir: tmp,
      backends: {
        kimi: fakeBackend('kimi', null, tmp),
        codex: fakeBackend('codex', null, tmp),
      },
      askUser: async () => '',
      onEvent: () => {},
    })

    await core.handleUserMessage('读一下那个大文件')

    const toolMsgs = (calls[1]!.messages as Array<{ role: string; content?: string }>).filter(
      m => m.role === 'tool',
    )
    const content = toolMsgs[0]!.content!
    expect(content.length).toBeLessThan(8500)
    expect(content).toContain(`已截断，全文在 ${bigFile}`)
  })

  it('工具执行出错作为 tool 结果回给模型，循环不崩', async () => {
    const { client } = fakeLlm([
      { toolCalls: [{ id: 'c1', name: 'read_artifact', args: JSON.stringify({ path: path.join(tmp, '不存在.log') }) }] },
      { content: '文件不存在，算了' },
    ])
    const events: AgentEvent[] = []
    const core = new AgentCore({
      config: testConfig(),
      projectName: 'proj',
      llm: client,
      stateDir: tmp,
      backends: {
        kimi: fakeBackend('kimi', null, tmp),
        codex: fakeBackend('codex', null, tmp),
      },
      askUser: async () => '',
      onEvent: e => events.push(e),
    })

    await core.handleUserMessage('读一个不存在的文件')

    const toolEnd = events.find(e => e.type === 'tool_end')
    expect(toolEnd).toMatchObject({ name: 'read_artifact', ok: false })
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'text', text: '文件不存在，算了' })
  })
})

describe('run_kimi / check_run', () => {
  it('runDetached 返回 runId/pid/artifact，done 后钉住 sessionId 并记录代发 prompt', async () => {
    const ctx = makeToolCtx({
      backends: {
        kimi: fakeBackend('kimi', 'sess-kimi-1', tmp),
        codex: fakeBackend('codex', null, tmp),
      },
    })
    await fs.writeFile(path.join(tmp, 'kimi-stdout.log'), 'line1\nline2\n')

    const started = await executeTool(ctx, 'run_kimi', JSON.stringify({ prompt: '请摸底项目' }))
    const startInfo = JSON.parse(started.text)
    expect(startInfo).toMatchObject({
      pid: 4321,
      artifactStdoutPath: path.join(tmp, 'kimi-stdout.log'),
      resumedSession: null,
    })
    expect(typeof startInfo.runId).toBe('string')

    await flush()
    // done 回收：sessionId 钉住 + prompt 记录
    expect(await ctx.pins.getPin('proj', 'kimi')).toEqual({
      sessionId: 'sess-kimi-1',
      sessionFile: null,
    })
    expect(await ctx.pins.getSentPrompts('sess-kimi-1')).toEqual(['请摸底项目'])

    const checked = await executeTool(ctx, 'check_run', JSON.stringify({ runId: startInfo.runId }))
    const info = JSON.parse(checked.text)
    expect(info).toMatchObject({ status: 'done', exitCode: 0, durationMs: 7, sessionId: 'sess-kimi-1' })
    expect(info.artifactTail).toContain('line2')
  })

  it('check_run 对未知 runId 返回错误文本而不是抛异常', async () => {
    const ctx = makeToolCtx()
    const res = await executeTool(ctx, 'check_run', JSON.stringify({ runId: 'nope' }))
    expect(res.text).toContain('未知 runId')
  })
})

describe('read_session_updates 的 human/agent 标注', () => {
  it('agent 代发精确匹配标 origin=agent，其余标 human，后台通知标 notification', async () => {
    const wireFile = path.join(tmp, 'wire.jsonl')
    const lines = [
      // agent 代发的任务（文本与代发记录精确一致）
      JSON.stringify({
        type: 'turn.prompt',
        origin: { kind: 'user' },
        time: 1,
        input: [{ type: 'text', text: '请摸底项目' }],
      }),
      // 用户亲自在 tmux 里插话
      JSON.stringify({
        type: 'turn.prompt',
        origin: { kind: 'user' },
        time: 2,
        input: [{ type: 'text', text: '先别动，我来改一下配置' }],
      }),
      // 后台任务通知（turn.steer + <notification 开头）
      JSON.stringify({
        type: 'turn.steer',
        origin: { kind: 'background_task' },
        time: 3,
        input: [{ type: 'text', text: '<notification task finished>' }],
      }),
      // assistant 输出
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 4,
        event: { type: 'content.part', uuid: 'u1', part: { type: 'text', text: '收到，开始摸底' } },
      }),
    ]
    await fs.writeFile(wireFile, lines.join('\n') + '\n')

    const pins = new PinStore(tmp)
    await pins.setPin('proj', 'kimi', { sessionId: 'sess-kimi-1', sessionFile: wireFile })
    await pins.recordSentPrompt('sess-kimi-1', '请摸底项目')

    const ctx = makeToolCtx({ pins })
    const res = await executeTool(ctx, 'read_session_updates', JSON.stringify({ cli: 'kimi' }))
    const data = JSON.parse(res.text)

    expect(data.sessionFile).toBe(wireFile)
    expect(data.messages).toEqual([
      { ts: 1, who: 'user', text: '请摸底项目', origin: 'agent' },
      { ts: 2, who: 'user', text: '先别动，我来改一下配置', origin: 'human' },
      { ts: 3, who: 'user', kind: 'notification', text: '<notification task finished>' },
      { ts: 4, who: 'assistant', text: '收到，开始摸底' },
    ])

    // 幂等：再读一次没有新消息
    const again = await executeTool(ctx, 'read_session_updates', JSON.stringify({ cli: 'kimi' }))
    expect(JSON.parse(again.text).messages).toEqual([])
  })

  it('找不到 session 文件时返回说明文本而不是抛异常', async () => {
    const ctx = makeToolCtx() // 无 pin，discovery 在临时 home 下也找不到
    const res = await executeTool(ctx, 'read_session_updates', JSON.stringify({ cli: 'codex' }))
    expect(res.text).toContain('未找到 codex 的 session 文件')
  })
})

describe('ledger', () => {
  it('update_ledger 追加 jsonl，多条累计', async () => {
    const ctx = makeToolCtx()
    await executeTool(
      ctx,
      'update_ledger',
      JSON.stringify({ direction: 'user->codex', kind: 'task_assignment', summary: '第一条' }),
    )
    await executeTool(
      ctx,
      'update_ledger',
      JSON.stringify({
        direction: 'kimi->user',
        kind: 'completion_report',
        summary: '第二条',
        pending: ['是否送审'],
      }),
    )
    const lines = (await fs.readFile(path.join(tmp, 'ledger.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ direction: 'user->codex', summary: '第一条' })
    expect(JSON.parse(lines[1]!)).toMatchObject({ pending: ['是否送审'] })
  })
})

describe('run 完成自动注入', () => {
  it('回合结束后 run 完成 → 注入通知并叫醒新回合', async () => {
    let resolveDone!: (r: import('../src/backends/AgentBackend.js').AgentRunResult) => void
    const donePromise = new Promise<import('../src/backends/AgentBackend.js').AgentRunResult>(
      res => {
        resolveDone = res
      },
    )
    const deferredBackend: AgentBackend = {
      name: 'kimi',
      run: async () => {
        throw new Error('测试只用 runDetached')
      },
      runDetached: (): DetachedRunHandle => ({
        pid: 9999,
        artifactStdoutPath: path.join(tmp, 'deferred-stdout.log'),
        artifactStderrPath: path.join(tmp, 'deferred-stderr.log'),
        done: donePromise,
        cancel: () => {},
      }),
    }
    const { client, calls } = fakeLlm([
      { toolCalls: [{ id: 't1', name: 'run_kimi', args: JSON.stringify({ prompt: '干活' }) }] },
      { content: '已派活，等完成通知' },
      { content: '收到完成通知，验收通过' },
    ])
    const events: AgentEvent[] = []
    const core = new AgentCore({
      config: testConfig(),
      projectName: 'proj',
      llm: client,
      backends: { kimi: deferredBackend, codex: deferredBackend },
      stateDir: tmp,
      askUser: async () => 'ok',
      onEvent: e => events.push(e),
    })

    await core.handleUserMessage('派活给 kimi')
    expect(calls).toHaveLength(2) // 第一回合正常结束，此时 run 还没完成

    resolveDone({ stdout: '', stderr: '', exitCode: 0, durationMs: 5, sessionId: 's1', warnings: [] })

    await vi.waitFor(() => expect(calls).toHaveLength(3))
    const thirdCallMessages = calls[2]!.messages as Array<{ role: string; content?: unknown }>
    const notice = thirdCallMessages.find(
      m => m.role === 'user' && String(m.content).includes('[后台任务完成]'),
    )
    expect(notice).toBeTruthy()
    expect(events.some(e => e.type === 'run_done')).toBe(true)
    expect(events.some(e => e.type === 'text' && e.text.includes('验收通过'))).toBe(true)
  })
})

describe('run 完成注入的消息顺序安全性', () => {
  it('check_run 等待期间 run 完成 → 通知排在 tool 响应之后，不破坏 tool_calls 配对', async () => {
    let resolveDone!: (r: import('../src/backends/AgentBackend.js').AgentRunResult) => void
    const donePromise = new Promise<import('../src/backends/AgentBackend.js').AgentRunResult>(
      res => {
        resolveDone = res
      },
    )
    const deferredBackend: AgentBackend = {
      name: 'kimi',
      run: async () => {
        throw new Error('测试只用 runDetached')
      },
      runDetached: (): DetachedRunHandle => ({
        pid: 8888,
        artifactStdoutPath: path.join(tmp, 'mid-stdout.log'),
        artifactStderrPath: path.join(tmp, 'mid-stderr.log'),
        done: donePromise,
        cancel: () => {},
      }),
    }
    let core!: AgentCore
    const { client, calls } = fakeLlm([
      { toolCalls: [{ id: 't1', name: 'run_kimi', args: JSON.stringify({ prompt: '干活' }) }] },
      () => ({
        toolCalls: [
          {
            id: 't2',
            name: 'check_run',
            args: JSON.stringify({ runId: core.context.runs.list()[0]!.runId }),
          },
        ],
      }),
      { content: '验收通过' },
    ])
    const events: AgentEvent[] = []
    core = new AgentCore({
      config: testConfig(),
      projectName: 'proj',
      llm: client,
      backends: { kimi: deferredBackend, codex: deferredBackend },
      stateDir: tmp,
      askUser: async () => 'ok',
      onEvent: e => events.push(e),
    })

    const turn = core.handleUserMessage('派活给 kimi 并等它完成')
    // 等到第二轮 LLM 已请求（check_run 工具正在 await done），再让 run 完成
    await vi.waitFor(() => expect(calls.length).toBe(2))
    resolveDone({ stdout: '', stderr: '', exitCode: 0, durationMs: 5, sessionId: 's2', warnings: [] })
    await turn

    expect(calls).toHaveLength(3)
    expect(events.filter(e => e.type === 'error')).toEqual([])
    const msgs = calls[2]!.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>
    const toolIdx = msgs.findIndex(m => m.role === 'tool' && m.tool_call_id === 't2')
    const noticeIdx = msgs.findIndex(
      m => m.role === 'user' && String(m.content).includes('[后台任务完成]'),
    )
    expect(toolIdx).toBeGreaterThan(-1)
    expect(noticeIdx).toBeGreaterThan(toolIdx) // 通知必须在 tool 响应之后
  })
})
