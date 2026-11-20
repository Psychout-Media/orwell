#!/usr/bin/env python3
"""ORW-109 - the FULL-WEEK tier: one game week played as a TALKING PLAYER against a configured front-end URL (dev), over the SAME HTTP/WebSocket API the browser uses, every
turn compared with the engine's own state read. Operator-triggered only: no CI job, no cron, no nightly.

  python3 scripts/live-run/live_full.py --creds ~/.config/orwell-dev/<account>.json --max-spend 3 --max-turns 200 [--base-url URL] [--out DIR]
  python3 scripts/live-run/live_full.py --stub [healthy|planted|orw10]     offline: no network, no model, no spend (what CI-safe tests and a first look use)

Truth is what a player's browser can read of the engine's state (GET /api/orwell/state composed with /status for the HUD and the decision card and /whereabouts for the presence strip: `live_truth.screen_view`), never the narration.
Nothing hidden or planned is read: what no screen shows is listed as NOT JUDGED in every report. The player sends messages through the chat stream (SSE when the server allows it, the WebSocket
`turn` frame when the game build is WebSocket-only), answers decision cards through POST /api/orwell/decision, and reads the public bubble only (reasoning is kept apart).
Credentials are read from the file named by --creds INSIDE this process and handed straight to the login call; they are never printed, logged or written to a report.
Exit: 0 PASS or NOTE, 1 FAIL, 2 could not run, 4 CAPPED. Writes report.md, report.json and plane-comment.html (anonymised) into --out.
"""
from __future__ import annotations

import argparse
import datetime as dt
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "rehearsal-kit"))

import live_compare as lc  # noqa: E402
import live_full_eval as ev  # noqa: E402
import live_truth as lt  # noqa: E402

MAX_TURNS_CEILING = 400
DEFAULT_MAX_SPEND = 3.0
UNSEEN_CALLS_FACTOR = 1.5     # the stream reports the narrator's own calls; the utility calls (auto-record, authoring) are not in it, so the meter pads what it sees
EST_INPUT_TOKENS = 20000      # when a turn's stream carried no usage at all: a deliberately high per-turn estimate (the cap trips early, never late)
CARD_STEPS_MAX = 40


# --- reading the stream (pure) --------------------------------------------------------------------------------------------------------------------------
class Reply:
    """What one player turn returned: the PUBLIC text, the reasoning kept apart, usage events, and how it ended."""

    def __init__(self):
        self.text, self.reasoning, self.usage, self.error, self.upstream, self.done, self.secs = "", "", [], None, [], False, 0.0

    def add(self, ev_):
        if not isinstance(ev_, dict):
            return
        if "delta" in ev_ and isinstance(ev_["delta"], str):
            if ev_.get("thinking"):
                self.reasoning += ev_["delta"]
            else:
                self.text += ev_["delta"]
        t = ev_.get("type")
        if t == "usage" and isinstance(ev_.get("data"), dict):
            self.usage.append(ev_["data"])
        elif t in ("narrator_away", "narrator_paused"):
            self.upstream.append(ev_.get("message") or t)
        elif t == "error" or "error" in ev_:
            self.error = str(ev_.get("error") or ev_.get("message") or "error")[:200]
        if ev_.get("done"):
            self.done = True


def parse_sse(lines):
    """Server-sent-event lines -> Reply. `event: error` frames and `[DONE]` are honoured; anything that is not JSON is ignored."""
    r, kind = Reply(), None
    for raw in lines:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
        line = line.rstrip("\r\n")
        if line.startswith("event:"):
            kind = line[6:].strip()
        elif line.startswith("data:"):
            body = line[5:].strip()
            if body == "[DONE]":
                r.done = True
                break
            try:
                d = json.loads(body)
            except ValueError:
                continue
            if kind == "error" and isinstance(d, dict):
                d = {"error": d.get("error") or "error"}
            r.add(d)
            kind = None
    return r


def parse_ws_frames(frames):
    """Chat-channel `event` frames (ADR 0017) -> Reply; an `error` frame ends it."""
    r = Reply()
    for f in frames:
        if not isinstance(f, dict):
            continue
        if f.get("t") == "error":
            r.error = str((f.get("d") or {}).get("code") or "error")
            break
        if f.get("t") == "event":
            r.add(f.get("d") or {})
            if r.done:
                break
    return r


