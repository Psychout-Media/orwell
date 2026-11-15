#!/usr/bin/env python3
"""ORW-109 - the SHORT TIER of formal live-run testing: a real narrator, a staged build, a written pass bar, one report.

Plays a real game through the real chat UI (headless Chromium) and, between player messages, jumps the engine clock with the engine's own player API (the same
calls the player's turn-in / time-passing make) so a few messages reach the veto morning of Week 1. Every turn is compared with ENGINE TRUTH and scored against
the pass bar in README.md. Writes report.md + report.json into the run dir and exits 0 (PASS) / 1 (FAIL) / 2 (could not run).

  python3 live_short.py --run-dir DIR [--fe URL] [--engine URL]   (default: the rig slot's own, RIG_BASE / RIG_ENGINE_URL; slot 1 when unset) [--token rehlocal]

The rig (engine + FE, fresh data, real narrator key, images OFF) is staged by the kit's stage script; this file never reads or prints a key. Roles only, no
cast names are hard-coded: whatever the cast is, the checks read it from the engine.
"""
from __future__ import annotations

import os
import argparse, json, re, sys, time, urllib.error, urllib.request

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
LEAK_RE = re.compile(r"npc:\d+|<think|</think|</?tool_use|</?tool_call|</?function_calls|advanceGame|submitDecision|beatSeq|\btool call\b|\[System prompt|(?-i:\bthe Vault\b|\bVault Wall\b)", re.I)
# a guard's replacement shell is not a scene
SHELL_RE = re.compile(r"feed glitched|lost what just came through|say that again\?|Responding\W*$", re.I)
# competition play that must not be narrated before the engine has run the competition
COMP_PLAY_RE = re.compile(r"\b(plank|apparatus|steel rails|platforms?|rounds? (?:one|two|three|1|2|3)|is out of the (?:competition|comp)|wins the (?:Power of Veto|veto|HOH|Head of Household)|crawl(?:s|ing) (?:along|across))\b", re.I)

# ORW-259: the app marks a running turn `data-mode="streaming"` (chatSubmitButton.js); "stop"/"cancel" never exist.
BUSY_JS = "!!document.querySelector('.send-btn[data-mode=\"streaming\"]')"
BUB = """() => [...document.querySelectorAll('#chat-history .msg-ai')].map(el => { const c = el.cloneNode(true);
  c.querySelectorAll('.thinking-content,.thinking,[class*=thinking],.msg-footer').forEach(n=>n.remove());
  return {txt:(c.innerText||'').trim(), done:!!el.querySelector('.msg-footer')}; })"""


class Engine:
    def __init__(self, base, token):
        self.jumps = 0  # runner-made clock moves (night sleeps, tick-to-due, entrance advances) since the last turn was recorded
        self.base, self.h = base, {"content-type": "application/json", "authorization": f"Bearer {token}"}

    def call(self, name, args=None):
        r = urllib.request.Request(self.base + "/player/call", data=json.dumps({"name": name, "args": args or {}}).encode(), headers=self.h, method="POST")
        try:
            return json.load(urllib.request.urlopen(r, timeout=90)).get("result")
        except urllib.error.HTTPError as e:  # name the engine call and its answer, so a COULD-NOT-RUN report says what refused
            body = e.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"engine {name} {args or {}} -> HTTP {e.code}: {body}") from None

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
        # ORW-446: a goodnight is HELD while a staged ceremony is open (reason "ceremony"): finish the ceremony (advance its watch steps, answer its card) and go to bed again.
        for k in range(30):
            r = self.call("turnIn") or {}
            h = r.get("held")
            if not (isinstance(h, dict) and h.get("reason") == "ceremony"): break
            a = self.call("advanceGame") or {}
            p = a.get("pending")
            if p and p.get("kind") != "ceremony-step":
                o = [x.get("id") for x in (p.get("options") or [])]
                try: self.call("submitDecision", {"kind": p.get("kind"), "choice": o[:2] if p.get("kind") == "nominations" else (o[0] if o else None), "use": False, "intent": "compete", "vote": o[0] if o else "a"})
                except RuntimeError: pass
        self.call("noteMessage", {"messageId": f"{tag}-wake"})

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
                if k == "ceremony-step": self.call("advanceGame"); continue  # a staged ceremony's watch step is advanced, never answered
                d = {"kind": k}
                if k in ("comp-round", "comp-intent"): d["intent"] = "compete"
                elif k == "nominations": d["choice"] = o[:2]
                elif k in ("veto-decision", "secret-veto"): d["use"] = False
                elif k == "replacement": d["replacement"] = o[0]
                else: d["vote"] = o[0] if o else "a"
                self.call("submitDecision", d); continue
            h = a.get("held")
            # A DAYTIME "not due yet" hold names the event and the minutes until it: let that time pass (sleeping instead skipped the event's day, night after
            # night - a live run sat in the premiere until Day 43). Anything else (a night hold, nothing happening) is a bed, as before.
            if is_schedule_hold(h):
                self.to_just_before_due(f"{tag}-{i}-due")
                for k in range(3): self.call("noteMessage", {"messageId": f"{tag}-{i}-due-x{k}"})
            elif h or not a.get("event"): self.sleep_through_night(f"{tag}-{i}")
        return False


