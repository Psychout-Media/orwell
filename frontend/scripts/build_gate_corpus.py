#!/usr/bin/env python3
"""ORW-1156 part 3: build the gate corpus (codes only) from admin transcript exports.

    python scripts/build_gate_corpus.py <dir of /api/admin/transcripts/<id> JSON exports> [--out data/gate_corpus.json]

Run it on a machine that may READ the transcripts. The output holds a short hash code per player message, the acts the turn really carried and each gate's decision: never any text.
Re-run after a gate changes to re-measure. Prints the per-gate miss rates."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src import gate_corpus  # noqa: E402

_TOOL_RE = re.compile(r'"(?:tool|name)"\s*:\s*"(\w+)"')
_MOVE_RE = re.compile(r'"playerMove"\s*:\s*\{(?![^}]*"refused")[^}]*"to"')


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(p.get("text", "")) if isinstance(p, dict) else str(p) for p in content)
    return ""


def rows_of_session(doc: dict) -> "list[dict]":
    msgs = doc.get("messages") or []
    rows, i = [], 0
    while i < len(msgs):
        m = msgs[i]
        if m.get("role") != "user":
            i += 1
            continue
        user = _text(m.get("content"))
        j, tools, narration, moved = i + 1, [], [], False
        while j < len(msgs) and msgs[j].get("role") != "user":
            blob = json.dumps(msgs[j].get("metadata") or msgs[j].get("tool_calls") or {})
            tools += _TOOL_RE.findall(blob)
            moved = moved or bool(_MOVE_RE.search(blob))
            if msgs[j].get("role") == "assistant":
                narration.append(_text(msgs[j].get("content")))
            j += 1
        if user.strip():
            rows.append(gate_corpus.row_for(user, gate_corpus.acts_of_turn(tools, " ".join(narration), moved)))
        i = j
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", default=str(gate_corpus.corpus_path()))
    a = ap.parse_args()
    rows, seen = [], set()
    for f in sorted(Path(a.src).glob("*.json")):
        try:
            doc = json.loads(f.read_text())
        except Exception as e:  # a bad export is skipped, loudly
            print(f"skip {f.name}: {type(e).__name__}", file=sys.stderr)
            continue
        if not doc.get("is_game_session", True):
            continue
        for r in rows_of_session(doc):
            if r["code"] not in seen:
                seen.add(r["code"])
                rows.append(r)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps({"rows": rows}, indent=0))
    print(f"{len(rows)} messages ({sum(1 for r in rows if r['acts'])} with an act) -> {a.out}")
    for g, v in gate_corpus.miss_rates(rows).items():
        print(f"  {g:24s} acts={','.join(v['acts']):24s} positives={v['positives']:4d} misses={v['misses']:4d} rate={v['missRate']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
