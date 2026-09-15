import { promises as fs } from 'node:fs'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { defaultArtifactPaths, LineFilteringTransform, spawnDetachedCommand } from '../src/backends/runCommand.js'
import { extractKimiAssistantText, extractKimiSessionId } from '../src/backends/KimiBackend.js'
import { extractLastMessageFromJsonl, extractSessionIdFromJsonl } from '../src/backends/CodexBackend.js'
import {
  buildClaudeCommand,
  ClaudeBackend,
  ClaudeStreamJsonParser,
  extractClaudeAssistantText,
  extractClaudeSessionId,
  resolveClaudeBinary,
} from '../src/backends/ClaudeBackend.js'

// ---- Kimi: session id 提取 ----

describe('extractKimiSessionId', () => {
  it('正常格式：从 meta/session.resume_hint 事件提取 session id', () => {
    const stdout = [
      JSON.stringify({ role: 'assistant', content: 'hello' }),
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'sess-abc-123' }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractKimiSessionId(stdout, warnings)).toBe('sess-abc-123')
    expect(warnings).toEqual([])
  })

  it('格式变动：没有 resume_hint 事件时返回 null 并产生 warning（列出实际事件）', () => {
    // 模拟上游改了事件名 / 结构的输出
    const stdout = [
      JSON.stringify({ role: 'meta', type: 'session.started', id: 'sess-xyz' }),
      JSON.stringify({ role: 'assistant', content: 'working...' }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractKimiSessionId(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('session id 提取失败')
    expect(warnings[0]).toContain('meta/session.started')
    expect(warnings[0]).toContain('assistant/?')
  })

  it('缺字段：resume_hint 存在但没有 session_id 时返回 null 并告警', () => {
    const stdout = JSON.stringify({ role: 'meta', type: 'session.resume_hint' })
    const warnings: string[] = []
    expect(extractKimiSessionId(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('meta/session.resume_hint')
  })

  it('跳过空行和非法 JSON 行', () => {
    const stdout = [
      '',
      'not json at all',
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 's1' }),
    ].join('\n')
    expect(extractKimiSessionId(stdout)).toBe('s1')
  })
})

// ---- Kimi: assistant 文本提取 ----

describe('extractKimiAssistantText', () => {
  it('收集所有 role=assistant 的字符串 content', () => {
    const stdout = [
      JSON.stringify({ role: 'assistant', content: '第一段' }),
      JSON.stringify({ role: 'user', content: '忽略我' }),
      JSON.stringify({ role: 'assistant', content: '第二段' }),
    ].join('\n')
    expect(extractKimiAssistantText(stdout)).toEqual(['第一段', '第二段'])
  })

  it('content 不是字符串时跳过；非法 JSON 行跳过', () => {
    const stdout = [
      JSON.stringify({ role: 'assistant', content: { text: '结构化内容' } }),
      '{broken',
      JSON.stringify({ role: 'assistant', content: 'ok' }),
    ].join('\n')
    expect(extractKimiAssistantText(stdout)).toEqual(['ok'])
  })

  it('没有 assistant 事件时返回空数组', () => {
    expect(extractKimiAssistantText('')).toEqual([])
  })
})

// ---- Codex: session id 提取 ----

describe('extractSessionIdFromJsonl', () => {
  it('正常格式：thread.started 事件的 thread.thread_id', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread: { thread_id: 'thr-1' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractSessionIdFromJsonl(stdout, warnings)).toBe('thr-1')
    expect(warnings).toEqual([])
  })

  it('兼容格式：顶层 thread_id 兜底', () => {
    const stdout = JSON.stringify({ type: 'thread.started', thread_id: 'thr-2' })
    expect(extractSessionIdFromJsonl(stdout)).toBe('thr-2')
  })

  it('格式变动：没有 thread.started 事件时返回 null 并产生 warning（列出实际事件类型）', () => {
    const stdout = [
      JSON.stringify({ type: 'session.initiated', session: { id: 'thr-3' } }),
      JSON.stringify({ type: 'item.completed', item: { text: 'done' } }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractSessionIdFromJsonl(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('session id 提取失败')
    expect(warnings[0]).toContain('session.initiated')
    expect(warnings[0]).toContain('item.completed')
  })

  it('缺字段：thread.started 存在但没有 thread_id 时返回 null 并告警', () => {
    const stdout = JSON.stringify({ type: 'thread.started', thread: {} })
    const warnings: string[] = []
    expect(extractSessionIdFromJsonl(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('thread.started')
  })
})

// ---- Codex: last message 提取 ----

describe('extractLastMessageFromJsonl', () => {
  it('正常格式：从最后一行倒序找到候选字段（item.text）', () => {
    const stdout = [
      JSON.stringify({ type: 'item.completed', item: { text: '较早的消息' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
      JSON.stringify({ type: 'item.completed', item: { text: '最后的消息' } }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractLastMessageFromJsonl(stdout, warnings)).toBe('最后的消息')
    expect(warnings).toEqual([])
  })

  it('兼容格式：message.content / output / result / content / text 候选字段', () => {
    expect(
      extractLastMessageFromJsonl(JSON.stringify({ message: { content: 'via message.content' } })),
    ).toBe('via message.content')
    expect(extractLastMessageFromJsonl(JSON.stringify({ output: 'via output' }))).toBe('via output')
    expect(extractLastMessageFromJsonl(JSON.stringify({ result: 'via result' }))).toBe('via result')
    expect(extractLastMessageFromJsonl(JSON.stringify({ text: 'via text' }))).toBe('via text')
  })

  it('格式变动：所有候选字段都不命中时返回 null 并产生 warning（列出实际事件类型）', () => {
    // 模拟上游把文本挪到未知字段的输出
    const stdout = [
      JSON.stringify({ type: 'item.completed', item: { message: '搬家了' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n')
    const warnings: string[] = []
    expect(extractLastMessageFromJsonl(stdout, warnings)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('last message 提取失败')
    expect(warnings[0]).toContain('item.completed')
    expect(warnings[0]).toContain('turn.completed')
  })

  it('缺字段/空白：空 stdout 返回 null 并告警；空白字符串候选不命中', () => {
    const warningsEmpty: string[] = []
    expect(extractLastMessageFromJsonl('', warningsEmpty)).toBeNull()
    expect(warningsEmpty).toHaveLength(1)

    const warningsBlank: string[] = []
    expect(
      extractLastMessageFromJsonl(JSON.stringify({ content: '   ' }), warningsBlank),
    ).toBeNull()
    expect(warningsBlank).toHaveLength(1)
  })

  it('跳过非法 JSON 行，继续向更早的行找', () => {
    const stdout = [
      JSON.stringify({ item: { text: '找到了' } }),
      '{not json',
    ].join('\n')
    expect(extractLastMessageFromJsonl(stdout)).toBe('找到了')
  })
})

// ---- Claude: stream-json protocol ----

describe('Claude stream-json parser', () => {
  it('从 system/init 和 terminal result 读取 session id，终态 result 优先', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'init-session' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'result-session' }),
    ].join('\n')
    const warnings: string[] = []

    expect(extractClaudeSessionId(stdout, warnings)).toBe('result-session')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('不一致')
  })

  it('旧输出没有 result 时兼容 system/init；格式不符会有可诊断 warning', () => {
    expect(
      extractClaudeSessionId(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'init-only' })),
    ).toBe('init-only')

    const warnings: string[] = []
    expect(extractClaudeSessionId(JSON.stringify({ type: 'system', subtype: 'other' }), warnings)).toBeNull()
    expect(warnings[0]).toContain('system/other')
  })

  it('只提取 assistant text block，thinking、tool_use、result 和其他角色均不泄漏为文本', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '这个绝不能返回' },
            { type: 'text', text: '第一段' },
            { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '不是 assistant' }] } }),
      JSON.stringify({ type: 'result', result: '也不能从 terminal result 取文本' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '第二段' }] } }),
    ].join('\n')

    expect(extractClaudeAssistantText(stdout)).toEqual(['第一段', '第二段'])
  })
})

