#!/usr/bin/env python3
"""ORW-1148 ops tool: bring houseguests into a room on a live save through the engine's own moveHouseguest, logged, replacing ad hoc scripts.

Dry run by default (reports who would move). `--apply` commits. Every run writes one audit line (logger plus the JSONL file named by ORWELL_OPS_LOG, default ~/.orwell/ops-regroup.jsonl).
Run from the frontend directory on the host that reaches the engine (ORWELL_ENGINE_MCP_URL):

    python3 scripts/orwell_regroup.py --user <owner> --room bedroom-c --who npc:1 npc:10 npc:15 --reason "why" [--apply]

Take the save snapshot first with the usual snapshot step; this tool never edits anything except the open occupancy of the named houseguests, and the engine refuses an illegal move."""
import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


async def _main(a) -> int:
    from src import orwell_engine, scene_reconcile
    rep = await scene_reconcile.regroup(a.user, a.room, a.who, orwell_engine, reason=a.reason, apply=a.apply, operator=a.operator)
    print(json.dumps(rep, indent=2, sort_keys=True))
    bad = [p for p in rep["people"] if p["result"] in ("unknown", "error", "illegal")]
    return 1 if bad else 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--user", required=True, help="the save owner's user key")
    p.add_argument("--room", required=True, help="the room id to bring them to, as the engine names it")
    p.add_argument("--who", nargs="+", required=True, help="houseguest ids or names")
    p.add_argument("--reason", required=True, help="why (goes in the audit line)")
    p.add_argument("--operator", default=os.environ.get("USER", "ops"))
    p.add_argument("--apply", action="store_true", help="commit the moves (default is a dry run)")
    return asyncio.run(_main(p.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
