#!/usr/bin/env python3
"""ORW-109 - the FULL-WEEK tier: one whole Week 1 played like a real player on the real narrator - casting, premiere, the HOH, nominations, the veto
draw + competition + ceremony, eviction night (vote, reveal, goodbyes, exit interview) and the morning of Week 2 - every turn scored against engine truth.

  python3 live_week.py --run-dir DIR [--fe ..] [--engine ..] [--token ..] [--max-turns-per-phase 30]

Same rig and rules as live_short.py (README.md): one run at a time, images OFF, real narrator key only inside the rig. The player is mostly social: between
the closed-set beats it talks, schemes and lingers; the harness jumps the engine clock (the engine's own turn-in / time-passing calls) only to skip waiting
for the schedule, and answers decision cards in the UI with the simplest legal option. Writes report.md + report.json; exit 0 PASS / 1 FAIL / 2 could not run.
"""
from __future__ import annotations

import argparse, json, re, sys, time

from live_short import clock_hour, BUB, BUSY_JS, CAST_LINES, COMP_PLAY_RE, EARLY_ASK, LEAK_RE, SHELL_RE, Chat, Engine, score as score_turn, write

CARD = """() => { const d=document.querySelector('#orwell-decision-card'); if(!d) return null;
  return {title:(d.querySelector('.odec-title')||{}).innerText||'', opts:[...d.querySelectorAll('.odec-opt')].map(o=>o.innerText.trim()), hasText:!!d.querySelector('textarea')}; }"""

SOCIAL = [
    "I pull someone aside and ask what they really think of this week.",
    "I linger in the room and listen to who is talking to whom.",
    "I check in with an ally and ask if they have heard anything.",
    "I grab a snack and ask the nearest houseguest how they are holding up.",
    "I tell someone a small half-truth to see how they react.",
    "I ask who is nervous about the vote and why.",
]
GO = ["I'm ready. Let's go.", "Okay, I'm in. Start it.", "Let's do this, I'm ready to play."]
BED = ["It's late and I'm exhausted. I say goodnight and go to bed.", "I head to my bunk and turn in for the night.", "I go to sleep. Goodnight, everyone."]
GOODBYE = "I'll miss you all. Play your own games, and good luck."


class _Resume(Exception):
    pass


class Week(Chat):
    def answer_card(self, c):
        """Click the simplest legal option for the card on screen; returns a label for the report."""
        title = (c.get("title") or "").lower(); opts = c["opts"]
        pick = [0]
        if "nominat" in title and len(opts) > 1: pick = [0, 1]
        else:
            for i, o in enumerate(opts):
                if re.search(r"(?i)\bcompete\b", o): pick = [i]; break
                if re.search(r"(?i)do not use|don'?t use|not use|keep", o): pick = [i]; break
                if re.search(r"(?i)\bskip\b", o): pick = [i]; break  # an evicted player: skip to the finale (the run is about the season, not a spectator tour)
        btns = self.page.query_selector_all("#orwell-decision-card .odec-opt")
        for i in pick:
            if i < len(btns): btns[i].click(); self.page.wait_for_timeout(150)
        if c.get("hasText"):
            ta = self.page.query_selector("#orwell-decision-card textarea")
            if ta: ta.fill(GOODBYE)
        if self.page.query_selector("#orwell-decision-card .odec-confirm"): self.page.click("#orwell-decision-card .odec-confirm")
        return f"card[{(c.get('title') or '')[:40]}] -> {[opts[i] for i in pick if i < len(opts)]}"

    def wait_new(self, before, t0, limit=240):
        self.page.wait_for_timeout(3000); stable, prev = 0, None
        while time.time() - t0 < limit:
            self.page.wait_for_timeout(2000)
            bs = self.page.evaluate(BUB); sig = json.dumps([x["txt"] for x in bs])
            busy = self.page.evaluate(BUSY_JS)
            stable = stable + 1 if (sig == prev and not busy) else 0
            prev = sig
            if stable >= 3: break
        bs = self.page.evaluate(BUB); new = bs[before:] if len(bs) >= before else bs
        return {"secs": round(time.time() - t0), "new_bubbles": len(new), "text": "\n".join(x["txt"] for x in new), "settled": bool(new) and new[-1]["done"], "timed_out": time.time() - t0 >= limit}

    def card_turn(self):
        c = self.page.evaluate(CARD)
        if not c: return None
        t0 = time.time(); before = len(self.page.evaluate(BUB)); label = self.answer_card(c)
        r = self.wait_new(before, t0); r["label_extra"] = label; return r


