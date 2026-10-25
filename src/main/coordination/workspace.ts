import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

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

/** 主 Agent 的只读工作区视野（docs/main-agent-workspace-plan-2026-10-24.md）：
 *  项目清单以配置为准（不做裸目录扫描）；路径解析 realpath 后必须留在项目根内，
 *  符号链接与链式 .. 逃逸一律拒绝。所有工具只读，诚实返回错误对象而不是抛给协议层。 */
export class Workspace {
  private readonly byName = new Map<string, WorkspaceProject>()
  private readonly roots = new Map<string, string>()
  constructor(readonly projects: readonly WorkspaceProject[]) {
    for (const p of projects) {
      if (this.byName.has(p.name)) throw new Error(`Duplicate project name: ${p.name}`)
      this.byName.set(p.name, p)
      try { this.roots.set(p.name, realpathSync(p.path)) } catch { /* 项目根暂不可达：保留注册，读取时如实报错 */ }
    }
  }

  listProjects(): unknown {
    return this.projects.map(p => ({
      name: p.name, path: p.path, summary: p.summary || undefined,
      readable: this.roots.has(p.name), delegable: p.delegable,
    }))
  }

  private project(name: string): WorkspaceProject | { error: string } {
    const p = this.byName.get(name)
    if (!p) return { error: `未知项目：${name}。可用项目见 list_projects。` }
    if (!this.roots.has(name)) return { error: `项目 ${name} 的目录当前不可达。` }
    return p
  }

  /** 解析项目内路径：拒绝绝对路径、凭据文件名；realpath 后必须仍在项目根内（符号链接/链式 .. 逃逸拒绝）。 */
  private resolve(name: string, rel: string): { root: string; target: string } | { error: string } {
    const p = this.project(name)
    if ('error' in p) return p
    if (!rel || rel.includes('\0')) return { error: '路径为空或非法。' }
    if (path.isAbsolute(rel)) return { error: '请使用项目内的相对路径。' }
    const segments = rel.split(/[\\/]+/).filter(s => s && s !== '.')
    if (segments.some(isDeniedName)) return { error: '凭据与密钥文件不可读取。' }
    const root = this.roots.get(name)!
    const target = path.resolve(root, segments.join('/'))
    if (target !== root && !target.startsWith(root + path.sep)) return { error: '路径越出项目根。' }
    let real: string
    try { real = realpathSync(target) } catch { return { error: `不存在：${rel}` } }
    if (real !== root && !real.startsWith(root + path.sep)) return { error: '路径经符号链接越出项目根，已拒绝。' }
    if (isDeniedName(path.basename(real))) return { error: '凭据与密钥文件不可读取。' }
    return { root, target: real }
  }

