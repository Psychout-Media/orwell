#!/usr/bin/env python3
"""Post-session analyzer for a live orwell playtest (P5). READ-ONLY.

  python3 post_session_analyzer.py --ssh root@10.0.1.243 --since "2026-11-05 17:00" --out report.md
  python3 post_session_analyzer.py --dir /path/to/run-dir --out report.md      # a rehearsal/run dir with fe.log, app.db, llm-io.jsonl

Over SSH it only runs fixed READ commands (journalctl, cat, stat) - nothing is written on the box, nothing is installed, no credentials are created.
It pulls: the front-end journal, the engine journal, app.db (+ -wal/-shm) and llm-io.jsonl, into a local temp dir, then reports in plain language:
  headlines, social share of messages, narration-guard activity by class (strips / scene cuts / holes) per message, latency, failed calls, stalls,
  card timings, narration-vs-engine mismatches (with short snippets), and what could NOT be measured.
Times: the DB stores UTC; journald lines carry their own offset and are converted to UTC. Pass --since/--until in UTC.
"""
import argparse, collections, datetime as dt, json, os, re, sqlite3, statistics, subprocess, sys, tempfile

APP = "/opt/orwell"
READ_ONLY_PREFIXES = ("journalctl ", "cat ", "stat ", "ls ")


def ssh_read(host, cmd, binary=False, timeout=180):
    """Run ONE read-only command on the box. The allow-list is enforced here, in code."""
    if not cmd.startswith(READ_ONLY_PREFIXES) or any(ch in cmd for ch in ";&|><`$\n"):
        raise SystemExit(f"refusing non-read-only/complex command: {cmd!r}")
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, cmd], capture_output=True, timeout=timeout)
    if r.returncode != 0:
        return None
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def pull(host, since, until, dest, app=APP):
    os.makedirs(dest, exist_ok=True)
    got = {}
    for unit, name in (("orwell-frontend", "fe.log"), ("orwell-engine", "engine.log")):
        cmd = f'journalctl -u {unit} --no-pager -o short-iso --since "{since}"' + (f' --until "{until}"' if until else "")
        txt = ssh_read(host, cmd)
        if txt is not None:
            open(os.path.join(dest, name), "w").write(txt)
            got[name] = len(txt)
    for rel, name in ((f"{app}/frontend/data/app.db", "app.db"), (f"{app}/frontend/data/app.db-wal", "app.db-wal"),
                      (f"{app}/frontend/data/app.db-shm", "app.db-shm"), (f"{app}/frontend/data/llm-io.jsonl", "llm-io.jsonl")):
        b = ssh_read(host, f"cat {rel}", binary=True)
        if b is not None:
            open(os.path.join(dest, name), "wb").write(b)
            got[name] = len(b)
    # the engine's latest save (clock + hang-out log); read-only ls/cat of the highest version only
    for base in (f"{app}/data/saves", f"{app}/.orwell-data/saves", f"{app}/data/.orwell-data/saves"):
        users = ssh_read(host, f"ls -1 {base}")
        if users is None:
            continue
        best = None
        for u in users.split():
            if not re.fullmatch(r"[0-9a-f]+", u):
                continue
            vs = ssh_read(host, f"ls -1 {base}/{u}") or ""
            vers = sorted(v for v in vs.split() if re.fullmatch(r"v\d+\.json", v))
            if vers and (best is None or vers[-1] > best[1]):
                best = (u, vers[-1])
        if best:
            b = ssh_read(host, f"cat {base}/{best[0]}/{best[1]}", binary=True)
            if b is not None:
                open(os.path.join(dest, "engine-save.json"), "wb").write(b)
                got["engine-save.json"] = len(b)
        break
    return got


# ── parsing ─────────────────────────────────────────────────────────────────────────────────────
JOURNAL_RE = re.compile(r"^(\d{4}-\d\d-\d\dT[\d:]+)([+-]\d{4}|Z) \S+ \S+?: (.*)$")
APPTS_RE = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ - ([\w.]+) - (\w+) - (.*)$")


