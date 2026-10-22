import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createCoordinationPreview } from './main-web-coordination.js'
import { demoModel } from './main-web-coordination-demo.js'
import { listenMainWebServer } from './main-web.js'

/** Same host/routes/page as preview. Only model and owner inputs are synthetic. */
export async function smokeCoordinationWeb(browser = false, newDirectoryParent?: string): Promise<void> {
  const app = createCoordinationPreview({ model: demoModel(), newDirectoryParent })
  try {
    await app.auth.setup('synthetic-smoke-password', app.auth.setupToken)
    const port = await listenMainWebServer(app.server, 0), base = `http://127.0.0.1:${port}`
    if (!browser) {
      const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-smoke-password' }) })
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!
      const sent = await fetch(base + '/api/messages?conversation=main', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ content: '合成检查', idempotencyKey: 'http-smoke' }) })
      if (sent.status !== 202) throw new Error('HTTP admission failed')
      for (let i = 0; i < 100 && !app.store.coordination.questions('fake-work').length; i++) await new Promise(r => setTimeout(r, 10))
      if (!app.store.coordination.questions('fake-work').length) throw new Error('Missing durable question')
      console.log('SYNTHETIC HTTP smoke passed: authenticated admission, model delegation, durable domain question')
    } else {
      // Uses preinstalled Python Playwright. No package/browser installation.
      const python = `
import sys
from playwright.sync_api import sync_playwright, expect
url=sys.argv[1]
assert url.startswith('http://127.0.0.1:')
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path='/home/vinci/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome')
    page=browser.new_page()
    page.goto(url)
    page.locator('#password').fill('synthetic-smoke-password')
    page.locator('#login-button').click()
    page.locator('#message').wait_for(state='visible')
    page.locator('[data-conversation="fake-work"]').click()
    page.locator('#message').fill('合成检查')
    page.locator('#send').click()
    page.locator('[data-question]').wait_for()
    page.locator('[aria-label="回答模拟问题"]').fill('A')
    page.wait_for_timeout(6500)
    assert page.locator('[aria-label="回答模拟问题"]').input_value() == 'A'
    page.locator('[data-conversation="main"]').click()
    page.locator('[data-conversation="fake-work"]').click()
    page.locator('[data-question]').wait_for()
    assert page.locator('[aria-label="回答模拟问题"]').input_value() == 'A'
    page.locator('[data-answer]').click()
    expect(page.locator('.task-card').first).to_contain_text('已完成', timeout=15000)
    page.locator('[data-conversation="main"]').click()
    expect(page.locator('#messages')).to_contain_text('模拟/联调回传', timeout=15000)
    page.reload()
    page.locator('#message').wait_for(state='visible')
    page.locator('#open-settings').click()
    page.locator('#logout').click()
    page.locator('#password').wait_for(state='visible')
    assert page.request.get(url+'/api/status').status == 401
    browser.close()
print('SYNTHETIC browser smoke passed: login, delegation, group answer, return, refresh, logout')
`
      const result = await promisify(execFile)('python3', ['-c', python, base], { timeout: 45000 })
      process.stdout.write(result.stdout)
    }
  } finally { await app.close(); rmSync(app.directory, { recursive: true, force: true }) }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), browser = args[0] === '--browser'
  if (browser) args.shift()
  if (args.length && (args.length !== 2 || args[0] !== '--preview-parent')) throw new Error('Use [--browser] [--preview-parent PARENT]')
  smokeCoordinationWeb(browser, args[1]).catch(error => { console.error(error); process.exitCode = 1 })
}
