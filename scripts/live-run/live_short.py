#!/usr/bin/env python3
"""ORW-109 - the SHORT TIER of formal live-run testing: a real narrator, a staged build, a written pass bar, one report.

Plays a real game through the real chat UI (headless Chromium) and, between player messages, jumps the engine clock with the engine's own player API (the same
calls the player's turn-in / time-passing make) so a few messages reach the veto morning of Week 1. Every turn is compared with ENGINE TRUTH and scored against
the pass bar in README.md. Writes report.md + report.json into the run dir and exits 0 (PASS) / 1 (FAIL) / 2 (could not run).

  python3 live_short.py --run-dir DIR [--fe http://127.0.0.1:17000] [--engine http://127.0.0.1:18765] [--token rehlocal]

The rig (engine + FE, fresh data, real narrator key, images OFF) is staged by the kit's stage script; this file never reads or prints a key. Roles only, no
cast names are hard-coded: whatever the cast is, the checks read it from the engine.
"""
from __future__ import annotations

import argparse, json, re, sys, time, urllib.request

CAST_LINES = [
    "Hi! My name is Rowan. I read rooms before I speak, and I want to win by being liked and quietly useful.",
    "People bring me their problems. I'm a school librarian from Ohio, 29, I keep everyone's secrets. I want to prove the quiet read beats the loud move.",
    "I listen first and decide late. My tell is I go still when I lie.",
    "In ten minutes people read me as soft and harmless; the wrong part is that I keep careful track of who owes whom. I'd burn a confidence only to save myself in the final week.",
    "That's everything. I'm ready, please put my name on the wall and start the season.",
    "I step through the doors and look around.",
]
CAST: list = []
EARLY_ASK = "Can we start the Head of Household competition right now? Run it."
VETO_MORNING = [
    "I wake up and head to the kitchen for coffee, waiting for the veto draw.",
    "I listen to the draw and see who got picked.",
    "I hang around the living room chatting with whoever is near.",
    "I keep chatting and wait for the veto competition to be called.",
]

PREMIERE_MINGLE = [
    "I take a seat and watch the new arrivals come in.", "I wave at the newest arrival and introduce myself.", "I ask the person next to me what they think of the house so far.",
    "I wait by the door for whoever walks in next.", "I say hello to the person who just came in.", "I grab a drink and watch the doors.",
    "I chat with the nearest person about who is still to come.", "I shake hands with the next arrival.", "I lean on the wall and watch the entrance.",
    "I compliment the latest arrival on their outfit.",
]
# a nominations ceremony voiced before the engine committed one (ritual cues only - 'nominations' in general talk is fine)
PHANTOM_CER_RE = re.compile(r"(?i)\bnomination ceremony\b|turns? (?:a|the|his|her|their) key\b|\bkeys? (?:are|is) on the table\b|\bhas (?:nominated|put up)\b|\bnominated (?:you|me)\b|\bon the block\b")
# one dialogue line: the chip initials, then the full name, then a dash ("TBTerrance Boyd — ...")
SPEAKER_RE = re.compile(r"(?m)^[A-Z]{1,3}([A-Z][a-z'-]+(?: [A-Z][a-z'-]+)+)\s*[\u2014-]")
PAIR_AFTER_RE = re.compile(r"(?i)nominees?\W+(?:are|were|is)\W+([A-Z][a-z'-]+(?: [A-Z][a-z'-]+)?) and ([A-Z][a-z'-]+(?: [A-Z][a-z'-]+)?)")
PAIR_BEFORE_RE = re.compile(r"([A-Z][a-z'-]+(?: [A-Z][a-z'-]+)?) and ([A-Z][a-z'-]+(?: [A-Z][a-z'-]+)?),? (?:are|were)(?: both)? (?:the )?(?:nominees|nominated|on the block|up for eviction)")

# machinery that must never reach a player-facing reply
LEAK_RE = re.compile(r"npc:\d+|<think|</think|advanceGame|submitDecision|beatSeq|\btool call\b|\[System prompt|(?-i:\bthe Vault\b|\bVault Wall\b)", re.I)
# a guard's replacement shell is not a scene
SHELL_RE = re.compile(r"feed glitched|lost what just came through|say that again\?|Responding\W*$", re.I)
# competition play that must not be narrated before the engine has run the competition
COMP_PLAY_RE = re.compile(r"\b(plank|apparatus|steel rails|platforms?|rounds? (?:one|two|three|1|2|3)|is out of the (?:competition|comp)|wins the (?:Power of Veto|veto|HOH|Head of Household)|crawl(?:s|ing) (?:along|across))\b", re.I)