# --- the spend meter (the cap is enforced HERE, in the harness) -----------------------------------------------------------------------------------------
class SpendMeter:
    """Dollars so far: the provider's own usage events priced with the kit's own rates (spend_guard.row_usd, a deliberately high flash-tier rate), padded for the calls the
    stream does not show; a turn whose stream carried no usage is priced from an estimate of its size. Feeds live_compare.Budget as its spend function."""

    def __init__(self):
        self.usd = 0.0
        import spend_guard
        self._sg = spend_guard

    def add_reply(self, reply):
        if reply.usage:
            for u in reply.usage:
                c = self._sg.usage_of({"usage": u})
                self.usd += self._sg.row_usd(c) * UNSEEN_CALLS_FACTOR
        else:
            out_tokens = (len(reply.text) + len(reply.reasoning)) / 3.0
            self.usd += (EST_INPUT_TOKENS * self._sg.PRICE_IN + out_tokens * self._sg.PRICE_OUT) * UNSEEN_CALLS_FACTOR

    def __call__(self):
        return self.usd


# --- the talking player ---------------------------------------------------------------------------------------------------------------------------------
GO_NOW = "I'm ready. Let's go."
HANG_OUT = "I hang out until it happens."
BED = "It's late and I'm exhausted. I say goodnight and go to bed."
NAP = "I'm worn out. I'm going to take a nap."
MOVE_NO_DESTINATION = "I leave the room."
ANSWER = "I answer honestly: I haven't decided yet, and I want to hear what you think first."
ASKS = ("what they really think of this week", "whether they have heard anything about the nominations", "how they are holding up",
        "who they trust most in here", "what they would do if they won the next competition", "who feels like a threat to them right now",
        "what they are most worried about this week", "who has been quiet and why", "whether they want to work together this week")
SHARES = ("I tell {name} I am still undecided about the week and want to keep my options open", "I tell {name} I noticed the mood change in the house today",
          "I admit to {name} that I am nervous about the next competition", "I tell {name} I have been keeping an eye on who talks to whom")
HANGOUTS = ("I sit with {name} and let the conversation wander", "I stay in the room and listen to what {name} and the others are saying",
            "I help {name} with whatever they are doing and see what they bring up")
BED_BANDS = ("night", "late-night")   # the player turns in once the HUD says it is night (the player owns their own bedtime)
NAP_BANDS = ("afternoon",)


def clock_band(label):
    """The HUD's day part of a clock label ("morning, Day 2" -> "morning"), or None."""
    m = re.match(r"^([a-z-]+)", (label or "").strip())
    return m.group(1) if m and m.group(1) in lt.BANDS else None


class Player:
    """The deterministic talking player. It picks WHO by least-recently-talked-to and WHAT by least-used shape (counts, never a random or modulo pick), so a run is reproducible
    against the same engine state. Every message is the player's own words; the harness is the player, so nothing here speaks for a houseguest."""

    def __init__(self):
        self.talked, self.used, self.sent, self.asked_ready, self.did_nap, self.did_move, self.last_bed_day = {}, {}, 0, set(), False, False, None

    def _pick_name(self, st):
        f = lt.facts(st)
        pool = list(f["present"]) or [n for n in f["cast"] if n != f["player"] and n not in f["evicted"]]
        if not pool:
            return None
        name = min(pool, key=lambda n: (self.talked.get(n, 0), pool.index(n)))
        self.talked[name] = self.talked.get(name, 0) + 1
        return name

    def _least_used(self, kind, options):
        i = min(range(len(options)), key=lambda k: (self.used.get((kind, k), 0), k))
        self.used[(kind, i)] = self.used.get((kind, i), 0) + 1
        return options[i]

    def next_message(self, st, turns):
        """The next thing the player says, from the engine's state and the last reply."""
        f = lt.facts(st)
        self.sent += 1
        band, ds = clock_band(f["clock"]), f["ds"]
        last = (turns[-1].get("text") or "").strip() if turns else ""
        day = re.search(r"Day (\d+)", f["clock"] or "")
        day = day.group(1) if day else None
        if band in BED_BANDS and self.last_bed_day != day:
            self.last_bed_day = day
            return BED
        if ds.get("due") and ds.get("next"):
            key = (ds.get("next"), f["week"])
            if key not in self.asked_ready:
                self.asked_ready.add(key)
                return GO_NOW
            return HANG_OUT
        if not self.did_nap and band in NAP_BANDS and self.sent >= 8:
            self.did_nap = True
            return NAP
        if not self.did_move and self.sent >= 14:
            self.did_move = True
            return MOVE_NO_DESTINATION
        if last.endswith("?") and not (turns and turns[-1].get("msg") == ANSWER):
            return ANSWER
        name = self._pick_name(st) or "someone"
        kinds = ("ask", "share", "hang")
        k = min(range(len(kinds)), key=lambda i: (self.used.get(("kind", i), 0), i))
        self.used[("kind", k)] = self.used.get(("kind", k), 0) + 1
        kind = kinds[k]
        if kind == "ask":
            return f"I pull {name} aside and ask {self._least_used('ask', ASKS)}."
        if kind == "share":
            return self._least_used("share", SHARES).format(name=name) + "."
        return self._least_used("hang", HANGOUTS).format(name=name) + "."