def parse_fe(path, offset_hours_default=0.0):
    """-> list of (utc datetime, level, logger, message). Accepts journald short-iso lines and plain app log lines."""
    out = []
    if not os.path.exists(path):
        return out
    for line in open(path, errors="replace"):
        line = line.rstrip("\n")
        jt = None
        m = JOURNAL_RE.match(line)
        if m:
            jt = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S")
            if m.group(2) not in ("Z", "+0000"):
                sign = 1 if m.group(2)[0] == "+" else -1
                jt -= sign * dt.timedelta(hours=int(m.group(2)[1:3]), minutes=int(m.group(2)[3:5]))
            line = m.group(3)
        a = APPTS_RE.match(line)
        if a:
            ts = dt.datetime.strptime(a.group(1), "%Y-%m-%d %H:%M:%S")
            ts = jt if jt else ts - dt.timedelta(hours=offset_hours_default)
            out.append((ts, a.group(3), a.group(2), a.group(4)))
        elif jt:
            out.append((jt, "INFO", "raw", line))
    return out


def load_turns(db_path, since, until):
    """One turn = a game-phase user message + the assistant message that answers it. Casting turns are excluded."""
    if not os.path.exists(db_path):
        return [], 0
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = c.execute("select session_id, role, content, metadata, timestamp, seq from chat_messages order by session_id, seq").fetchall()
    turns, casting, pend = [], 0, {}
    for sid, role, content, md, ts, seq in rows:
        try:
            md = json.loads(md or "{}")
        except Exception:
            md = {}
        try:
            t = dt.datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S")
        except Exception:
            continue
        if role == "user":
            pend[sid] = (t, md, content or "")
        elif role == "assistant" and sid in pend:
            t0, umd, utext = pend.pop(sid)
            if umd.get("phase") == "casting" or md.get("phase") == "casting":
                casting += 1
                continue
            if t0 < since or (until and t0 > until):
                continue
            turns.append({"start": t0, "end": t, "user": utext, "text": content or "", "md": md,
                          "latency": md.get("response_time") if isinstance(md.get("response_time"), (int, float)) else (t - t0).total_seconds(),
                          "ttft": md.get("time_to_first_token"), "model": md.get("model"), "out_tokens": md.get("output_tokens"),
                          "ann": [a.get("kind") for a in (md.get("announcements") or []) if isinstance(a, dict)]})
    return turns, casting


STRIP_CLASSES = (("veto", "veto winner/holder"), ("HOH", "head of household"), ("evictee", "evictee"), ("ballot", "ballot/tally before reveal"),
                 ("nominee", "nominee"), ("closing wrapper", "(wrapper of a stripped line)"))
CUT_CLASSES = (("COMPETITION RESULT", "competition result ahead of the engine"), ("NOMINATION", "nomination ahead of the engine"),
               ("EVICTION VOTE TALLY", "vote tally / result"), ("EVICTION (", "eviction ahead of the engine"), ("HEAD OF HOUSEHOLD", "head of household"),
               ("VETO", "veto"), ("board-absence", "pre-ceremony fabrication"), ("player removal", "phantom player removal"),
               ("engine unreachable", "engine unreachable"))