BUB = """() => [...document.querySelectorAll('#chat-history .msg-ai')].map(el => { const c = el.cloneNode(true);
  c.querySelectorAll('.thinking-content,.thinking,[class*=thinking],.msg-footer').forEach(n=>n.remove());
  return {txt:(c.innerText||'').trim(), done:!!el.querySelector('.msg-footer')}; })"""


class Engine:
    def __init__(self, base, token):
        self.jumps = 0  # runner-made clock moves (night sleeps, tick-to-due, entrance advances) since the last turn was recorded
        self.base, self.h = base, {"content-type": "application/json", "authorization": f"Bearer {token}"}

    def call(self, name, args=None):
        r = urllib.request.Request(self.base + "/player/call", data=json.dumps({"name": name, "args": args or {}}).encode(), headers=self.h, method="POST")
        return json.load(urllib.request.urlopen(r, timeout=90)).get("result")

    def hour(self):
        st = self.call("getGameState"); m = re.match(r"^(\d{1,2}):(\d{2})(am|pm), Day (\d+)$", st.get("clockLabel") or "")
        if not m: return None, st
        h = int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0) + int(m.group(2)) / 60
        return (h + 24 if h < 8 else h), st

    def sleep_through_night(self, tag):
        self.jumps += 1
        n = 0
        while True:
            h, _ = self.hour()
            if h is None or h >= 24 or n > 700: break
            self.call("noteMessage", {"messageId": f"{tag}-{n}"}); n += 1
        self.call("turnIn"); self.call("noteMessage", {"messageId": f"{tag}-wake"})

    def tick_to_night(self, tag):
        """Let the evening pass with the engine's own message ticks until the NIGHT period (a player may not go to bed earlier)."""
        self.jumps += 1
        for n in range(400):
            st = self.call("gameStatus") or {}
            if st.get("timeOfDay") in ("night", "late-night"): return
            self.call("noteMessage", {"messageId": f"{tag}-t{n}"})

    def to_just_before_due(self, tag):
        self.jumps += 1
        n = 0
        while n < 500:
            _, st = self.hour(); ds = st.get("daySchedule") or {}
            if ds.get("due") or (isinstance(ds.get("minutesUntil"), int) and ds["minutesUntil"] <= 5): return
            self.call("noteMessage", {"messageId": f"{tag}-{n}"}); n += 1

    def entrances(self):
        self.jumps += 1
        for _ in range(80):
            ent = (self.call("premiereIntros") or {}).get("entrance") or {}
            if not ent or ent.get("stage") == "done": return
            a = self.call("advanceGame")
            if a.get("pending"): return

    def play_pendings_until(self, phase, tag, max_steps=40):
        """Drive the closed-set loop with the simplest legal answers until `phase` is reached (never past it)."""
        for i in range(max_steps):
            st = self.call("getGameState")
            if st.get("phase") == phase: return True
            a = self.call("advanceGame"); p = a.get("pending")
            if p:
                k, o = p.get("kind"), [x.get("id") for x in (p.get("options") or [])]
                d = {"kind": k}
                if k in ("comp-round", "comp-intent"): d["intent"] = "compete"
                elif k == "nominations": d["choice"] = o[:2]
                elif k in ("veto-decision", "secret-veto"): d["use"] = False
                elif k == "replacement": d["replacement"] = o[0]
                else: d["vote"] = o[0] if o else "a"
                self.call("submitDecision", d); continue
            if a.get("held") or not a.get("event"): self.sleep_through_night(f"{tag}-{i}")
        return False