def decision_body(pending, me):
    """The simplest legal answer to a decision card, as the browser's card posts it (POST /api/orwell/decision). A nominee who holds the veto saves themselves."""
    k = (pending or {}).get("kind")
    opts = [o.get("id") for o in (pending or {}).get("options") or [] if isinstance(o, dict) and o.get("id")]
    body = {"kind": k}
    if k in ("comp-round", "comp-intent"):
        body["intent"] = "compete"
    elif k == "nominations":
        body["choice"] = opts[:2]
    elif k in ("veto-decision", "secret-veto"):
        body["use"] = False
    elif k == "replacement":
        body["replacement"] = opts[0] if opts else None
    elif k == "finale-statement":
        body["statement"] = "I played an honest game and I am proud of it."
    elif k == "finale-answer":
        body["appeal"] = ((pending or {}).get("appeals") or ["own-game"])[0]
    else:
        body["vote"] = opts[0] if opts else "a"
    return {a: b for a, b in body.items() if b is not None}


# --- the worlds: the real front end, and the offline replay -------------------------------------------------------------------------------------------
def load_creds(path):
    """(server, username, password) from the account file. The values stay in this process: nothing here prints, logs or returns them in an error message."""
    d = json.load(open(os.path.expanduser(path)))
    return str(d.get("server") or "").rstrip("/"), str(d["username"]), str(d["password"])