def is_schedule_hold(h):
    """True only for the engine's DAYTIME schedule hold (an event not yet due). A night or bedtime hold also carries `next` and a positive `minutesUntil`, but no `reason`
    (src/ports/GameSession.ts `held`: reason "schedule" is present only on the schedule hold), and a night hold is a bed, never a wait for the event."""
    return isinstance(h, dict) and h.get("reason") == "schedule" and h.get("next") not in (None, "bedtime") and isinstance(h.get("minutesUntil"), int) and h["minutesUntil"] > 0


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
            busy = self.page.evaluate(BUSY_JS)
            arrived = len(bs) > before  # a reply that has not started yet (the casting finalize builds the whole season first) is not "settled"
            stable = stable + 1 if (sig == prev and not busy and arrived) else 0
            prev = sig
            if stable >= 3: break
        bs = self.page.evaluate(BUB); new = bs[before:] if len(bs) >= before else bs
        # The footer (copy / retry actions) is added when the bubble is finalized; give a late one a few more seconds before calling the bubble unfinalized.
        for _ in range(8):
            if not new or new[-1]["done"]: break
            self.page.wait_for_timeout(2000); bs = self.page.evaluate(BUB); new = bs[before:] if len(bs) >= before else bs
        text = "\n".join(x["txt"] for x in new)
        return {"secs": round(time.time() - t0), "new_bubbles": len(new), "text": text, "settled": bool(new) and bool(text.strip()) and not self.page.evaluate(BUSY_JS),
                "finalized": bool(new) and new[-1]["done"], "timed_out": time.time() - t0 >= limit}


CROSS_EVENING = ["I hang out in the kitchen with whoever is still up until morning.", "I chat quietly about tonight's eviction with the people near me."]
CROSS_BED = "It's been a long night. I say goodnight and go to bed."
CROSS_MORNING = ["I get up and look around the house. What's happening today?", "I find someone to talk to about the new week."]


