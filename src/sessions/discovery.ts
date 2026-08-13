import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/** 定位 kimi 当前项目最新的 wire.jsonl：
 * ~/.kimi-code/sessions/wd_<项目目录basename>_<hash>/session_* /agents/main/wire.jsonl
 * hash 算法未知，按前缀 glob 匹配，按 mtime 取最新。
 */
export async function findKimiSessionFile(
  projectDir: string,
  homeDir: string = os.homedir(),
): Promise<string | null> {
  const base = path.join(homeDir, ".kimi-code", "sessions");
  const prefix = `wd_${path.basename(path.resolve(projectDir))}_`;
  let wdDirs: string[];
  try {
    wdDirs = (await fs.readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => path.join(base, e.name));
  } catch {
    return null;
  }

  let best: { file: string; mtimeMs: number } | null = null;
  for (const wdDir of wdDirs) {
    let sessionDirs: string[];
    try {
      sessionDirs = (await fs.readdir(wdDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name.startsWith("session_"))
        .map((e) => path.join(wdDir, e.name));
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const wire = path.join(sessionDir, "agents", "main", "wire.jsonl");
      try {
        const st = await fs.stat(wire);
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: wire, mtimeMs: st.mtimeMs };
      } catch {
        // wire.jsonl 不存在，跳过
      }
    }
  }
  return best?.file ?? null;
}

export interface CodexDiscoveryOptions {
  /** 只扫描最近 N 天的日期目录，默认 30 */
  days?: number;
  homeDir?: string;
}

/** 定位 codex 当前项目最新的 rollout jsonl：
 * 按日期目录（~/.codex/sessions/YYYY/MM/DD，UTC）倒序遍历，
 * 读每个 rollout-*.jsonl 首行 session_meta 的 payload.cwd 与项目路径匹配，按时间取最新。
 */
export async function findCodexSessionFile(
  projectDir: string,
  opts: CodexDiscoveryOptions = {},
): Promise<string | null> {
  const days = opts.days ?? 30;
  const base = path.join(opts.homeDir ?? os.homedir(), ".codex", "sessions");
  const cwd = path.resolve(projectDir);

  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const dir = path.join(
      base,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    );
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    let best: { file: string; ts: number } | null = null;
    for (const f of files) {
      const full = path.join(dir, f);
      const meta = await readSessionMeta(full);
      if (!meta || meta.cwd === null) continue;
      if (path.resolve(meta.cwd) !== cwd) continue;
      let ts = meta.timestamp !== null ? Date.parse(meta.timestamp) : NaN;
      if (Number.isNaN(ts)) ts = (await fs.stat(full)).mtimeMs;
      if (!best || ts > best.ts) best = { file: full, ts };
    }
    // 日期倒序：当天有匹配即全局最新，不必再扫更早的日期
    if (best) return best.file;
  }
  return null;
}

interface SessionMeta {
  cwd: string | null;
  timestamp: string | null;
}

/** 只读首行（session_meta 行可达数十 KB，含 base_instructions，必须流式读） */
async function readSessionMeta(file: string): Promise<SessionMeta | null> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const d = JSON.parse(line) as Record<string, unknown>;
      if (d.type !== "session_meta") return null;
      const payload = d.payload as Record<string, unknown> | undefined;
      return {
        cwd: typeof payload?.cwd === "string" ? payload.cwd : null,
        timestamp: typeof payload?.timestamp === "string" ? payload.timestamp : null,
      };
    }
    return null;
  } catch {
    return null; // 首行 JSON 解析失败 / 读文件失败，跳过该文件
  } finally {
    rl.close();
    stream.destroy();
  }
}
