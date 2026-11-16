#!/usr/bin/env python3
"""photobrief_probe: author the per-person SHOT BRIEFS for a cast file with the real cast writer (or a canned one) and print the final photo prompts.

What one run does:
  1. reads a cards file (a flat list of 15 public cards, or the older {"casts":[{"cards":[...]}]} wrapper) and the FLOOR prompts the engine built for them
     (`npx tsx scripts/orw480-three.ts <cards.json> --all --json > floor.json`);
  2. deals the random anchors per person (facet of life, time, season and weather, energy) from seeded side streams;
  3. ONE writer call for the whole cast (15 briefs), the per-brief checks, ONE editor pass for the offenders, the floor for any that still fail;
  4. composes the final prompt of each person (the engine's prompt with its clothes, setting, light and moment sentences replaced by the brief);
  5. prints the prompts in the `--- npc_N (Name)` format on stdout, the briefs + anchors + rejections to --briefs FILE, and the model calls and cost to stderr.

Isolation (the same sandbox as castprobe, imported from the file next to this one): the writer config is a one-time READ-ONLY copy of production settings and
endpoints into a temp dir; a Python audit hook blocks every write, rename, delete, subprocess and every connect to the production engine port; image entry points
raise. It starts NO engine (briefs need none) and makes NO image call. --dry uses a canned writer and no network at all.

Usage:
  Put orwell_photo_brief.py (frontend/src/) next to this file when running against a production install that does not have it yet.
  python3 photobrief_probe.py --cards casts/0052-....json --floor floor-0052.json --ids npc:10,npc:15,npc:12 [--briefs briefs.json] [--out prompts.txt] [--seed 1]
  python3 photobrief_probe.py ... --dry --app <a checkout with frontend/src>   # offline, canned writer
Exit: 0 ok, 2 error.
"""
import argparse
import asyncio
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def load_cards(path):
    raw = json.load(open(path, encoding="utf-8"))
    if isinstance(raw, dict):
        casts = raw.get("casts") or []
        raw = (casts[0].get("cards") if casts else []) or []
    return [c for c in raw if isinstance(c, dict) and c.get("id")]


CANNED_PLACES = (
    "the end of a short pier behind the person's home near {town}, with {thing} piled beside it",
    "the corner of a quiet street in {town}, {thing} stacked against the wall behind",
    "the back yard of the person's home in {town}, with {thing} growing along the fence",
    "a worn path through a field outside {town}, with {thing} in the long grass",
    "the person's own kitchen table in {town}, with {thing} drying on the sill",
    "a small back room of the person's home in {town}, with {thing} on a shelf",
    "the steps of a small hall in {town}, with {thing} propped by the door",
)
CANNED_DOING = ("paused between two small chores", "stopped mid-way through reading something", "just looking up from a task", "waiting for someone to arrive",
                "holding a cup and listening", "half-turned from a conversation", "resting after a long walk")
CANNED_BODY = ("an easy half-smile, shoulders loose, standing upright", "a steady look at the camera, jaw relaxed, upright", "a wide real laugh, looking off to one side",
               "a calm, level look, arms relaxed at the sides", "a small shy smile, eyes dropping away, shoulders a little in", "a dry half-smile, one brow slightly raised")


CANNED_OBJ = ("lantern", "ladder", "kettle", "trowel", "binder", "bucket", "spade", "saddle", "anvil", "tripod", "hamper", "canoe", "hammock", "radio", "easel")
CANNED_FAR = ("a heron standing", "a dog asleep", "a pickup parked", "a neighbour walking", "a cat sitting", "a tractor idling", "a rowboat drifting", "a bicycle leaning",
              "a goat grazing", "a delivery van parked", "a child on a scooter", "a horse standing", "a kite flying", "a cart parked", "a gull perched")
CANNED_SIG = ("a pocketknife on a lanyard-free cord", "a pocket notebook", "a harmonica", "a stopwatch", "a bone whistle", "a dented lunchbox", "a brass telescope", "a paperweight",
              "a ring of old keys", "a tin pinwheel", "a medallion", "a travel ukulele", "a silver thimble", "a pressed-flower scrapbook", "a small compass")