class LiveWorld:
    """The browser's own API against a base URL: login, the engine state read, the chat stream, the decision card."""

    def __init__(self, base, user, password, transport="auto", timeout=300):
        self.base, self._user, self._pw, self.timeout, self.transport = base.rstrip("/"), user, password, timeout, transport
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.session = None
        self.secrets = (user, password)

    def _req(self, method, path, body=None, stream=False, timeout=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method, headers={"content-type": "application/json", "accept": "text/event-stream" if stream else "application/json"})
        try:
            resp = self.op.open(r, timeout=timeout or 60)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path} -> HTTP {e.code}") from None
        except urllib.error.URLError as e:
            raise RuntimeError(f"{method} {path} -> {type(e.reason).__name__}") from None
        return resp if stream else json.load(resp)

    def login(self):
        self._req("POST", "/api/auth/login", {"username": self._user, "password": self._pw, "remember": False})
        self._pw = None   # not needed again: the session cookie carries the login
        sid = (self._req("GET", "/api/orwell/game-session") or {}).get("sessionId")
        if not sid:
            raise RuntimeError("no started game is bound to this account (start one in the browser first)")
        self.session = sid

    def build(self):
        try:
            h = self._req("GET", "/api/orwell/health")
        except RuntimeError:
            return "unknown"
        return json.dumps({k: h.get(k) for k in ("commit", "version", "sha", "flags") if isinstance(h, dict) and k in h})[:300]

    def state(self):
        """What the player's screens read, from the routes they read it from: /state (the board, tiles, day part), /status (the HUD and the decision card) and /whereabouts (the presence
        strip). A route that fails leaves its keys absent (unknown), never invented; /state failing is a failed read."""
        state = self._req("GET", "/api/orwell/state")
        status = whereabouts = None
        for path in ("/api/orwell/status", "/api/orwell/whereabouts"):
            try:
                got = self._req("GET", path)
            except RuntimeError:
                got = None
            if path.endswith("status"):
                status = got
            else:
                whereabouts = got
        return lt.screen_view(state, status, whereabouts)

    def decide(self, body):
        return self._req("POST", "/api/orwell/decision", body)

    def send(self, message):
        t0 = time.time()
        body = {"message": message, "session": self.session, "client_msg_id": f"live-{uuid.uuid4().hex[:12]}"}
        reply = None
        if self.transport in ("auto", "sse"):
            try:
                resp = self._req("POST", "/api/chat_stream", body, stream=True, timeout=self.timeout)
                reply = parse_sse(resp)
            except RuntimeError as e:
                if self.transport == "sse" or "426" not in str(e):
                    reply = Reply()
                    reply.error = str(e)
        if reply is None:
            reply = self._send_ws(message, body["client_msg_id"])
        reply.secs = round(time.time() - t0, 1)
        return reply

    def _send_ws(self, message, cmid):
        """The game build's own transport (docs/design/websocket-phase1-protocol.md): hello -> ack -> subscribe -> turn, then the chat channel's event frames until `done`. NOT yet
        proven against a live server (the first operator run is that proof); any failure comes back as a no-reply turn, never as made-up text."""
        r = Reply()
        try:
            from websockets.sync.client import connect
        except ImportError:
            r.error = "the websockets package is not installed"
            return r
        cookie = "; ".join(f"{c.name}={c.value}" for c in self.jar)
        url = re.sub(r"^http", "ws", self.base) + "/api/ws/session"
        frames = []
        try:
            with connect(url, additional_headers={"Cookie": cookie, "Origin": self.base}, open_timeout=30, max_size=None) as ws:
                ws.send(json.dumps({"t": "hello", "cid": "c_00", "d": {"perTabId": self.session, "protocol": 1}}))
                ack = json.loads(ws.recv(timeout=30))
                beat = ((ack.get("d") or {}).get("beatSeq"))
                ws.send(json.dumps({"t": "subscribe", "ch": "chat", "cid": "c_01", "d": {"fromSeq": 0}}))
                ws.send(json.dumps({"t": "turn", "ch": "chat", "cid": "c_09", "d": {"message": message, "clientMsgId": cmid, "expectedBeatSeq": beat, "attachments": [], "mode": "agent"}}))
                t0 = time.time()
                while time.time() - t0 < self.timeout:
                    f = json.loads(ws.recv(timeout=60))
                    if f.get("t") == "ping":
                        ws.send(json.dumps({"t": "pong"}))
                        continue
                    if f.get("t") == "event" and f.get("d", {}).get("type") == "message_saved" and not frames:
                        continue
                    frames.append(f)
                    if f.get("t") == "error" or (f.get("t") == "event" and (f.get("d") or {}).get("done")):
                        break
        except Exception as e:  # noqa: BLE001 - a transport failure is a no-reply turn
            r = parse_ws_frames(frames)
            r.error = r.error or f"ws {type(e).__name__}"
            return r
        return parse_ws_frames(frames)


class ReplayWorld:
    """Offline: a recorded or generated sequence of steps {msg_state_before?, state, reply} played back as if it were the front end. `pending` states hold until decide()."""

    def __init__(self, steps, first_state):
        self.steps, self.i, self._state, self.decisions, self.session = steps, 0, first_state, 0, "stub"
        self.secrets = ()

    def login(self):
        pass

    def build(self):
        return "offline stub"

    def state(self):
        """A step's `screens` ({state, status, whereabouts}: the routes' payloads) are composed exactly as the live world composes them; a plain dict is already a screen view."""
        cur = self._state
        if isinstance(cur, dict) and isinstance(cur.get("screens"), dict):
            return lt.screen_view(cur["screens"].get("state"), cur["screens"].get("status"), cur["screens"].get("whereabouts"))
        return cur

    def decide(self, body):
        self.decisions += 1
        cur = self._state
        if isinstance(cur, dict) and isinstance(cur.get("screens"), dict):   # the card is answered: the HUD route and the state's card kind both clear
            sc = cur["screens"]
            self._state = {"screens": dict(sc, state=dict(sc.get("state") or {}, pending=None), status=dict(sc.get("status") or {}, pending=None))}
        else:
            self._state = dict(cur, pending=None)
        return {"ok": True}

    def send(self, message):
        if self.i >= len(self.steps):
            r = Reply()
            r.error = "the recorded sequence ended"
            return r
        step = self.steps[self.i]
        self.i += 1
        self._state = step["state"]
        r = Reply()
        r.text, r.reasoning, r.error, r.secs = step.get("reply", ""), step.get("reasoning", ""), step.get("error"), step.get("secs", 1.0)
        r.usage = step.get("usage") or []
        return r