class Chat:
    def __init__(self, page, base):
        self.page, self.base = page, base

    def send(self, text, limit=240):
        t0 = time.time(); before = len(self.page.evaluate(BUB))
        self.page.fill("#message", text); self.page.wait_for_timeout(300)
        if self.page.evaluate("document.querySelector('.send-btn')?.getAttribute('data-mode')") == "send": self.page.click(".send-btn")
        else: self.page.keyboard.press("Enter")
        self.page.wait_for_timeout(3000); stable, prev = 0, None
        while time.time() - t0 < limit:
            self.page.wait_for_timeout(2000)
            bs = self.page.evaluate(BUB); sig = json.dumps([x["txt"] for x in bs])
            busy = self.page.evaluate("!!document.querySelector('.send-btn[data-mode=\"stop\"], .send-btn[data-mode=\"cancel\"]')")
            stable = stable + 1 if (sig == prev and not busy) else 0
            prev = sig
            if stable >= 3: break
        bs = self.page.evaluate(BUB); new = bs[before:] if len(bs) >= before else bs
        return {"secs": round(time.time() - t0), "new_bubbles": len(new), "text": "\n".join(x["txt"] for x in new), "settled": bool(new) and new[-1]["done"], "timed_out": time.time() - t0 >= limit}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True); ap.add_argument("--fe", default="http://127.0.0.1:17000")
    ap.add_argument("--engine", default="http://127.0.0.1:18765"); ap.add_argument("--token", default="rehlocal")
    ap.add_argument("--turn-limit-secs", type=int, default=120, help="a reply slower than this is a STALL warning; 240 is a FAIL")
    ap.add_argument("--rescore", action="store_true", help="re-score the saved report.json turns with the current pass bar (no game is played)")
    a = ap.parse_args()
    if a.rescore:
        turns = json.load(open(f"{a.run_dir}/report.json"))["turns"]; checks = []
        score(turns, checks, lambda cid, ok, detail, severity="fail": checks.append({"id": cid, "ok": bool(ok), "severity": severity, "detail": detail}), a.turn_limit_secs)
        write(a.run_dir, turns, checks, None); hard = [c for c in checks if not c["ok"] and c["severity"] == "fail"]
        print("RESULT:", "FAIL" if hard else "PASS"); sys.exit(1 if hard else 0)
    from playwright.sync_api import sync_playwright
    eng = Engine(a.engine, a.token); turns = []; checks = []

    def check(cid, ok, detail, severity="fail"):
        checks.append({"id": cid, "ok": bool(ok), "severity": severity, "detail": detail})

    def play(label, text, expect_phase=None):
        st0 = eng.call("getGameState")
        r = chat.send(text)
        st = eng.call("getGameState")
        def room_of(s_):
            # who the player can SEE or HEAR: the room itself plus the rooms in their sightline (a voice from the open kitchen is not a phantom), and anyone already through the premiere door
            w = (s_.get("whereabouts") or {})
            names_ = {x.get("name") for x in (w.get("present") or []) if isinstance(x, dict)}
            for r_ in (w.get("nearby") or []):
                names_ |= {x.get("name") for x in (r_.get("present") or []) if isinstance(x, dict)}
            return sorted(n for n in names_ if n)
        ent = (eng.call("premiereIntros") or {}).get("entrance") or {} if st.get("phase") == "premiere" else {}
        t = {"label": label, "msg": text[:80], "secs": r["secs"], "phase": st.get("phase"), "clock": st.get("clockLabel"), "ds": st.get("daySchedule"), "text": r["text"], "settled": r["settled"],
             "room_start": room_of(st0), "room_end": sorted(set(room_of(st)) | set(ent.get("arrivedNames") or [])), "inside": ent.get("insideCount"), "arrived": ent.get("arrivedNames"), "entrance_stage": ent.get("stage"), "hoh_name": ((st.get("ceremony") or {}).get("hoh") or {}).get("name") if isinstance((st.get("ceremony") or {}).get("hoh"), dict) else None,
             "timed_out": r["timed_out"], "new_bubbles": r["new_bubbles"], "phase_before": st0.get("phase"), "nominees": [n.get("name") for n in (st.get("nominees") or (st.get("ceremony") or {}).get("nominees") or [])],
             "veto_holder": ((st.get("veto") or (st.get("ceremony") or {}).get("veto")) or {}).get("holder")}
        t["harness_jump"] = eng.jumps; eng.jumps = 0
        turns.append(t); return t

    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=["--disable-dev-shm-usage", "--disable-gpu", "--headless=old"])
            page = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
            page.goto(a.fe + "/", wait_until="load", timeout=60000); page.wait_for_timeout(6000)
            chat = Chat(page, a.fe)
            for i, line in enumerate(CAST_LINES): play(f"cast-{i + 1}", line)
            st = eng.call("getGameState")
            check("G1-game-started", st.get("phase") not in (None, "setup"), f"phase after casting: {st.get('phase')}")
            # (a) the premiere through the REAL chat path: every few messages another houseguest must walk in (ORW prod: arrivals froze at 9 of 16)
            for i, line in enumerate(PREMIERE_MINGLE): play(f"premiere-{i + 1}", line)
            eng.entrances()
            st = eng.call("getGameState"); facts_clock = st.get("clockLabel") or ""
            check("D1-day-one-not-skipped", "Day 1" in facts_clock, f"after the premiere the clock reads {facts_clock!r} (must still be Day 1: the night is the player's)")
            ent = (eng.call("premiereIntros") or {}).get("entrance") or {}
            check("A1-all-arrived", ent.get("insideCount") == ent.get("total") and (ent.get("total") or 0) >= 2, f"entrance {ent.get('insideCount')} of {ent.get('total')} inside at the end of the premiere")
            global CAST
            CAST = list(ent.get("arrivedNames") or [])
            eng.sleep_through_night("n1")
            # the early ask: production has not called the competition yet, so the engine must not have run it
            t = play("early-ask-hoh", EARLY_ASK)
            check("P1-production-hold", t["phase"] in ("premiere", "hoh-competition") and not eng.call("getGameState").get("hoh"), f"asked for the HOH comp at {t['clock']}; engine phase {t['phase']}, hoh set: {bool(eng.call('getGameState').get('hoh'))}")
            eng.to_just_before_due("m1")
            eng.play_pendings_until("veto-competition", "w1")
            eng.sleep_through_night("n3")  # the veto competition needs a night after nominations
            st = eng.call("getGameState")
            check("G2-reached-veto-morning", st.get("phase") == "veto-competition", f"phase {st.get('phase')} at {st.get('clockLabel')}")
            for i, line in enumerate(VETO_MORNING): play(f"veto-morning-{i + 1}", line)
            b.close()
    except Exception as e:  # noqa: BLE001
        print("could not run:", repr(e)[:300]); write(a.run_dir, turns, checks, str(e)); sys.exit(2)

    score(turns, checks, check, a.turn_limit_secs)
    write(a.run_dir, turns, checks, None)
    hard = [c for c in checks if not c["ok"] and c["severity"] == "fail"]
    print("RESULT:", "FAIL" if hard else "PASS", f"({len(hard)} failing, {sum(1 for c in checks if not c['ok'] and c['severity'] == 'warn')} warnings)")
    sys.exit(1 if hard else 0)


