import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainWebAuth, sessionFromCookie, validateWriteOrigin } from '../src/main/web-auth.js'

// Ignore only the sandbox's synthetic /tmp Git marker for disposable fixtures.
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === '/tmp/.git') throw Object.assign(new Error('fixture root'), { code: 'ENOENT' })
    return fs.lstatSync(...args)
  } }
})

describe('private web credentials', () => {
  let directory: string
  let now: number
  let auth: MainWebAuth
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'web-auth-')); now = Date.now(); auth = new MainWebAuth(directory, () => now) })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  it('stores only salted password and session hashes, persisting authentication across restart', async () => {
    const bootstrap = auth.setupToken!
    const session = await auth.setup('test password 123', bootstrap)
    expect(auth.setupToken).toBeUndefined()
    const saved = readFileSync(path.join(directory, 'web-auth.json'), 'utf8')
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(directory, 'web-auth.json')).mode & 0o777).toBe(0o600)
    for (const secret of [bootstrap, session, 'test password 123']) expect(saved).not.toContain(secret)
    auth = new MainWebAuth(directory, () => now)
    expect(auth.setupToken).toBeUndefined()
    expect(auth.authorized(session)).toBe(true)
    await expect(auth.setup('new password', bootstrap)).rejects.toThrow()
    expect(auth.authorized(await auth.login('test password 123'))).toBe(true)
    auth.logout(session)
    expect(auth.authorized(session)).toBe(false)
  })
  it('invalidates prior startup setup capability and prevents concurrent setup', async () => {
    const old = auth.setupToken
    auth = new MainWebAuth(directory, () => now)
    await expect(auth.setup('test password', old)).rejects.toThrow()
    const results = await Promise.allSettled([auth.setup('test password', auth.setupToken), auth.setup('second password', auth.setupToken)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  })
  it('bounds password input, rate limits failures and expires sessions', async () => {
    for (const password of ['', '1234567', 'x'.repeat(257)]) await expect(auth.setup(password, auth.setupToken)).rejects.toThrow()
    const session = await auth.setup('test password', auth.setupToken)
    for (let i = 0; i < 5; i++) await expect(auth.login('wrong password')).rejects.toThrow('密码不正确')
    await expect(auth.login('test password')).rejects.toThrow('尝试过于频繁')
    now += 60_001
    expect(auth.authorized(await auth.login('test password'))).toBe(true)
    now += 30 * 24 * 60 * 60 * 1000
    expect(auth.authorized(session)).toBe(false)
  })
  it('extracts exact cookie name and validates origin', () => {
    expect(sessionFromCookie('other=x; agents_main_session=abc; last=y')).toBe('abc')
    expect(sessionFromCookie('other_agents_main_session=abc')).toBeUndefined()
    expect(validateWriteOrigin('https://host.ts.net', 'host.ts.net')).toEqual({ secure: true })
    expect(validateWriteOrigin('null', 'host.ts.net')).toBeUndefined()
    expect(validateWriteOrigin('https://evil.test', 'host.ts.net')).toBeUndefined()
    expect(validateWriteOrigin('http://host.ts.net', 'host.ts.net')).toBeUndefined()
  })
  it('refuses symlinked authentication files', () => {
    const filename = path.join(directory, 'web-auth.json')
    rmSync(filename)
    symlinkSync(path.join(directory, 'owner-context.md'), filename)
    expect(() => new MainWebAuth(directory)).toThrow('Unsafe web auth file')
  })
})
