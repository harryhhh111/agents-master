import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface LedgerEntry {
  direction: string
  kind: string
  summary: string
  anchors?: string[]
  pending?: string[]
}

/** 传话台账：state/ledger.jsonl 追加写，每条带 ts + 工具参数原文。 */
export class Ledger {
  constructor(private readonly stateDir: string) {}

  get file(): string {
    return path.join(this.stateDir, 'ledger.jsonl')
  }

  async append(entry: LedgerEntry): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    await fs.appendFile(this.file, line + '\n')
  }
}