describe('Claude command protocol', () => {
  it('CKRUNNER_CLAUDE_BINARY 优先于配置的 binary', () => {
    const before = process.env.CKRUNNER_CLAUDE_BINARY
    process.env.CKRUNNER_CLAUDE_BINARY = '/env/claude'
    try {
      expect(resolveClaudeBinary({ binary: '/config/claude' })).toBe('/env/claude')
    } finally {
      if (before === undefined) delete process.env.CKRUNNER_CLAUDE_BINARY
      else process.env.CKRUNNER_CLAUDE_BINARY = before
    }
  })

  it('新任务带 stream-json、verbose、permission mode 和 positional prompt', () => {
    const command = buildClaudeCommand(
      '实现这个切片',
      { cwd: '/workspace', timeoutMs: 42 },
      { binary: '/opt/claude', permissionMode: 'acceptEdits' },
    )

    expect(command).toMatchObject({ cmd: '/opt/claude', cwd: '/workspace', timeoutMs: 42 })
    expect(command.args).toEqual([
      '-p',
      '--verbose',
      '--output-format=stream-json',
      '--permission-mode',
      'acceptEdits',
      '--',
      '实现这个切片',
    ])
  })

  it('省略配置时使用 acceptEdits：适合无 TTY 的编码委派，但不是 bypassPermissions', () => {
    const command = buildClaudeCommand('实现这个切片', { cwd: '/workspace' })
    expect(command.args).toContain('acceptEdits')
    expect(command.args).not.toContain('bypassPermissions')
  })

  it('续接任务加入 --resume，且不把 prompt 送到 stdin', () => {
    const command = buildClaudeCommand('继续检查', { cwd: '/workspace', sessionId: 'claude-session-1' })
    expect(command.args).toEqual([
      '-p',
      '--verbose',
      '--output-format=stream-json',
      '--permission-mode',
      'acceptEdits',
      '--resume',
      'claude-session-1',
      '--',
      '继续检查',
    ])
    expect(command.args?.at(-1)).toBe('继续检查')
    expect(command.input).toBeUndefined()
  })

  it('在位置 prompt 前放置 --，使 dash 开头的 prompt 不会被解析为 flag', () => {
    const command = buildClaudeCommand('--not-a-claude-flag', { cwd: '/workspace' })
    expect(command.args?.slice(-2)).toEqual(['--', '--not-a-claude-flag'])
  })
})

