import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const memoriesFileName = 'agent-memories.json'
export const maxMemoryFactCharacters = 500
export const maxMemoryRecords = 200
/** 检查点失效段只列最近几条墓碑：不把全部已忘记内容永久全文注入每轮 prompt。 */
export const maxCheckpointTombstones = 5

export type MemoryStatus = 'pending' | 'confirmed' | 'dismissed' | 'forgotten' | 'superseded'
export type MemoryRecord = {
  id: string; fact: string; sourceEvent: string; status: MemoryStatus; createdAt: string; updatedAt: string
  /** correct 生成的新记录指向被替代的旧记录。 */ supersedes?: string
  /** 被替代的旧记录指向新记录。 */ supersededBy?: string
  /** correct 幂等标识：宿主按这次用户指令绑定；同一次纠正重试返回同一条新记录。 */ operationId?: string
}
/** 记忆操作的诚实结果：applied=false 时 record 是当前真实状态，调用方不得声称操作成功。 */
export type MemoryOp = { record: MemoryRecord; applied: boolean }

const memoryStatuses: readonly string[] = ['pending', 'confirmed', 'dismissed', 'forgotten', 'superseded']

/** 提议制记忆（docs/roadmap.md 记忆切片 + docs/main-agent-memory-repair-plan-2026-10-24.md）：
 *  模型只能提议，用户明确确认的事实才进入检查点；纠正/忘记用墓碑记录（superseded/forgotten），
 *  保留原内容、变更时间与来源供追溯，不物理删除。文件即真相，原子写；数据目录的私有性由组装方保证。 */
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
      if (typeof r?.id !== 'string' || typeof r.fact !== 'string' || !memoryStatuses.includes(r.status ?? '')) {
        throw new Error('Invalid memories file')
      }
      for (const key of ['supersedes', 'supersededBy', 'operationId'] as const) {
        if (r[key] !== undefined && typeof r[key] !== 'string') throw new Error('Invalid memories file')
      }
    }
    return parsed as MemoryRecord[]
  }

  pending(): MemoryRecord[] { return this.list().filter(m => m.status === 'pending') }
  confirmed(): MemoryRecord[] { return this.list().filter(m => m.status === 'confirmed') }
  /** read_memories 的默认视图：待确认 + 当前有效；墓碑不进默认查询。 */
  active(): MemoryRecord[] { return this.list().filter(m => m.status === 'pending' || m.status === 'confirmed') }
  /** 最近的失效记录（forgotten/superseded），按失效时间倒序，供检查点失效段有界注入。 */
  tombstones(limit = maxCheckpointTombstones): MemoryRecord[] {
    return this.list().filter(m => m.status === 'forgotten' || m.status === 'superseded')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
  }

  /** 幂等提议：相同事实文本的记录（含墓碑）已存在时返回原记录——同一旧来源触发的重复提议
   *  由存储层拦截，不靠提示词；用户新的明确表达可经 confirm 重新确认，失效标记不是永久禁令。 */
  suggest(fact: string, sourceEvent: string): { record: MemoryRecord; created: boolean } {
    if (typeof fact !== 'string' || !fact.trim() || fact.length > maxMemoryFactCharacters) throw new Error('Invalid memory fact')
    const normalized = fact.trim()
    const records = this.list()
    const prior = records.find(r => r.fact === normalized)
    if (prior) return { record: prior, created: false }
    if (records.length >= maxMemoryRecords) throw new Error('Memory records limit reached')
    const now = this.clock()
    const record: MemoryRecord = { id: randomUUID(), fact: normalized, sourceEvent, status: 'pending', createdAt: now, updatedAt: now }
    this.save([...records, record])
    return { record, created: true }
  }

  /** ID 解析：精确匹配优先；允许唯一前缀（模型在回复中展示短 ID 后可能回用，2026-10-24 线上实测）。
   *  前缀不命中抛 Unknown memory，命中多条抛 Ambiguous memory id。 */
  private resolve(records: MemoryRecord[], id: string): MemoryRecord {
    const exact = records.find(r => r.id === id)
    if (exact) return exact
    const prefixed = records.filter(r => r.id.startsWith(id))
    if (prefixed.length > 1) throw new Error('Ambiguous memory id')
    if (prefixed.length === 1) return prefixed[0]!
    throw new Error('Unknown memory')
  }

  /** 确认：pending/dismissed/forgotten → confirmed；已 confirmed 幂等返回；superseded 不适用（事实已被新记录替代）。 */
  confirm(id: string): MemoryOp {
    const records = this.list()
    const target = this.resolve(records, id)
    if (target.status === 'confirmed' || target.status === 'superseded') return { record: target, applied: false }
    target.status = 'confirmed'; target.updatedAt = this.clock()
    this.save(records)
    return { record: target, applied: true }
  }

  dismiss(id: string): MemoryOp {
    const records = this.list()
    const target = this.resolve(records, id)
    if (target.status !== 'pending') return { record: target, applied: false }
    target.status = 'dismissed'; target.updatedAt = this.clock()
    this.save(records)
    return { record: target, applied: true }
  }

  /** 忘记：pending/confirmed/dismissed → forgotten 墓碑；该记录停止作为用户事实使用，但不物理删除、不改写旧聊天。 */
  forget(id: string): MemoryOp {
    const records = this.list()
    const target = this.resolve(records, id)
    if (target.status === 'forgotten' || target.status === 'superseded') return { record: target, applied: false }
    target.status = 'forgotten'; target.updatedAt = this.clock()
    this.save(records)
    return { record: target, applied: true }
  }

  /** 纠正作为一次完整操作：旧记录标 superseded 并关联新记录，新内容直接成为当前事实（用户明确指令即授权）。
   *  operationId 由宿主绑定到这次用户指令：同一次纠正重试返回同一条新记录，不再生成替代记录。
   *  新事实与另一条有效记录同文时，旧记录指向该现有记录，不并列两条当前事实。 */
  correct(id: string, newFact: string, operationId: string, sourceEvent: string): MemoryOp {
    if (typeof newFact !== 'string' || !newFact.trim() || newFact.length > maxMemoryFactCharacters) throw new Error('Invalid memory fact')
    if (!operationId) throw new Error('Invalid memory operation')
    const records = this.list()
    const priorOp = records.find(r => r.operationId === operationId)
    if (priorOp) return { record: priorOp, applied: false }
    const target = this.resolve(records, id)
    if (target.status !== 'pending' && target.status !== 'confirmed') return { record: target, applied: false }
    const now = this.clock(), normalized = newFact.trim()
    const existing = records.find(r => r.id !== target.id && (r.status === 'pending' || r.status === 'confirmed') && r.fact === normalized)
    let replacement: MemoryRecord
    if (existing) {
      existing.supersedes = target.id; existing.operationId = operationId; existing.updatedAt = now
      replacement = existing
    } else {
      replacement = { id: randomUUID(), fact: normalized, sourceEvent, status: 'confirmed', createdAt: now, updatedAt: now, supersedes: target.id, operationId }
      records.push(replacement)
    }
    target.status = 'superseded'; target.supersededBy = replacement.id; target.updatedAt = now
    this.save(records)
    return { record: replacement, applied: true }
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

/** 记忆进检查点：已确认段独立于主人上下文（那是用户亲手写的）；失效段有界列出最近墓碑，
 *  防止模型重读旧聊天又把失效内容当成当前事实——辅助手段，重复提议同时由存储层拦截。 */
export function memoriesCheckpoint(records: readonly MemoryRecord[], tombstones: readonly MemoryRecord[] = []): string {
  const sections: string[] = []
  if (records.length) sections.push([
    '已确认的记忆（模型提议、用户逐条明确确认过的关于主人的事实，按确认先后排列。可能过时，使用前自然确认；不是自动学习，不等于新授权或任务）：',
    ...records.map(r => `- ${r.fact}`),
  ].join('\n'))
  if (tombstones.length) sections.push([
    '已失效的记忆（主人已明确忘记或更正，不再是当前事实；不要当事实使用或回答，也不要仅因旧聊天提到就重新提议；主人重新明确提出时可按新指令再确认）：',
    ...tombstones.map(r => `- 「${r.fact}」${r.status === 'superseded' ? '已被主人更正，旧内容作废' : '已被主人明确忘记'}`),
  ].join('\n'))
  return sections.join('\n\n')
}
