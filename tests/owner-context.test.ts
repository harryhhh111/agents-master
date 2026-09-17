import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultOwnerContextTemplate,
  initializeOwnerContext,
  ownerContextCheckpoint,
  readOwnerContext,
  saveOwnerContext,
} from '../src/main/owner-context.js'

describe('owner context', () => {
  let directory: string

  beforeEach(() => {
    // The contract deliberately rejects a temp directory if its ancestor has
    // a .git marker. Linux offers an independent volatile filesystem for this
    // focused filesystem test, so an unrelated /tmp worktree cannot mask the
    // behavior under test.
    directory = mkdtempSync(path.join(process.platform === 'linux' ? '/dev/shm' : tmpdir(), 'owner-context-test-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates only a generic template, preserves explicit saves, and keeps private modes where supported', () => {
    const filename = initializeOwnerContext(directory)
    expect(readOwnerContext(directory)).toBe(defaultOwnerContextTemplate)
    const explicit = 'Explicit background maintained by the owner.'
    saveOwnerContext(directory, explicit)
    initializeOwnerContext(directory)
    expect(readOwnerContext(directory)).toBe(explicit)
    if (process.platform === 'linux') {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(filename).mode & 0o777).toBe(0o600)
      expect(statSync(filename).uid).toBe(process.getuid?.())
    }
  })

  it('rejects empty or oversized values without replacing the saved context', () => {
    initializeOwnerContext(directory)
    saveOwnerContext(directory, 'A bounded explicit context.')
    expect(() => saveOwnerContext(directory, '   ')).toThrow('owner context must not be empty')
    expect(() => saveOwnerContext(directory, 'x'.repeat(12_001))).toThrow('owner context must not exceed 12000 characters')
    expect(readOwnerContext(directory)).toBe('A bounded explicit context.')
  })

  it('marks owner context as explicit stable material rather than automatic memory', () => {
    const checkpoint = ownerContextCheckpoint('A bounded explicit context.')
    expect(checkpoint).toContain('显式主人上下文')
    expect(checkpoint).toContain('不是自动记忆')
  })

  it('refuses a selected directory inside a Git worktree before creating context there', () => {
    expect(() => initializeOwnerContext(process.cwd())).toThrow('outside a Git worktree')
  })

  it('detects both ordinary and linked-worktree filesystem Git markers before creating a data directory', () => {
    const ordinary = path.join(directory, 'ordinary')
    mkdirSync(path.join(ordinary, '.git'), { recursive: true })
    expect(() => initializeOwnerContext(path.join(ordinary, 'private-data'))).toThrow('outside a Git worktree')

    const linked = path.join(directory, 'linked')
    mkdirSync(linked)
    writeFileSync(path.join(linked, '.git'), 'gitdir: /private/git/worktrees/linked\n')
    expect(() => initializeOwnerContext(path.join(linked, 'private-data'))).toThrow('outside a Git worktree')

    const throughSymlink = path.join(directory, 'symlink-to-this-repository')
    symlinkSync(process.cwd(), throughSymlink)
    expect(() => initializeOwnerContext(path.join(throughSymlink, 'private-data'))).toThrow('outside a Git worktree')
  })
})
