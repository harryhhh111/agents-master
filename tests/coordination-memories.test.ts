import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { AgentMemories, maxCheckpointTombstones, memoriesCheckpoint } from '../src/main/coordination/memories.js'

it('提议制记忆：提议-确认-忘记闭环、去重、跨实例持久、检查点渲染', () => {
  const directory = mkdtempSync('/dev/shm/memories-test-')
  try {
    const memories = new AgentMemories(directory)
    const { record, created } = memories.suggest('主人旅居昆明', 'evt-1')
    expect(created).toBe(true)
    expect(memories.suggest('主人旅居昆明', 'evt-2')).toEqual({ record, created: false })
    expect(memories.pending().map(m => m.id)).toEqual([record.id])
    expect(memories.confirm(record.id).applied).toBe(true)
    expect(memories.confirm(record.id).applied).toBe(false)
    expect(memories.confirmed()[0]!.fact).toBe('主人旅居昆明')
    expect(memories.pending()).toEqual([])
    const checkpoint = memoriesCheckpoint(new AgentMemories(directory).confirmed())
    expect(checkpoint).toContain('已确认的记忆')
    expect(checkpoint).toContain('主人旅居昆明')
    expect(memoriesCheckpoint([])).toBe('')
    expect(memories.forget(record.id).applied).toBe(true)
    expect(memories.confirmed()).toEqual([])
    // 墓碑拦截：同一事实的旧来源重提返回墓碑本身，不生成新提议
    const re = memories.suggest('主人旅居昆明', 'evt-3')
    expect(re.created).toBe(false)
    expect(re.record.status).toBe('forgotten')
    // 用户新的明确表达允许重新确认，失效标记不是永久禁令
    expect(memories.confirm(record.id).applied).toBe(true)
    expect(memories.confirmed()[0]!.id).toBe(record.id)
    const other = memories.suggest('主人喜欢蓝色以外的合成事实', 'evt-4').record
    expect(memories.dismiss(other.id).applied).toBe(true)
    expect(memories.list().find(r=>r.id===other.id)!.status).toBe('dismissed')
    expect(memories.confirm(record.id).applied).toBe(false)
    expect(() => memories.confirm('unknown')).toThrow()
    expect(() => memories.forget('unknown')).toThrow()
  } finally { rmSync(directory, { recursive: true }) }
})

it('纠正：旧记录墓碑化并关联新记录，同一操作重试返回同一条，同文现有记录不并列', () => {
  const directory = mkdtempSync('/dev/shm/memories-test-')
  try {
    const memories = new AgentMemories(directory)
    const blue = memories.suggest('主人喜欢蓝色', 'evt-1').record
    memories.confirm(blue.id)
    const op = memories.correct(blue.id, '主人喜欢绿色', 'user-turn-9:op', 'user-turn-9')
    expect(op.applied).toBe(true)
    expect(op.record.status).toBe('confirmed')
    expect(op.record.supersedes).toBe(blue.id)
    expect(op.record.sourceEvent).toBe('user-turn-9')
    const old = memories.list().find(r => r.id === blue.id)!
    expect(old.status).toBe('superseded')
    expect(old.supersededBy).toBe(op.record.id)
    expect(old.fact).toBe('主人喜欢蓝色')
    // 幂等：同一 operationId 重试返回同一条新记录，不重复落库
    const retry = memories.correct(blue.id, '主人喜欢绿色', 'user-turn-9:op', 'user-turn-9')
    expect(retry.applied).toBe(false)
    expect(retry.record.id).toBe(op.record.id)
    expect(memories.list().filter(r => r.fact === '主人喜欢绿色')).toHaveLength(1)
    // 纠正到另一条已存在的事实：旧记录指向现有记录，不并列两条当前事实
    const red = memories.suggest('主人喜欢红色', 'evt-2').record
    memories.confirm(red.id)
    const merge = memories.correct(op.record.id, '主人喜欢红色', 'user-turn-10:op', 'user-turn-10')
    expect(merge.record.id).toBe(red.id)
    expect(memories.active().filter(r => r.fact === '主人喜欢红色')).toHaveLength(1)
    expect(memories.list().find(r => r.id === op.record.id)!.supersededBy).toBe(red.id)
    // superseded/forgotten 记录不能再被确认或纠正
    expect(memories.confirm(blue.id).applied).toBe(false)
    expect(memories.correct(blue.id, '主人喜欢黄色', 'user-turn-11:op', 'user-turn-11').applied).toBe(false)
    // 检查点：新事实在有效段，旧事实在失效段
    const checkpoint = memoriesCheckpoint(memories.confirmed(), memories.tombstones())
    expect(checkpoint).toContain('主人喜欢红色')
    expect(checkpoint).toContain('已失效的记忆')
    expect(checkpoint).toContain('「主人喜欢蓝色」已被主人更正，旧内容作废')
    expect(checkpoint).toContain('「主人喜欢绿色」已被主人更正，旧内容作废')
  } finally { rmSync(directory, { recursive: true }) }
})

it('忘记进检查点失效段且有界；默认查询与墓碑隔离；旧格式文件兼容读取', () => {
  const directory = mkdtempSync('/dev/shm/memories-test-')
  try {
    // 旧格式（无新可选字段、仅三种状态）必须可读
    writeFileSync(path.join(directory, 'agent-memories.json'), JSON.stringify([
      { id: 'legacy-1', fact: '旧确认记录', sourceEvent: 'e1', status: 'confirmed', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' },
      { id: 'legacy-2', fact: '旧忽略记录', sourceEvent: 'e2', status: 'dismissed', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' },
    ]))
    const memories = new AgentMemories(directory)
    expect(memories.confirmed()[0]!.fact).toBe('旧确认记录')
    memories.forget('legacy-1')
    const checkpoint = memoriesCheckpoint(memories.confirmed(), memories.tombstones())
    expect(checkpoint).toContain('「旧确认记录」已被主人明确忘记')
    expect(checkpoint).not.toContain('- 旧确认记录\n')
    expect(memories.active()).toEqual([])
    // 失效段有界：超过上限只取最近几条
    for (let i = 0; i < maxCheckpointTombstones + 3; i++) {
      const r = memories.suggest(`合成事实 ${i}`, `evt-b-${i}`).record
      memories.confirm(r.id)
      memories.forget(r.id)
    }
    expect(memories.tombstones().length).toBe(maxCheckpointTombstones)
    expect(memories.list().filter(r => r.status === 'forgotten').length).toBe(maxCheckpointTombstones + 4)
  } finally { rmSync(directory, { recursive: true }) }
})