def crossover(eng, play, check, chat):
    """ORW-433 (Ryne: "the turn over going to bed / waking up ... crossovers from week to week"): from the Week 1 veto morning the engine is driven to eviction night
    (the closed set answered with the simplest legal picks), then the night and the crossover are played through the REAL chat: an evening, a "hang out until
    morning" ask that must not reach morning, the player's own goodnight, and the Week 2 morning. Checks map to the Auditor's ORW-433 lines."""
    eng.play_pendings_until("hoh-competition", "x1", max_steps=80)
    st = eng.call("getGameState"); wk0, day0 = st.get("week"), st.get("dayNumber")
    check("X0-reached-eviction-night", st.get("phase") == "hoh-competition" and (wk0 or 0) >= 2 and not st.get("hoh"), f"phase {st.get('phase')} week {wk0} at {st.get('clockLabel')}, HOH set {bool(st.get('hoh'))}")
    evicted = [h.get("name") for h in (st.get("house") or []) if isinstance(h, dict) and h.get("status") not in (None, "active")]
    for i, line in enumerate(CROSS_EVENING): play(f"cross-evening-{i + 1}", line)
    st = eng.call("getGameState")
    check("N2-hang-out-never-reaches-morning", st.get("dayNumber") == day0 and st.get("timeOfDay") not in ("morning", "afternoon"), f"after 'hang out until morning': {st.get('clockLabel')} ({st.get('timeOfDay')}), started Day {day0}")
    eng.tick_to_night("x-night")
    bed = play("cross-bed", CROSS_BED)
    st = eng.call("getGameState")
    check("N2-the-bed-ends-the-night", (st.get("dayNumber") or 0) == (day0 or 0) + 1, f"after the goodnight: {st.get('clockLabel')} (was Day {day0}) - the narrator must call the bed")
    check("W2-week-chapter-at-the-bed", chat.page.evaluate("!!document.querySelector('.ow-week-card')"), "a Week recap card is on the page after the bed after eviction")
    last = evicted[-1] if evicted else None
    check("N4-the-bed-voices-the-day", bool(last) and last.split()[0] in bed["text"], f"the bed reply names the evicted houseguest ({last}) as part of the day in review", "warn")
    # T17 (0102 / ORW-382): the turnIn the narrator made at the bed closed the day and materialized its day-in-review; the engine re-reads it with dailyRecap.
    # Eviction night is a day the player witnessed (the vote, the goodbye, the evening turns above), so an empty recap is a FAIL.
    rec = eng.call("dailyRecap") or {}
    items = [x for k in ("highlights", "surfaced", "yourDay") for x in (rec.get(k) or [])] if isinstance(rec, dict) else []
    check("T17-a-recap-every-bedtime", bool(items), f"dailyRecap after the bed: day {rec.get('day') if isinstance(rec, dict) else None}, {len(items)} item(s) (highlights / surfaced / yourDay); the closed day was Day {day0}, with the eviction and {len(CROSS_EVENING)} evening scenes witnessed")
    if isinstance(rec, dict) and rec.get("day") is not None and rec.get("day") != day0: check("T17-the-recap-is-the-closed-day", False, f"dailyRecap is for Day {rec.get('day')}, the bed closed Day {day0}", "warn")
    bed["recap"] = rec
    for i, line in enumerate(CROSS_MORNING): play(f"cross-morning-{i + 1}", line)
    # T19 (ORW-418/419): the engine moves the player FIRST, from the player's own words, before the narrator runs. Walk somewhere the player is not.
    here = (eng.call("getGameState").get("whereabouts") or {}).get("room")
    dest, words = ("living-room", "I walk to the living room.") if here == "kitchen" else ("kitchen", "I walk to the kitchen.")
    play("cross-walk", words)
    st = eng.call("getGameState"); w = st.get("whereabouts") or {}; mv = st.get("playerMove") or {}
    if w.get("room") != dest and isinstance(mv, dict) and mv.get("refused"):
        check("T19-the-engine-moves-the-player-first", False, f"{words!r}: the engine refused the move ({mv.get('reason')!r}); player in {w.get('room')!r}", "warn")
    else:
        check("T19-the-engine-moves-the-player-first", w.get("room") == dest, f"{words!r} from {here!r}: engine has the player in {w.get('room')!r} (playerMove {mv!r})")
    st = eng.call("getGameState"); ds = st.get("daySchedule") or {}
    check("W3-hoh-next-in-the-afternoon", ds.get("next") == "hoh-competition" and ds.get("phase") == "afternoon", f"schedule next {ds.get('next')!r} at {ds.get('phase')!r} on {st.get('clockLabel')}")
    hdr = chat.page.evaluate("(() => { const s = [...document.querySelectorAll('#chat-history .role-timestamp-moment')].pop(); return s ? s.textContent : ''; })()")
    check("W10-the-bubble-header-shows-the-new-week", f"Week {st.get('week')}" in (hdr or ""), f"last bubble header {hdr!r} vs engine week {st.get('week')}")
    widgets(eng, check, chat, "morning")
    # N1 / N12: a daytime "go to bed" never ends the night (the bedtime gate); a nap may pass some hours but never reaches the evening or the next day.
    d1 = eng.call("getGameState").get("dayNumber")
    play("too-early-bed", "I'm exhausted. I'm going to bed now.")
    st = eng.call("getGameState")
    check("N1-a-daytime-goodnight-does-not-end-the-day", st.get("dayNumber") == d1 and st.get("timeOfDay") not in ("night", "late-night"), f"after a daytime goodnight: {st.get('clockLabel')} ({st.get('timeOfDay')}), was Day {d1}")
    play("nap", "I go to my bedroom and take a nap.")
    st = eng.call("getGameState")
    check("N12-a-nap-stays-in-the-day", st.get("dayNumber") == d1 and st.get("timeOfDay") in ("morning", "afternoon", "early-morning"), f"after a nap: {st.get('clockLabel')} ({st.get('timeOfDay')}), was Day {d1}")
    # N5: an EARLY bed (the start of the night) wakes before the house; on waking nobody is up and the widgets agree.
    # The day's HOH competition is due this afternoon: play it (and the nominations after it) first, or ticking to the night drags the comp into the night and the
    # goodnight is overruled by the event (an event always wins) - a runner artefact, not the game.
    eng.play_pendings_until("nominations", "x2", max_steps=60)
    eng.tick_to_night("x-early")
    d2 = eng.call("getGameState").get("dayNumber")
    play("early-bed", "I'm turning in early tonight. Goodnight.")
    st = eng.call("getGameState"); h = eng.hour()[0]
    woke_early = st.get("dayNumber") == (d2 or 0) + 1 and h is not None and (h < 8 or 24 <= h < 32)
    check("N5-an-early-bed-wakes-before-the-house", woke_early, f"after an early goodnight: {st.get('clockLabel')} (was Day {d2})")
    if woke_early and (h % 24) < 6:
        check("N5-nobody-is-up-on-an-early-wake", not (st.get("awake") or []), f"awake on waking: {[x.get('name') for x in st.get('awake') or []]}")
    play("early-wake-look", "I get up quietly and look around the house.")
    widgets(eng, check, chat, "early wake")


