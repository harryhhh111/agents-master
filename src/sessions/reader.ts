import { promises as fs } from "node:fs";
import path from "node:path";
import type { ParseResult } from "./types.js";

/** 增量读取 JSONL 会话文件：按文件路径记录 byte offset（持久化到 stateDir/offsets.json），
 * 每次只读新增字节；最后一行写了一半时不消费，留到下次补齐后再返回。
 * 幂等：连续读两次，第二次返回空。
 */
export class SessionReader {
  private offsets: Record<string, number> | null = null;

  constructor(private readonly stateDir: string) {}

  private get stateFile(): string {
    return path.join(this.stateDir, "offsets.json");
  }

  private async load(): Promise<void> {
    if (this.offsets !== null) return;
    try {
      this.offsets = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as Record<string, number>;
    } catch {
      this.offsets = {};
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(this.offsets, null, 2));
  }

  /** 返回自上次读取以来新增的完整行（不含末尾不完整的半行） */
  async readNewLines(filePath: string): Promise<string[]> {
    await this.load();
    const key = path.resolve(filePath);
    const stat = await fs.stat(key);
    let offset = this.offsets![key] ?? 0;
    if (stat.size < offset) offset = 0; // 文件被截断/轮换，从头读
    if (stat.size === offset) return [];

    const fh = await fs.open(key, "r");
    let buf: Buffer;
    try {
      buf = Buffer.alloc(stat.size - offset);
      await fh.read(buf, 0, buf.length, offset);
    } finally {
      await fh.close();
    }

    const lastNl = buf.lastIndexOf(0x0a); // "\n"
    if (lastNl === -1) return []; // 新增字节里没有完整行
    const complete = buf.subarray(0, lastNl + 1);
    this.offsets![key] = offset + complete.length;
    await this.save();
    return complete
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  }

  /** 读新增行并直接过 parser，返回新增消息 */
  async readMessages(filePath: string, parse: (chunk: string) => ParseResult): Promise<ParseResult> {
    const lines = await this.readNewLines(filePath);
    if (lines.length === 0) return { messages: [], warnings: 0 };
    return parse(lines.join("\n") + "\n");
  }
}