describe('spawnDetachedCommand artifact and stdout semantics', () => {
  const command = (script: string) => ({
    cmd: '/bin/sh',
    args: ['-c', `${script}; sleep 0.05`],
  })

  it('uses owner-only default artifacts where supported and retains stderr internally', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'detached-artifacts-'))
    try {
      const paths = defaultArtifactPaths(dir, 'test')
      const handle = spawnDetachedCommand({
        ...command("printf %s 'raw stdout'; printf %s 'private diagnostic' >&2"),
        cwd: dir,
        artifactStdoutPath: paths.stdoutPath,
        artifactStderrPath: paths.stderrPath,
        artifactStdoutTransform: stdout => stdout,
      })
      const result = await handle.done

      expect(result).toMatchObject({ stdout: 'raw stdout', stderr: 'private diagnostic', exitCode: 0 })
      expect(await fs.readFile(paths.stdoutPath, 'utf8')).toBe('raw stdout')
      expect(await fs.readFile(paths.stderrPath, 'utf8')).toBe('private diagnostic')
      if (process.platform !== 'win32') {
        expect((await fs.stat(path.dirname(paths.stdoutPath))).mode & 0o777).toBe(0o700)
        expect((await fs.stat(paths.stdoutPath)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(paths.stderrPath)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('documents and preserves normal, transform, and line-filter done.stdout modes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'detached-stdout-'))
    try {
      const normalPath = path.join(dir, 'normal.log')
      const normal = spawnDetachedCommand({
        ...command("printf %s 'normal raw'"),
        cwd: dir,
        artifactStdoutPath: normalPath,
        artifactStderrPath: path.join(dir, 'normal.stderr.log'),
      })
      expect((await normal.done).stdout).toBe('normal raw')
      expect(await fs.readFile(normalPath, 'utf8')).toBe('normal raw')

      const transformedPath = path.join(dir, 'transformed.log')
      const transformed = spawnDetachedCommand({
        ...command("printf %s 'transform raw'"),
        cwd: dir,
        artifactStdoutPath: transformedPath,
        artifactStderrPath: path.join(dir, 'transformed.stderr.log'),
        artifactStdoutTransform: stdout => `public: ${stdout}`,
      })
      expect((await transformed.done).stdout).toBe('transform raw')
      expect(await fs.readFile(transformedPath, 'utf8')).toBe('public: transform raw')

      const filteredPath = path.join(dir, 'filtered.log')
      const filtered = spawnDetachedCommand({
        ...command("printf '%s\\n' private public"),
        cwd: dir,
        artifactStdoutPath: filteredPath,
        artifactStderrPath: path.join(dir, 'filtered.stderr.log'),
        artifactStdoutLineFilter: { onLine: line => (line === 'public' ? 'public' : null) },
      })
      expect((await filtered.done).stdout).toBe('public')
      expect(await fs.readFile(filteredPath, 'utf8')).toBe('public')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Claude permission configuration', () => {
  it('未写 [backends.claude] 时安全默认 acceptEdits，显式配置仍可覆盖', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-config-'))
    const config = path.join(dir, 'config.toml')
    try {
      await fs.writeFile(
        config,
        '[llm]\nbase_url = "https://fake.example"\nmodel = "fake"\n\n[delegation]\nlevel = "supervised"\n\n[[projects]]\nname = "proj"\npath = "/tmp/proj"\n',
      )
      expect(loadConfig(config).backends.claude).toEqual({ binary: 'claude', permission_mode: 'acceptEdits' })

      await fs.appendFile(config, '\n[backends.claude]\npermission_mode = "plan"\n')
      expect(loadConfig(config).backends.claude.permission_mode).toBe('plan')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('LineFilteringTransform', () => {
  it('handles JSON lines split across byte chunks and never passes private blocks to its output', async () => {
    const parser = new ClaudeStreamJsonParser()
    const transform = new LineFilteringTransform({ onLine: line => parser.consumeLine(line) })
    const output: Buffer[] = []
    transform.on('data', chunk => output.push(Buffer.from(chunk)))

    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: '公开 ✓' }] },
    }) + '\n'
    // Split inside the multibyte checkmark as well as the JSON record.
    const bytes = Buffer.from(line)
    const checkmark = bytes.indexOf(Buffer.from('✓'))
    const ended = once(transform, 'end')
    transform.write(bytes.subarray(0, checkmark + 1))
    transform.write(bytes.subarray(checkmark + 1, checkmark + 2))
    transform.end(bytes.subarray(checkmark + 2))
    await ended

    expect(Buffer.concat(output).toString('utf8')).toBe('公开 ✓')
    expect(Buffer.concat(output).toString('utf8')).not.toContain('private')
  })

  it('discards an oversized private line, then continues through a long stream with bounded line state', async () => {
    const publicLines: string[] = []
    let discarded = 0
    const transform = new LineFilteringTransform(
      {
        onLine: line => {
          const event = JSON.parse(line) as { public?: string }
          return event.public ?? null
        },
        onDiscardedLine: () => { discarded++ },
      },
      128,
    )
    transform.on('data', chunk => publicLines.push(Buffer.from(chunk).toString('utf8')))

    const privatePayload = JSON.stringify({ private: 'secret-'.repeat(10_000) }) + '\n'
    const ended = once(transform, 'end')
    for (let i = 0; i < privatePayload.length; i += 17) transform.write(privatePayload.slice(i, i + 17))
    for (let i = 0; i < 4_000; i++) transform.write(JSON.stringify({ public: `line-${i}` }) + '\n')
    transform.end()
    await ended

    const publicOutput = publicLines.join('')
    expect(discarded).toBe(1)
    expect(publicOutput).toContain('line-0')
    expect(publicOutput).toContain('line-3999')
    expect(publicOutput).not.toContain('secret-')
  })
})

describe('ClaudeBackend execution', () => {
  it('run 和 runDetached 的 artifact 与返回结果只包含 assistant text，绝不落盘 thinking', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-backend-'))
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stream-session' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '公开结果' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'stream-session', result: '不要取我' }),
    ].join('\n') + '\n'
    const binary = path.join(dir, 'fake-claude')
    const shellLiteral = `'${stream.replaceAll("'", "'\\\"'\\\"'")}'`
    await fs.writeFile(binary, `#!/bin/sh\nprintf '%s' ${shellLiteral}\nsleep 0.05\n`)
    await fs.chmod(binary, 0o755)

    try {
      const backend = new ClaudeBackend({ binary, permissionMode: 'default' })
      const stdoutPath = path.join(dir, 'sync.stdout.log')
      const stderrPath = path.join(dir, 'sync.stderr.log')
      const sync = await backend.run('任务', {
        cwd: dir,
        artifactStdoutPath: stdoutPath,
        artifactStderrPath: stderrPath,
      })
      expect(sync).toMatchObject({ stdout: '公开结果', sessionId: 'stream-session', exitCode: 0 })
      expect(await fs.readFile(stdoutPath, 'utf8')).toBe('公开结果')

      const detached = backend.runDetached('续接任务', {
        cwd: dir,
        sessionId: 'stream-session',
        artifactStdoutPath: path.join(dir, 'detached.stdout.log'),
        artifactStderrPath: path.join(dir, 'detached.stderr.log'),
      })
      // 进程仍在运行时也只能读到空 artifact 或已过滤的公开文本，绝不能读到原始 stream。
      const runningArtifact = await fs.readFile(detached.artifactStdoutPath, 'utf8')
      expect(runningArtifact).not.toContain('private')
      expect(runningArtifact).not.toContain('thinking')
      const detachedResult = await detached.done
      expect(detachedResult).toMatchObject({ stdout: '公开结果', sessionId: 'stream-session', exitCode: 0 })
      expect(await fs.readFile(detached.artifactStdoutPath, 'utf8')).toBe('公开结果')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