# --- the run loop ---------------------------------------------------------------------------------------------------------------------------------------
def reached_planned_end(start_week, st):
    """The bar's planned end for a full week: the weekly eviction has happened and the next head of household is crowned, or the game is over."""
    f = lt.facts(st)
    if f["finished"]:
        return True
    return bool(f["week"] and start_week is not None and f["week"] > start_week and f["hoh"])


def run(world, budget, meter, player=None, log=lambda *_: None, max_stall_cards=CARD_STEPS_MAX):
    """Play the week. Returns (turns, reached_end, error, capped)."""
    player = player or Player()
    turns, error, capped, cards = [], None, False, 0
    st = world.state()
    start_week = lt.facts(st)["week"]
    end_at = None
    try:
        while True:
            if reached_planned_end(start_week, st):
                end_at = len(turns) if end_at is None else end_at
                if len(turns) - end_at >= lt.RESULT_WINDOW:   # play the result window out, so the last result is judged and not just noted
                    return turns, True, None, False
            pend = lt.facts(st)["pending"]
            if pend:
                cards += 1
                if cards > max_stall_cards:
                    return turns, False, "a decision card would not clear", False
                world.decide(decision_body(pend, lt.facts(st)["player"]))
                st = world.state()
                continue
            budget.check()
            msg = player.next_message(st, turns)
            label = f"turn-{len(turns) + 1}"
            st0 = st
            reply = world.send(msg)
            st = world.state()
            budget.note_turn()
            meter.add_reply(reply)
            rec = lt.turn_record(label, msg, st0, st, reply.text, reply.secs, reply.error)
            rec["upstream_notice"] = bool(reply.upstream)
            turns.append(rec)
            log(label, rec["phase"], len(reply.text))
    except lc.BudgetExceeded as e:
        return turns, False, str(e), True
    except Exception as e:  # noqa: BLE001
        return turns, False, f"{type(e).__name__}: {e}", False


# --- the offline scenarios (the stub) -------------------------------------------------------------------------------------------------------------------
SCENE = ("The kitchen hums with low talk; {a} stirs a pot and glances up at {b} while the afternoon light slants across the counter, and the whole room seems to wait on someone "
         "to say the thing nobody has said yet. ")


def _state(week, phase, clock, cast, hoh=None, nominees=(), veto=None, evicted=(), player=None, due=False, nxt=None, pending=None, finished=False, winner=None):
    """One generated step as the three browser routes would serve it, composed by the real `screen_view`. `clock` is the HUD's "<day part>, Day N"."""
    band, _, day = clock.partition(", Day ")
    ids = {n: f"hg{i}" for i, n in enumerate(cast)}
    ref = lambda n: {"id": ids[n], "name": n}  # noqa: E731
    house = [{"id": ids[n], "name": n, "status": "evicted" if n in evicted else "active"} for n in cast]
    board = {"hoh": ref(hoh) if hoh else None, "nominees": [ref(n) for n in nominees], "veto": {"holder": ref(veto) if veto else None, "used": False, "players": []}}
    state = {"started": True, "phase": phase, "week": week, "timeOfDay": band, "dayNumber": int(day), "daySchedule": {"due": due, "next": nxt, "minutesUntil": 0 if due else 90},
             "ceremony": board, "house": house, "player": ref(player) if player else None, "pending": {"kind": pending["kind"]} if pending else None, "finished": finished}
    status = dict(board, pending=pending, finished=finished, winner=ref(winner) if winner else None)
    whereabouts = {"whereabouts": {"room": "kitchen", "present": [ref(n) for n in cast[1:5]]}}
    return {"screens": {"state": state, "status": status, "whereabouts": whereabouts}}


