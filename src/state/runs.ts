import { randomUUID } from 'node:crypto'
import type { AgentRunResult, DetachedRunHandle } from '../backends/AgentBackend.js'

export interface RunRecord {
  runId: string
  backend: string
  /** 本次代发的 prompt 原文（sessionId 未落定前的 human/agent 标注要用） */
  prompt: string
  handle: DetachedRunHandle
  startedAt: number
  status: 'running' | 'done'
  result?: AgentRunResult
  error?: string
}

/** 进程内 run 注册表：runId → 句柄与最终结果的回收位。 */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>()
  private readonly doneListeners: Array<(record: RunRecord) => void> = []

  /** run 完成（或失败）时通知，AgentCore 用它把完成消息自动注入对话流 */
  onDone(listener: (record: RunRecord) => void): void {
    this.doneListeners.push(listener)
  }

  register(backend: string, prompt: string, handle: DetachedRunHandle): RunRecord {
    const record: RunRecord = {
      runId: randomUUID(),
      backend,
      prompt,
      handle,
      startedAt: Date.now(),
      status: 'running',
    }
    this.runs.set(record.runId, record)
    const notify = () => {
      for (const l of this.doneListeners) l(record)
    }
    handle.done
      .then(result => {
        record.status = 'done'
        record.result = result
        notify()
      })
      .catch((e: unknown) => {
        record.status = 'done'
        record.error = e instanceof Error ? e.message : String(e)
        notify()
      })
    return record
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId)
  }

  /** 全部 run（按注册顺序），TUI /runs 和状态栏用 */
  list(): RunRecord[] {
    return [...this.runs.values()]
  }

  /** 某 cli 仍在运行的 run 的 prompt 列表（run 未结束时 sessionId 未知，pins 里还没有） */
  activePrompts(backend: string): string[] {
    const out: string[] = []
    for (const r of this.runs.values()) {
      if (r.backend === backend && r.status === 'running') out.push(r.prompt)
    }
    return out
  }
}
