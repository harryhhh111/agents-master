import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { it, expect } from 'vitest'
import {
  createWebReleasePlan,
  findEscapingSymlinks,
  findForbiddenReleasePaths,
  packageWebRelease,
  parsePackageReleaseArguments,
} from '../scripts/package-web-release.js'
import { readPackagedReleaseId } from '../scripts/main-web.js'

const readProjectFile = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

it('发布参数严格校验,默认 release 根目录在私有数据区', () => {
  expect(parsePackageReleaseArguments(['--channel', 'main-web'], '/home/synthetic')).toEqual({
    channel: 'main-web',
    releaseRoot: '/home/synthetic/.local/share/agents-master/releases',
    releaseId: undefined,
    skipInstall: false,
    dryRun: false,
  })
  expect(parsePackageReleaseArguments([
    '--channel', 'preview-worker',
    '--release-root', '/srv/releases',
    '--release-id', 'step-c.1',
    '--dry-run',
  ], '/home/synthetic')).toEqual({
    channel: 'preview-worker',
    releaseRoot: '/srv/releases',
    releaseId: 'step-c.1',
    skipInstall: false,
    dryRun: true,
  })
  expect(() => parsePackageReleaseArguments(['--channel', 'bad'], '/home/synthetic')).toThrow('未知发布通道')
  expect(() => parsePackageReleaseArguments(['--channel', 'main-web', '--channel', 'preview-worker'], '/home/synthetic')).toThrow('只能指定一次')
  expect(() => parsePackageReleaseArguments(['--channel', 'main-web', '--release-id', 'current'], '/home/synthetic')).toThrow('不安全')
  expect(() => parsePackageReleaseArguments(['--channel', 'main-web', '--release-id', '../escape'], '/home/synthetic')).toThrow('不安全')
})

it('稳定入口与预览 worker 使用相互独立的不可变 release 目录', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const stable = createWebReleasePlan({
    channel: 'main-web',
    releaseRoot: '/srv/releases',
    skipInstall: false,
    dryRun: true,
  }, commit)
  const preview = createWebReleasePlan({
    channel: 'preview-worker',
    releaseRoot: '/srv/releases',
    skipInstall: false,
    dryRun: true,
  }, commit)
  expect(stable.destination).toBe('/srv/releases/main-web/0123456789ab')
  expect(preview.destination).toBe('/srv/releases/preview-worker/0123456789ab')
  expect(stable.destination).not.toBe(preview.destination)
  expect(stable.current).toBe('/srv/releases/main-web/current')
  expect(preview.current).toBe('/srv/releases/preview-worker/current')
})

it('相对 --release-root 解析为绝对路径,current 链接不会断链', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const plan = createWebReleasePlan({
    channel: 'main-web',
    releaseRoot: 'relative-releases',
    skipInstall: false,
    dryRun: true,
  }, commit)
  expect(path.isAbsolute(plan.releaseRoot)).toBe(true)
  expect(path.isAbsolute(plan.destination)).toBe(true)
  expect(plan.current).toBe(path.join(plan.releaseRoot, 'main-web', 'current'))
})

it('发布目录拒绝密钥、凭据与个人数据路径,放行深层同名源码目录', () => {
  expect(findForbiddenReleasePaths(['.env', 'config/.env.local', 'state/stock_data/x.db', '.agent-artifacts/r.md', 'a.pem', 'b.key', 'id_rsa', 'x/id_ed25519', '.git/config', 'sessions/wire.jsonl', 'sessions/.env.template'])).toEqual([
    '.env', 'config/.env.local', 'state/stock_data/x.db', '.agent-artifacts/r.md', 'a.pem', 'b.key', 'id_rsa', 'x/id_ed25519', '.git/config', 'sessions/wire.jsonl', 'sessions/.env.template',
  ])
  expect(findForbiddenReleasePaths(['src/main.ts', 'docs/roadmap.md', '.env.example', 'deploy/agents-master-web.service', 'package.json', 'src/state/store.ts', 'src/sessions/index.ts', 'src/agent/.env.sample'])).toEqual([])
})