def widgets(eng, check, chat, where):
    """N7 / N8 in the browser: the Nightfall card lists who is awake (first names, ORW-383) and the Whereabouts card shows only houseguests the engine has with the player."""
    st = eng.call("getGameState")
    awake = [(x.get("name") or "").split()[0] for x in (st.get("awake") or []) if isinstance(x, dict)]
    night = chat.page.evaluate("(document.getElementById('orwell-night') || {}).innerText || ''")
    if not night: check(f"N7-widget-missing[{where}]", False, "the Nightfall card is absent or empty, so the awake list was not checked in the browser", "warn")
    else:
        if awake: check(f"N7-widget-lists-the-awake[{where}]", all(n in night for n in awake) and "Turned in" not in night, f"widget {night[:120]!r} vs engine awake {awake}")
        else: check(f"N7-widget-lists-the-awake[{where}]", "turned in" in night.lower(), f"widget {night[:120]!r}, engine: nobody awake")
    pres = chat.page.evaluate("(document.getElementById('orwell-presence') || {}).innerText || ''")
    w = st.get("whereabouts") or {}
    with_me = {(x.get("name") or "").split()[0] for x in (w.get("present") or []) if isinstance(x, dict)}
    asleep = {(x.get("name") or "").split()[0] for x in (st.get("asleep") or []) if isinstance(x, dict)}
    if not pres: check(f"N8-widget-missing[{where}]", False, "the Whereabouts card is absent or empty, so the sleepers-with-me rule was not checked in the browser", "warn")
    else:
        shown_asleep = sorted(n for n in asleep if n and n not in with_me and re.search(r"\b" + re.escape(n) + r"\b", pres.split("\n")[0]))
        check(f"N8-whereabouts-shows-no-sleeper-with-me[{where}]", not shown_asleep, f"Whereabouts header {pres.split(chr(10))[0][:100]!r}; asleep shown with the player: {shown_asleep}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True); ap.add_argument("--fe", default=os.environ.get("RIG_BASE", "http://127.0.0.1:17000"))
    ap.add_argument("--engine", default=os.environ.get("RIG_ENGINE_URL", "http://127.0.0.1:18765")); ap.add_argument("--token", default="rehlocal")
    ap.add_argument("--turn-limit-secs", type=int, default=120, help="a reply slower than this is a STALL warning; 240 is a FAIL")
    ap.add_argument("--crossover", action="store_true", help="ORW-433: after the veto morning, play on to eviction night and cross into Week 2 through the real chat bed")
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
        t = {"label": label, "msg": text[:80], "secs": r["secs"], "phase": st.get("phase"), "clock": st.get("clockLabel"), "ds": st.get("daySchedule"), "text": r["text"], "settled": r["settled"], "finalized": r.get("finalized"),
             "room_start": room_of(st0), "room_end": sorted(set(room_of(st)) | set(ent.get("arrivedNames") or [])), "inside": ent.get("insideCount"), "arrived": ent.get("arrivedNames"), "entrance_stage": ent.get("stage"), "hoh_name": ((st.get("ceremony") or {}).get("hoh") or {}).get("name") if isinstance((st.get("ceremony") or {}).get("hoh"), dict) else None,
             "timed_out": r["timed_out"], "new_bubbles": r["new_bubbles"], "phase_before": st0.get("phase"), "nominees": [n.get("name") for n in (st.get("nominees") or (st.get("ceremony") or {}).get("nominees") or [])],
             "veto_holder": ((st.get("veto") or (st.get("ceremony") or {}).get("veto")) or {}).get("holder"),
             # T16 (ORW-376): the engine's headcounts, the player included, at the start and end of the turn (an eviction inside a reply changes the house)
             "counts_start": (st0.get("whereabouts") or {}).get("counts"), "counts": (st.get("whereabouts") or {}).get("counts")}
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
            # T12 (Ryne, ORW-368): every houseguest gives their champagne toast before the premiere ends; a short run that passes through the premiere checks it.
            check("T12-every-toast", ent.get("stage") in (None, "done") and not ent.get("toastRemaining"), f"entrance stage {ent.get('stage')!r}, toasts remaining {ent.get('toastRemaining')!r}")
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
            if a.crossover: crossover(eng, play, check, chat)
            b.close()
    except Exception as e:  # noqa: BLE001
        print("could not run:", repr(e)[:300]); write(a.run_dir, turns, checks, str(e)); sys.exit(2)

    score(turns, checks, check, a.turn_limit_secs)
    write(a.run_dir, turns, checks, None)
    hard = [c for c in checks if not c["ok"] and c["severity"] == "fail"]
    print("RESULT:", "FAIL" if hard else "PASS", f"({len(hard)} failing, {sum(1 for c in checks if not c['ok'] and c['severity'] == 'warn')} warnings)")
    sys.exit(1 if hard else 0)


# T13: a clock time the player can read ("8:15", "8:15pm", "9 am", "nine o'clock", "noon"/"midnight" only in a time phrase: "at/by/until noon", "it's midnight", "noon sharp"; not "Midnight snack", "the midnight-blue dress" or "high noon"). Parts of the day are allowed.
ZERO_CLOCK_RE = re.compile(r"(?i)\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+o'?clock\b|\b(?:at|by|until|till|past|after|before|around)\s+(?:noon|midnight)\b|\bit(?:'s| is)\s+(?:almost |nearly |just |about )?(?:noon|midnight)\b|\b(?:noon|midnight)\s+sharp\b")
NAP_MSG_RE = re.compile(r"(?i)\b(?:take|taking|have|grab) (?:a |an )?(?:nap|lie[- ]down|rest)\b")
BED_MSG_RE = re.compile(r"(?i)\b(go(?:ing)? to (?:bed|sleep)|turn(?:ing)? in|head to my bunk|goodnight|good night)\b")


<<<<<<< HEAD
_NUMW = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}
_NUM = r"(\d{1,2}|" + "|".join(sorted(_NUMW, key=len, reverse=True)) + r")"
# the whole house named outright: "N of us left / still in the house", "N houseguests remain", "all N of us"
_HC_HOUSE_RE = re.compile(r"(?i)\b(all\s+(?:the\s+)?)?" + _NUM + r"\s+(of us|houseguests|people|players)\b(?=(\s+(?:are\s+|were\s+)?(?:left|remain\w*|still\s+(?:here|standing|in\s+(?:the|this)\s+(?:house|game))|in\s+(?:the|this)\s+(?:house|game)|under\s+(?:this|one)\s+roof)\b)?)")
# a place right after the number is a ROOM count ("the four of us at the table"), never a house total
_HC_PLACE_RE = re.compile(r"(?i)^\s*(?:at|around|on|by|near|in|inside|out|outside|over|crammed|squeezed|huddled|sitting|sat|left\s+(?:at|in|on|by))\b")
_HC_WORLD_RE = re.compile(r"(?i)^\s*(?:left|remain\w*|still|in\s+(?:the|this)\s+(?:house|game)|under\s+(?:this|one)\s+roof)")


