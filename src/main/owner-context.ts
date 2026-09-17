import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const ownerContextFileName = 'owner-context.md'
export const maxOwnerContextCharacters = 12_000

/**
 * A deliberately generic starting point. It is created only by the Web
 * entrypoint and is never inferred from conversation history.
 */
export const defaultOwnerContextTemplate = [
  '# Owner context',
  '',
  'This is an explicit, user-maintained background for future main-agent conversations.',
  'Edit and save it deliberately when you want to provide stable context.',
  '',
  'It is not automatic memory. The agent cannot create tasks, memories, claims, or take external actions.',
].join('\n')

function verifyPrivatePath(pathname: string, expectedMode: number, kind: 'directory' | 'file'): void {
  if (process.platform !== 'linux') return
  const stats = statSync(pathname)
  if ((kind === 'directory' && !stats.isDirectory()) || (kind === 'file' && !stats.isFile())) {
    throw new Error(`${pathname} must be a ${kind}`)
  }
  const currentUserId = process.getuid?.()
  if (currentUserId === undefined || stats.uid !== currentUserId) {
    throw new Error(`${pathname} must be owned by the current user`)
  }
  if ((stats.mode & 0o777) !== expectedMode) throw new Error(`${pathname} must have mode ${expectedMode.toString(8)}`)
}

function ownerContextPath(dataDirectory: string): string {
  if (!dataDirectory.trim()) throw new Error('dataDirectory must not be empty')
  return path.join(dataDirectory, ownerContextFileName)
}

/**
 * Refuse a selected location that could make private context visible to Git.
 * This deliberately does not invoke Git: missing executables, config, or
 * repository corruption must never turn the privacy check into an allow.
 */
function assertOutsideGitWorkTree(dataDirectory: string): void {
  if (!dataDirectory.trim()) throw new Error('dataDirectory must not be empty')
  let candidate = path.resolve(dataDirectory)
  const missingSegments: string[] = []
  while (true) {
    try {
      lstatSync(candidate)
      try {
        candidate = path.join(realpathSync(candidate), ...missingSegments.reverse())
        break
      } catch {
        throw new Error('Unable to verify whether owner context dataDirectory is outside a Git worktree')
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      const parent = path.dirname(candidate)
      if (parent === candidate) {
        throw new Error('Unable to verify whether owner context dataDirectory is outside a Git worktree')
      }
      missingSegments.push(path.basename(candidate))
      candidate = parent
    }
  }
  let probe = candidate
  while (true) {
    if (path.basename(probe) === '.git') {
      throw new Error('owner context dataDirectory must be outside a Git worktree')
    }
    try {
      lstatSync(path.join(probe, '.git'))
      throw new Error('owner context dataDirectory must be outside a Git worktree')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // No Git marker at this ancestor; keep walking to the filesystem root.
      } else if (error instanceof Error && error.message === 'owner context dataDirectory must be outside a Git worktree') {
        throw error
      } else {
        throw new Error('Unable to verify whether owner context dataDirectory is outside a Git worktree')
      }
    }
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
}

function verifyPrivateDirectory(dataDirectory: string): void {
  if (!statSync(dataDirectory).isDirectory()) throw new Error('dataDirectory must be a directory')
  chmodSync(dataDirectory, 0o700)
  verifyPrivatePath(dataDirectory, 0o700, 'directory')
}

export function validateOwnerContext(content: string): void {
  if (typeof content !== 'string' || !content.trim()) throw new Error('owner context must not be empty')
  if (content.length > maxOwnerContextCharacters) {
    throw new Error(`owner context must not exceed ${maxOwnerContextCharacters} characters`)
  }
}

/** Creates the generic file once and never overwrites an existing user edit. */
export function initializeOwnerContext(dataDirectory: string): string {
  assertOutsideGitWorkTree(dataDirectory)
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  verifyPrivateDirectory(dataDirectory)
  const filename = ownerContextPath(dataDirectory)
  if (!existsSync(filename)) {
    writeFileSync(filename, defaultOwnerContextTemplate, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  }
  if (lstatSync(filename).isSymbolicLink() || !statSync(filename).isFile()) {
    throw new Error('owner context must be a regular file')
  }
  chmodSync(filename, 0o600)
  verifyPrivatePath(filename, 0o600, 'file')
  return filename
}

export function readOwnerContext(dataDirectory: string): string {
  const filename = initializeOwnerContext(dataDirectory)
  const content = readFileSync(filename, 'utf8')
  validateOwnerContext(content)
  return content
}

/** Replaces the file atomically inside the already-private data directory. */
export function saveOwnerContext(dataDirectory: string, content: string): void {
  validateOwnerContext(content)
  const filename = initializeOwnerContext(dataDirectory)
  const temporary = path.join(dataDirectory, `.${ownerContextFileName}.next`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, filename)
    chmodSync(filename, 0o600)
    verifyPrivatePath(filename, 0o600, 'file')
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Stable checkpoint material supplied only from an explicitly saved file. */
export function ownerContextCheckpoint(content: string): string {
  validateOwnerContext(content)
  return [
    '显式主人上下文（用户可查看、编辑和保存；不是自动记忆，也不代表任务、认识或授权）：',
    content,
  ].join('\n\n')
}
