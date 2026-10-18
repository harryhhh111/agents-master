import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { initializeOwnerContext } from './owner-context.js'

export const mainWebCookieName = 'agents_main_session'
export const mainWebSessionSeconds = 30 * 24 * 60 * 60
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const secret = (): string => randomBytes(32).toString('base64url')
const equal = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const derive = (password: string, salt: string): Promise<string> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key.toString('hex')))
})
type State = { password?: { salt: string; hash: string }; sessions: Record<string, number> }

/** Single-owner credentials and hashed sessions, stored only in the private data directory. */
export class MainWebAuth {
  readonly #filename: string
  readonly #now: () => number
  #state: State
  #bootstrap?: string
  #failures = 0
  #blockedUntil = 0
  #busy = false

  constructor(dataDirectory: string, now: () => number = Date.now) {
    initializeOwnerContext(dataDirectory)
    this.#filename = path.join(dataDirectory, 'web-auth.json')
    this.#now = now
    if (existsSync(this.#filename)) {
      const stat = lstatSync(this.#filename)
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform === 'linux' &&
          (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600))) throw new Error('Unsafe web auth file')
      this.#state = JSON.parse(readFileSync(this.#filename, 'utf8')) as State
      if (!this.#state.sessions || typeof this.#state.sessions !== 'object' || Array.isArray(this.#state.sessions) ||
          (this.#state.password && (!/^[a-f0-9]{64}$/.test(this.#state.password.salt) || !/^[a-f0-9]{128}$/.test(this.#state.password.hash)))) {
        throw new Error('Invalid web auth file')
      }
    } else {
      this.#state = { sessions: {} }
      this.#save()
    }
    if (!this.#state.password) this.#bootstrap = secret()
  }

  get configured(): boolean { return this.#state.password !== undefined }
  /** Only the startup terminal receives this short-lived first-setup capability. */
  get setupToken(): string | undefined { return this.#bootstrap }

  async setup(password: unknown, token: unknown): Promise<string> {
    if (this.#busy || this.configured || typeof token !== 'string' || !this.#bootstrap ||
        !equal(hash(token), hash(this.#bootstrap))) throw new Error('设置凭据无效或已失效。')
    this.#validatePassword(password)
    this.#busy = true
    try {
      const salt = randomBytes(32).toString('hex')
      const passwordHash = await derive(password, salt)
      this.#state.password = { salt, hash: passwordHash }
      const session = this.#issue()
      this.#bootstrap = undefined
      return session
    } finally { this.#busy = false }
  }

  async login(password: unknown): Promise<string> {
    if (this.#blockedUntil > this.#now() || this.#busy) throw new Error('尝试过于频繁，请稍后再试。')
    this.#validatePassword(password)
    this.#busy = true
    try {
      const saved = this.#state.password
      if (!saved || !equal(await derive(password, saved.salt), saved.hash)) {
        this.#failures += 1
        if (this.#failures >= 5) { this.#blockedUntil = this.#now() + 60_000; this.#failures = 0 }
        throw new Error('密码不正确。')
      }
      this.#failures = 0
      return this.#issue()
    } finally { this.#busy = false }
  }

  authorized(session: string | undefined): boolean {
    if (!session || !/^[A-Za-z0-9_-]{43}$/.test(session)) return false
    const expires = this.#state.sessions[hash(session)]
    return typeof expires === 'number' && expires > this.#now()
  }

  logout(session: string | undefined): void {
    if (session) { delete this.#state.sessions[hash(session)]; this.#save() }
  }

  #validatePassword(password: unknown): asserts password is string {
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
      throw new Error('密码必须为 8 到 256 个字符。')
    }
  }

  #issue(): string {
    for (const [key, expires] of Object.entries(this.#state.sessions)) {
      if (expires <= this.#now()) delete this.#state.sessions[key]
    }
    // Bound disk growth for this personal single-user service.
    const keys = Object.keys(this.#state.sessions)
    for (const key of keys.slice(0, Math.max(0, keys.length - 19))) delete this.#state.sessions[key]
    const session = secret()
    this.#state.sessions[hash(session)] = this.#now() + mainWebSessionSeconds * 1000
    this.#save()
    return session
  }

  #save(): void {
    const temporary = `${this.#filename}.${secret()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.#state), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.#filename)
  }
}

export function sessionFromCookie(cookie: string | undefined): string | undefined {
  return cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${mainWebCookieName}=`))?.slice(mainWebCookieName.length + 1)
}

export function sessionCookie(session: string, secure: boolean, clear = false): string {
  return `${mainWebCookieName}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : mainWebSessionSeconds}${secure ? '; Secure' : ''}`
}

/** Host is supplied by the direct HTTP request, never an arbitrary forwarded header. */
export function validateWriteOrigin(origin: string | undefined, host: string | undefined): { secure: boolean } | undefined {
  if (!origin || !host) return undefined
  try {
    const url = new URL(origin)
    if (url.origin !== origin || url.host !== host) return undefined
    if (url.protocol === 'https:') return { secure: true }
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return { secure: false }
  } catch { /* Invalid or opaque origin. */ }
  return undefined
}