def headcount_claims(text):
    """T16: the house-total claims in a reply as (severity, number, the words, named-the-house-outright). FAIL when the claim names the whole house ("all N of us", "N houseguests left",
    "N of us in the house"); WARN for an unqualified "N of us" (it may be the room); nothing for a room count ("the four of us at the table"), a houseguest
    count without a house word ("16 houseguests walked in" may be the season's cast), or any other number."""
    out = []
    for m in _HC_HOUSE_RE.finditer(text or ""):
        raw, noun, house_words = m.group(2).lower(), m.group(3).lower(), m.group(4)
        n = int(raw) if raw.isdigit() else _NUMW[raw]
        rest = text[m.end():m.end() + 30]
        if house_words: sev = "fail"
        elif _HC_PLACE_RE.match(rest) and not _HC_WORLD_RE.match(rest): continue
        elif m.group(1) and noun in ("of us", "houseguests"): sev = "fail"
        elif noun == "of us" and n >= 5: sev = "warn"  # "the two of us" / "the three of us" is a pair or a huddle, never a house total
        else: continue
        out.append((sev, n, m.group(0).strip() + (house_words or ""), bool(house_words)))
    return out
=======
def draw_voiced(text):
    """The reply voices the veto chip draw (the ceremony that sanctions about an hour of clock, and the C2 check)."""
    return bool(re.search(r"(?i)veto", text or "") and re.search(r"(?i)draw|chip|pull|playing for", text or ""))
