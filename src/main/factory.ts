import { chmodSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { SQLiteMainInboxStore, type SQLiteMainInboxStoreOptions } from './inbox.js'
import { MainAgentRuntime } from './runtime.js'

export interface MainAgentRuntimeFactoryOptions extends SQLiteMainInboxStoreOptions {
  /** Required composition-owned directory; stores never create it themselves. */
  dataDirectory: string
  databaseFileName?: string
}

export interface MainAgentRuntimeResources {
  databasePath: string
  store: SQLiteMainInboxStore
  runtime: MainAgentRuntime
  close(): void
}

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

/** Composition root for the Stage 1.2a runtime storage. */
export function createMainAgentRuntime(options: MainAgentRuntimeFactoryOptions): MainAgentRuntimeResources {
  if (!options.dataDirectory.trim()) throw new Error('dataDirectory must not be empty')
  const databaseFileName = options.databaseFileName ?? 'main-agent.sqlite'
  if (!databaseFileName || path.basename(databaseFileName) !== databaseFileName) {
    throw new Error('databaseFileName must be a file name, not a path')
  }
  mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 })
  if (!statSync(options.dataDirectory).isDirectory()) throw new Error('dataDirectory must be a directory')
  chmodSync(options.dataDirectory, 0o700)
  verifyPrivatePath(options.dataDirectory, 0o700, 'directory')

  const databasePath = path.join(options.dataDirectory, databaseFileName)
  const store = new SQLiteMainInboxStore(databasePath, { clock: options.clock })
  chmodSync(databasePath, 0o600)
  verifyPrivatePath(databasePath, 0o600, 'file')
  return {
    databasePath,
    store,
    runtime: new MainAgentRuntime(store),
    close: () => store.close(),
  }
}