# A81 - the OTHER narration-guard log lines. (marker substring of the FE log text after "[orwell] ", human class, severity) - severity "down" = the guard itself is off / failed (read these first),
# "fired" = it corrected something, "skipped" = it errored and failed open. tests: rehearsal-kit/test_guard_log_drift.py fails when an FE guard log line has no marker here.
GUARD_LINES = (
    ("faithfulness guard DOWN", "faithfulness guard DOWN (a closed-set draft could not be judged)", "down"),
    ("faithfulness check failed", "faithfulness guard DOWN (check failed)", "down"),
    ("faithfulness judge call failed", "faithfulness guard DOWN (judge call failed)", "down"),
    ("faithfulness judge model resolve failed", "faithfulness guard DOWN (judge model unresolved)", "down"),
    ("pre-emission guard HELD a phantom closed-set outcome", "pre-emission guard held a phantom outcome", "fired"),
    ("pre-emission guard HELD a 'met everyone' overclaim", "pre-emission guard held a 'met everyone' overclaim", "fired"),
    ("pre-emission guard HELD an evicted-houseguest-in-a-room claim", "pre-emission guard held an evicted-houseguest-in-a-room claim", "fired"),
    ("pre-emission guard HELD a wrong-nominee claim", "pre-emission guard held a wrong-nominee claim", "fired"),
    ("N-17: replaced", "N-17 replaced an invented confession", "fired"),
    ("phantom-finale guard STRIPPED", "phantom-finale guard stripped units", "fired"),
    ("overclaim BLOCKED", "overclaim blocked in-turn (regenerated or replaced)", "fired"),
    ("knowledge-wall: stripped", "knowledge wall stripped a sealed-content sentence", "fired"),
    ("presence OMISSION", "presence omission detected (re-ground next turn)", "fired"),
    ("replay guard", "replay guard dropped a re-told scene", "fired"),
    ("blank-turn guard", "blank-turn guard re-prompted for narration", "fired"),
    ("E22 guard: stood down", "E22 guard stood down (turn wrote)", "fired"),
    ("auto-record: dropped off-scene", "auto-record dropped off-scene ids", "fired"),
    ("deal back-fill refused by the N-4 guard", "N-4 guard refused a deal back-fill", "fired"),
    ("E22 guard:", "E22 guard (a narrated turn wrote nothing to the engine: fallback write / stood down)", "fired"),
    ("deferred-fold queue overflow", "deferred-fold queue overflow (the OLDEST queued consequence fold was dropped)", "down"),
    ("deferred fold (", "deferred fold exhausted its retry budget (a consequence fold was surfaced as lost)", "down"),
    ("_DESYNC_REGROUND queue at cap", "re-ground queue at cap (the oldest correction was dropped)", "fired"),
    ("post-turn desync check: peer advanced", "post-turn desync check skipped (a peer window advanced the board)", "fired"),
    ("post-turn desync check skipped", "post-turn desync check errored (failed open)", "skipped"),
    ("post-turn desync check failed", "post-turn desync check errored (failed open)", "skipped"),
    ("scene circuit-breaker: engine unreadable", "scene circuit-breaker cut a scene (engine unreadable while a board change was narrated)", "fired"),
    ("double-blank guard", "double-blank guard emitted a minimal in-voice beat", "fired"),
    ("S2a strip fail-opened", "S2a strip failed open (no excision confirmed; the beat was not appended)", "skipped"),
    ("anti-stale CAP", "anti-stale cap reached (the advance was held and a re-ground queued)", "fired"),
    ("pre-emission outcome guard skipped", "pre-emission outcome guard errored (failed open)", "skipped"),
    ("pre-emission location guard skipped", "pre-emission location guard errored (failed open)", "skipped"),
    ("pre-emission met-everyone guard skipped", "pre-emission met-everyone guard errored (failed open)", "skipped"),
    ("pre-emission nominee guard skipped", "pre-emission nominee guard errored (failed open)", "skipped"),
    ("scene circuit-breaker skipped", "scene circuit-breaker errored (failed open)", "skipped"),
)
GUARD_CLASS_TAG = re.compile(r"class=([A-Za-z0-9+\-]+)")  # A77: the class tag now on the pre-emission and desync lines

def classify(text, table, default="other"):
    for k, v in table:
        if k in text:
            return v
    return default