def canned_llm(cards):
    """An offline writer: a plausible, DIFFERENT brief per person built from their sheet (for the unit tests and --dry). Never a real model."""
    async def fn(messages):
        user = json.loads(messages[-1]["content"])
        sheets = user.get("cast") or user.get("rewrite") or {}
        out = {}
        for n, (i, s) in enumerate(sheets.items()):
            bio = str(s.get("biography") or "")
            town = str(s.get("hometown") or "their town")
            words = [w for w in re.findall(r"[A-Za-z]{6,}", bio)]
            thing = words[(n * 3 + 1) % len(words)] if words else "garden"
            wardrobe = [w for w in (s.get("wardrobe") or []) if isinstance(w, str)] or ["a plain grey tee", "worn jeans"]
            q = (bio.split(".")[0] or "an ordinary life")[:60]
            a = s.get("anchors") or {}
            out[i] = {
                "where": CANNED_PLACES[n % len(CANNED_PLACES)].format(town=town, thing=thing),
                "doing": CANNED_DOING[n % len(CANNED_DOING)],
                "inFrame": [f"a {CANNED_OBJ[n % len(CANNED_OBJ)]} left out", f"{CANNED_FAR[n % len(CANNED_FAR)]} far off, out of focus"],
                "wear": ", ".join(wardrobe[:2]),
                "signature": CANNED_SIG[n % len(CANNED_SIG)],
                "timeLight": f"{a.get('time', 'mid-morning')}, {a.get('weather', 'clear')}",
                "expressionBody": CANNED_BODY[n % len(CANNED_BODY)],
                "why": f'"{q}"',
                "tie": f'"{thing}"',
            }
        return json.dumps(out)
    return fn


def parse_floor(path):
    d = json.load(open(path, encoding="utf-8"))
    return {k.replace("_", ":"): v for k, v in d.items()}


def load_brief_module():
    """The brief module: the copy next to this file when there is one (so the probe runs against a production install that does not have the new code), else the front end's own."""
    import importlib.util
    here = os.path.join(HERE, "orwell_photo_brief.py")
    if os.path.exists(here):
        spec = importlib.util.spec_from_file_location("orwell_photo_brief_local", here)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    from src import orwell_photo_brief as mod
    return mod


async def run(args, cards, floor, llm_fn):
    B = load_brief_module()
    res = await B.author_briefs(cards, llm_fn, seed=args.seed)
    finals = {}
    for c in cards:
        i = str(c["id"])
        fp = (floor.get(i) or {}).get("prompt", "")
        finals[i] = B.final_prompt(fp, res["briefs"].get(i), res["anchors"].get(i), c) if fp else ""
    return res, finals


def emit(args, cards, floor, res, finals):
    ids = [x.strip() for x in args.ids.split(",") if x.strip()] if args.ids else [str(c["id"]) for c in cards]
    names = {str(c["id"]): c.get("name") or "" for c in cards}
    lines = []
    for i in ids:
        lines.append(f"\n--- {i.replace(':', '_')} ({names.get(i, '?')})\n{finals.get(i, '')}")
    text = "\n".join(lines) + "\n"
    sys.stdout.write(text)
    # the paths were made absolute against the launch directory before any chdir; a failed write is fatal, never silent
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        if not os.path.exists(args.out):
            raise RuntimeError(f"--out was not written: {args.out}")
    if args.briefs:
        with open(args.briefs, "w", encoding="utf-8") as f:
            json.dump({"briefs": res["briefs"], "floor": res["floor"], "floorReasons": res.get("floorReasons"), "oneObject": res.get("oneObject"), "anchors": res["anchors"], "rejected": res["rejected"], "rewritten": res["rewritten"],
                       "raw": res.get("raw"), "finalPrompts": {i: finals.get(i) for i in ids}, "floorPrompts": {i: (floor.get(i) or {}).get("prompt") for i in ids}},
                      f, indent=1, ensure_ascii=False)
        if not os.path.exists(args.briefs):
            raise RuntimeError(f"--briefs was not written: {args.briefs}")


