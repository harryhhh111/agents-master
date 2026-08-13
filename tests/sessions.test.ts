import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCodexChunk } from "../src/sessions/codexParser.js";
import { findCodexSessionFile, findKimiSessionFile } from "../src/sessions/discovery.js";
import { parseKimiChunk } from "../src/sessions/kimiParser.js";
import { SessionReader } from "../src/sessions/reader.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function readFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES, name), "utf8");
}

describe("parseKimiChunk", () => {
  it("从真实切片提取 turn.prompt / turn.steer / text part，丢弃噪音", async () => {
    const { messages, warnings } = parseKimiChunk(await readFixture("kimi-wire.jsonl"));
    expect(warnings).toBe(0);
    // 3 条用户 prompt + 2 条 steer + 3 条 assistant text part（重复 uuid 已去重）
    expect(messages).toHaveLength(8);

    expect(messages[0]).toEqual({ ts: 1785467153392, who: "user", text: "你先了解一下项目情况" });

    const steers = messages.filter((m) => m.kind === "steer");
    expect(steers).toHaveLength(2);
    expect(steers[0]!.who).toBe("user");
    expect(steers[0]!.text).toContain("<notification");

    const assistants = messages.filter((m) => m.who === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants[0]!.text).toBe("再看一下当前服务器环境和 git 状态。");
    expect(assistants[0]!.kind).toBeUndefined();
    // 去重：fixture 中 uuid=c4309d65… 的 part 出现两次，只保留一条
    expect(assistants.filter((m) => m.text === "再看一下当前服务器环境和 git 状态。")).toHaveLength(1);

    // 被丢弃/跳过的：origin.kind=="task" 的 prompt、think、tool.call/result、
    // step.*、llm.request、usage、system-reminder prompt、空文本 part
    for (const m of messages) {
      expect(m.text).not.toContain("system-reminder");
      expect(m.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("解析失败 / 字段缺失的行计入 warnings，不静默降级", () => {
    const chunk = [
      "这不是 JSON",
      JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "缺 time 字段" }], origin: { kind: "user" } }),
      JSON.stringify({ type: "turn.prompt", origin: { kind: "user" }, time: 1 }), // 缺 input
      JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "缺 uuid" } }, time: 2 }),
    ].join("\n");
    const { messages, warnings } = parseKimiChunk(chunk);
    expect(warnings).toBe(4); // 1 解析失败 + 2 缺 time + 1 缺 uuid（缺 input 的行同时缺 time？不——它有 time）
    expect(messages.map((m) => m.text)).toEqual(["缺 time 字段", "缺 uuid"]);
    expect(messages[0]!.ts).toBe(0);
  });
});

describe("parseCodexChunk", () => {
  it("从真实切片提取 user/assistant 消息，剥离注入块", async () => {
    const { messages, warnings } = parseCodexChunk(await readFixture("codex-rollout.jsonl"));
    expect(warnings).toBe(0);
    // 2 条真实 user + 3 条 assistant；纯注入块 user 和 system-reminder user 被跳过
    expect(messages).toHaveLength(5);

    const users = messages.filter((m) => m.who === "user");
    expect(users).toHaveLength(2);
    expect(users[0]!.ts).toBe(Date.parse("2026-07-28T12:02:53.436Z"));
    expect(users[0]!.text).toMatch(/^我用 FCF \+ ROE 深度价值/);

    const assistants = messages.filter((m) => m.who === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants[0]!.text).toContain("我会先定位你当前筛选结果所用的接口和数据源");

    for (const m of messages) {
      expect(m.text).not.toMatch(/recommended_plugins|environment_context|user_instructions|permissions_instructions|system-reminder/);
    }
  });

  it("解析失败 / 字段缺失的行计入 warnings", () => {
    const chunk = [
      "{broken json",
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "缺 timestamp" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-28T12:00:00Z", payload: { type: "message", role: "user" } }), // 缺 content
    ].join("\n");
    const { messages, warnings } = parseCodexChunk(chunk);
    expect(warnings).toBe(3); // 1 解析失败 + 1 缺 timestamp + 1 缺 content
    expect(messages.map((m) => m.text)).toEqual(["缺 timestamp"]);
    expect(messages[0]!.ts).toBe(0);
  });
});