def analyze(events, turns, llm_rows, since, until):
    R = {}
    ev = [e for e in events if e[0] >= since and (not until or e[0] <= until)]
    R["turns"] = len(turns)
    # per-turn event attribution
    for t in turns:
        t["events"] = [e for e in ev if t["start"] - dt.timedelta(seconds=1) <= e[0] <= t["end"] + dt.timedelta(seconds=3)]
        msgs = [e[3] for e in t["events"]]
        t["advanced"] = bool(t["ann"]) or any("pre-resolve advanced" in m or "Tool executed: advanceGame" in m or "Tool executed: runCompetition" in m
                                              or "Tool executed: submitDecision" in m or "committed advanceGame silently" in m for m in msgs)
        t["hole"] = "live feeds cut away" in t["text"]
        t["interlude"] = "technical interlude" in t["text"] or "feed glitched" in t["text"]
        t["held"] = any("production holds" in m or "social runway holding" in m for m in msgs)
    event_turns = [t for t in turns if t["advanced"]]
    R["event_turns"] = len(event_turns)
    R["social_turns"] = len(turns) - len(event_turns)
    R["social_share"] = (R["social_turns"] / len(turns)) if turns else None
    # guard activity
    strips, cuts, softs = collections.Counter(), collections.Counter(), collections.Counter()
    snippets = []
    for ts, lvl, lg, m in ev:
        if "role-claim guard STRIPPED" in m:
            body = m.split(": ", 1)[1] if ": " in m else m
            for part in body.split("; "):
                cls = classify(part.split(" ← ")[0], STRIP_CLASSES)
                if cls != "(wrapper of a stripped line)":
                    strips[cls] += 1
                    snippets.append((ts, "stripped a claim the engine hadn't committed (" + cls + ")", part.split(" ← ")[-1][:110]))
        elif "scene circuit-breaker HELD" in m:
            cls = classify(m, CUT_CLASSES)
            cuts[cls] += 1
            snippets.append((ts, "cut a whole scene (" + cls + ")", re.sub(r"^.*?\(phase=([a-z-]+);", r"engine phase \1:", m)[:150]))
        elif "presence-wall: dropped" in m:
            cuts_presence = "presence wall: dropped a houseguest who is not in the scene"
            strips[cuts_presence] += 1
        elif "soft-fail" in m:
            softs[re.sub(r"^.*soft-fail (\S+).*$", r"\1", m)] += 1
    guard_lines, guard_down = collections.Counter(), collections.Counter()
    for ts, lvl, lg, m in ev:
        for marker, label, sev in GUARD_LINES:
            if marker in m:
                guard_lines[(sev, label)] += 1
                if len(snippets) < 400:
                    tag = GUARD_CLASS_TAG.search(m)
                    snippets.append((ts, f"{label}" + (f" [{tag.group(1)}]" if tag else ""), re.sub(r"^.*?\[orwell\]\s*", "", m)[:150]))
                break
    for ts, lvl, lg, m in ev:
        if "desync detected" in m or "pre-emission guard HELD a phantom closed-set outcome" in m:
            tag = GUARD_CLASS_TAG.search(m)
            if tag:
                guard_down[tag.group(1)] += 1
    R["guard_lines"], R["guard_classes"] = guard_lines, guard_down
    R["strips"], R["cuts"], R["softfails"] = strips, cuts, softs
    R["strip_total"], R["cut_total"] = sum(strips.values()), sum(cuts.values())
    R["cut_turns"] = sum(1 for t in turns if any("scene circuit-breaker HELD" in e[3] for e in t["events"]))
    R["strip_turns"] = sum(1 for t in turns if any("role-claim guard STRIPPED" in e[3] or "presence-wall: dropped" in e[3] for e in t["events"]))
    R["holes"] = sum(1 for t in turns if t["hole"])
    R["interludes"] = sum(1 for t in turns if t["interlude"])
    R["desync"] = sum(1 for e in ev if "desync detected" in e[3])
    R["anti_stale"] = sum(1 for e in ev if "ANTI-STALE" in e[3])
    R["hold_cap"] = sum(1 for e in ev if "production hold cap" in e[3])
    R["prod_holds"] = sum(1 for e in ev if "production holds" in e[3])
    R["stall_forced"] = sum(1 for e in ev if "forcing an IN-TURN voice" in e[3] or "forced advance" in e[3].lower())
    # latency
    lat = sorted(t["latency"] for t in turns if isinstance(t["latency"], (int, float)))
    R["lat"] = {"n": len(lat), "median": statistics.median(lat) if lat else None, "p90": lat[int(0.9 * (len(lat) - 1))] if lat else None, "max": lat[-1] if lat else None}
    slow = sorted(turns, key=lambda t: -(t["latency"] or 0))[:5]
    R["slow"] = [(t["start"], round(t["latency"] or 0, 1), t["user"][:60]) for t in slow]
    # silent / empty turns (a stall the player felt)
    R["empty_turns"] = [(t["start"], t["user"][:60]) for t in turns if len(t["text"].strip()) < 20]
    # errors
    errs = collections.Counter()
    for ts, lvl, lg, m in ev:
        if lvl in ("ERROR", "CRITICAL") or "Stream connect" in m and "failed" in m or "host cooled" in m or "unreachable (cooldown" in m:
            errs[re.sub(r"\d+", "N", m)[:90]] += 1
    R["errors"] = errs
    # llm-io
    L = {"calls": 0, "failed": 0, "by_class": collections.Counter(), "dur": collections.defaultdict(list), "cost": 0.0, "tok_in": 0, "tok_out": 0}
    for r in llm_rows:
        ts = dt.datetime.fromtimestamp(r.get("ts", 0) / 1000, dt.timezone.utc).replace(tzinfo=None)
        if ts < since or (until and ts > until):
            continue
        L["calls"] += 1
        if r.get("ok") is False:
            L["failed"] += 1
            L["by_class"][str(r.get("failClass"))] += 1
        if r.get("durationMs"):
            L["dur"][r.get("model")].append(r["durationMs"] / 1000)
        u = (r.get("response") or {}).get("usage") if isinstance(r.get("response"), dict) else None
        if isinstance(u, dict):
            L["cost"] += u.get("cost") or 0
            L["tok_in"] += u.get("input_tokens") or 0
            L["tok_out"] += u.get("output_tokens") or 0
    R["llm"] = L
    # cards: the player's time on a decision card = their reply/submit gap after the previous narration. Needs the "decision submitted" log line (P5 hook).
    cards = []
    for ts, lvl, lg, m in ev:
        mm = re.search(r"decision submitted kind=(\S+)", m)
        if mm:
            prev = [t for t in turns if t["end"] <= ts]
            gap = (ts - prev[-1]["end"]).total_seconds() if prev else None
            cards.append((mm.group(1), gap))
    R["cards"] = cards
    R["snippets"] = snippets
    R["per_turn"] = (lambda n: (R["strip_total"] / n, R["cut_total"] / n))(max(1, len(turns)))
    return R


