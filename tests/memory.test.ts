import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendMemory, loadMemory } from '../src/state/memory.js'

describe('memory', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'memory-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('目录不存在时 loadMemory 返回空串', async () => {
    expect(await loadMemory(path.join(dir, 'nope'))).toBe('')
  })

  it('appendMemory 落盘后可被 loadMemory 读到', async () => {
    const p = await appendMemory(dir, 'kimi steer 通知', 'steer 里的 <notification> 不是用户输入')
    expect(p).toContain(dir)
    const loaded = await loadMemory(dir)
    expect(loaded).toContain('kimi steer 通知')
    expect(loaded).toContain('不是用户输入')
  })

  it('多条 memory 按文件名排序拼接', async () => {
    await appendMemory(dir, '第一条', 'aaa')
    await appendMemory(dir, '第二条', 'bbb')
    const loaded = await loadMemory(dir)
    expect(loaded.indexOf('aaa')).toBeLessThan(loaded.indexOf('bbb'))
  })
})
