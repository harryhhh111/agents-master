import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const webReleaseChannels = ['main-web', 'preview-worker'] as const
export type WebReleaseChannel = (typeof webReleaseChannels)[number]

export interface PackageWebReleaseArguments {
  channel: WebReleaseChannel
  releaseRoot: string
  releaseId?: string
  skipInstall: boolean
  dryRun: boolean
}

export interface WebReleasePlan {
  channel: WebReleaseChannel
  releaseRoot: string
  releaseId: string
  sourceCommit: string
  destination: string
  current: string
}

function usage(): string {
  return 'Use --channel main-web|preview-worker [--release-root DIRECTORY] [--release-id ID] [--skip-install] [--dry-run]'
}

export function parsePackageReleaseArguments(args: readonly string[], homeDirectory = homedir()): PackageWebReleaseArguments {
  let channel: WebReleaseChannel | undefined
  let releaseRoot = path.join(homeDirectory, '.local', 'share', 'agents-master', 'releases')
  let releaseId: string | undefined
  let sawReleaseRoot = false
  let sawReleaseId = false
  let skipInstall = false
  let dryRun = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const value = args[index + 1]
    if (arg === '--channel') {
      if (channel !== undefined) throw new Error('--channel 只能指定一次')
      if (!webReleaseChannels.includes(value as WebReleaseChannel)) throw new Error(`未知发布通道: ${value ?? ''}`)
      channel = value as WebReleaseChannel
      index += 1
      continue
    }
    if (arg === '--release-root') {
      if (sawReleaseRoot) throw new Error('--release-root 只能指定一次')
      if (!value || !value.trim()) throw new Error('--release-root 需要一个非空目录')
      releaseRoot = value
      sawReleaseRoot = true
      index += 1
      continue
    }
    if (arg === '--release-id') {
      if (sawReleaseId) throw new Error('--release-id 只能指定一次')
      if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) || value === '.' || value === '..' || value === 'current') throw new Error('--release-id 含有不安全字符')
      releaseId = value
      sawReleaseId = true
      index += 1
      continue
    }
    if (arg === '--skip-install') {
      skipInstall = true
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    throw new Error(`${usage()}; unknown argument: ${arg ?? ''}`)
  }
  if (!channel) throw new Error(usage())
  return { channel, releaseRoot, releaseId, skipInstall, dryRun }
}

function run(command: string, args: string[], options: { cwd: string; input?: Buffer; env?: NodeJS.ProcessEnv }): Buffer {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    env: options.env ?? process.env,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

function gitOutput(repoRoot: string, args: string[]): string {
  return run('git', args, { cwd: repoRoot }).toString('utf8').trim()
}

export function createWebReleasePlan(options: PackageWebReleaseArguments, sourceCommit: string): WebReleasePlan {
  const releaseId = options.releaseId ?? sourceCommit.slice(0, 12)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(releaseId) || releaseId === '.' || releaseId === '..' || releaseId === 'current') throw new Error('releaseId 不安全')
  const releaseRoot = path.resolve(options.releaseRoot)
  const channelRoot = path.join(releaseRoot, options.channel)
  return {
    channel: options.channel,
    releaseRoot,
    releaseId,
    sourceCommit,
    destination: path.join(channelRoot, releaseId),
    current: path.join(channelRoot, 'current'),
  }
}

/** 仅仓库根部的数据/产物目录禁止进入 release；深层同名源码目录（如 src/state/、src/sessions/）不受影响。 */
const forbiddenRootPath = /^(?:\.git|\.agent-artifacts|state|sessions)(?:\/|$)/
/** 任意层级都禁止的敏感文件名（basename 匹配）。 */
const forbiddenBasename = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa).*)$|\.(?:pem|key)$/
const allowedEnvTemplates = new Set(['.env.example', '.env.sample', '.env.template'])

export function findForbiddenReleasePaths(files: readonly string[]): string[] {
  return files.filter(file => {
    if (forbiddenRootPath.test(file)) return true
    const base = path.basename(file)
    if (allowedEnvTemplates.has(base)) return false
    return forbiddenBasename.test(base)
  })
}

function collectReleaseFiles(root: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...collectReleaseFiles(path.join(root, entry.name), relative))
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative)
  }
  return files
}

/** 符号链接以 link:目标 参与哈希；既进入清单也能被名称扫描看到。 */
function hashReleaseFile(root: string, file: string): string {
  const full = path.join(root, file)
  const content = lstatSync(full).isSymbolicLink() ? `link:${readlinkSync(full)}` : readFileSync(full)
  return createHash('sha256').update(content).digest('hex')
}

/** 逃逸发布目录的符号链接一律拒绝。解析不做事前词法折叠：`..` 在符号链接组件上的
 *  折叠是错的（fake/../x 中 fake 若是链接，真实解析先进入 fake 的目标再回退），
 *  因此逐组件模拟内核解析：dirStack 只保留已验证的真实目录；遇到链接组件就展开其
 *  目标继续处理。绝对目标、逃出根、悬空、穿越非目录、成环或超步数上限都算逃逸。 */