def main():
    ap = argparse.ArgumentParser(description="Author the per-person photo briefs for a cast file and print the final prompts.")
    ap.add_argument("--cards", required=True)
    ap.add_argument("--floor", required=True, help="the engine's floor prompts: orw480-three.ts <cards> --all --json")
    ap.add_argument("--ids", default="", help="comma-separated ids to print (briefs are always authored for the whole cast)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=None)
    ap.add_argument("--briefs", default=None, help="write the briefs, anchors and rejection counts here")
    ap.add_argument("--dry", action="store_true", help="a canned writer, no network at all")
    ap.add_argument("--app", default="/opt/orwell")
    ap.add_argument("--fe-data", default=None)
    ap.add_argument("--resolve-as", default="rhino")
    ap.add_argument("--max-usd", type=float, default=0.05)
    ap.add_argument("--max-calls", type=int, default=6)
    args = ap.parse_args()
    # relative paths mean the directory the probe was launched from, whatever it chdirs into later
    for attr in ("cards", "floor", "out", "briefs", "fe_data", "app"):
        v = getattr(args, attr, None)
        if v:
            setattr(args, attr, os.path.abspath(v))
    cards, floor = load_cards(args.cards), parse_floor(args.floor)
    if len(cards) < 3:
        sys.exit("photobrief_probe: no cards found")
    app = os.path.abspath(args.app)
    fe = os.path.join(app, "frontend") if os.path.exists(os.path.join(app, "frontend", "src")) else os.path.abspath(os.path.join(HERE, ".."))
    if args.dry:
        sys.path.insert(0, fe)
        res, finals = asyncio.run(run(args, cards, floor, canned_llm(cards)))
        emit(args, cards, floor, res, finals)
        log(f"[photobrief] DRY: canned writer, calls={res['calls']} accepted={len(res['briefs'])} floor={len(res['floor'])} rejected={json.dumps(res['rejected'])}")
        return 0
    try:
        sys.path.insert(0, HERE)
        import castprobe as CP
    except Exception as e:
        sys.exit(f"photobrief_probe: castprobe.py must sit next to this file for the sandbox ({type(e).__name__}: {e}); use --dry offline")
    CP.STATE.update(dry=False, max_calls=args.max_calls, max_usd=args.max_usd)
    for var in ("ORWELL_ENGINE_MCP_URL", "BBAI_ENGINE_MCP_URL"):
        m = re.search(r":(\d+)", os.environ.get(var, "") or "")
        if m:
            CP.STATE["prod_ports"].add(int(m.group(1)))
    outs = {os.path.abspath(p) for p in (args.out, args.briefs) if p}
    orig_under = CP._under_tmp
    CP._under_tmp = lambda p: (isinstance(p, (str, os.PathLike)) and os.path.abspath(os.fspath(p)) in outs) or orig_under(p)
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="photobrief-", dir="/tmp"))
    os.chmod(tmp, 0o700)
    CP.STATE["tmp"] = tmp
    sys.addaudithook(CP._audit)
    code = 0
    try:
        for k in [k for k in os.environ if k.startswith("BBAI_")]:
            os.environ.pop(k)
        # no engine is started: these only let the front-end modules import (nothing connects to them)
        os.environ["ORWELL_ENGINE_MCP_URL"] = "http://127.0.0.1:9"
        os.environ["ORWELL_ENGINE_TOKEN"] = "probe-none"
        os.environ["ORWELL_ENGINE_ADMIN_TOKEN"] = "probe-none"
        ns = argparse.Namespace(dry=False, fe_data=args.fe_data, resolve_as=args.resolve_as)
        fe_dir, prod_data, fe_tmp = CP.prepare_frontend(app, tmp, ns)
        os.chdir(fe_tmp)
        CP.patch_constants(fe_tmp)
        import importlib
        importlib.import_module("core.database")
        CP.patch_after_import(fe_tmp, ns)
        n = CP.copy_endpoints(prod_data, fe_tmp)
        log(f"[photobrief] writer config: copied {n} model_endpoints row(s) read-only into the temp DB")
        CP.block_images()
        CP.install_meter()
        from src import orwell_cast_authoring as A
        owner = f"castprobe-{os.getpid()}-0"
        llm_fn = asyncio.run(A.resolve_authoring_llm_fn(owner, min_output_tokens=9000))
        if llm_fn is None:
            raise RuntimeError("no writer resolved")
        res, finals = asyncio.run(run(args, cards, floor, llm_fn))
        emit(args, cards, floor, res, finals)
        log(f"[photobrief] briefs accepted={len(res['briefs'])} (rewritten {res['rewritten']}) floor={len(res['floor'])} rejected={json.dumps(res['rejected'], sort_keys=True)}")
        log(f"[photobrief] floor reasons: {json.dumps(res.get('floorReasons'), sort_keys=True)}; objects landed {res.get('objectsLanded')}; one object left on {res.get('oneObject')}")
    except Exception as e:
        log(f"[photobrief] ERROR: {type(e).__name__}: {e}")
        code = 2
    finally:
        calls = CP.STATE["calls"]
        log(f"[photobrief] TOTAL calls={len(calls)} in_tokens={sum(c['in'] for c in calls)} out_tokens={sum(c['out'] for c in calls)} "
            f"cost=${sum(c['cost'] for c in calls):.4f}{' (partly estimated from tokens)' if any(c['est'] for c in calls) else ''}")
        log(f"[photobrief] sandbox: blocked write/network attempts = {len(CP.STATE['blocked'])}")
        for b in CP.STATE["blocked"][:20]:
            log(f"[photobrief]   blocked: {b}")
        import shutil
        os.chdir("/")
        CP.STATE["cleaning"] = True
        shutil.rmtree(tmp, ignore_errors=True)
        CP.STATE["cleaning"] = False
    return code


if __name__ == "__main__":
    sys.exit(main())
