#!/usr/bin/env python3
"""ORW-1145 - the DEV LIVE CHECK: one flag ON then OFF on a box that stands still, on a fresh pre-cast account, reporting the turnDrivers numbers.

  ORWELL_INTERNAL_TOKEN=<the dev box's internal token> \\
    python3 scripts/live-run/live_check.py --base-url http://<dev host>:<port> --flag act_first_enabled --turns 6 [--seed N] [--out DIR] [--max-spend 1.0]

What it does, in order (dev only: the three ops routes refuse a production deployment):
  1. HOLD    POST /api/admin/ops/deploy-hold: writes data/.deploy-hold, which deploy/orwell-update.sh honours, so no auto-deploy restarts the services mid-run.
  2. ACCOUNT POST /api/admin/ops/prepare-test-account: a livecheck-<utc> admin account, images OFF, a season started through the engine with the fixed seed, and the
             WHOLE cast authored inside that call, so turn 1 is playable at once (the 4-6 minute wait is spent here, not inside a turn).
  3. PLAY    logs in as that account, finds the default chat model, opens the game chat and plays N scripted turns (the deterministic live_full Player: no model picks
             the words) with the flag ON, then N with it OFF (the setting is POSTed as the test admin and put back as it was afterwards).
  4. REPORT  GET /api/admin/health as the test account; prints the turnDrivers counters for each arm (the DELTA over that arm) and writes report.json and report.md.
  5. CLEAR   always, even after a failure: clears the hold, restores the flag, deletes the account (unless --keep-account).

Secrets: the internal token is read from ORWELL_INTERNAL_TOKEN (never from an argument), the account password is generated in memory and handed to the login call; neither is
printed, logged or written. The report holds numbers only: no player or houseguest text.
Exit: 0 done, 2 could not run, 4 spend cap reached. Offline self-test (no network, no spend): python3 scripts/live-run/live_check.py --dry-run
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "rehearsal-kit"))

import live_compare as lc  # noqa: E402
import live_full as lf  # noqa: E402
import live_truth as lt  # noqa: E402

TOKEN_HEADER = "X-Orwell-Internal-Token"
DRIVER_KEYS = ("turns", "narratorToolTurns", "beltDrivenTurns", "narratorOnly", "beltOnly", "both", "none", "planOnly", "planCommitTurns",
               "actFirstTurns", "engineFlowTurns", "unledgeredTurns", "errorTurns")
DEFAULT_FLAG = "act_first_enabled"
DEFAULT_HOLD_MINUTES = 120


class Ops:
    """The token-authenticated admin doors (hold, account). The token never leaves this object."""

    def __init__(self, base, token, timeout=1800):
        self.base, self._token, self.timeout = base.rstrip("/"), token, timeout

    def post(self, path, body):
        r = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method="POST",
                                   headers={"content-type": "application/json", TOKEN_HEADER: self._token})
        try:
            with urllib.request.urlopen(r, timeout=self.timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            try:
                why = json.load(e).get("reason", "")
            except Exception:  # noqa: BLE001 - an unreadable error body is just no reason
                why = ""
            raise RuntimeError(f"POST {path} -> HTTP {e.code} {why}".strip()) from None
        except urllib.error.URLError as e:
            raise RuntimeError(f"POST {path} -> {type(e.reason).__name__}") from None


class Player(lf.LiveWorld):
    """The test account's own session: the browser's API plus the few admin reads and writes the account may make as an admin."""

    def ensure_session(self):
        """Open the game chat on the default chat model and bind it as the account's canonical game session (what the browser does on first load)."""
        got = self._req("GET", "/api/orwell/game-session") or {}
        if got.get("sessionId"):
            self.session = got["sessionId"]
            return
        dflt = self._req("GET", "/api/default-chat") or {}
        ep, model = dflt.get("endpoint_id") or dflt.get("endpointId") or "", dflt.get("model") or ""
        if not (ep and model):
            raise RuntimeError("no default chat model is configured for the test account")
        from urllib.parse import urlencode
        form = urlencode({"name": "Season 1", "endpoint_id": ep, "model": model, "skip_validation": "true"}).encode()
        r = urllib.request.Request(self.base + "/api/session", data=form, method="POST", headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json"})
        try:
            sid = json.load(self.op.open(r, timeout=60))["id"]
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"POST /api/session -> HTTP {e.code}") from None
        self._req("POST", "/api/orwell/game-session", {"sessionId": sid})
        self.session = sid

    def login_only(self):
        self._req("POST", "/api/auth/login", {"username": self._user, "password": self._pw, "remember": False})
        self._pw = None
        self.ensure_session()

    def get_flag(self, flag):
        return bool((self._req("GET", "/api/auth/settings") or {}).get(flag))

    def set_flag(self, flag, value):
        self._req("POST", "/api/auth/settings", {flag: bool(value)})

    def drivers(self):
        d = (self._req("GET", "/api/admin/health") or {}).get("turnDrivers")
        return d if isinstance(d, dict) else {}