def names(lst): return [x.get("name") for x in (lst or []) if isinstance(x, dict)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True); ap.add_argument("--fe", default="http://127.0.0.1:17000")
    ap.add_argument("--engine", default="http://127.0.0.1:18765"); ap.add_argument("--token", default="rehlocal")
    ap.add_argument("--max-turns-per-phase", type=int, default=30); ap.add_argument("--turn-limit-secs", type=int, default=120)
    ap.add_argument("--season", action="store_true", help="after Week 1, keep playing week after week to the finale and the jury vote")
    ap.add_argument("--resume", action="store_true", help="attach to the game already running on the rig (no casting, no Week 1 checks) and play on with --season")
    ap.add_argument("--max-turns-total", type=int, default=400); ap.add_argument("--max-turns-per-week", type=int, default=90)
    a = ap.parse_args()
    from playwright.sync_api import sync_playwright
    eng = Engine(a.engine, a.token); turns, checks, facts = [], [], {"phases": []}
    if a.resume:
        try: turns.extend(json.loads(l) for l in open(f"{a.run_dir}/turns.jsonl"))
        except OSError: pass

    def check(cid, ok, detail, severity="fail"): checks.append({"id": cid, "ok": bool(ok), "severity": severity, "detail": detail})

    def snap(label, text, r, extra=""):
        st = eng.call("getGameState"); cer = st.get("ceremony") or {}
        t = {"label": label, "msg": (text or extra)[:80], "secs": r["secs"], "phase": st.get("phase"), "week": st.get("week"), "clock": st.get("clockLabel"), "ds": st.get("daySchedule"), "text": r["text"],
             "settled": r["settled"], "timed_out": r["timed_out"], "new_bubbles": r["new_bubbles"], "pending": ((st.get("pending") or {}).get("kind") if isinstance(st.get("pending"), dict) else None),
             "nominees": names(cer.get("nominees") or st.get("nominees")), "veto_holder": ((cer.get("veto") or {}).get("holder") or {}).get("name") if isinstance((cer.get("veto") or {}).get("holder"), dict) else None,
             "hoh": (cer.get("hoh") or {}).get("name") if isinstance(cer.get("hoh"), dict) else None}
        t["harness_jump"] = eng.jumps; eng.jumps = 0; t["phase_before"] = facts.get("_last_phase"); facts["_last_phase"] = st.get("phase")
        turns.append(t)
        try: open(f"{a.run_dir}/turns.jsonl", "a").write(json.dumps(t, default=str) + "\n")
        except Exception: pass
        try: open(f"{a.run_dir}/progress.log", "a").write(f"{len(turns)}\t{t['label']}\tweek={t['week']} {t['phase']} {t['clock']}\t{t['secs']}s\t{len(t['text'])}c\n")
        except Exception: pass
        if not facts["phases"] or facts["phases"][-1][0] != (st.get("week"), st.get("phase")): facts["phases"].append(((st.get("week"), st.get("phase")), len(turns)))
        return t, st

    def play_until(pred, prefix, max_turns):
        """Social/ready turns + card answers until pred(state) holds. Returns True if reached within max_turns."""
        n = 0; stuck = 0; bed_n = 0; flat = 0; last_key = None
        while n < max_turns:
            st = eng.call("getGameState")
            if pred(st): return True
            r = week.card_turn()
            if r is not None:
                n += 1; snap(f"{prefix}-{n}-card", None, r, r.get("label_extra", "")); continue
            ds = st.get("daySchedule") or {}
            # ORW-258 cadence: ONE event per day. If the next event belongs to tomorrow (`todaysEvent` set) the evening passes and the player goes to bed at the NIGHT period; if it is
            # later today the runner lets the time pass without sleeping; the runner NEVER sleeps through an event day.
            if ds.get("todaysEvent"):
                stuck = 0
                if (clock_hour(st.get("clockLabel")) or 0) < 20.0 and (clock_hour(st.get("clockLabel")) or 0) >= 8.0: eng.tick_to_night(f"{prefix}-{n}")
            elif ds.get("due") is False:
                stuck += 1
                if stuck >= 2:
                    eng.to_just_before_due(f"{prefix}-{n}"); stuck = 0
            same = (st.get("week"), st.get("phase")) == last_key; last_key = (st.get("week"), st.get("phase"))
            late = clock_hour(st.get("clockLabel")) is not None and clock_hour(st.get("clockLabel")) >= 21
            night_now = (clock_hour(st.get("clockLabel")) or 0) >= 20.0 or (clock_hour(st.get("clockLabel")) or 12) < 8.0
            if ds.get("todaysEvent") and night_now:
                text = BED[bed_n % len(BED)]; bed_n += 1  # the night is the player's: a due ceremony waits for them to turn in (ORW-116); a real player goes to bed
                if bed_n >= 3: eng.call("turnIn"); eng.jumps += 1; facts.setdefault("bed_not_honoured", []).append({"clock": st.get("clockLabel"), "turn": len(turns)}); bed_n = 0  # the model never turned them in after 3 asks: report it and move on
            else:
                text = GO[n % len(GO)] if ds.get("due") else SOCIAL[n % len(SOCIAL)]
            t0 = time.time(); before = len(week.page.evaluate(BUB))
            week.page.fill("#message", text); week.page.wait_for_timeout(300)
            if week.page.evaluate("document.querySelector('.send-btn')?.getAttribute('data-mode')") == "send": week.page.click(".send-btn")
            else: week.page.keyboard.press("Enter")
            r = week.wait_new(before, t0); n += 1; snap(f"{prefix}-{n}", text, r)
        return pred(eng.call("getGameState"))

    def season_loop():
        def over(s): return bool(s.get("finished")) or bool(s.get("winner"))
        wk = 1; per_week = 0; last_week = eng.call("getGameState").get("week", 2); facts["weeks"] = []
        while not over(eng.call("getGameState")) and len(turns) < a.max_turns_total:
            cur = eng.call("getGameState").get("week", last_week)
            ok = play_until(lambda s: over(s) or s.get("week", cur) > cur, f"w{cur}", a.max_turns_per_week)
            facts["weeks"].append({"week": cur, "advanced": ok, "turns_total": len(turns)})
            check(f"S-week-{cur}-advanced", ok, f"week {cur} ended within {a.max_turns_per_week} turns (total turns {len(turns)})")
            if not ok: break
        fin = eng.call("getGameState"); facts["final"] = {"finished": fin.get("finished"), "winner": fin.get("winner"), "phase": fin.get("phase"), "week": fin.get("week")}
        check("S-finale-reached", over(fin), f"finished={fin.get('finished')} winner={fin.get('winner')} phase={fin.get('phase')} after {len(turns)} turns")
        rec2 = eng.call("seasonRecap") or {}; check("S-evictions-recorded", len(names(rec2.get("evicted"))) >= 1, f"evicted in order: {names(rec2.get('evicted'))}")


    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=["--disable-dev-shm-usage", "--disable-gpu", "--headless=old"])
            page = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
            page.goto(a.fe + "/", wait_until="load", timeout=60000); page.wait_for_timeout(6000)
            week = Week(page, a.fe)
            if a.resume:
                season_loop(); check("W6-no-stuck-card", page.evaluate(CARD) is None and not (eng.call("getGameState").get("pending")), "no decision card left on screen / pending"); b.close(); raise _Resume()
            for i, line in enumerate(CAST_LINES):
                t0 = time.time(); before = len(page.evaluate(BUB)); page.fill("#message", line); page.wait_for_timeout(300)
                if page.evaluate("document.querySelector('.send-btn')?.getAttribute('data-mode')") == "send": page.click(".send-btn")
                else: page.keyboard.press("Enter")
                snap(f"cast-{i + 1}", line, week.wait_new(before, t0))
            st = eng.call("getGameState"); check("G1-game-started", st.get("phase") not in (None, "setup"), f"phase after casting: {st.get('phase')}")
            eng.entrances(); eng.sleep_through_night("n1")
            t0 = time.time(); before = len(page.evaluate(BUB)); page.fill("#message", EARLY_ASK); page.keyboard.press("Enter")
            t, st = snap("early-ask-hoh", EARLY_ASK, week.wait_new(before, t0))
            check("P1-production-hold", not st.get("hoh") and st.get("phase") in ("premiere", "hoh-competition"), f"asked for the HOH comp at {t['clock']}; engine phase {st.get('phase')}")
            eng.to_just_before_due("m1")
            cap = a.max_turns_per_phase
            ok = play_until(lambda s: s.get("phase") == "nominations" or (s.get("phase") == "veto-competition"), "hoh", cap)
            check("W1-hoh-played", ok, f"reached nominations within {cap} turns (phase {eng.call('getGameState').get('phase')})")
            ok = play_until(lambda s: s.get("phase") == "veto-competition", "noms", cap)
            check("W2-nominations-done", ok, f"reached the veto phase within {cap} turns")
            st = eng.call("getGameState"); facts["nominees"] = names((st.get("ceremony") or {}).get("nominees"))
            check("W2b-two-nominees", len(facts["nominees"]) == 2, f"engine nominees: {len(facts['nominees'])}")
            ok = play_until(lambda s: s.get("phase") == "veto-ceremony", "veto", cap)
            check("W3-veto-competition-played", ok, f"reached the veto ceremony within {cap} turns")
            st = eng.call("getGameState"); holder = (((st.get("ceremony") or {}).get("veto") or {}).get("holder") or {}).get("name"); facts["veto_holder"] = holder
            check("W3b-veto-holder-named", bool(holder), f"engine veto holder: {holder}")
            if holder:
                comp_text = "\n".join(t["text"] for t in turns if t["label"].startswith("veto-") and not t["label"].startswith("veto-ceremony"))
                check("W3c-winner-voiced", holder.split()[0] in comp_text, f"the engine's veto winner ({holder}) is named in the competition replies")
                others = set(re.findall(r"([A-Z][a-z]+(?: [A-Z][a-z]+)?) wins the (?:Power of Veto|veto)", comp_text, re.I))
                bad = [o for o in others if holder.split()[0].lower() not in o.lower()]
                check("W3d-no-wrong-winner", not bad, f"replies crown someone other than the engine's winner: {bad}" if bad else "no conflicting winner")
            ok = play_until(lambda s: s.get("phase") == "eviction", "cer", cap)
            check("W4-veto-ceremony-done", ok, f"reached eviction within {cap} turns")
            ok = play_until(lambda s: s.get("week", 1) >= 2 and s.get("phase") in ("hoh-competition", "premiere"), "evict", cap + 10)
            check("W5-eviction-night-done", ok, f"reached Week 2 within {cap + 10} turns")
            rec = eng.call("seasonRecap") or {}; ev = names(rec.get("evicted")); facts["evicted"] = ev
            check("W5b-one-evicted", len(ev) == 1, f"engine evicted: {ev}")
            if ev:
                ev_text = "\n".join(t["text"] for t in turns if t["label"].startswith("evict-"))
                check("W5c-evictee-voiced", ev[0].split()[0] in ev_text, f"the engine's evictee ({ev[0]}) is named in the eviction-night replies")
            if a.season: season_loop()
            check("W6-no-stuck-card", page.evaluate(CARD) is None and not (eng.call("getGameState").get("pending")), "no decision card left on screen / pending")
            b.close()
    except _Resume:
        pass
    except Exception as e:  # noqa: BLE001
        print("could not run:", repr(e)[:300]); write(a.run_dir, turns, checks, str(e)); sys.exit(2)

    score_turn(turns, checks, check, a.turn_limit_secs)
    # the closed-set comp check applies to the veto-competition HOLD only (live_short); here the competition is played, so drop it
    checks[:] = [c for c in checks if not c["id"].startswith("C1-") and c["id"] != "C2-draw-voiced"]
    write(a.run_dir, turns, checks, None)
    json.dump(facts, open(f"{a.run_dir}/week-facts.json", "w"), default=str, indent=1)
    hard = [c for c in checks if not c["ok"] and c["severity"] == "fail"]
    print("RESULT:", "FAIL" if hard else "PASS", f"({len(hard)} failing, {sum(1 for c in checks if not c['ok'] and c['severity'] == 'warn')} warnings, {len(turns)} turns)")
    sys.exit(1 if hard else 0)


if __name__ == "__main__":
    main()
