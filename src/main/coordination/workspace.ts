import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 工作区项目（config.toml [[projects]]）：阅读范围与可委派范围分别表达（delegable）。 */
export interface WorkspaceProject { name: string; path: string; summary: string; delegable: boolean }

const maxListEntries = 200
const maxReadLines = 400
const maxReadFileBytes = 2 * 1024 * 1024
const maxLineLength = 500
const maxSearchMatches = 50
const maxSearchFiles = 3000
const maxSearchFileBytes = 512 * 1024
const searchTimeBudgetMs = 2000
const gitTimeoutMs = 5000
/** 搜索默认跳过的重型/无关目录；.agent-artifacts 的普通报告允许按需读取，不在跳过列表。 */
const searchSkipDirs = new Set(['node_modules', '.git', 'dist', '.vite', '.pnpm', 'releases', '__pycache__'])
/** 凭据与密钥文件不读给模型（与打包器同源边界）。 */
function isDeniedName(base: string): boolean {
  const lower = base.toLowerCase()
  return lower === '.env' || lower.startsWith('.env.') || lower.startsWith('.env-')
    || lower.endsWith('.pem') || lower.endsWith('.key') || lower.startsWith('id_rsa') || lower.startsWith('id_ed25519')
    || lower === 'credentials' || lower === 'credentials.json'
}
/** CLI 原始日志命名（与 src/backends/runCommand.ts defaultArtifactPaths 一致）：<stamp>.stdout.log / <stamp>.stderr.log。
 *  stderr 可能含凭据或启动诊断，一律不开放；stdout 仅任务绑定的 read_artifact 入口可读，
 *  通用 read_file/search_files/list_files 对两者都不开放。 */
function isCliStderrLogName(base: string): boolean { return base.toLowerCase().endsWith('.stderr.log') }
function isCliRawLogName(base: string): boolean {
  const lower = base.toLowerCase()
  return lower.endsWith('.stdout.log') || lower.endsWith('.stderr.log')
}

/** 主 Agent 的只读工作区视野（docs/main-agent-workspace-plan-2026-10-24.md）：
 *  注册项目以配置为准；授权发现根下的一级目录自动成为可读项目（delegable 恒为 false）。
 *  路径解析 realpath 后必须留在项目根内，符号链接与链式 .. 逃逸一律拒绝；realpath 后的每一级
 *  组件都过凭据文件名校验（符号链接别名不能绕过被拒目录）。所有工具只读且异步，
 *  不阻塞 worker 事件循环；未找到/截断/超时一律返回 {error} 对象而不是抛给协议层。 */
export class Workspace {
  private readonly byName = new Map<string, WorkspaceProject>()
  private readonly roots = new Map<string, string>()
  private readonly discoveryRoots: string[] = []
  constructor(readonly projects: readonly WorkspaceProject[], discoveryRoots: readonly string[] = []) {
    for (const p of projects) {
      if (this.byName.has(p.name)) throw new Error(`Duplicate project name: ${p.name}`)
      this.byName.set(p.name, p)
      try { this.roots.set(p.name, realpathSync(p.path)) } catch { /* 项目根暂不可达：保留注册，读取时如实报错 */ }
    }
    for (const r of discoveryRoots) {
      try { this.discoveryRoots.push(realpathSync(r)) } catch { /* 发现根不可达：跳过，发现结果为空 */ }
    }
  }