def stub_week(fault=None):
    """A generated Week 1 as (steps, first_state): HOH, nominations, veto, ceremony, eviction, Week 2's HOH. `fault` plants ONE defect so each detector has a positive control:
    phantom (a veto winner the engine never committed), stall (the veto ceremony due for many turns), stand_in (a canned line as the reply), missing (an eviction the narration never
    tells), leak (an npc id and an operator aside), unanswered (an empty reply), retcon, timeskip, or orw10 (the recorded ORW-10 veto-ceremony stall shape)."""
    cast = ["Pa Aa", "Pb Bb", "Pc Cc", "Pd Dd", "Pe Ee", "Pf Ff"]
    me = cast[0]
    from live_detect import stand_in_table
    canned = next(iter(stand_in_table().values()), "The live feeds cut away - the control room is not ready to show you the next moment.")
    scene = SCENE.format(a="the HOH", b="a nominee") * 2
    st = []
    base = dict(cast=cast, player=me)

    def add(state, reply, **kw):
        st.append(dict({"state": state, "reply": reply}, **kw))

    add(_state(1, "hoh-competition", "morning, Day 2", **base, due=False), scene + "Everyone talks about the coming competition.")
    add(_state(1, "nominations", "morning, Day 2", hoh=cast[1], **base, due=True, nxt="nominations"), scene + "The HOH is the new Head of Household and the room buzzes.")
    add(_state(1, "nominations", "morning, Day 2", hoh=cast[1], nominees=[cast[2], cast[3]], **base, due=False), scene + "Two houseguests are nominated and sit stunned on the block.")
    add(_state(1, "veto-competition", "afternoon, Day 3", hoh=cast[1], nominees=[cast[2], cast[3]], **base, due=True, nxt="veto-competition"), scene + "Everyone gathers for the veto draw.")
    add(_state(1, "veto-ceremony", "afternoon, Day 4", hoh=cast[1], nominees=[cast[2], cast[3]], veto=cast[4], **base, due=True, nxt="veto-ceremony"), scene + "The veto winner steps forward with the veto in hand.")
    if fault == "orw10":   # the recorded shape of the ORW-10 stall: the ceremony due, nothing committed, the same canned cutaway shown turn after turn
        for _ in range(35):   # the card: 35 messages with the ceremony due
            add(_state(1, "veto-ceremony", "afternoon, Day 4", hoh=cast[1], nominees=[cast[2], cast[3]], veto=cast[4], **base, due=True, nxt="veto-ceremony"), canned)
    elif fault == "stall":
        for k in range(6):
            add(_state(1, "veto-ceremony", "afternoon, Day 4", hoh=cast[1], nominees=[cast[2], cast[3]], veto=cast[4], **base, due=True, nxt="veto-ceremony"),
                scene + f"Still waiting, beat {k}, and nobody moves.")
    add(_state(1, "eviction", "evening, Day 5", hoh=cast[1], nominees=[cast[2], cast[3]], veto=cast[4], **base, due=True, nxt="eviction"), scene + "The house gathers on the couches for the live vote.")
    ev_reply = scene + "The votes are read aloud and the room goes silent as the house votes out a nominee."
    ev_state = _state(1, "hoh-competition", "night, Day 5", hoh=None, evicted=[cast[3]], **base)
    add(ev_state, scene + "The house sleeps badly after a long and tense night." if fault == "missing" else ev_reply)
    add(_state(2, "nominations", "morning, Day 6", hoh=cast[2], evicted=[cast[3]], **base), scene + "The new Head of Household sits in the HOH room and thinks.")
    for _ in range(lt.RESULT_WINDOW):
        add(_state(2, "nominations", "morning, Day 6", hoh=cast[2], evicted=[cast[3]], **base), scene + "The new week settles in and people drift between rooms.")
    pos = {"phantom": 1, "stand_in": 2, "leak": 3, "unanswered": 4, "retcon": 6, "timeskip": 0}
    if fault in pos:
        s = st[pos[fault]]
        if fault == "phantom":
            s["reply"] = scene + f"{cast[5]} wins the Power of Veto and the room erupts."
        elif fault == "stand_in":
            s["reply"] = canned
        elif fault == "leak":
            s["reply"] = scene + " Let me record this interaction. npc:17 glares at the nominee."
        elif fault == "unanswered":
            s["reply"] = ""
            s["error"] = "no reply"
        elif fault == "retcon":
            s["state"] = _state(1, "veto-ceremony", "afternoon, Day 4", hoh=cast[5], nominees=[cast[2], cast[3]], veto=cast[4], **base, due=True, nxt="veto-ceremony")
        elif fault == "timeskip":
            s["state"] = _state(1, "hoh-competition", "evening, Day 2", **base)
    first = _state(1, "hoh-competition", "morning, Day 2", **base)
    return st, first


