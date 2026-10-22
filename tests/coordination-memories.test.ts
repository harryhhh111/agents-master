import { mkdtempSync, rmSync } from 'node:fs'
import { expect, it } from 'vitest'
import { AgentMemories, memoriesCheckpoint } from '../src/main/coordination/memories.js'

it('提议制记忆：提议-确认-删除闭环、去重、跨实例持久、检查点渲染', () => {
  const directory = mkdtempSync('/dev/shm/memories-test-')
  try {
    const memories = new AgentMemories(directory)
    const record = memories.suggest('主人旅居昆明', 'evt-1')
    expect(memories.suggest('主人旅居昆明', 'evt-2').id).toBe(record.id)
    expect(memories.pending().map(m => m.id)).toEqual([record.id])
    expect(() => memories.remove(record.id)).toThrow()
    memories.confirm(record.id)
    expect(memories.confirmed()[0]!.fact).toBe('主人旅居昆明')
    expect(memories.pending()).toEqual([])
    const checkpoint = memoriesCheckpoint(new AgentMemories(directory).confirmed())
    expect(checkpoint).toContain('已确认的记忆')
    expect(checkpoint).toContain('主人旅居昆明')
    expect(memoriesCheckpoint([])).toBe('')
    memories.remove(record.id)
    expect(memories.confirmed()).toEqual([])
    const again = memories.suggest('主人旅居昆明', 'evt-3')
    expect(again.id).not.toBe(record.id)
    memories.dismiss(again.id)
    expect(memories.pending()).toEqual([])
    const third = memories.suggest('主人旅居昆明', 'evt-4')
    expect(third.status).toBe('pending')
    expect(() => memories.confirm('unknown')).toThrow()
  } finally { rmSync(directory, { recursive: true }) }
})