>>>>>>> origin/main


def abs_hours(label):
    m = re.match(r"^(\d{1,2}):(\d{2})(am|pm), Day (\d+)$", label or "")
    return None if not m else (int(m.group(4)) - 1) * 24 + int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0) + int(m.group(2)) / 60


def clock_hour(label):
    m = re.match(r"^(\d{1,2}):(\d{2})(am|pm)", label or "")
    return (int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0) + int(m.group(2)) / 60) if m else None


def score(turns, checks, check, turn_limit):
    for t in turns:
        lab = t["label"]
        if lab.endswith("-card"): continue  # a decision-card click (live_week) is not a chat turn: no bubble, no scene, by design
        check(f"T1-answered[{lab}]", t["new_bubbles"] > 0 and t["settled"] and not t["timed_out"], f"bubbles={t['new_bubbles']} settled={t['settled']} timed_out={t['timed_out']}")
        if t.get("finalized") is False and t["settled"]: check(f"T1c-finalized[{lab}]", False, "the reply arrived but its bubble never got its footer (copy / retry actions): an unfinalized live holder", "warn")
        short_ok = lab.startswith("early-ask")  # a one-line deflection of an out-of-schedule request is legitimate; still reported
        shell = SHELL_RE.search(t["text"])
        check(f"T2-real-scene[{lab}]", not shell and (len(t["text"]) >= 200 or short_ok), f"{len(t['text'])} chars" + (" (guard shell text)" if shell else ""))
        if short_ok and len(t["text"]) < 200: check(f"T2b-thin-reply[{lab}]", False, f"only {len(t['text'])} chars for a player request - a thin answer, not a scene", "warn")
        m = LEAK_RE.search(t["text"]); check(f"T3-no-machinery[{lab}]", not m, f"leak: {m.group(0)!r}" if m else "clean")
        check(f"T4-latency[{lab}]", t["secs"] <= turn_limit, f"{t['secs']}s (warn > {turn_limit}s)", "warn")
        check(f"T5-latency-hard[{lab}]", t["secs"] <= 240, f"{t['secs']}s (fail > 240s)")
        # T13 zero clocks (Ryne, ORW-377): a reply names the part of the day, never a clock time. The bubble's own header stamp is stripped first (that is ORW-379's
        # territory, not the narration's).
        _zc_body = re.sub(r"\b\d{1,2}:\d{2}\s*[AP]M\b", " ", t["text"])
        zc = ZERO_CLOCK_RE.search(_zc_body)
        check(f"T13-zero-clocks[{lab}]", not zc, f"clock time in the reply: {zc.group(0)!r}" if zc else "no clock time")
        # The bubble's own header stamp ("Production 03:57 PM") is the wall clock of the chat row, not a claim about the game: strip it before looking for a clock claim.
        body = re.sub(r"\b\d{1,2}:\d{2}\s*[AP]M\b", " ", t["text"], flags=re.I)
        eh = clock_hour(t.get("clock")); cm = re.search(r"\b(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm))", body, flags=re.I) if eh is not None else None
        if cm:
            nh = int(cm.group(1)) + int(cm.group(2)) / 60
            pm_word = re.search(re.escape(cm.group(0)) + r"\s+(?:at night|in the (?:evening|afternoon)|tonight)", body, flags=re.I)  # "8:10 at night" is 8:10pm
            nh = nh + 12 if (nh < 12 and eh >= 12 and (nh < 8 or pm_word)) else nh
            check(f"C3-clock-claim[{lab}]", abs(nh - eh) <= 1.0, f"reply says {cm.group(0)}, engine clock {t['clock']}", "warn")
    # NO SKIPPED TIME (Ryne: "It shouldn't ever skip time"): between two consecutive player turns the clock may not move more than ~1 hour unless the
    # player went to bed (a bed message) or the night reached 8am. Jumps the RUNNER made itself (night sleeps, tick-to-due, entrance advances) are tagged
    # `harness_jump` and listed separately, never blamed on the game. A competition played inside one message moves the clock by its own length: reported as a note.
    prev = None
    for t in turns:
        a_ = abs_hours(t.get("clock"))
        if prev is not None and a_ is not None and a_ - prev > 1.0:
            gap = a_ - prev; bed = bool(BED_MSG_RE.search(t.get("msg") or "") or NAP_MSG_RE.search(t.get("msg") or "")); wake8 = abs((a_ % 24) - 8.0) < 0.2 and ((prev % 24) >= 23.0 or (prev % 24) < 8.0)  # the night ran its course to 8am (the previous turn was already deep in the night), not a day cut short
            if t.get("harness_jump"): check(f"K1-clock-jump-by-runner[{t['label']}]", True, f"+{gap:.1f}h, made by the runner's own engine call ({t['harness_jump']} move(s)) - not the game", "note")
            elif bed or wake8: check(f"K1-clock-jump-bed[{t['label']}]", True, f"+{gap:.1f}h after a bed message or to 8am", "note")
            elif t.get("phase_before") in ("hoh-competition", "veto-competition") and t.get("phase") != t.get("phase_before"):
                # Ryne 2026-11-10: "Comps should take several hours. They should never be one message and should always be a full play by play." A competition that is crowned in a message
                # which also moves the clock by hours spent its hours inside ONE reply.
                if gap <= 1.5: check(f"K1-clock-jump-competition[{t['label']}]", True, f"+{gap:.1f}h: the crown's share on top of the spread rounds (a competition that spans several messages)", "note")
                else: check(f"K2-competition-in-one-message[{t['label']}]", False, f"{t.get('phase_before')} was crowned in a single message and the clock jumped +{gap:.1f}h ({t.get('msg')!r})")
            elif t.get("phase_before") == t.get("phase") == "eviction" and gap <= 2.5:
                # ORW-347: a staged eviction night reads its ballots one per engine step (5 minutes each, up to 15 voters ~ 75 min, more when the reply also plays the goodbye steps) and a reply may play several steps. Same phase, same evening, never across a night: the scheduled ceremony playing out, not skipped time.
                check(f"K1-clock-jump-ceremony[{t['label']}]", True, f"+{gap:.1f}h: the eviction night's ballots read inside one reply (5 min per staged step)", "note")
            elif t.get("phase_before") == t.get("phase") == "veto-competition" and gap <= 1.5 and draw_voiced(t.get("text")):
                # ORW-281: the veto chip draw is its own morning mini ceremony and costs a ceremony's felt hours (~1h, daySchedule DURATION_CATEGORY "veto-draw": "ceremony"),
                # so the reply that voices the draw moves the clock about an hour. Sanctioned, not skipped time.
                check(f"K1-clock-jump-veto-draw[{t['label']}]", True, f"+{gap:.1f}h: the veto draw ceremony (ORW-281, about 1h)", "note")
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
            if t.get("entrance_stage") not in (None, "entrances"): break  # everyone is in (the toast or later): a flat count is no longer a stall
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
    # T16 (Ryne, ORW-376): a stated house total counts the player.
    for t in turns:
        for sev, n, said, explicit in headcount_claims(t["text"]):
            truth = {c.get("house") for c in (t.get("counts_start"), t.get("counts")) if isinstance(c, dict) and isinstance(c.get("house"), int)}
            if not truth: continue
            rooms = {c.get("room") for c in (t.get("counts_start"), t.get("counts")) if isinstance(c, dict)}
            if n in truth or (not explicit and n in rooms): continue  # "all N of us" / "N of us" said in a room of N is the room's own "all of us" (headcountLines)
            check(f"T16-headcount-includes-the-player[{t['label']}]", False, f"reply says {said!r}; the engine has {sorted(truth)} in the house (the player included), {sorted(r for r in rooms if r is not None)} in the room", sev)
    held = [t for t in turns if t["label"].startswith("veto-morning") and t["phase"] == "veto-competition" and (t["ds"] or {}).get("due") is False]
    for t in held:
        m = COMP_PLAY_RE.search(t["text"])
        check(f"C1-no-pre-narrated-comp[{t['label']}]", not m, f"competition play narrated while the engine had not run it: {m.group(0)!r}" if m else "house talk only")
    draw = [t for t in turns if t["label"].startswith("veto-morning")]
    check("C2-draw-voiced", any(draw_voiced(t["text"]) for t in draw), "a veto-morning reply voices the draw")