describe("SessionReader", () => {
  let tmp: string;
  let file: string;
  let reader: SessionReader;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sessions-test-"));
    file = path.join(tmp, "wire.jsonl");
    reader = new SessionReader(path.join(tmp, "state"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("增量读取且幂等：第二次读返回空", async () => {
    await fs.writeFile(file, '{"a":1}\n{"b":2}\n');
    expect(await reader.readNewLines(file)).toEqual(['{"a":1}', '{"b":2}']);
    expect(await reader.readNewLines(file)).toEqual([]);

    await fs.appendFile(file, '{"c":3}\n');
    expect(await reader.readNewLines(file)).toEqual(['{"c":3}']);
    expect(await reader.readNewLines(file)).toEqual([]);
  });

  it("最后一行写了一半时不消费，补齐后完整返回", async () => {
    await fs.writeFile(file, '{"a":1}\n{"inc');
    expect(await reader.readNewLines(file)).toEqual(['{"a":1}']); // 半行不返回
    expect(await reader.readNewLines(file)).toEqual([]);

    await fs.appendFile(file, 'omplete":true}\n');
    expect(await reader.readNewLines(file)).toEqual(['{"incomplete":true}']);
  });

  it("offset 持久化到 offsets.json，新实例接着上次位置读", async () => {
    await fs.writeFile(file, '{"a":1}\n');
    expect(await reader.readNewLines(file)).toEqual(['{"a":1}']);

    const stateRaw = JSON.parse(await fs.readFile(path.join(tmp, "state", "offsets.json"), "utf8")) as Record<string, number>;
    expect(stateRaw[path.resolve(file)]).toBe('{"a":1}\n'.length);

    const reader2 = new SessionReader(path.join(tmp, "state"));
    expect(await reader2.readNewLines(file)).toEqual([]);
    await fs.appendFile(file, '{"b":2}\n');
    expect(await reader2.readNewLines(file)).toEqual(['{"b":2}']);
  });

  it("文件被截断（size < offset）时从头重读", async () => {
    await fs.writeFile(file, '{"a":1}\n{"b":2}\n');
    await reader.readNewLines(file);
    await fs.writeFile(file, '{"new":1}\n');
    expect(await reader.readNewLines(file)).toEqual(['{"new":1}']);
  });

  it("readMessages 直接过 parser 返回新增消息", async () => {
    const line = JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "你好" }], origin: { kind: "user" }, time: 100 });
    await fs.writeFile(file, line + "\n");
    const r1 = await reader.readMessages(file, parseKimiChunk);
    expect(r1.messages).toEqual([{ ts: 100, who: "user", text: "你好" }]);
    expect(r1.warnings).toBe(0);
    const r2 = await reader.readMessages(file, parseKimiChunk);
    expect(r2.messages).toEqual([]);
  });
});

describe("discovery", () => {
  let home: string;
  const projectDir = "/home/vinci/projects/stock_data";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "discovery-test-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeKimiWire(wdName: string, sessionName: string, mtime: Date): Promise<string> {
    const wire = path.join(home, ".kimi-code", "sessions", wdName, sessionName, "agents", "main", "wire.jsonl");
    await fs.mkdir(path.dirname(wire), { recursive: true });
    await fs.writeFile(wire, "{}\n");
    await fs.utimes(wire, mtime, mtime);
    return wire;
  }

  it("kimi：按 wd_<basename>_ 前缀匹配，按 mtime 取最新", async () => {
    await writeKimiWire("wd_stock_data_aaaa", "session_old", new Date("2026-08-01"));
    const newest = await writeKimiWire("wd_stock_data_bbbb", "session_new", new Date("2026-08-10"));
    await writeKimiWire("wd_other_cccc", "session_x", new Date("2026-08-12")); // 前缀不匹配

    expect(await findKimiSessionFile(projectDir, home)).toBe(newest);
  });

  it("kimi：无匹配目录返回 null", async () => {
    expect(await findKimiSessionFile(projectDir, home)).toBeNull();
  });

  function dateDir(daysAgo: number): string {
    const d = new Date(Date.now() - daysAgo * 86400_000);
    return path.join(
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    );
  }

  async function writeRollout(daysAgo: number, name: string, cwd: string, ts: string): Promise<string> {
    const file = path.join(home, ".codex", "sessions", dateDir(daysAgo), name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // base_instructions 撑大首行，验证流式读首行不被 33KB+ 的 session_meta 卡死
    const meta = { timestamp: ts, type: "session_meta", payload: { timestamp: ts, cwd, base_instructions: { text: "x".repeat(100_000) } } };
    await fs.writeFile(file, JSON.stringify(meta) + "\n");
    return file;
  }

  it("codex：按首行 session_meta 的 cwd 匹配，取最新", async () => {
    const expectHit = await writeRollout(1, "rollout-new.jsonl", projectDir, "2026-08-11T10:00:00Z");
    await writeRollout(1, "rollout-other.jsonl", "/some/other/project", "2026-08-11T12:00:00Z"); // cwd 不匹配
    await writeRollout(5, "rollout-old.jsonl", projectDir, "2026-08-07T10:00:00Z"); // 更早的匹配

    expect(await findCodexSessionFile(projectDir, { homeDir: home })).toBe(expectHit);
  });

  it("codex：同一天多个匹配取时间最新者", async () => {
    await writeRollout(1, "rollout-a.jsonl", projectDir, "2026-08-11T10:00:00Z");
    const later = await writeRollout(1, "rollout-b.jsonl", projectDir, "2026-08-11T15:00:00Z");
    expect(await findCodexSessionFile(projectDir, { homeDir: home })).toBe(later);
  });

  it("codex：超出 days 窗口的目录不扫，返回 null", async () => {
    await writeRollout(10, "rollout-old.jsonl", projectDir, "2026-08-01T10:00:00Z");
    expect(await findCodexSessionFile(projectDir, { homeDir: home, days: 5 })).toBeNull();
  });
});
