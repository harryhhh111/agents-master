import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const memoriesFileName = 'agent-memories.json'
export const maxMemoryFactCharacters = 500
export const maxMemoryRecords = 200

export type MemoryStatus = 'pending' | 'confirmed' | 'dismissed'
export type MemoryRecord = {
  id: string; fact: string; sourceEvent: string; status: MemoryStatus; createdAt: string; updatedAt: string
}

/** 提议制记忆（docs/roadmap.md 记忆切片）：模型只能提议，用户明确确认的事实才进入检查点。
 *  文件即真相，原子写；数据目录的私有性由组装方（owner-context 初始化）保证。 */
export class AgentMemories {
  constructor(private readonly dataDirectory: string, private readonly clock: () => string = () => new Date().toISOString()) {}

  private file(): string { return path.join(this.dataDirectory, memoriesFileName) }

  list(): MemoryRecord[] {
    const filename = this.file()
    if (!existsSync(filename)) return []
    const parsed = JSON.parse(readFileSync(filename, 'utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error('Invalid memories file')
    for (const record of parsed) {
      const r = record as Partial<MemoryRecord>
      if (typeof r?.id !== 'string' || typeof r.fact !== 'string' || !['pending', 'confirmed', 'dismissed'].includes(r.status ?? '')) {
        throw new Error('Invalid memories file')
      }
    }
    return parsed as MemoryRecord[]
  }

  pending(): MemoryRecord[] { return this.list().filter(m => m.status === 'pending') }
  confirmed(): MemoryRecord[] { return this.list().filter(m => m.status === 'confirmed') }

  /** 幂等提议：相同事实文本的未删除记录已存在时返回原记录。 */
  suggest(fact: string, sourceEvent: string): MemoryRecord {
    if (typeof fact !== 'string' || !fact.trim() || fact.length > maxMemoryFactCharacters) throw new Error('Invalid memory fact')
    const normalized = fact.trim()
    const records = this.list()
    const prior = records.find(r => r.fact === normalized && r.status !== 'dismissed')
    if (prior) return prior
    if (records.length >= maxMemoryRecords) throw new Error('Memory records limit reached')
    const now = this.clock()
    const record: MemoryRecord = { id: randomUUID(), fact: normalized, sourceEvent, status: 'pending', createdAt: now, updatedAt: now }
    this.save([...records, record])
    return record
  }

  confirm(id: string): MemoryRecord { return this.update(id, 'confirmed') }
  dismiss(id: string): MemoryRecord { return this.update(id, 'dismissed') }
  /** 删除已确认记忆（用户行使忘记权）；pending/dismissed 记录保留作提议去重证据。 */
  remove(id: string): void {
    const records = this.list()
    const target = records.find(r => r.id === id)
    if (!target) throw new Error('Unknown memory')
    if (target.status !== 'confirmed') throw new Error('Only confirmed memories can be removed')
    this.save(records.filter(r => r.id !== id))
  }

  private update(id: string, status: MemoryStatus): MemoryRecord {
    const records = this.list()
    const target = records.find(r => r.id === id)
    if (!target) throw new Error('Unknown memory')
    if (target.status !== 'pending') return target
    target.status = status; target.updatedAt = this.clock()
    this.save(records)
    return target
  }

  private save(records: MemoryRecord[]): void {
    const filename = this.file()
    const temporary = filename + '.next'
    try {
      writeFileSync(temporary, JSON.stringify(records, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      chmodSync(temporary, 0o600)
      renameSync(temporary, filename)
      chmodSync(filename, 0o600)
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
}

/** 已确认记忆进检查点：独立于主人上下文（那是用户亲手写的），标注来源与时效约束。 */
export function memoriesCheckpoint(records: readonly MemoryRecord[]): string {
  if (!records.length) return ''
  return [
    '已确认的记忆（模型提议、用户逐条明确确认过的关于主人的事实，按确认先后排列。可能过时，使用前自然确认；不是自动学习，不等于新授权或任务）：',
    ...records.map(r => `- ${r.fact}`),
  ].join('\n')
}