export function findEscapingSymlinks(root: string, files: readonly string[]): string[] {
  return files.filter(file => lstatSync(path.join(root, file)).isSymbolicLink() && symlinkEscapes(root, file))
}

function symlinkEscapes(root: string, startFile: string): boolean {
  // 收集清单只深入真实目录，起始路径的目录前缀必然是真实目录。
  const startDir = path.dirname(startFile)
  const dirStack = startDir === '.' ? [] : startDir.split('/')
  const seenLinks = new Set([startFile])
  let target = readlinkSync(path.join(root, startFile))
  if (path.isAbsolute(target)) return true
  const components = target.split('/')
  for (let guard = 0; guard < 400; guard += 1) {
    if (components.length === 0) return false
    const component = components.shift()!
    if (component === '' || component === '.') continue
    if (component === '..') {
      if (dirStack.length === 0) return true
      dirStack.pop()
      continue
    }
    dirStack.push(component)
    const relative = dirStack.join('/')
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(path.join(root, relative)) } catch { return true }
    if (stat.isSymbolicLink()) {
      if (seenLinks.has(relative)) return true
      seenLinks.add(relative)
      const next = readlinkSync(path.join(root, relative))
      if (path.isAbsolute(next)) return true
      // 该链接的后续组件相对于链接所在目录继续解析
      dirStack.pop()
      components.unshift(...next.split('/'))
      continue
    }
    if (!stat.isDirectory()) return components.length > 0
  }
  return true
}

function hashReleaseFiles(root: string, files: readonly string[]): string {
  return files.map(file => `${hashReleaseFile(root, file)}  ${file}`).join('\n') + '\n'
}

export async function packageWebRelease(args: readonly string[], repoRoot = process.cwd()): Promise<WebReleasePlan> {
  const options = parsePackageReleaseArguments(args)
  const sourceCommit = gitOutput(repoRoot, ['rev-parse', 'HEAD'])
  const plan = createWebReleasePlan(options, sourceCommit)
  const dirty = gitOutput(repoRoot, ['status', '--porcelain'])
  if (dirty && !options.dryRun) throw new Error('只能从干净 Git 工作树打包；请先提交或清理改动。')
  if (options.dryRun) return plan
  const resolvedRepo = path.resolve(repoRoot)
  if (plan.releaseRoot === resolvedRepo || plan.releaseRoot.startsWith(`${resolvedRepo}${path.sep}`)) {
    throw new Error('发布根目录必须位于 Git 工作树之外。')
  }
  if (existsSync(plan.destination)) throw new Error(`发布目录已存在，拒绝覆盖: ${plan.destination}`)
  let currentStat: ReturnType<typeof lstatSync> | undefined
  try { currentStat = lstatSync(plan.current) } catch { currentStat = undefined }
  if (currentStat && !currentStat.isSymbolicLink()) throw new Error(`current 路径不是发布链接，拒绝替换: ${plan.current}`)

  let created = false
  try {
    mkdirSync(plan.destination, { recursive: true, mode: 0o700 })
    created = true
    const archive = run('git', ['archive', '--format=tar', plan.sourceCommit], { cwd: repoRoot })
    run('tar', ['-xf', '-', '-C', plan.destination], { cwd: repoRoot, input: archive })
    const sourceFiles = collectReleaseFiles(plan.destination).sort()
    const forbidden = findForbiddenReleasePaths(sourceFiles)
    if (forbidden.length > 0) throw new Error(`发布目录含有禁止打包的路径: ${forbidden.slice(0, 5).join(', ')}`)
    const escaping = findEscapingSymlinks(plan.destination, sourceFiles)
    if (escaping.length > 0) throw new Error(`发布目录含有逃逸发布目录的符号链接: ${escaping.slice(0, 5).join(', ')}`)
    const manifest = hashReleaseFiles(plan.destination, sourceFiles)
    writeFileSync(path.join(plan.destination, 'source-manifest.sha256'), manifest, { mode: 0o600 })
    writeFileSync(path.join(plan.destination, 'release.json'), `${JSON.stringify({
      channel: plan.channel,
      releaseId: plan.releaseId,
      sourceCommit: plan.sourceCommit,
      createdAt: new Date().toISOString(),
      sourceFileCount: sourceFiles.length,
      sourceManifestSha256: createHash('sha256').update(manifest).digest('hex'),
    }, null, 2)}\n`, { mode: 0o600 })
    if (!options.skipInstall) {
      run('pnpm', ['install', '--frozen-lockfile'], {
        cwd: plan.destination,
        env: {
          HOME: process.env.HOME ?? homedir(),
          PATH: process.env.PATH ?? '',
          CI: 'true',
          DOTENV_CONFIG_PATH: '/dev/null',
        },
      })
    }
    const temporaryCurrent = path.join(path.dirname(plan.current), `.current.${process.pid}.tmp`)
    rmSync(temporaryCurrent, { force: true })
    symlinkSync(plan.destination, temporaryCurrent, 'dir')
    renameSync(temporaryCurrent, plan.current)
    return plan
  } catch (error) {
    if (created) rmSync(plan.destination, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  packageWebRelease(process.argv.slice(2))
    .then(plan => { process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`) })
    .catch(error => { console.error((error as Error).message); process.exitCode = 1 })
}