def find_save(d):
    """The newest engine save under a run dir (engine-save.json from --ssh, or engine-data/saves/<user>/vNNN.json from a rehearsal)."""
    direct = os.path.join(d, "engine-save.json")
    if os.path.exists(direct):
        return direct
    best = None
    for root, _, files in os.walk(os.path.join(d, "engine-data", "saves")):
        for f in files:
            m = re.fullmatch(r"v(\d+)\.json", f)
            if m and (best is None or int(m.group(1)) > best[0]):
                best = (int(m.group(1)), os.path.join(root, f))
    return best[1] if best else None


def clock_metrics(events, turns, save_path):
    """Per-message clock pacing (clock-per-message, 2026-11-05). Each player message should bill ONE 5-minute step (48 per 4-hour morning block)."""
    C = {"turns": len(turns)}
    notes = [e for e in events if "noteMessage" in e[3] and "skipped" not in e[3]]
    C["note_lines"] = len(notes)
    C["note_accepted"] = sum(1 for e in notes if re.search(r"accepted=(True|true)", e[3]))
    C["note_duplicate"] = sum(1 for e in notes if re.search(r"accepted=(False|false)", e[3]))
    C["note_failed"] = sum(1 for e in events if "noteMessage skipped" in e[3])
    C["stale409"] = sum(1 for e in events if "reconciled a stale-beat 409" in e[3])
    C["hangout_skipped"] = sum(1 for e in events if "hang-out skipped" in e[3])
    C["interrupts"] = sum(1 for e in events if re.search(r"interrupt", e[3], re.I) and e[2] != "raw")
    C["save"] = None
    if save_path:
        try:
            sv = json.load(open(save_path))
            live = sv.get("live") or {}
            hl = live.get("hangOutLog") or []
            C["save"] = {"hour": live.get("nightDepth"), "tod": live.get("timeOfDay"), "beatSeq": sv.get("beatSeq"), "week": sv.get("week"), "phase": sv.get("phase"),
                         "hangouts": len(hl), "hangout_minutes": sum(h.get("minutes", 0) for h in hl),
                         "stops": collections.Counter(h.get("stopReason") for h in hl), "hangout_count": live.get("hangOutCount")}
        except Exception as ex:
            C["save_error"] = str(ex)[:80]
    return C


