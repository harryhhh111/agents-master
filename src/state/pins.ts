import { promises as fs } from 'node:fs'
import path from 'node:path'

export type CliName = 'kimi' | 'codex'

export interface CliPin {
  sessionId: string
  /** 定位到的 session 记录文件；未定位时为 null（下次 read_session_updates 走 discovery 补上） */
  sessionFile: string | null
}

interface PinsData {
  /** 项目 → cli → 钉住的 session */
  projects: Record<string, Partial<Record<CliName, CliPin>>>
  /** sessionId → agent 代发过的 prompt 原文，供 read_session_updates 标注 agent/human */
  sentPrompts: Record<string, string[]>
}

/** state/pins.json 的读写：session 钉住 + agent 代发 prompt 记录。 */
export class PinStore {
  private data: PinsData | null = null

  constructor(private readonly stateDir: string) {}

  private get file(): string {
    return path.join(this.stateDir, 'pins.json')
  }

  private async load(): Promise<PinsData> {
    if (this.data !== null) return this.data
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8')) as PinsData
    } catch {
      this.data = { projects: {}, sentPrompts: {} }
    }
    return this.data
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2))
  }

  async getPin(project: string, cli: CliName): Promise<CliPin | null> {
    const data = await this.load()
    return data.projects[project]?.[cli] ?? null
  }

  async setPin(project: string, cli: CliName, pin: CliPin): Promise<void> {
    const data = await this.load()
    data.projects[project] = { ...data.projects[project], [cli]: pin }
    await this.save()
  }

  async recordSentPrompt(sessionId: string, prompt: string): Promise<void> {
    const data = await this.load()
    const list = data.sentPrompts[sessionId] ?? []
    list.push(prompt)
    data.sentPrompts[sessionId] = list
    await this.save()
  }

  async getSentPrompts(sessionId: string): Promise<string[]> {
    const data = await this.load()
    return data.sentPrompts[sessionId] ?? []
  }
}
