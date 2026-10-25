import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { Workspace } from '../src/main/coordination/workspace.js'

function fixture(): { root: string; ws: Workspace } {
  const root = mkdtempSync('/dev/shm/ws-test-')
  const project = path.join(root, 'proj')
  mkdirSync(path.join(project, 'src'), { recursive: true })
  mkdirSync(path.join(project, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(path.join(project, 'README.md'), '# 合成项目\n这是一个测试项目。\n')
  writeFileSync(path.join(project, 'src', 'main.ts'), 'const answer = 42\nconsole.log(answer)\n')
  writeFileSync(path.join(project, '.env'), 'SECRET=should-never-leak\n')
  writeFileSync(path.join(project, 'node_modules', 'dep', 'index.js'), 'const answer = 1\n')
  const ws = new Workspace([{ name: 'proj', path: project, summary: '合成项目', delegable: true }])
  return { root, ws }
}

it('list_projects/list_files/read_file/search_files 基本行为与截断标注', async () => {
  const { root, ws } = fixture()
  try {
    const projects = await ws.listProjects() as Array<{ name: string; summary: string; delegable: boolean; readable: boolean; registered: boolean }>
    expect(projects).toEqual([{ name: 'proj', path: path.join(root, 'proj'), summary: '合成项目', readable: true, delegable: true, registered: true }])

    const listing = await ws.listFiles('proj', '.') as { entries: Array<{ name: string }>; truncated: boolean }
    const names = listing.entries.map(e => e.name)
    expect(names).toContain('src/')
    expect(names).toContain('README.md')
    expect(names).not.toContain('.env')
    expect(listing.truncated).toBe(false)

    const read = await ws.readFile('proj', 'src/main.ts', 1) as { lines: string[]; totalLines: number; truncated: boolean }
    expect(read.lines[0]).toBe('1: const answer = 42')
    expect(read.totalLines).toBe(3)
    const tail = await ws.readFile('proj', 'src/main.ts', 99) as { note?: string }
    expect(tail.note).toContain('超出文件末尾')

    const hit = await ws.searchFiles('proj', 'answer') as { matches: Array<{ path: string; line?: number }> }
    expect(hit.matches.some(m => m.path === 'src/main.ts' && m.line === 1)).toBe(true)
    // node_modules 默认跳过
    expect(hit.matches.some(m => m.path.includes('node_modules'))).toBe(false)
    const byName = await ws.searchFiles('proj', 'readme') as { matches: Array<{ path: string }> }
    expect(byName.matches.some(m => m.path === 'README.md')).toBe(true)

    expect(await ws.listFiles('proj', 'nope')).toHaveProperty('error')
    expect(await ws.listFiles('unknown', '.')).toHaveProperty('error')
  } finally { rmSync(root, { recursive: true }) }
})

it('路径安全：绝对路径、.. 逃逸、符号链接逃逸、凭据文件与别名目录一律拒绝', async () => {
  const { root, ws } = fixture()
  try {
    const outside = path.join(root, 'outside.txt')
    writeFileSync(outside, 'outside secret\n')
    expect(await ws.readFile('proj', '/etc/passwd', 1)).toHaveProperty('error')
    expect(await ws.readFile('proj', '../outside.txt', 1)).toHaveProperty('error')
    expect(await ws.readFile('proj', 'a/../../outside.txt', 1)).toHaveProperty('error')
    expect(await ws.readFile('proj', '.env', 1)).toHaveProperty('error')
    expect(await ws.readFile('proj', 'sub/.env.local', 1)).toHaveProperty('error')
    // 符号链接逃逸：项目内链接指向项目外
    symlinkSync(outside, path.join(root, 'proj', 'src', 'escape.txt'))
    expect(await ws.readFile('proj', 'src/escape.txt', 1)).toHaveProperty('error')
    // 子目录里的绝对符号链接同样拒绝
    symlinkSync('/', path.join(root, 'proj', 'src', 'abs-link'))
    expect(await ws.listFiles('proj', 'src/abs-link')).toHaveProperty('error')
    // 符号链接别名指向被拒目录：realpath 后逐组件校验，不得绕过（W1 复核回归）
    mkdirSync(path.join(root, 'proj', '.env.private'))
    writeFileSync(path.join(root, 'proj', '.env.private', 'data.txt'), 'SYNTHETIC_DENIED_DIRECTORY_MARKER\n')
    symlinkSync('.env.private', path.join(root, 'proj', 'alias'))
    expect(await ws.readFile('proj', '.env.private/data.txt', 1)).toHaveProperty('error')
    expect(await ws.readFile('proj', 'alias/data.txt', 1)).toHaveProperty('error')
    expect(await ws.listFiles('proj', 'alias')).toHaveProperty('error')
  } finally { rmSync(root, { recursive: true }) }
})

it('project_status：真实 Git 仓返回分支/HEAD/未提交数；非 Git 目录如实报错', async () => {
  const { root, ws } = fixture()
  try {
    expect(await ws.projectStatus('proj')).toHaveProperty('error')
    const git = (args: string[]) => execFileSync('git', ['-C', path.join(root, 'proj'), ...args], { encoding: 'utf8' })
    git(['init', '-b', 'main'])
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'synthetic init'])
    const status = await ws.projectStatus('proj') as { branch: string; head: string; uncommittedChanges: number; recentCommits: string[]; readAt: string }
    expect(status.branch).toBe('main')
    expect(status.head).toContain('synthetic init')
    expect(status.recentCommits).toHaveLength(1)
    writeFileSync(path.join(root, 'proj', 'dirty.txt'), 'x\n')
    expect((await ws.projectStatus('proj') as { uncommittedChanges: number }).uncommittedChanges).toBe(1)
  } finally { rmSync(root, { recursive: true }) }
})

