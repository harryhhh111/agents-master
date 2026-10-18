import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function run(args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'FAKE-smoke-capture-'))
  const out = openSync(join(dir, 'stdout'), 'wx', 0o600)
  const err = openSync(join(dir, 'stderr'), 'wx', 0o600)
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke-coordination.ts', ...args], {
      timeout: 15_000, env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' }, stdio: ['ignore', out, err],
    })
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve)
    })
    return { status, stdout: readFileSync(join(dir, 'stdout'), 'utf8'), stderr: readFileSync(join(dir, 'stderr'), 'utf8') }
  } finally { closeSync(out); closeSync(err); rmSync(dir, { recursive: true, force: true }) }
}

it('runs bounded FAKE smoke with completed chat, durable question and fair report', async () => {
  const result = await run()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('foreground reply COMPLETED while executor HELD')
  expect(result.stdout).toContain('durable original question + answer + new run after restart')
  expect(result.stdout).toContain('PASS: no model, network, real CLI, owner context or project access')
})

it('rejects arbitrary data paths before opening any database', async () => {
  const result = await run(['--data-directory=/never-access-this'])
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('FAKE smoke accepts no arguments or data paths')
})
