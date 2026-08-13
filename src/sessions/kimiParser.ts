import type { ParseResult, SessionMessage } from "./types.js";

const SYSTEM_REMINDER = /^<system-reminder>/;

/** 取舍规则对照 docs/handoff-analysis/extract.py 的 extract_kimi：
 * 保留 turn.prompt(origin.kind=="user") / turn.steer / content.part 中的 text；
 * 丢弃 think、tool.call/result、step.*、llm.request、usage 等中间过程。
 */
export function parseKimiChunk(chunk: string): ParseResult {
  const messages: SessionMessage[] = [];
  let warnings = 0;
  // 同一 text part 可能 append 多次，按 event.uuid 去重（去重范围为本 chunk）
  const seenParts = new Set<string>();

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
    const type = rec.type;

    if (type === "turn.prompt" || type === "turn.steer") {
      const origin = rec.origin as Record<string, unknown> | undefined;
      // steer 不检查 origin.kind：实测后台任务通知也走 turn.steer，与 extract.py 保持一致全部保留
      if (type === "turn.prompt" && origin?.kind !== "user") continue;
      if (!Array.isArray(rec.input)) {
        warnings++;
        continue;
      }
      const text = joinInputText(rec.input).trim();
      if (!text || SYSTEM_REMINDER.test(text)) continue;
      const ts = typeof rec.time === "number" ? rec.time : null;
      if (ts === null) warnings++;
      const msg: SessionMessage = { ts: ts ?? 0, who: "user", text };
      if (type === "turn.steer") msg.kind = "steer";
      messages.push(msg);
    } else if (type === "context.append_loop_event") {
      const event = rec.event as Record<string, unknown> | undefined;
      if (event?.type !== "content.part") continue;
      const part = event.part as Record<string, unknown> | undefined;
      if (part?.type !== "text") continue;
      const uuid = typeof event.uuid === "string" ? event.uuid : null;
      if (uuid === null) warnings++;
      const dedupeKey = uuid ?? JSON.stringify(part.text);
      if (seenParts.has(dedupeKey)) continue;
      seenParts.add(dedupeKey);
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (!text || SYSTEM_REMINDER.test(text)) continue;
      const ts = typeof rec.time === "number" ? rec.time : null;
      if (ts === null) warnings++;
      messages.push({ ts: ts ?? 0, who: "assistant", text });
    }
    // 其他 type（think / tool.* / step.* / llm.request / usage ...）一律丢弃
  }
  return { messages, warnings };
}

function joinInputText(input: unknown[]): string {
  let out = "";
  for (const p of input) {
    if (typeof p === "object" && p !== null) {
      const part = p as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") out += part.text;
    }
  }
  return out;
}
