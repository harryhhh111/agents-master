import type { ParseResult, SessionMessage } from "./types.js";

const SYSTEM_REMINDER = /^<system-reminder>/;
// codex 注入 user 消息里的环境/指令块，非贪婪跨行剥离
const INJECTED =
  /<(recommended_plugins|environment_context|user_instructions|permissions_instructions)>.*?<\/\1>/gs;

/** 取舍规则对照 docs/handoff-analysis/extract.py 的 extract_codex：
 * 只保留 response_item 中 payload.type=="message" 且 role 为 user/assistant 的文本；
 * 丢弃 reasoning、custom_tool_call、function_call、event_msg 等。
 */
export function parseCodexChunk(chunk: string): ParseResult {
  const messages: SessionMessage[] = [];
  let warnings = 0;

  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      warnings++;
      continue;
    }
    if (typeof d !== "object" || d === null) {
      warnings++;
      continue;
    }
    const rec = d as Record<string, unknown>;
    if (rec.type !== "response_item") continue;
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    if (!Array.isArray(payload.content)) {
      warnings++;
      continue;
    }
    let text = joinContentText(payload.content).trim();
    if (role === "user") text = text.replace(INJECTED, "").trim();
    if (!text || SYSTEM_REMINDER.test(text)) continue;
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (Number.isNaN(ts)) warnings++;
    messages.push({ ts: Number.isNaN(ts) ? 0 : ts, who: role, text });
  }
  return { messages, warnings };
}

function joinContentText(content: unknown[]): string {
  let out = "";
  for (const c of content) {
    if (typeof c === "object" && c !== null) {
      const item = c as Record<string, unknown>;
      if ((item.type === "input_text" || item.type === "output_text") && typeof item.text === "string") {
        out += item.text;
      }
    }
  }
  return out;
}
