#!/usr/bin/env python3
"""把 codex rollout jsonl / kimi wire.jsonl 浓缩成"用户说了什么 / agent 正式回复了什么"的纯对话记录。

取舍规则:
- Kimi: 保留 turn.prompt / turn.steer (用户输入) 和 content.part 中 type==text 的 assistant 回复;
        丢弃 think、tool.call/result、step/usage/llm.request 等中间过程。
- Codex: 保留 response_item 中 message role=user/assistant 的文本;
         丢弃 reasoning、custom_tool_call、function_call、event_msg 等。
"""
import json
import sys
import re
from pathlib import Path

SR = re.compile(r"^<system-reminder>", re.S)
INJECTED = re.compile(
    r"<(recommended_plugins|environment_context|user_instructions|permissions_instructions)>.*?</\1>",
    re.S,
)


def clean(text: str) -> str:
    return text.strip()


def extract_kimi(path: Path, out):
    turn_time = {}
    last_text_part = {}  # (turnId, step) -> uuid, 同一 part 可能多次 append, 去重
    seen_parts = set()
    for line in path.open():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = d.get("type")
        if t == "turn.prompt":
            origin = d.get("origin", {}).get("kind")
            if origin != "user":
                continue
            text = "".join(p.get("text", "") for p in d.get("input", []) if p.get("type") == "text")
            if not text or SR.match(text):
                continue
            out.append((d.get("time", 0), "USER", clean(text)))
        elif t == "turn.steer":
            text = "".join(p.get("text", "") for p in d.get("input", []) if p.get("type") == "text")
            if text and not SR.match(text):
                out.append((d.get("time", 0), "USER(steer)", clean(text)))
        elif t == "context.append_loop_event":
            e = d.get("event", {})
            if e.get("type") == "content.part":
                part = e.get("part", {})
                if part.get("type") == "text":
                    uuid = e.get("uuid")
                    if uuid in seen_parts:
                        continue
                    seen_parts.add(uuid)
                    text = part.get("text", "")
                    if text.strip():
                        out.append((d.get("time", 0), "KIMI", clean(text)))


def extract_codex(path: Path, out):
    for line in path.open():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("type") != "response_item":
            continue
        p = d.get("payload", {})
        if p.get("type") != "message":
            continue
        role = p.get("role")
        if role not in ("user", "assistant"):
            continue
        texts = []
        for c in p.get("content", []):
            if isinstance(c, dict) and c.get("type") in ("input_text", "output_text"):
                texts.append(c.get("text", ""))
        text = clean("".join(texts))
        if role == "user":
            text = clean(INJECTED.sub("", text))
        if not text or SR.match(text):
            continue
        ts = d.get("timestamp", "")
        out.append((ts, "USER" if role == "user" else "CODEX", text))


def fmt_time(ts):
    if isinstance(ts, (int, float)) and ts:
        import datetime
        return datetime.datetime.fromtimestamp(ts / 1000).strftime("%m-%d %H:%M:%S")
    return str(ts)[:19]


def main():
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    out = []
    if "wire" in src.name:
        extract_kimi(src, out)
    else:
        extract_codex(src, out)
    with dst.open("w") as f:
        for ts, who, text in out:
            f.write(f"\n===== [{fmt_time(ts)}] {who} =====\n{text}\n")
    print(f"{src.name}: {len(out)} messages -> {dst} ({dst.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