def delta(before, after):
    """Per-key difference of the numeric counters; the rates are recomputed from the deltas (a rate of a window, not of the ring)."""
    out = {k: (after.get(k) or 0) - (before.get(k) or 0) for k in DRIVER_KEYS}
    n = out["turns"]
    out["narratorToolRate"] = round(out["narratorToolTurns"] / n, 3) if n > 0 else None
    out["beltDrivenRate"] = round(out["beltDrivenTurns"] / n, 3) if n > 0 else None
    return out


def play_arm(world, label, flag, value, turns, meter, max_spend, log):
    """Set the flag, play `turns` scripted turns, return the arm's numbers. A cap, a stuck card or a failed turn ends the arm and is named in `ended`."""
    world.set_flag(flag, value)
    before = world.drivers()
    player, played, errors, secs, ended = lf.Player(), [], 0, [], "done"
    budget = lc.Budget(max_spend, turns, meter)
    st = world.state()
    cards = 0
    try:
        while True:
            pend = lt.facts(st)["pending"]
            if pend:
                cards += 1
                if cards > lf.CARD_STEPS_MAX:
                    ended = "a decision card would not clear"
                    break
                world.decide(lf.decision_body(pend, lt.facts(st)["player"]))
                st = world.state()
                continue
            budget.check()
            msg = player.next_message(st, played)
            reply = world.send(msg)
            st = world.state()
            budget.note_turn()
            meter.add_reply(reply)
            played.append({"text": reply.text, "msg": msg})
            secs.append(reply.secs)
            errors += 1 if reply.error else 0
            log(label, len(played), reply.secs, "error" if reply.error else "ok")
    except lc.BudgetExceeded as e:
        ended = "done" if e.kind == "turn" else f"{e.kind} cap reached"
    except Exception as e:  # noqa: BLE001 - the arm's failure is data, never a crash that skips the clear step
        ended = f"{type(e).__name__}"
    after = world.drivers()
    srt = sorted(secs)
    return {"arm": label, "flag": flag, "value": value, "turnsPlayed": len(played), "turnErrors": errors, "ended": ended,
            "secsMedian": srt[len(srt) // 2] if srt else None, "secsMax": srt[-1] if srt else None, "drivers": delta(before, after)}


def render(meta, arms):
    lines = [f"# Live check {meta['flag']} on {meta['build']}", "", f"seed {meta['seed']}, {meta['turns']} turns per arm, hold {meta['holdMinutes']} min, started {meta['startedUtc']} UTC "
             f"(Arizona {meta['startedAz']}), cast authored {meta['authored']}/{meta['total']} in {meta['authorSeconds']} s", "",
             "| arm | turns | errors | secs median / max | narrator tool turns | belt driven | act-first | none | tool rate | belt rate | ended |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for a in arms:
        d = a["drivers"]
        lines.append(f"| {a['arm']} | {a['turnsPlayed']} | {a['turnErrors']} | {a['secsMedian']} / {a['secsMax']} | {d['narratorToolTurns']} | {d['beltDrivenTurns']} | "
                     f"{d['actFirstTurns']} | {d['none']} | {d['narratorToolRate']} | {d['beltDrivenRate']} | {a['ended']} |")
    lines += ["", "Numbers only. No player or houseguest text is in this report."]
    return "\n".join(lines) + "\n"


def run_check(ops, world_factory, args, out_dir, now=None, log=lambda *_: None):
    """The whole check around a `world_factory(username, password)` (a Player, or a stub in the self-test). Returns (exit_code, report_dict). The clear step always runs."""
    ts = (now or dt.datetime.now(dt.timezone.utc))
    username = "livecheck-" + ts.strftime("%Y%m%d%H%M%S")
    password = secrets.token_urlsafe(24)
    held = created = False
    world = None
    prior = None
    arms, code, meta = [], 0, {}
    try:
        ops.post("/api/admin/ops/deploy-hold", {"minutes": args.hold_minutes, "reason": "live check " + ts.strftime("%H:%M")})
        held = True
        log("hold", "set", args.hold_minutes)
        prep = ops.post("/api/admin/ops/prepare-test-account", {"username": username, "password": password, "seed": args.seed, "authorTimeoutS": args.author_timeout})
        created = bool(prep.get("created"))
        if not prep.get("ok"):
            raise RuntimeError("the account was not prepared: " + str(prep.get("reason")))
        if not prep.get("ready"):
            raise RuntimeError(f"the cast is not fully authored ({prep.get('authored')}/{prep.get('total')}); not playing on a floor cast")
        world = world_factory(username, password)
        world.login_only()
        prior = world.get_flag(args.flag)
        meter = lf.SpendMeter()
        for label, value in (("ON", True), ("OFF", False)):
            arm = play_arm(world, label, args.flag, value, args.turns, meter, args.max_spend, log)
            arms.append(arm)
            if arm["ended"].endswith("cap reached"):
                code = 4
                break
        build = world.build()
        meta = {"flag": args.flag, "build": build, "seed": args.seed, "turns": args.turns, "holdMinutes": args.hold_minutes, "startedUtc": ts.strftime("%Y-%m-%d %H:%M"),
                "startedAz": (ts - dt.timedelta(hours=7)).strftime("%Y-%m-%d %H:%M"), "authored": prep.get("authored"), "total": prep.get("total"), "authorSeconds": prep.get("authorSeconds")}
    except Exception as e:  # noqa: BLE001
        code = 2
        meta = dict(meta, error=f"{type(e).__name__}: {e}"[:300])
    finally:
        if world is not None and prior is not None:
            try:
                world.set_flag(args.flag, prior)
            except Exception as e:  # noqa: BLE001
                meta["restoreFlagFailed"] = type(e).__name__
        if created and not args.keep_account:
            try:
                ops.post("/api/admin/ops/delete-test-account", {"username": username})
            except Exception as e:  # noqa: BLE001
                meta["deleteAccountFailed"] = str(e)[:120]
        if held:
            try:
                ops.post("/api/admin/ops/deploy-hold", {"clear": True})
                log("hold", "cleared")
            except Exception as e:  # noqa: BLE001
                meta["clearHoldFailed"] = str(e)[:120]   # the hold still ends by itself (bounded, counted from the file's mtime)
    report = {"meta": meta, "arms": arms}
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=1)
        if arms and "error" not in meta:
            with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as fh:
                fh.write(render(meta, arms))
    return code, report


class StubOps:
    """Offline: records every door call. `fail_on` makes the named path raise, to prove the clear step still runs."""

    def __init__(self, fail_on=None, authored=15, total=15):
        self.calls, self.fail_on, self.authored, self.total = [], fail_on, authored, total

    def post(self, path, body):
        self.calls.append((path, {k: v for k, v in body.items() if k != "password"}))
        if self.fail_on and path.endswith(self.fail_on):
            raise RuntimeError(f"POST {path} -> stub failure")
        if path.endswith("prepare-test-account"):
            return {"ok": True, "created": True, "authored": self.authored, "total": self.total, "ready": self.authored == self.total, "authorSeconds": 1.0}
        return {"ok": True}


class StubWorld(lf.ReplayWorld):
    """Offline: the generated week, a flag the arms flip, and a turnDrivers ring that grows one turn at a time (a flag ON turn counts as act-first)."""

    def __init__(self, steps, first):
        super().__init__(steps, first)
        self.flags, self.ring, self.on = {}, {k: 0 for k in DRIVER_KEYS}, False

    def login_only(self):
        pass

    def get_flag(self, flag):
        return bool(self.flags.get(flag))

    def set_flag(self, flag, value):
        self.flags[flag] = bool(value)
        self.on = bool(value)

    def drivers(self):
        return dict(self.ring)

    def send(self, message):
        r = super().send(message)
        self.ring["turns"] += 1
        if self.on:
            self.ring["narratorToolTurns"] += 1
            self.ring["actFirstTurns"] += 1
        else:
            self.ring["beltDrivenTurns"] += 1
        return r


def dry_run(a, out):
    """The offline self-test: a stub server, the generated week, the whole flow, no network and no spend. Exit 0 only while the flow works AND the clear step survives a failure."""
    steps, first = lf.stub_week(None)
    ops = StubOps()
    code, rep = run_check(ops, lambda u, p: StubWorld(steps, first), a, out)
    paths = [c[0].rsplit("/", 1)[-1] for c in ops.calls]
    ok = code == 0 and [x["arm"] for x in rep["arms"]] == ["ON", "OFF"] and paths == ["deploy-hold", "prepare-test-account", "delete-test-account", "deploy-hold"] and ops.calls[-1][1] == {"clear": True}
    ok = ok and rep["arms"][0]["drivers"]["actFirstTurns"] == rep["arms"][0]["turnsPlayed"] and rep["arms"][1]["drivers"]["actFirstTurns"] == 0
    bad = StubOps(fail_on="prepare-test-account")   # positive control: a failed step still clears the hold
    code2, _ = run_check(bad, lambda u, p: StubWorld(steps, first), a, None)
    ok = ok and code2 == 2 and bad.calls[-1][1] == {"clear": True}
    print("LIVE-CHECK DRY-RUN", "PASS" if ok else "FAIL", out)
    return 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base-url", help="the dev front end's base URL")
    ap.add_argument("--flag", default=DEFAULT_FLAG, help=f"the runtime setting to turn ON then OFF (default {DEFAULT_FLAG})")
    ap.add_argument("--turns", type=int, default=6, help="scripted turns per arm (1..40)")
    ap.add_argument("--seed", type=int, default=20261128)
    ap.add_argument("--hold-minutes", type=int, default=DEFAULT_HOLD_MINUTES, help="how long the deploy hold lasts at most (1..240)")
    ap.add_argument("--author-timeout", type=float, default=900.0, help="seconds the cast authoring may take inside the account step")
    ap.add_argument("--max-spend", type=float, default=1.0, help="dollars (the harness's own high estimate); the run stops cleanly at this")
    ap.add_argument("--out", default=None)
    ap.add_argument("--keep-account", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="offline self-test against a stub server: no network, no spend")
    a = ap.parse_args(argv)
    a.turns = max(1, min(40, a.turns))
    a.hold_minutes = max(1, min(240, a.hold_minutes))
    out = a.out or os.path.join(os.getcwd(), "live-check-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    if a.dry_run:
        return dry_run(a, out)
    token = os.environ.get("ORWELL_INTERNAL_TOKEN", "")
    if not a.base_url or not token:
        print("LIVE-CHECK COULD-NOT-RUN: --base-url and ORWELL_INTERNAL_TOKEN are required")
        return 2
    ops = Ops(a.base_url, token)
    code, report = run_check(ops, lambda u, p: Player(a.base_url, u, p), a, out, log=lambda *x: print("[live-check]", *x, flush=True))
    word = {0: "DONE", 2: "COULD-NOT-RUN", 4: "CAPPED"}[code]
    print(f"LIVE-CHECK {word} {out}/report.json" + (f" ({report['meta'].get('error')})" if report["meta"].get("error") else ""))
    for arm in report["arms"]:
        d = arm["drivers"]
        print(f"  {arm['arm']:>3}: turns {arm['turnsPlayed']} errors {arm['turnErrors']} narrator-tool {d['narratorToolTurns']} belt {d['beltDrivenTurns']} act-first {d['actFirstTurns']} none {d['none']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