it('链式、悬空与成环符号链接均视为逃逸,发布目录内部链接放行', () => {
  const root = mkdtempSync('/dev/shm/web-release-links-')
  try {
    mkdirSync(path.join(root, 'sub'), { recursive: true })
    writeFileSync(path.join(root, 'safe.txt'), 'x')
    symlinkSync('/etc/passwd', path.join(root, 'direct'))
    symlinkSync('direct', path.join(root, 'chained'))
    symlinkSync('../chained', path.join(root, 'sub', 'deep'))
    symlinkSync('safe.txt', path.join(root, 'internal'))
    symlinkSync('missing.txt', path.join(root, 'dangling'))
    symlinkSync('cycle-b', path.join(root, 'cycle-a'))
    symlinkSync('cycle-a', path.join(root, 'cycle-b'))
    const files = ['direct', 'chained', 'sub/deep', 'internal', 'dangling', 'cycle-a', 'cycle-b', 'safe.txt']
    expect(findEscapingSymlinks(root, files).sort()).toEqual(['chained', 'cycle-a', 'cycle-b', 'dangling', 'direct', 'sub/deep'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('词法折叠掩盖的链式 .. 逃逸与子目录绝对链接均拒绝', () => {
  const root = mkdtempSync('/dev/shm/web-release-links2-')
  try {
    // fake/../secret 词法折叠后是 root 内同名文件,但 fake 是链接时真实解析为 /etc/../secret
    writeFileSync(path.join(root, 'secret'), 'harmless inside')
    symlinkSync('/etc', path.join(root, 'fake'))
    symlinkSync('fake/../secret', path.join(root, 'folded'))
    // 子目录里的绝对链接,目录内恰好存在对应相对路径文件
    mkdirSync(path.join(root, 'sub', 'etc'), { recursive: true })
    writeFileSync(path.join(root, 'sub', 'etc', 'passwd'), 'decoy')
    symlinkSync('/etc/passwd', path.join(root, 'sub', 'absolute'))
    const files = ['fake', 'folded', 'secret', 'sub/absolute', 'sub/etc/passwd']
    expect(findEscapingSymlinks(root, files).sort()).toEqual(['fake', 'folded', 'sub/absolute'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('发布标识从 release.json 读取,缺失或非法时回退常量', () => {
  const root = mkdtempSync('/dev/shm/web-release-manifest-')
  try {
    expect(readPackagedReleaseId(root, 'fallback-id')).toBe('fallback-id')
    writeFileSync(path.join(root, 'release.json'), JSON.stringify({ releaseId: 'step-c.2', channel: 'main-web' }))
    expect(readPackagedReleaseId(root, 'fallback-id')).toBe('step-c.2')
    writeFileSync(path.join(root, 'release.json'), JSON.stringify({ releaseId: '../escape' }))
    expect(readPackagedReleaseId(root, 'fallback-id')).toBe('fallback-id')
    writeFileSync(path.join(root, 'release.json'), 'not json')
    expect(readPackagedReleaseId(root, 'fallback-id')).toBe('fallback-id')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('dry-run 只返回计划,不创建发布目录,并记录当前 Git 提交', async () => {
  const root = mkdtempSync('/dev/shm/web-release-plan-')
  try {
    const plan = await packageWebRelease([
      '--channel', 'preview-worker',
      '--release-root', root,
      '--release-id', 'synthetic-dry-run',
      '--dry-run',
    ], process.cwd())
    expect(plan.releaseId).toBe('synthetic-dry-run')
    expect(plan.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(plan.destination)).toBe(false)
    expect(existsSync(path.join(root, 'preview-worker'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('release service 模板固定到 release current,不依赖可变 Git 工作树', () => {
  const stable = readProjectFile('deploy/agents-master-web-release.service')
  const previewSwitch = readProjectFile('deploy/agents-master-web-release.service.d/preview.conf')
  const worker = readProjectFile('deploy/agents-master-preview-worker.service')

  for (const content of [stable, previewSwitch, worker]) {
    expect(content).toContain('/home/vinci/.local/share/agents-master/releases/')
    expect(content).not.toContain('/home/vinci/projects/agents-master')
  }
  for (const content of [stable, worker]) expect(content).toContain('UMask=0077')
  // 部署时实测调整：工作目录固定到 release current，入口用相对 scripts 路径，
  // 避免经 current 软链接的绝对脚本路径导致入口判断被跳过。
  expect(stable).toContain('WorkingDirectory=/home/vinci/.local/share/agents-master/releases/main-web/current')
  expect(stable).toContain('releases/main-web/current/node_modules/tsx/dist/cli.mjs scripts/main-web.ts')
  expect(stable).not.toContain('--preview-socket')
  expect(stable).toContain('Environment=DOTENV_CONFIG_PATH=/home/vinci/.config/agents-master/env')
  expect(previewSwitch).toContain('ExecStart=')
  expect(previewSwitch).toContain('--preview-socket /home/vinci/.local/share/agents-master/run/preview.sock')
  expect(previewSwitch).toContain('Wants=agents-master-preview-worker.service')

  expect(worker).toContain('WorkingDirectory=/home/vinci/.local/share/agents-master/releases/preview-worker/current')
  expect(worker).toContain('releases/preview-worker/current/node_modules/tsx/dist/cli.mjs scripts/preview-worker.ts')
  expect(worker).toContain('--data-dir /home/vinci/.local/share/agents-master/main-chat-preview')
  expect(worker).toContain('--socket /home/vinci/.local/share/agents-master/run/preview.sock')
  // 真实模型模式：凭据只经 DOTENV_CONFIG_PATH 私有文件供给，缺省 demo 才用 /dev/null。
  expect(worker).toContain('--model real')
  expect(worker).toContain('DOTENV_CONFIG_PATH=/home/vinci/.config/agents-master/env')
  // 真实 CLI 执行：白名单项目委派由 worker 内 executor 完成，PATH 需含三个 CLI 的 bin 目录。
  expect(worker).toContain('--executor cli')
  expect(worker).toContain('/home/vinci/.local/bin')
  expect(worker).toContain('/home/vinci/.kimi-code/bin')
  expect(worker).toContain('/usr/bin/env -i HOME=/home/vinci PATH=')
  expect(worker).not.toContain('\nEnvironment=')
  expect(worker).not.toContain('--port')
  expect(worker).not.toContain('EnvironmentFile')
  expect(worker).not.toContain('dotenv/config')
})

it('运行手册明确未部署、备份、预览先关闭、验收和回退边界', () => {
  const runbook = readProjectFile('docs/web-version-switch-runbook.md')
  expect(runbook).toContain('尚未安装、未重启现网、未迁移数据')
  expect(runbook).toContain('预览保持关闭')
  expect(runbook).toContain('备份与冻结基线')
  expect(runbook).toContain('回退到旧服务')
  expect(runbook).toContain('真实模型/CLI')
  expect(runbook).toContain('不读取生产聊天')
  expect(runbook).toContain('DOTENV_CONFIG_PATH=/dev/null')
  expect(runbook).toContain('/home/vinci/.config/agents-master/env')
  expect(runbook).toContain('source-manifest.sha256')
  expect(runbook).toContain('返回稳定版')
})