def fmt_clock(C):
    out = ["\n## In-game clock pacing"]
    A = out.append
    n = C["turns"]
    A("Each player message should move the in-game clock exactly 5 minutes (about 48 messages per 4-hour block, 3 messages is roughly 15 minutes). Plain chat counts the same as a message that makes tool calls.")
    if C["note_lines"] or C["note_failed"]:
        A(f"- Clock announcements (noteMessage): **{C['note_accepted']} accepted** for {n} player messages, {C['note_duplicate']} repeats ignored, {C['note_failed']} failed to send." + (" (**Mismatch**: accepted should equal the player messages, apart from retries.)" if n and abs(C['note_accepted'] - n) > max(2, 0.05 * n) else ""))
    else:
        A("- Clock announcements (noteMessage): **not measurable** - this build writes no log line per announcement. Player messages seen: %d." % n)
    A(f"- Stale-beat 409s that the front-end had to reconcile: **{C['stale409']}** (a few are normal under two windows; one per message would mean the clock announcement is racing the game state).")
    A(f"- Hang-out requests that were skipped/failed: {C['hangout_skipped']}. Lines mentioning an interruption: {C['interrupts']}.")
    sv = C.get("save")
    if sv:
        A(f"- Engine state at the end (latest save): week {sv['week']}, phase {sv['phase']}, clock hour **{sv['hour'] if sv['hour'] is None else round(sv['hour'], 2)}** ({sv['tod']}), commit #{sv['beatSeq']}.")
        if sv["hangouts"]:
            stops = ", ".join(f"{k} x{v}" for k, v in sv["stops"].most_common())
            A(f"- Hang-outs recorded by the engine: **{sv['hangouts']}** totalling {sv['hangout_minutes']} in-game minutes; why each stopped: {stops}. (Stop reasons: event-due, pulled, npc-approach, observed, bedtime.)")
        else:
            A("- Hang-outs recorded by the engine: none.")
        h = sv.get("hour")
        if isinstance(h, (int, float)) and sv.get("week") == 1 and 8 <= h < 24 and not str(sv.get("phase", "")).startswith("eviction"):
            implied = ((h - 8) * 60 - (sv["hangout_minutes"] or 0)) / 5
            A(f"- Day-1 cross-check: the clock is {(h - 8) * 60:.0f} minutes past 8:00; minus {sv['hangout_minutes']} minutes of hang-out leaves about **{implied:.0f} billed messages** at 5 minutes each, against {n} player messages in the window (the premiere and casting messages cost no clock time). The billed number must not exceed the player-message count; if it does, a message was billed twice. About 48 billed messages should reach noon.")
        else:
            A("- Day-1 cross-check: not applicable (the game is past Day 1 or the clock hour is not on the first day).")
    else:
        A("- Engine state: **not measurable** - no engine save was found in the pulled data.")
    return out