BED_MSG_RE = re.compile(r"(?i)\b(go(?:ing)? to (?:bed|sleep)|turn(?:ing)? in|head to my bunk|goodnight|good night)\b")


def abs_hours(label):
    m = re.match(r"^(\d{1,2}):(\d{2})(am|pm), Day (\d+)$", label or "")
    return None if not m else (int(m.group(4)) - 1) * 24 + int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0) + int(m.group(2)) / 60


def clock_hour(label):
    m = re.match(r"^(\d{1,2}):(\d{2})(am|pm)", label or "")
    return (int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0) + int(m.group(2)) / 60) if m else None


def score(turns, checks, check, turn_limit):
    for t in turns:
        lab = t["label"]
        check(f"T1-answered[{lab}]", t["new_bubbles"] > 0 and t["settled"] and not t["timed_out"], f"bubbles={t['new_bubbles']} settled={t['settled']} timed_out={t['timed_out']}")
        short_ok = lab.startswith("early-ask")  # a one-line deflection of an out-of-schedule request is legitimate; still reported
        shell = SHELL_RE.search(t["text"])
        check(f"T2-real-scene[{lab}]", not shell and (len(t["text"]) >= 200 or short_ok), f"{len(t['text'])} chars" + (" (guard shell text)" if shell else ""))
        if short_ok and len(t["text"]) < 200: check(f"T2b-thin-reply[{lab}]", False, f"only {len(t['text'])} chars for a player request - a thin answer, not a scene", "warn")
        m = LEAK_RE.search(t["text"]); check(f"T3-no-machinery[{lab}]", not m, f"leak: {m.group(0)!r}" if m else "clean")
        check(f"T4-latency[{lab}]", t["secs"] <= turn_limit, f"{t['secs']}s (warn > {turn_limit}s)", "warn")
        check(f"T5-latency-hard[{lab}]", t["secs"] <= 240, f"{t['secs']}s (fail > 240s)")
        eh = clock_hour(t.get("clock")); cm = re.search(r"\b(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm))", t["text"]) if eh is not None else None
        if cm:
            nh = int(cm.group(1)) + int(cm.group(2)) / 60
            nh = nh + 12 if nh < 8 and eh >= 12 else nh
            check(f"C3-clock-claim[{lab}]", abs(nh - eh) <= 1.0, f"reply says {cm.group(0)}, engine clock {t['clock']}", "warn")
    # NO SKIPPED TIME (Ryne: "It shouldn't ever skip time"): between two consecutive player turns the clock may not move more than ~1 hour unless the
    # player went to bed (a bed message) or the night reached 8am. Jumps the RUNNER made itself (night sleeps, tick-to-due, entrance advances) are tagged
    # `harness_jump` and listed separately, never blamed on the game. A competition played inside one message moves the clock by its own length: reported as a note.
    prev = None
    for t in turns:
        a_ = abs_hours(t.get("clock"))
        if prev is not None and a_ is not None and a_ - prev > 1.0:
            gap = a_ - prev; bed = bool(BED_MSG_RE.search(t.get("msg") or "")); wake8 = abs((a_ % 24) - 8.0) < 0.2 and ((prev % 24) >= 23.0 or (prev % 24) < 8.0)  # the night ran its course to 8am (the previous turn was already deep in the night), not a day cut short
            if t.get("harness_jump"): check(f"K1-clock-jump-by-runner[{t['label']}]", True, f"+{gap:.1f}h, made by the runner's own engine call ({t['harness_jump']} move(s)) - not the game", "note")
            elif bed or wake8: check(f"K1-clock-jump-bed[{t['label']}]", True, f"+{gap:.1f}h after a bed message or to 8am", "note")
            elif t.get("phase_before") in ("hoh-competition", "veto-competition") and t.get("phase") != t.get("phase_before"):
                # Ryne 2026-11-10: "Comps should take several hours. They should never be one message and should always be a full play by play." A competition that is crowned in a message
                # which also moves the clock by hours spent its hours inside ONE reply.
                if gap <= 1.5: check(f"K1-clock-jump-competition[{t['label']}]", True, f"+{gap:.1f}h: the crown's share on top of the spread rounds (a competition that spans several messages)", "note")
                else: check(f"K2-competition-in-one-message[{t['label']}]", False, f"{t.get('phase_before')} was crowned in a single message and the clock jumped +{gap:.1f}h ({t.get('msg')!r})")
            elif t.get("phase_before") != t.get("phase") and gap <= 4.5: check(f"K1-clock-jump-competition[{t['label']}]", True, f"+{gap:.1f}h as the phase moved {t.get('phase_before')} -> {t.get('phase')} (a beat played inside one message)", "note")
            else: check(f"K1-no-skipped-time[{t['label']}]", False, f"clock {prev:.1f}h -> {a_:.1f}h (+{gap:.1f}h) on {t.get('msg')!r}: no bed message, not 8am, no runner move")
        if a_ is not None: prev = a_
    # K3 (ORW-258, Ryne: the evening ceremony NEEDS to happen in the evening): an event the schedule reports as due must fire within about 2 messages of being due.
    run_, last_ = 0, None
    for t in turns:
        ds_ = t.get("ds") or {}
        key_ = (ds_.get("next"), t.get("week"), t.get("phase"))
        if ds_.get("due") and ds_.get("next") in ("nominations", "veto-ceremony", "eviction") and not t.get("pending"):
            run_ = run_ + 1 if key_ == last_ else 1
            # eviction night is a staged event (vote, reveal, result, goodbyes): its `due` stays true through those steps, so it gets a longer allowance than the single-beat ceremonies
            if run_ == (9 if ds_.get("next") == "eviction" else 4): check(f"K3-due-evening-ceremony-unfired[{t['label']}]", False, f"{ds_.get('next')} has been due for {run_} messages without firing (clock {t.get('clock')})")
            last_ = key_
        else:
            run_, last_ = 0, None
    # (a) arrivals keep coming during the real premiere chat: never 6 messages in a row with the same count while more are still to come
    prem = [t for t in turns if t["label"].startswith("premiere-") and t.get("inside") is not None]
    if prem:
        run, worst, last = 0, 0, None
        for t in prem:
            run = run + 1 if t["inside"] == last else 0; worst = max(worst, run); last = t["inside"]
        check("A2-arrivals-progress", worst < 6 and prem[-1]["inside"] > prem[0]["inside"], f"inside went {prem[0]['inside']} -> {prem[-1]['inside']} over {len(prem)} premiere messages; longest flat stretch {worst} messages")
    # (c) no ceremony voiced before the engine committed it: before nominations the engine has no nominees and no HOH, so ritual cues are phantom
    for t in turns:
        if t["phase"] in ("premiere", "setup", "hoh-competition") and not t.get("nominees"):
            m = PHANTOM_CER_RE.search(t["text"])
            check(f"C4-no-phantom-ceremony[{t['label']}]", not m, f"ritual voiced with no nominees committed: {m.group(0)!r}" if m else "no ceremony voiced")
    # (d) a stated nominee pair must be the engine's pair
    for t in turns:
        if not t.get("nominees") or len(t["nominees"]) != 2: continue
        truth = {n.lower() for n in t["nominees"]}
        for rx in (PAIR_AFTER_RE, PAIR_BEFORE_RE):
            for m in rx.finditer(t["text"]):
                said = {m.group(1).lower(), m.group(2).lower()}
                same = all(any(x == n or x == n.split()[0] or n.startswith(x) for n in truth) for x in said)
                check(f"C5-nominee-names[{t['label']}]", same, f"narration names {sorted(said)}; engine nominees {sorted(truth)}")
    # (e) nobody speaks in the player's room unless the engine has them there (at the start or end of the turn - people can walk in or out within a reply)
    for t in turns:
        if t["phase"] in ("setup",) or t.get("room_end") is None: continue
        ok_names = {n.lower() for n in (t.get("room_start") or []) + (t.get("room_end") or [])}
        if not ok_names and not t.get("room_end"): continue
        bad = sorted({n for n in SPEAKER_RE.findall(t["text"]) if n.lower() not in ok_names and not any(n.lower() == x or n.split()[0].lower() == x.split()[0] for x in ok_names)})
        check(f"C6-speakers-in-room[{t['label']}]", not bad, f"spoke in the player's room but the engine has them elsewhere: {bad}" if bad else "every speaker is in the room")
    held = [t for t in turns if t["label"].startswith("veto-morning") and t["phase"] == "veto-competition" and (t["ds"] or {}).get("due") is False]
    for t in held:
        m = COMP_PLAY_RE.search(t["text"])
        check(f"C1-no-pre-narrated-comp[{t['label']}]", not m, f"competition play narrated while the engine had not run it: {m.group(0)!r}" if m else "house talk only")
    draw = [t for t in turns if t["label"].startswith("veto-morning")]
    check("C2-draw-voiced", any(re.search(r"(?i)veto", t["text"]) and re.search(r"(?i)draw|chip|pull|playing for", t["text"]) for t in draw), "a veto-morning reply voices the draw")