# The vault note "Live Run Pass Bar" (the Auditor's) numbers the checks; the short tier's own ids map onto it here.
BAR_MAP = [("T1 real scene", {"T2", "T2b"}), ("T5 message answered", {"T1"}), ("T6 no machinery", {"T3"}), ("T9 time is honest", {"K1", "D1", "C3"}),
           ("T12 every houseguest toasts", {"T12"}), ("T13 zero clocks", {"T13"}), ("T16 headcounts include the player", {"T16"}),
           ("T17 a recap every bedtime (crossover)", {"T17", "N4"}), ("T19 the engine moves the player first (crossover)", {"T19"}), ("run level: reaches its end", {"G1", "G2"}), ("production hold", {"P1"}), ("latency", {"T4", "T5"})]
NOT_COVERED = ["T2 phase match, T3 phantom outcome, T4 silent retcon, T7 hidden information, T8 choices through the card, T10 invented confession: read by hand from the transcript",
               "T15 the awake list, T18 naps, T20 early sleepers wake alone: need the full week or the widget",
               "T17 and T19 run only with --crossover",
               "eviction night and the finale: the short tier stops at the Week 1 veto morning"]
NOT_COVERED_CROSSOVER = "the finale and everything after Week 2's start: a `--crossover` run plays on through Week 1's eviction night into Week 2, no further"