it('read_artifact：产物目录内读取与列目录；stderr 与越界拒绝', async () => {
  const { root, ws } = fixture()
  try {
    const dir = path.join(root, 'proj', '.agent-artifacts', 'run-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'stdout.log'), '执行输出第一行\n第二行\n')
    writeFileSync(path.join(dir, 'stderr.log'), 'debug noise\n')
    writeFileSync(path.join(dir, 'report.md'), '# 报告\n')
    const stdoutPath = path.join(dir, 'stdout.log')
    const stderrPath = path.join(dir, 'stderr.log')
    const read = await ws.readArtifact(stdoutPath, stderrPath, 'stdout.log') as { lines: string[] }
    expect(read.lines[0]).toBe('1: 执行输出第一行')
    expect(await ws.readArtifact(stdoutPath, stderrPath, 'stderr.log')).toHaveProperty('error')
    expect(await ws.readArtifact(stdoutPath, stderrPath, '../../README.md')).toHaveProperty('error')
    const listing = await ws.readArtifact(stdoutPath, stderrPath, '.') as { entries: string[] }
    expect(listing.entries).toContain('report.md')
  } finally { rmSync(root, { recursive: true }) }
})

// W1 复核回归：CLI 原始日志（runCommand 命名 <stamp>.stdout.log / <stamp>.stderr.log）
// 不得经通用读取/搜索/列目录泄露；read_artifact 只开放当前任务绑定的 stdout。
it('CLI 原始日志边界：通用入口拒绝 raw log；read_artifact 只开放当前任务绑定 stdout', async () => {
  const { root, ws } = fixture()
  try {
    const dir = path.join(root, 'proj', '.agent-artifacts')
    mkdirSync(dir, { recursive: true })
    const aOut = path.join(dir, 'codex-a.stdout.log')
    const aErr = path.join(dir, 'codex-a.stderr.log')
    writeFileSync(aOut, 'SYNTHETIC_PUBLIC_OUTPUT\n')
    writeFileSync(aErr, 'SYNTHETIC_PRIVATE_DIAGNOSTIC_A\n')
    writeFileSync(path.join(dir, 'kimi-b.stdout.log'), 'SYNTHETIC_OTHER_TASK_OUTPUT\n')
    writeFileSync(path.join(dir, 'kimi-b.stderr.log'), 'SYNTHETIC_PRIVATE_DIAGNOSTIC_B\n')
    writeFileSync(path.join(dir, 'review.md'), '# 普通报告\nSYNTHETIC_REPORT\n')
    // 通用 read_file 不开放任何 raw log（含其他任务的）
    expect(await ws.readFile('proj', '.agent-artifacts/codex-a.stdout.log')).toHaveProperty('error')
    expect(await ws.readFile('proj', '.agent-artifacts/codex-a.stderr.log')).toHaveProperty('error')
    expect(await ws.readFile('proj', '.agent-artifacts/kimi-b.stderr.log')).toHaveProperty('error')
    // 搜索跳过 raw log（文件名与内容都不命中），普通报告仍可检索
    const byContent = await ws.searchFiles('proj', 'SYNTHETIC_PRIVATE') as { matches: Array<{ path: string }> }
    expect(byContent.matches).toEqual([])
    const byName = await ws.searchFiles('proj', 'stdout') as { matches: Array<{ path: string }> }
    expect(byName.matches).toEqual([])
    const report = await ws.searchFiles('proj', 'SYNTHETIC_REPORT') as { matches: Array<{ path: string }> }
    expect(report.matches.some(m => m.path === '.agent-artifacts/review.md')).toBe(true)
    // 列目录过滤 raw log
    const listing = await ws.listFiles('proj', '.agent-artifacts') as { entries: Array<{ name: string }> }
    expect(listing.entries.map(e => e.name)).toEqual(['review.md'])
    // 任务绑定入口：只开放当前任务绑定的 stdout；普通报告可读
    expect(await ws.readArtifact(aOut, aErr, 'codex-a.stdout.log')).not.toHaveProperty('error')
    expect(await ws.readArtifact(aOut, aErr, 'codex-a.stderr.log')).toHaveProperty('error')
    expect(await ws.readArtifact(aOut, aErr, 'kimi-b.stdout.log')).toHaveProperty('error')
    expect(await ws.readArtifact(aOut, aErr, 'kimi-b.stderr.log')).toHaveProperty('error')
    expect(await ws.readArtifact(aOut, aErr, 'review.md')).not.toHaveProperty('error')
    const artListing = await ws.readArtifact(aOut, aErr, '.') as { entries: string[] }
    expect(artListing.entries).toContain('codex-a.stdout.log')
    expect(artListing.entries).toContain('review.md')
    expect(artListing.entries.some(n => n.includes('stderr'))).toBe(false)
    expect(artListing.entries).not.toContain('kimi-b.stdout.log')
    // 合法源码继续可读
    expect(await ws.readFile('proj', 'src/main.ts')).not.toHaveProperty('error')
  } finally { rmSync(root, { recursive: true }) }
})

// W3 复核回归：授权发现根下的未注册项目目录自动可读（delegable 恒 false）；
// 隐藏目录与越根符号链接不发现。
it('项目发现：授权根下未注册目录可读不可委派；越根符号链接与隐藏目录不发现', async () => {
  const root = mkdtempSync('/dev/shm/ws-disc-')
  const outside = mkdtempSync('/dev/shm/ws-out-')
  try {
    mkdirSync(path.join(root, 'registered-proj'))
    mkdirSync(path.join(root, 'new-proj'))
    writeFileSync(path.join(root, 'new-proj', 'NOTE.md'), '新项目笔记\n')
    mkdirSync(path.join(root, '.hidden'))
    symlinkSync(outside, path.join(root, 'escape-link'))
    const ws = new Workspace(
      [{ name: 'registered-proj', path: path.join(root, 'registered-proj'), summary: '已注册', delegable: true }],
      [root],
    )
    const list = await ws.listProjects() as Array<{ name: string; delegable: boolean; registered: boolean }>
    const names = list.map(p => p.name)
    expect(names).toContain('registered-proj')
    expect(names).toContain('new-proj')
    expect(names).not.toContain('.hidden')
    expect(names).not.toContain('escape-link')
    expect(list.find(p => p.name === 'new-proj')).toMatchObject({ delegable: false, registered: false })
    expect(list.find(p => p.name === 'registered-proj')).toMatchObject({ delegable: true, registered: true })
    // 发现的项目可读
    const read = await ws.readFile('new-proj', 'NOTE.md') as { lines: string[] }
    expect(read.lines[0]).toContain('新项目笔记')
    // 发现根本身不存在时如实报错
    const broken = new Workspace([], [path.join(root, 'no-such-root')])
    expect(await broken.listProjects()).toEqual([])
    expect(await broken.listFiles('new-proj', '.')).toHaveProperty('error')
  } finally { rmSync(root, { recursive: true }); rmSync(outside, { recursive: true }) }
})