  listFiles(project: string, rel: string): unknown {
    const r = this.resolve(project, rel || '.')
    if ('error' in r) return r
    let stat
    try { stat = statSync(r.target) } catch { return { error: `不存在：${rel}` } }
    if (!stat.isDirectory()) return { error: `${rel} 不是目录；读取文件请用 read_file。` }
    const entries = readdirSync(r.target, { withFileTypes: true })
      .filter(e => !isDeniedName(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const shown = entries.slice(0, maxListEntries).map(e => {
      const full = path.join(r.target, e.name)
      let mtime = '', size: number | undefined
      try { const s = statSync(full); mtime = s.mtime.toISOString().slice(0, 19); if (e.isFile()) size = s.size } catch { /*  dangling symlink */ }
      return { name: e.isDirectory() ? e.name + '/' : e.name, ...(size !== undefined ? { size } : {}), mtime }
    })
    return { project, path: rel || '.', entries: shown, truncated: entries.length > maxListEntries }
  }

  readFile(project: string, rel: string, startLine = 1): unknown {
    const r = this.resolve(project, rel)
    if ('error' in r) return r
    let stat
    try { stat = statSync(r.target) } catch { return { error: `不存在：${rel}` } }
    if (stat.isDirectory()) return { error: `${rel} 是目录；查看目录请用 list_files。` }
    if (stat.size > maxReadFileBytes) return { error: `文件过大（${stat.size} 字节），未读取；可用 search_files 定位后按行段读取。` }
    const buffer = readFileSync(r.target)
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

  searchFiles(project: string, query: string): unknown {
    const r = this.resolve(project, '.')
    if ('error' in r) return r
    const q = query.trim().toLowerCase()
    if (!q) return { error: '搜索词为空。' }
    const started = Date.now()
    const matches: Array<{ path: string; line?: number; excerpt?: string }> = []
    let scanned = 0, skippedLarge = 0, timedOut = false
    const walk = (dir: string, relBase: string): void => {
      if (matches.length >= maxSearchMatches || scanned >= maxSearchFiles) return
      if (Date.now() - started > searchTimeBudgetMs) { timedOut = true; return }
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (matches.length >= maxSearchMatches || scanned >= maxSearchFiles || timedOut) return
        if (isDeniedName(e.name)) continue
        const full = path.join(dir, e.name), rel = relBase ? `${relBase}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (searchSkipDirs.has(e.name) || e.name.startsWith('.git')) continue
          walk(full, rel)
        } else if (e.isFile()) {
          if (rel.toLowerCase().includes(q)) matches.push({ path: rel })
          if (matches.length >= maxSearchMatches) return
          scanned++
          let buffer: Buffer
          try {
            const s = statSync(full)
            if (s.size > maxSearchFileBytes) { skippedLarge++; continue }
            buffer = readFileSync(full)
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
    walk(r.target, '')
    return { project, query, matches, scannedFiles: scanned, skippedLargeFiles: skippedLarge, truncated: matches.length >= maxSearchMatches || scanned >= maxSearchFiles || timedOut }
  }

  /** 只读 Git 状态：固定参数调用，模型不提供任意 git 参数。 */
  projectStatus(project: string): unknown {
    const p = this.project(project)
    if ('error' in p) return p
    const root = this.roots.get(project)!
    const git = (args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: gitTimeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    try {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
      const head = git(['log', '-1', '--format=%h %s (%cI)'])
      const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length
      const recent = git(['log', '-5', '--format=%h %s (%cI)']).split('\n').filter(Boolean)
      return { project, branch, head, uncommittedChanges: dirty, recentCommits: recent, readAt: new Date().toISOString() }
    } catch (error) {
      return { error: `无法读取 ${project} 的 Git 状态：${(error as Error).message.slice(0, 200)}` }
    }
  }

  /** 任务绑定产物读取：根目录限定在该 run 的 .agent-artifacts 产物目录；stderr 原始日志不开放。 */
  readArtifact(artifactStdoutPath: string, artifactStderrPath: string | undefined, rel: string): unknown {
    const dir = path.dirname(artifactStdoutPath)
    if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return { error: '请使用产物目录内的相对路径。' }
    const target = path.resolve(dir, rel)
    if (target !== dir && !target.startsWith(dir + path.sep)) return { error: '路径越出产物目录。' }
    let real: string
    try { real = realpathSync(target) } catch { return { error: `产物不存在：${rel}` } }
    if (real !== dir && !real.startsWith(dir + path.sep)) return { error: '产物路径经符号链接越界，已拒绝。' }
    let stderrReal: string | undefined
    try { if (artifactStderrPath) stderrReal = realpathSync(artifactStderrPath) } catch { /* stderr 文件可能不存在 */ }
    if (stderrReal && real === stderrReal) return { error: 'stderr 原始日志不开放；结论以任务回执为准。' }
    if (isDeniedName(path.basename(real))) return { error: '凭据与密钥文件不可读取。' }
    let stat
    try { stat = statSync(real) } catch { return { error: `产物不存在：${rel}` } }
    if (stat.isDirectory()) {
      const entries = readdirSync(real, { withFileTypes: true }).slice(0, maxListEntries)
      return { entries: entries.map(e => e.isDirectory() ? e.name + '/' : e.name) }
    }
    if (stat.size > maxReadFileBytes) return { error: `产物过大（${stat.size} 字节），未读取。` }
    const buffer = readFileSync(real)
    if (buffer.subarray(0, 8192).includes(0)) return { error: '二进制产物不可读取。' }
    const lines = buffer.toString('utf8').split('\n')
    const slice = lines.slice(0, maxReadLines)
    return { path: rel, totalLines: lines.length, lines: slice.map((l, i) => `${i + 1}: ${l.length > maxLineLength ? l.slice(0, maxLineLength) + ' …[行截断]' : l}`), truncated: lines.length > maxReadLines }
  }
}