def not_covered(checks):
    """The coverage list for THIS run: a run that drove the crossover (it left X0 checks) did cover eviction night and Week 2's start."""
    if any(str(c.get("id", "")).startswith("X0-") for c in checks):
        return NOT_COVERED[:-1] + [NOT_COVERED_CROSSOVER]
    return list(NOT_COVERED)


def _header(run_dir, turns):
    """The pass bar's report header: build, flags, time (UTC and Arizona), model, turns, spend. Each piece is read from what run_short.sh left in the run dir."""
    import datetime
    def _j(n):
        try:
            return json.load(open(f"{run_dir}/{n}"))
        except Exception:  # an absent file just leaves that line out
            return {}
    meta, spend, health = _j("meta.json"), _j("spend.json"), _j("health.json")
    now = datetime.datetime.now(datetime.timezone.utc); az = now - datetime.timedelta(hours=7)
    flags = health.get("flags") or {}
    on = sorted(k for k, v in flags.items() if v is True) if isinstance(flags, dict) else []
    return [f"- Build: `{meta.get('sha', '?')}` ({meta.get('ref', 'main')}); flags on: {', '.join(on) or 'n/a'}",
            f"- When: {now:%Y-%m-%d %H:%M} UTC / {az:%H:%M} Arizona; tier: short; model: {meta.get('model', '?')}",
            f"- Spend: ${spend.get('usd_estimate', '?')} of a ${meta.get('cap', '?')} cap", ""]


def write(run_dir, turns, checks, error):
    hard = [c for c in checks if not c["ok"] and c["severity"] == "fail"]; warn = [c for c in checks if not c["ok"] and c["severity"] == "warn"]
    verdict = "COULD NOT RUN" if error else ("FAIL" if hard else "PASS")
    json.dump({"verdict": verdict, "error": error, "checks": checks, "turns": turns}, open(f"{run_dir}/report.json", "w"), indent=1)
    L = [f"# Live run (short tier) - {verdict}", ""] + _header(run_dir, turns) + [f"Turns played: {len(turns)}. Failing checks: {len(hard)}. Warnings: {len(warn)}." + (f" Could not run: {error}" if error else ""), ""]
    L += ["## Checked against the Live Run Pass Bar", ""] + [f"- {bar}: {', '.join(sorted({c['id'].split('[')[0] for c in checks if c['id'].split('[')[0].split('-')[0] in ids})) or '-'}" for bar, ids in BAR_MAP] + [""]
    L += ["## Not covered by the short tier", ""] + [f"- {x}" for x in not_covered(checks)] + [""]
    if hard or warn:
        L += ["## Not passing", ""] + [f"- **{c['severity'].upper()}** `{c['id']}` - {c['detail']}" for c in hard + warn] + [""]
    L += ["## Every check", ""] + [f"- {'ok ' if c['ok'] else 'NO '} `{c['id']}` - {c['detail']}" for c in checks] + ["", "## Turns", ""]
    for t in turns:
        L += [f"### {t['label']} - {t['secs']}s - {t['clock']} - phase {t['phase']}", f"Player: {t['msg']}", "", "> " + t["text"][:700].replace("\n", "\n> "), ""]
    open(f"{run_dir}/report.md", "w").write("\n".join(L))


if __name__ == "__main__":
    main()
