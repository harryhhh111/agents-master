import { promises as fs } from 'node:fs'
import { parseCodexChunk } from '../sessions/codexParser.js'
import { findCodexSessionFile, findKimiSessionFile } from '../sessions/discovery.js'
import { parseKimiChunk } from '../sessions/kimiParser.js'
import type { RunRegistry } from '../state/runs.js'

/** 斜杠命令需要的只读上下文：项目路径（做 session discovery）和 run 注册表。 */
export interface CommandContext {
  projectPath: string
  /** agent 大脑没启动（缺 LLM key）时为 null */
  runs: RunRegistry | null
}

export const HELP_TEXT = [
  '可用命令：',
  '  /help                 列出本帮助',
  '  /raw kimi|codex [N]   翻看该 CLI 当前 session 的最近 N 条原文（默认 30）',
  '  /runs                 查看后台 run 列表和 artifact 尾部',
  '  /exit                 退出',
  '其余输入：agent 空闲时作为新目标；决策点待答时作为回答；agent 工作时为插话。',
].join('\n')

const RAW_DEFAULT_TAIL = 30
const RAW_MSG_CHARS = 400
const ARTIFACT_TAIL_CHARS = 400
const RUNS_MAX = 10

function fmtTs(ts: number): string {
  return ts > 0 ? new Date(ts).toTimeString().slice(0, 8) : '--:--:--'
}

async function rawSession(cli: 'kimi' | 'codex', tail: number, projectPath: string): Promise<string> {
  const file =
    cli === 'kimi' ? await findKimiSessionFile(projectPath) : await findCodexSessionFile(projectPath)
  if (!file) return `未找到 ${cli} 的 session 文件（项目还没跑过会话？）`

  // 原文翻看要看到历史，直接全量读文件过 parser，不走增量 reader（它的 offset 是给 agent 用的）
  const content = await fs.readFile(file, 'utf8')
  const { messages, warnings } = cli === 'kimi' ? parseKimiChunk(content) : parseCodexChunk(content)
  const slice = messages.slice(-tail)
  const header = [
    `${cli} session: ${file}`,
    `共 ${messages.length} 条，显示最近 ${slice.length} 条` +
      (warnings > 0 ? `（${warnings} 行解析告警）` : ''),
  ].join('\n')
  const body = slice
    .map(m => {
      const kind = m.kind ? `/${m.kind}` : ''
      const text = m.text.length > RAW_MSG_CHARS ? m.text.slice(0, RAW_MSG_CHARS) + '…' : m.text
      return `[${fmtTs(m.ts)}] ${m.who}${kind}: ${text}`
    })
    .join('\n\n')
  return `${header}\n\n${body || '(没有可显示的消息)'}`
}

async function runsList(runs: RunRegistry): Promise<string> {
  const all = runs.list()
  if (all.length === 0) return '还没有任何 run。'
  const recent = all.slice(-RUNS_MAX)
  const blocks = await Promise.all(
    recent.map(async r => {
      const elapsed = ((Date.now() - r.startedAt) / 1000).toFixed(0)
      const head =
        `${r.status === 'running' ? '▶' : '■'} ${r.runId.slice(0, 8)} ${r.backend} ` +
        `${r.status} ${elapsed}s pid=${r.handle.pid}` +
        (r.result ? ` exit=${r.result.exitCode}` : '') +
        (r.error ? ` error=${r.error}` : '')
      let tail = ''
      try {
        const content = await fs.readFile(r.handle.artifactStdoutPath, 'utf8')
        tail = content.length > ARTIFACT_TAIL_CHARS ? '…' + content.slice(-ARTIFACT_TAIL_CHARS) : content
        tail = tail.trimEnd()
      } catch {
        tail = '(artifact 暂不可读)'
      }
      return tail ? `${head}\n  ${tail.replace(/\n/g, '\n  ')}` : head
    }),
  )
  const omitted = all.length > recent.length ? `(还有 ${all.length - recent.length} 条更早的 run 未显示)\n` : ''
  return omitted + blocks.join('\n\n')
}

/** 执行一条斜杠命令，返回渲染进对话区的文本。/exit 由 App 单独拦截，不走这里。 */
export async function runSlashCommand(input: string, ctx: CommandContext): Promise<string> {
  const parts = input.trim().split(/\s+/)
  const cmd = parts[0]
  switch (cmd) {
    case '/help':
      return HELP_TEXT
    case '/raw': {
      const cli = parts[1]
      if (cli !== 'kimi' && cli !== 'codex') return '用法: /raw kimi|codex [N]'
      const tail = parts[2] ? Number.parseInt(parts[2], 10) : RAW_DEFAULT_TAIL
      if (!Number.isFinite(tail) || tail <= 0) return `N 必须是正整数，收到 ${parts[2]}`
      try {
        return await rawSession(cli, tail, ctx.projectPath)
      } catch (e) {
        return `读取 ${cli} session 失败: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    case '/runs':
      if (!ctx.runs) return 'agent 大脑未启动（缺 DEEPSEEK_API_KEY），没有 run 注册表。'
      return runsList(ctx.runs)
    default:
      return `未知命令 ${cmd}，/help 查看可用命令`
  }
}