def write(run_dir, turns, checks, error):
    hard = [c for c in checks if not c["ok"] and c["severity"] == "fail"]; warn = [c for c in checks if not c["ok"] and c["severity"] == "warn"]
    verdict = "COULD NOT RUN" if error else ("FAIL" if hard else "PASS")
    json.dump({"verdict": verdict, "error": error, "checks": checks, "turns": turns}, open(f"{run_dir}/report.json", "w"), indent=1)
    L = [f"# Live run (short tier) - {verdict}", "", f"Turns played: {len(turns)}. Failing checks: {len(hard)}. Warnings: {len(warn)}." + (f" Could not run: {error}" if error else ""), ""]
    if hard or warn:
        L += ["## Not passing", ""] + [f"- **{c['severity'].upper()}** `{c['id']}` - {c['detail']}" for c in hard + warn] + [""]
    L += ["## Every check", ""] + [f"- {'ok ' if c['ok'] else 'NO '} `{c['id']}` - {c['detail']}" for c in checks] + ["", "## Turns", ""]
    for t in turns:
        L += [f"### {t['label']} - {t['secs']}s - {t['clock']} - phase {t['phase']}", f"Player: {t['msg']}", "", "> " + t["text"][:700].replace("\n", "\n> "), ""]
    open(f"{run_dir}/report.md", "w").write("\n".join(L))


if __name__ == "__main__":
    main()