  /** 授权发现根下的一级目录：跳过隐藏/凭据/重型目录，符号链接解析后必须仍在发现根内。 */
  private async discover(): Promise<Map<string, { project: WorkspaceProject; root: string }>> {
    const found = new Map<string, { project: WorkspaceProject; root: string }>()
    for (const root of this.discoveryRoots) {
      let entries
      try { entries = await readdir(root, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (found.has(e.name) || this.byName.has(e.name)) continue
        if (e.name.startsWith('.') || isDeniedName(e.name) || searchSkipDirs.has(e.name)) continue
        if (!e.isDirectory() && !e.isSymbolicLink()) continue
        let real: string
        try { real = await realpath(path.join(root, e.name)) } catch { continue }
        if (real !== root && !real.startsWith(root + path.sep)) continue
        try { if (!(await stat(real)).isDirectory()) continue } catch { continue }
        found.set(e.name, { project: { name: e.name, path: real, summary: '', delegable: false }, root: real })
      }
    }
    return found
  }

  async listProjects(): Promise<unknown> {
    const discovered = await this.discover()
    return [
      ...this.projects.map(p => ({
        name: p.name, path: p.path, summary: p.summary || undefined,
        readable: this.roots.has(p.name), delegable: p.delegable, registered: true,
      })),
      ...[...discovered.values()].map(d => ({ name: d.project.name, path: d.project.path, readable: true, delegable: false, registered: false })),
    ]
  }

  private async project(name: string): Promise<{ project: WorkspaceProject; root: string } | { error: string }> {
    const registered = this.byName.get(name)
    if (registered) {
      const root = this.roots.get(name)
      if (!root) return { error: `项目 ${name} 的目录当前不可达。` }
      return { project: registered, root }
    }
    const discovered = await this.discover()
    const d = discovered.get(name)
    if (!d) return { error: `未知项目：${name}。可用项目见 list_projects。` }
    return d
  }

  /** 解析项目内路径：拒绝绝对路径、凭据文件名、CLI 原始日志；realpath 后必须仍在项目根内，
   *  且解析后的每一级组件都过凭据名校验（符号链接/链式 .. 逃逸、别名进入被拒目录一律拒绝）。 */
  private async resolve(name: string, rel: string): Promise<{ root: string; target: string } | { error: string }> {
    const p = await this.project(name)
    if ('error' in p) return p
    if (!rel || rel.includes('\0')) return { error: '路径为空或非法。' }
    if (path.isAbsolute(rel)) return { error: '请使用项目内的相对路径。' }
    const segments = rel.split(/[\\/]+/).filter(s => s && s !== '.')
    if (segments.some(isDeniedName)) return { error: '凭据与密钥文件不可读取。' }
    const root = p.root
    const target = path.resolve(root, segments.join('/'))
    if (target !== root && !target.startsWith(root + path.sep)) return { error: '路径越出项目根。' }
    let real: string
    try { real = await realpath(target) } catch { return { error: `不存在：${rel}` } }
    if (real !== root && !real.startsWith(root + path.sep)) return { error: '路径经符号链接越出项目根，已拒绝。' }
    if (path.relative(root, real).split(path.sep).some(isDeniedName)) return { error: '凭据与密钥文件不可读取。' }
    if (isCliRawLogName(path.basename(real))) return { error: 'CLI 原始日志不经通用读取开放；任务的公开标准输出请用 read_artifact 按任务读取。' }
    return { root, target: real }
  }

  async listFiles(project: string, rel: string): Promise<unknown> {
    const r = await this.resolve(project, rel || '.')
    if ('error' in r) return r
    let st
    try { st = await stat(r.target) } catch { return { error: `不存在：${rel}` } }
    if (!st.isDirectory()) return { error: `${rel} 不是目录；读取文件请用 read_file。` }
    const entries = (await readdir(r.target, { withFileTypes: true }))
      .filter(e => !isDeniedName(e.name) && !isCliRawLogName(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const shown = await Promise.all(entries.slice(0, maxListEntries).map(async e => {
      let mtime = '', size: number | undefined
      try { const s = await stat(path.join(r.target, e.name)); mtime = s.mtime.toISOString().slice(0, 19); if (e.isFile()) size = s.size } catch { /* dangling symlink */ }
      return { name: e.isDirectory() ? e.name + '/' : e.name, ...(size !== undefined ? { size } : {}), mtime }
    }))
    return { project, path: rel || '.', entries: shown, truncated: entries.length > maxListEntries }
  }

  async readFile(project: string, rel: string, startLine = 1): Promise<unknown> {
    const r = await this.resolve(project, rel)
    if ('error' in r) return r
    let st
    try { st = await stat(r.target) } catch { return { error: `不存在：${rel}` } }
    if (st.isDirectory()) return { error: `${rel} 是目录；查看目录请用 list_files。` }
    if (st.size > maxReadFileBytes) return { error: `文件过大（${st.size} 字节），未读取；可用 search_files 定位后按行段读取。` }
    const buffer = await readFile(r.target)
    if (buffer.subarray(0, 8192).includes(0)) return { error: '二进制文件不可读取。' }
    const lines = buffer.toString('utf8').split('\n')
    const from = Math.max(1, Math.floor(startLine) || 1)
    if (from > lines.length) return { project, path: rel, totalLines: lines.length, lines: [], note: `起始行 ${from} 超出文件末尾。` }
    const slice = lines.slice(from - 1, from - 1 + maxReadLines)
    return {
      project, path: rel, totalLines: lines.length, fromLine: from,
      lines: slice.map((l, i) => `${from + i}: ${l.length > maxLineLength ? l.slice(0, maxLineLength) + ' …[行截断]' : l}`),
      truncated: from - 1 + maxReadLines < lines.length,
    }
  }

  async searchFiles(project: string, query: string, signal?: AbortSignal): Promise<unknown> {
    const r = await this.resolve(project, '.')
    if ('error' in r) return r
    const q = query.trim().toLowerCase()
    if (!q) return { error: '搜索词为空。' }
    const started = Date.now()
    const matches: Array<{ path: string; line?: number; excerpt?: string }> = []
    let scanned = 0, skippedLarge = 0, timedOut = false
    const walk = async (dir: string, relBase: string): Promise<void> => {
      if (matches.length >= maxSearchMatches || scanned >= maxSearchFiles) return
      if (Date.now() - started > searchTimeBudgetMs || signal?.aborted) { timedOut = true; return }
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (matches.length >= maxSearchMatches || scanned >= maxSearchFiles || timedOut) return
        if (Date.now() - started > searchTimeBudgetMs || signal?.aborted) { timedOut = true; return }
        if (isDeniedName(e.name) || isCliRawLogName(e.name)) continue
        const full = path.join(dir, e.name), rel = relBase ? `${relBase}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (searchSkipDirs.has(e.name) || e.name.startsWith('.git')) continue
          await walk(full, rel)
        } else if (e.isFile()) {
          if (rel.toLowerCase().includes(q)) matches.push({ path: rel })
          if (matches.length >= maxSearchMatches) return
          scanned++
          let buffer: Buffer
          try {
            const s = await stat(full)
            if (s.size > maxSearchFileBytes) { skippedLarge++; continue }
            buffer = await readFile(full)
          } catch { continue }
          if (buffer.subarray(0, 8192).includes(0)) continue
          const lines = buffer.toString('utf8').split('\n')
          for (let i = 0; i < lines.length && matches.length < maxSearchMatches; i++) {
            const line = lines[i]!
            if (line.toLowerCase().includes(q)) {
              const excerpt = line.trim()
              matches.push({ path: rel, line: i + 1, excerpt: excerpt.length > 200 ? excerpt.slice(0, 200) + ' …' : excerpt })
            }
          }
        }
      }
    }
    await walk(r.target, '')
    return { project, query, matches, scannedFiles: scanned, skippedLargeFiles: skippedLarge, truncated: matches.length >= maxSearchMatches || scanned >= maxSearchFiles || timedOut }
  }

  /** 只读 Git 状态：固定参数异步调用（受超时与取消信号约束），模型不提供任意 git 参数。 */
  async projectStatus(project: string, signal?: AbortSignal): Promise<unknown> {
    const p = await this.project(project)
    if ('error' in p) return p
    const git = async (args: string[]): Promise<string> =>
      (await execFileAsync('git', ['-C', p.root, ...args], { encoding: 'utf8', timeout: gitTimeoutMs, signal })).stdout.trim()
    try {
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      const head = await git(['log', '-1', '--format=%h %s (%cI)'])
      const dirty = (await git(['status', '--porcelain'])).split('\n').filter(Boolean).length
      const recent = (await git(['log', '-5', '--format=%h %s (%cI)'])).split('\n').filter(Boolean)
      return { project, branch, head, uncommittedChanges: dirty, recentCommits: recent, readAt: new Date().toISOString() }
    } catch (error) {
      return { error: `无法读取 ${project} 的 Git 状态：${(error as Error).message.slice(0, 200)}` }
    }
  }

  /** 任务绑定产物读取：根目录限定在该 run 的 .agent-artifacts 产物目录。
   *  stderr 原始日志一律不开放（含其他任务的）；原始 stdout 仅开放当前任务绑定的那个文件。 */
  async readArtifact(artifactStdoutPath: string, artifactStderrPath: string | undefined, rel: string): Promise<unknown> {
    const dir = path.dirname(artifactStdoutPath)
    if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return { error: '请使用产物目录内的相对路径。' }
    const target = path.resolve(dir, rel)
    if (target !== dir && !target.startsWith(dir + path.sep)) return { error: '路径越出产物目录。' }
    let real: string
    try { real = await realpath(target) } catch { return { error: `产物不存在：${rel}` } }
    if (real !== dir && !real.startsWith(dir + path.sep)) return { error: '产物路径经符号链接越界，已拒绝。' }
    let stdoutReal: string | undefined
    let stderrReal: string | undefined
    try { stdoutReal = await realpath(artifactStdoutPath) } catch { /* stdout 文件可能不存在 */ }
    try { if (artifactStderrPath) stderrReal = await realpath(artifactStderrPath) } catch { /* stderr 文件可能不存在 */ }
    const base = path.basename(real)
    if (isCliStderrLogName(base) || (stderrReal !== undefined && real === stderrReal)) return { error: 'stderr 原始日志不开放；结论以任务回执为准。' }
    if (isCliRawLogName(base) && real !== stdoutReal) return { error: '仅开放当前任务绑定的公开标准输出；其他任务的原始日志不开放。' }
    if (isDeniedName(base)) return { error: '凭据与密钥文件不可读取。' }
    let st
    try { st = await stat(real) } catch { return { error: `产物不存在：${rel}` } }
    if (st.isDirectory()) {
      const entries = (await readdir(real, { withFileTypes: true }))
        .filter(e => !isDeniedName(e.name) && !isCliStderrLogName(e.name)
          && !(isCliRawLogName(e.name) && path.join(real, e.name) !== stdoutReal))
        .slice(0, maxListEntries)
      return { entries: entries.map(e => e.isDirectory() ? e.name + '/' : e.name) }
    }
    if (st.size > maxReadFileBytes) return { error: `产物过大（${st.size} 字节），未读取。` }
    const buffer = await readFile(real)
    if (buffer.subarray(0, 8192).includes(0)) return { error: '二进制产物不可读取。' }
    const lines = buffer.toString('utf8').split('\n')
    const slice = lines.slice(0, maxReadLines)
    return { path: rel, totalLines: lines.length, lines: slice.map((l, i) => `${i + 1}: ${l.length > maxLineLength ? l.slice(0, maxLineLength) + ' …[行截断]' : l}`), truncated: lines.length > maxReadLines }
  }
}