def fmt(R, window, sources, casting):
    n = R["turns"]
    L = R["llm"]
    pct = lambda x: "n/a" if x is None else f"{100 * x:.0f}%"
    out = []
    A = out.append
    A(f"# Playtest session report\n\nWindow (UTC): {window}. Data: {', '.join(f'{k} ({v} bytes)' for k, v in sources.items()) or 'none found'}.\n")
    A("## Headlines")
    if not n:
        A("- No game messages found in this window (casting messages excluded: %d). Check the window and the box." % casting)
    else:
        A(f"- **{n} game messages** answered (plus {casting} casting messages). **Social share: {pct(R['social_share'])}** ({R['social_turns']} social, {R['event_turns']} messages where the engine committed an event).")
        A(f"- Narration guards: **{R['strip_turns']} of {n} messages had a wrong claim stripped** ({R['strip_total']} sentences) and **{R['cut_turns']} had a whole scene cut** ({R['cut_total']} cuts, the same scene can be cut more than once); **{R['holes']} messages show the 'live feeds cut away' hole** the player sees.")
        lt = R["lat"]
        A(f"- Speed: median **{lt['median']:.1f}s**, 90th percentile {lt['p90']:.1f}s, slowest {lt['max']:.1f}s per message.")
        A(f"- Problems the player could feel: **{R['interludes']} 'technical interlude' replies, {len(R['empty_turns'])} near-empty replies, {L['failed']} failed model calls, {sum(R['errors'].values())} connection/error log lines.**")
        A(f"- Pacing safety: {R['prod_holds']} times an event was held until its scheduled hour, {R['hold_cap']} times the safety cap released a stuck clock, {R['anti_stale']} anti-stale holds, {R['desync']} narration/engine desync detections.")
    A("\n## Social vs event messages")
    A(f"A message counts as an *event* message when the engine committed something during it (a competition, ceremony, vote, decision) and *social* otherwise. Social: **{R['social_turns']}**, event: **{R['event_turns']}**, share **{pct(R['social_share'])}** (target: the majority is social).")
    A("\n## Narration vs engine truth (what the guards caught)")
    A("| Class | Count | What it means |\n|---|---|---|")
    for k, v in R["strips"].most_common():
        A(f"| stripped: {k} | {v} | a sentence was removed before the player saw it (the engine had not committed what it claimed) |")
    for k, v in R["cuts"].most_common():
        A(f"| scene cut: {k} | {v} | the narrator played a result ahead of the engine; the whole scene was cut and re-grounded |")
    if not R["strips"] and not R["cuts"]:
        A("| none | 0 | no phantom claims were caught |")
    # A81 - the rest of the guard family, with the guard-DOWN lines first (a guard that is off is the most important thing to see)
    A("\n### Other guard activity")
    gl = R["guard_lines"]
    if not gl:
        A("None of the other narration guards logged anything in this window.")
    else:
        A("| Severity | Guard line | Count |\n|---|---|---|")
        for (sev, label), v in sorted(gl.items(), key=lambda kv: ({"down": 0, "fired": 1, "skipped": 2}[kv[0][0]], -kv[1])):
            A(f"| {'**GUARD DOWN**' if sev == 'down' else sev} | {label} | {v} |")
    if R["guard_classes"]:
        A("\nGuard classes seen on the pre-emission / desync lines (A77 tags): " + ", ".join(f"{k} x{v}" for k, v in R["guard_classes"].most_common()) + ".")
    if R["snippets"]:
        A("\nExamples (first 12, oldest first):")
        for ts, what, sn in sorted(R["snippets"])[:12]:
            A(f"- {ts:%H:%M:%S} {what}: _{sn}_")
    A("\n## Latency")
    lt = R["lat"]
    A(f"Per-message response time: median {lt['median']}, p90 {lt['p90']}, max {lt['max']} seconds over {lt['n']} messages." if lt["n"] else "No latency data.")
    for ts, s, u in R["slow"]:
        A(f"- slow: {ts:%H:%M:%S} took {s}s after _{u}_")
    for model, ds in L["dur"].items():
        ds.sort()
        A(f"- model `{model}`: {len(ds)} streamed calls, median {statistics.median(ds):.1f}s, p90 {ds[int(0.9 * (len(ds) - 1))]:.1f}s")
    A("\n## Failed calls, errors, stalls")
    A(f"- Model calls: {L['calls']} recorded, **{L['failed']} failed**" + (f" ({dict(L['by_class'])})" if L["failed"] else "") + (f"; est. cost ${L['cost']:.2f}, {L['tok_in']} in / {L['tok_out']} out tokens." if L["calls"] else " (no llm-io file found - not measurable)."))
    for k, v in R["errors"].most_common(8):
        A(f"- {v}x {k}")
    A(f"- Stall signals: {R['anti_stale']} anti-stale holds, {R['stall_forced']} forced re-voices, {sum(R['softfails'].values())} soft-fails" + (f" ({dict(R['softfails'])})" if R["softfails"] else "") + ".")
    for ts, u in R["empty_turns"][:8]:
        A(f"- near-empty reply at {ts:%H:%M:%S} to _{u}_")
    A("\n## Card timings")
    if R["cards"]:
        gaps = sorted(g for _, g in R["cards"] if g is not None)
        A(f"{len(R['cards'])} decision cards were submitted" + (f"; time from the preceding narration to submit: median {statistics.median(gaps):.0f}s, max {gaps[-1]:.0f}s." if gaps else "."))
        c = collections.Counter(k for k, _ in R["cards"])
        A("By kind: " + ", ".join(f"{k} x{v}" for k, v in c.most_common()))
    else:
        A("Not measurable from this data: no `decision submitted` log lines were found (they are emitted only by builds that include the P5 hook).")
    out.extend(fmt_clock(R["clock"]))
    A("\n## Could not be measured")
    A("- Whether the narration was *good* - only whether it contradicted the engine (guards) or went missing.\n- Sentence-level drops by the per-sentence guard (not logged on their own); only role-claim strips, whole-scene cuts and presence-wall drops are counted.\n- Cards the player never answered.")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ssh"); ap.add_argument("--dir"); ap.add_argument("--app", default=APP)
    ap.add_argument("--since", default="2000-01-01 00:00"); ap.add_argument("--until", default="")
    ap.add_argument("--out", default="-")
    a = ap.parse_args()
    since = dt.datetime.strptime(a.since[:16], "%Y-%m-%d %H:%M")
    until = dt.datetime.strptime(a.until[:16], "%Y-%m-%d %H:%M") if a.until else None
    if a.ssh:
        d = tempfile.mkdtemp(prefix="orwell-session-")
        sources = pull(a.ssh, a.since, a.until, d, a.app)
    elif a.dir:
        d = a.dir
        sources = {f: os.path.getsize(os.path.join(d, f)) for f in ("fe.log", "engine.log", "app.db", "llm-io.jsonl", "engine-save.json") if os.path.exists(os.path.join(d, f))}
    else:
        raise SystemExit("give --ssh user@host or --dir")
    events = parse_fe(os.path.join(d, "fe.log"))
    turns, casting = load_turns(os.path.join(d, "app.db"), since, until)
    llm = []
    p = os.path.join(d, "llm-io.jsonl")
    if os.path.exists(p):
        for line in open(p, errors="replace"):
            try:
                llm.append(json.loads(line))
            except Exception:
                pass
    R = analyze(events, turns, llm, since, until)
    R["clock"] = clock_metrics([e for e in events if e[0] >= since and (not until or e[0] <= until)], turns, find_save(d))
    rep = fmt(R, f"{a.since} .. {a.until or 'now'}", sources, casting)
    if a.out == "-":
        print(rep)
    else:
        open(a.out, "w").write(rep)
        print("wrote", a.out)


if __name__ == "__main__":
    main()
