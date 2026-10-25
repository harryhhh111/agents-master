import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
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

it('list_projects/list_files/read_file/search_files 基本行为与截断标注', () => {
  const { root, ws } = fixture()
  try {
    const projects = ws.listProjects() as Array<{ name: string; summary: string; delegable: boolean; readable: boolean }>
    expect(projects).toEqual([{ name: 'proj', path: path.join(root, 'proj'), summary: '合成项目', readable: true, delegable: true }])

    const listing = ws.listFiles('proj', '.') as { entries: Array<{ name: string }>; truncated: boolean }
    const names = listing.entries.map(e => e.name)
    expect(names).toContain('src/')
    expect(names).toContain('README.md')
    expect(names).not.toContain('.env')
    expect(listing.truncated).toBe(false)

    const read = ws.readFile('proj', 'src/main.ts', 1) as { lines: string[]; totalLines: number; truncated: boolean }
    expect(read.lines[0]).toBe('1: const answer = 42')
    expect(read.totalLines).toBe(3)
    const tail = ws.readFile('proj', 'src/main.ts', 99) as { note?: string }
    expect(tail.note).toContain('超出文件末尾')

    const hit = ws.searchFiles('proj', 'answer') as { matches: Array<{ path: string; line?: number }> }
    expect(hit.matches.some(m => m.path === 'src/main.ts' && m.line === 1)).toBe(true)
    // node_modules 默认跳过
    expect(hit.matches.some(m => m.path.includes('node_modules'))).toBe(false)
    const byName = ws.searchFiles('proj', 'readme') as { matches: Array<{ path: string }> }
    expect(byName.matches.some(m => m.path === 'README.md')).toBe(true)

    expect(ws.listFiles('proj', 'nope')).toHaveProperty('error')
    expect(ws.listFiles('unknown', '.')).toHaveProperty('error')
  } finally { rmSync(root, { recursive: true }) }
})

it('路径安全：绝对路径、.. 逃逸、符号链接逃逸、凭据文件一律拒绝', () => {
  const { root, ws } = fixture()
  try {
    const outside = path.join(root, 'outside.txt')
    writeFileSync(outside, 'outside secret\n')
    expect(ws.readFile('proj', '/etc/passwd', 1)).toHaveProperty('error')
    expect(ws.readFile('proj', '../outside.txt', 1)).toHaveProperty('error')
    expect(ws.readFile('proj', 'a/../../outside.txt', 1)).toHaveProperty('error')
    expect(ws.readFile('proj', '.env', 1)).toHaveProperty('error')
    expect(ws.readFile('proj', 'sub/.env.local', 1)).toHaveProperty('error')
    // 符号链接逃逸：项目内链接指向项目外
    symlinkSync(outside, path.join(root, 'proj', 'src', 'escape.txt'))
    expect(ws.readFile('proj', 'src/escape.txt', 1)).toHaveProperty('error')
    // 子目录里的绝对符号链接同样拒绝
    symlinkSync('/', path.join(root, 'proj', 'src', 'abs-link'))
    expect(ws.listFiles('proj', 'src/abs-link')).toHaveProperty('error')
  } finally { rmSync(root, { recursive: true }) }
})

it('project_status：真实 Git 仓返回分支/HEAD/未提交数；非 Git 目录如实报错', () => {
  const { root, ws } = fixture()
  try {
    expect(ws.projectStatus('proj')).toHaveProperty('error')
    const git = (args: string[]) => execFileSync('git', ['-C', path.join(root, 'proj'), ...args], { encoding: 'utf8' })
    git(['init', '-b', 'main'])
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'synthetic init'])
    const status = ws.projectStatus('proj') as { branch: string; head: string; uncommittedChanges: number; recentCommits: string[]; readAt: string }
    expect(status.branch).toBe('main')
    expect(status.head).toContain('synthetic init')
    expect(status.recentCommits).toHaveLength(1)
    writeFileSync(path.join(root, 'proj', 'dirty.txt'), 'x\n')
    expect((ws.projectStatus('proj') as { uncommittedChanges: number }).uncommittedChanges).toBe(1)
  } finally { rmSync(root, { recursive: true }) }
})

it('read_artifact：产物目录内读取与列目录；stderr 与越界拒绝', () => {
  const { root, ws } = fixture()
  try {
    const dir = path.join(root, 'proj', '.agent-artifacts', 'run-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'stdout.log'), '执行输出第一行\n第二行\n')
    writeFileSync(path.join(dir, 'stderr.log'), 'debug noise\n')
    writeFileSync(path.join(dir, 'report.md'), '# 报告\n')
    const stdoutPath = path.join(dir, 'stdout.log')
    const stderrPath = path.join(dir, 'stderr.log')
    const read = ws.readArtifact(stdoutPath, stderrPath, 'stdout.log') as { lines: string[] }
    expect(read.lines[0]).toBe('1: 执行输出第一行')
    expect(ws.readArtifact(stdoutPath, stderrPath, 'stderr.log')).toHaveProperty('error')
    expect(ws.readArtifact(stdoutPath, stderrPath, '../../README.md')).toHaveProperty('error')
    const listing = ws.readArtifact(stdoutPath, stderrPath, '.') as { entries: string[] }
    expect(listing.entries).toContain('report.md')
  } finally { rmSync(root, { recursive: true }) }
})