def run_stub(kind, out_dir, max_turns=60, max_spend=3.0):
    fault = {"healthy": None, "planted": "phantom"}.get(kind, kind)
    steps, first = stub_week(fault)
    world = ReplayWorld(steps, first)
    meter = SpendMeter()
    budget = lc.Budget(max_spend, max_turns, meter)
    turns, reached, error, capped = run(world, budget, meter)
    return finish(turns, reached, error, capped, budget, world, out_dir, {"model": "offline stub", "build": "offline stub"})


def finish(turns, reached, error, capped, budget, world, out_dir, meta):
    table = None
    findings, stats = ev.judge_run(turns, table)
    names = sorted({n for t in turns for n in (t.get("cast") or [])})
    now = dt.datetime.now(dt.timezone.utc)
    meta = dict(meta, started_utc=now.strftime("%Y-%m-%d %H:%M"), started_az=(now - dt.timedelta(hours=7)).strftime("%Y-%m-%d %H:%M"))
    word = ev.verdict(findings, stats, error if (error and not turns and not capped) else None, capped, reached)
    md, data = ev.build_report(meta, turns, findings, stats, budget.summary(), word, error, names, getattr(world, "secrets", ()), reached)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        ev.write_report(out_dir, md, data)
    return word, md, data


EXIT = {"PASS": 0, "NOTE": 0, "FAIL": 1, "COULD NOT RUN": 2, "CAPPED": 4}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--creds", help="the account file (server, username, password); read in code, never printed")
    ap.add_argument("--base-url", help="the front end's base URL (default: the creds file's server)")
    ap.add_argument("--out", default=None, help="the report directory (default ./live-full-<utc>)")
    ap.add_argument("--max-spend", type=float, default=DEFAULT_MAX_SPEND, help="dollars; the run stops cleanly and reports CAPPED at this estimate")
    ap.add_argument("--max-turns", type=int, default=200, help=f"player messages (1..{MAX_TURNS_CEILING})")
    ap.add_argument("--transport", choices=("auto", "sse", "ws"), default="auto")
    ap.add_argument("--replay", help="offline: play back a recorded {first, steps} JSON file (a recorded failure or a healthy sequence) through the same judge")
    ap.add_argument("--stub", nargs="?", const="healthy", help="offline replay: healthy | planted | stall | stand_in | missing | leak | unanswered | retcon | timeskip | orw10")
    a = ap.parse_args(argv)
    a.max_turns = max(1, min(MAX_TURNS_CEILING, a.max_turns))
    out = a.out or os.path.join(os.getcwd(), "live-full-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    if a.replay:
        rec = json.load(open(a.replay))
        world = ReplayWorld(rec["steps"], rec["first"])
        meter = SpendMeter()
        budget = lc.Budget(a.max_spend, a.max_turns, meter)
        turns, reached, error, capped = run(world, budget, meter)
        word, _, _ = finish(turns, reached, error, capped, budget, world, out, {"model": "recorded replay", "build": os.path.basename(a.replay)})
        print(f"LIVE-FULL {word} (replay) {out}/report.md")
        return EXIT[word]
    if a.stub:
        word, md, _ = run_stub(a.stub, out, a.max_turns, a.max_spend)
        print(f"LIVE-FULL {word} (stub {a.stub}) {out}/report.md")
        return EXIT[word]
    if not a.creds:
        ap.error("--creds is required (or --stub)")
    try:
        server, user, pw = load_creds(a.creds)
        world = LiveWorld(a.base_url or server, user, pw, a.transport)
        world.login()
    except Exception as e:  # noqa: BLE001
        print("LIVE-FULL COULD-NOT-RUN", ev.scrub_all(f"{type(e).__name__}: {e}", (), (user if "user" in dir() else "", pw if "pw" in dir() else "")))
        return 2
    meter = SpendMeter()
    budget = lc.Budget(a.max_spend, a.max_turns, meter)
    turns, reached, error, capped = run(world, budget, meter, log=lambda *x: print("[live-full]", *x, flush=True))
    word, md, _ = finish(turns, reached, error, capped, budget, world, out, {"model": "the account's configured narrator", "build": world.build()})
    print(f"LIVE-FULL {word} {out}/report.md")
    return EXIT[word]


if __name__ == "__main__":
    sys.exit(main())
