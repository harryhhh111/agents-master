import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { MainWebAuth } from '../src/main/web-auth.js'
import { MainWebEventBus, createMainWebServer, listenMainWebServer } from './main-web.js'
import { createMainWebPreviewChannel } from './main-web-preview.js'
import { startPreviewWorker } from './preview-worker.js'

/** Synthetic Step B smoke: stable entry, preview worker and browser share one login. */
export async function smokeMainWebPreview(browser = false, parentDirectory = '/dev/shm'): Promise<void> {
  const root = mkdtempSync(path.join(parentDirectory, 'main-web-preview-smoke-'))
  const socketPath = path.join(root, 'run', 'preview.sock')
  const worker = await startPreviewWorker({ dataDirectory: path.join(root, 'preview'), socketPath })
  const stableDirectory = path.join(root, 'stable')
  mkdirSync(stableDirectory, { mode: 0o700 })
  const auth = new MainWebAuth(stableDirectory)
  const events = new MainWebEventBus()
  const previewChannel = createMainWebPreviewChannel({ socketPath, releaseId: 'browser-smoke-preview' })
  const server = createMainWebServer({
    host: { start: () => 0, submit: () => 0, recover: () => 0, setCheckpoint: () => {}, getStatus: () => 'idle' },
    readHistory: () => [],
    dataDirectory: stableDirectory,
    events,
    auth,
    previewChannel,
  })
  const close = async () => {
    previewChannel.close()
    events.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) })
    await worker.close()
    rmSync(root, { recursive: true, force: true })
  }
  try {
    const port = await listenMainWebServer(server, 0)
    const base = `http://127.0.0.1:${port}`
    await auth.setup('synthetic-smoke-password', auth.setupToken)
    if (!browser) {
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-smoke-password' }) })
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!
      const preview = await fetch(`${base}/preview/api/conversations`, { headers: { cookie } })
      if (preview.status !== 200) throw new Error(`preview route failed: ${preview.status}`)
      console.log('SYNTHETIC Step B HTTP smoke passed: one login reaches stable and preview channels')
      return
    }
    const python = `
import sys
from playwright.sync_api import sync_playwright, expect
base=sys.argv[1]
assert base.startswith('http://127.0.0.1:')
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path='/home/vinci/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome')
    page=browser.new_page()
    page.goto(base+'/')
    page.locator('#password').fill('synthetic-smoke-password')
    page.locator('#login-button').click()
    page.locator('#message').wait_for(state='visible')
    expect(page.locator('#version-current')).to_contain_text('稳定版')
    page.locator('#to-preview').click()
    page.wait_for_url('**/preview/')
    page.locator('#coordination-cards').wait_for(state='attached')
    expect(page.locator('body')).to_contain_text('模拟 / 联调 · 无真实项目执行')
    page.locator('#message').fill('浏览器预览消息')
    page.locator('#send').click()
    expect(page.locator('#messages')).to_contain_text('浏览器预览消息')
    page.locator('#to-stable').click()
    page.wait_for_url(base+'/')
    expect(page.locator('#version-current')).to_contain_text('稳定版')
    page.goto(base+'/preview/')
    expect(page.locator('#messages')).to_contain_text('浏览器预览消息')
    page.locator('#message').fill('未提交草稿')
    page.once('dialog', lambda dialog: dialog.dismiss())
    page.locator('#to-stable').click()
    page.wait_for_timeout(300)
    assert page.url.endswith('/preview/')
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('#to-stable').click()
    page.wait_for_url(base+'/')
    browser.close()
print('SYNTHETIC Step B browser smoke passed: login, same-site switch, preview send, durable return, draft confirmation')
`
    const result = await promisify(execFile)('python3', ['-c', python, base], { timeout: 45_000 })
    process.stdout.write(result.stdout)
  } finally {
    await close()
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  const browser = args.includes('--browser')
  const parentIndex = args.indexOf('--preview-parent')
  const parent = parentIndex >= 0 ? args[parentIndex + 1] : '/dev/shm'
  const unexpected = args.filter((arg, index) => arg !== '--browser' && arg !== '--preview-parent' && index !== parentIndex + 1)
  if (!parent || unexpected.length > 0) {
    throw new Error('Use [--browser] [--preview-parent PARENT]')
  }
  smokeMainWebPreview(browser, parent).catch(error => { console.error(error); process.exitCode = 1 })
}
