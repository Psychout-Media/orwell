#!/usr/bin/env python3
"""ORW-554: the daily token-cost report. No model calls, no network: it only reads the token ledger's roll-up file.

    python scripts/orwell_token_report.py                     # every user, every stored UTC date
    python scripts/orwell_token_report.py --days 3 --user alice
    python scripts/orwell_token_report.py --rollup path/to/orwell_token_ledger_rollup.json --json

It prints, from the ledger's daily roll-up:
  * cost, calls, input tokens and cache hit rate per call site (the table that says where the money goes);
  * the same per model, and per UTC date;
  * cost per played day (mean, median, worst), for entries that carry an in-game day.

Hit rate = cache-hit tokens / (hit + miss) prompt tokens. A site whose rate is low while its input is large is
where a prompt-prefix fix pays most (a cache hit costs about one fiftieth of a miss).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_COUNTERS = ("calls", "inputTokens", "cacheHitTokens", "cacheMissTokens", "reasoningTokens", "outputTokens", "cost")


def _zero() -> dict:
    return {k: 0 for k in _COUNTERS}


def _add(into: dict, row: dict) -> None:
    for k in _COUNTERS:
        v = row.get(k, 0)
        into[k] = into.get(k, 0) + (v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0)


def _finish(row: dict) -> dict:
    out = dict(row)
    hm = out["cacheHitTokens"] + out["cacheMissTokens"]
    out["hitRate"] = (out["cacheHitTokens"] / hm) if hm > 0 else None
    out["cost"] = round(out["cost"], 6)
    return out


def build_report(rollup: dict, user: str | None = None, days: int | None = None) -> dict:
    """Aggregate a loaded roll-up dict ``{user: {"daily": ..., "gameDays": ...}}`` into the report structure (pure; testable by hand)."""
    roll = rollup if isinstance(rollup, dict) else {}
    roll = {u: r for u, r in roll.items() if isinstance(r, dict)}  # a damaged user row is skipped, never a crash
    users = [user] if user else sorted(roll)
    by_site: dict = {}
    by_model: dict = {}
    by_date: dict = {}
    game_days: dict = {}
    dates = sorted({d for u in users for d in ((roll.get(u) or {}).get("daily") or {})})
    if days and days > 0:
        dates = dates[-days:]
    keep = set(dates)
    for u in users:
        ur = roll.get(u) or {}
        for date, rows in (ur.get("daily") or {}).items():
            if date not in keep or not isinstance(rows, dict):
                continue
            for rk, row in rows.items():
                site, _, model = str(rk).partition("|")
                if not isinstance(row, dict):
                    continue
                _add(by_site.setdefault(site, _zero()), row)
                _add(by_model.setdefault(model, _zero()), row)
                _add(by_date.setdefault(date, _zero()), row)
        # played days are not dated, so they cover everything stored for the user (the --days window does not cut them)
        for gk, row in (ur.get("gameDays") or {}).items():
            if isinstance(row, dict):
                _add(game_days.setdefault(f"{u}/{gk}", _zero()), row)
    total = _zero()
    for r in by_site.values():
        _add(total, r)
    costs = [r["cost"] for r in game_days.values()]
    per_day = {
        "count": len(costs),
        "mean": round(statistics.fmean(costs), 6) if costs else None,
        "median": round(statistics.median(costs), 6) if costs else None,
        "max": round(max(costs), 6) if costs else None,
    }
    return {
        "dates": dates,
        "total": _finish(total),
        "bySite": {k: _finish(v) for k, v in sorted(by_site.items(), key=lambda kv: -kv[1]["cost"])},
        "byModel": {k: _finish(v) for k, v in sorted(by_model.items(), key=lambda kv: -kv[1]["cost"])},
        "byDate": {k: _finish(v) for k, v in sorted(by_date.items())},
        "costPerPlayedDay": per_day,
    }


def _pct(x) -> str:
    return "  n/a" if x is None else f"{100 * x:5.1f}%"


def _table(title: str, rows: dict, total_cost: float) -> list[str]:
    out = [title, f"  {'name':<34}{'calls':>8}{'input':>13}{'hit rate':>10}{'output':>11}{'cost USD':>11}{'share':>8}"]
    for name, r in rows.items():
        share = (r["cost"] / total_cost) if total_cost else 0
        out.append(f"  {name[:33]:<34}{r['calls']:>8}{r['inputTokens']:>13}{_pct(r['hitRate']):>10}"
                   f"{r['outputTokens']:>11}{r['cost']:>11.4f}{100 * share:>7.1f}%")
    return out


def render(rep: dict) -> str:
    t = rep["total"]
    lines = [f"Token cost report, UTC dates {rep['dates'][0] if rep['dates'] else '-'} .. {rep['dates'][-1] if rep['dates'] else '-'}",
             f"Total: {t['calls']} calls, {t['inputTokens']} input tokens, hit rate {_pct(t['hitRate']).strip()}, "
             f"{t['outputTokens']} output tokens, ${t['cost']:.4f}", ""]
    lines += _table("Per call site", rep["bySite"], t["cost"]) + [""]
    lines += _table("Per model", rep["byModel"], t["cost"]) + [""]
    lines += _table("Per UTC date", rep["byDate"], t["cost"]) + [""]
    p = rep["costPerPlayedDay"]
    if p["count"]:
        lines.append(f"Cost per played day over {p['count']} days: mean ${p['mean']:.4f}, median ${p['median']:.4f}, worst ${p['max']:.4f}")
    else:
        lines.append("Cost per played day: no entries carry an in-game day yet")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rollup", help="path to orwell_token_ledger_rollup.json (default: the app's data dir)")
    ap.add_argument("--user", help="only this user (default: all)")
    ap.add_argument("--days", type=int, help="only the most recent N UTC dates")
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    a = ap.parse_args(argv)
    if a.rollup:
        path = Path(a.rollup)
    else:
        from src.orwell_token_ledger import _rollup_path

        path = _rollup_path()
    try:
        rollup = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        print("no roll-up file yet", file=sys.stderr)
        return 1
    except ValueError:
        print("roll-up file is not valid JSON", file=sys.stderr)
        return 1
    rep = build_report(rollup, user=a.user, days=a.days)
    print(json.dumps(rep, indent=2) if a.json else render(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
