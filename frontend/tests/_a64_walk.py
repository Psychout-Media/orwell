"""ORW-414: the shared week-1 walk for the A64 real-loop tests (test_a64_week1_clock_real_loop.py = the player on the block, test_a64b_week1_voter_readiness_spam.py = the voter).
Split out of the one 170 s file so each walk is its own file under the 120 s budget and the two can run on different workers. Helpers only; no test lives here. Docstring of the original (the invariants):

A64 - week 1 played through the REAL loop under the in-game clock (0118): real engine (dist/main.js) + real FE chat route + a scripted fake narrator that calls NO tools. Extends A40 (HOH only)
across the veto competition, the veto ceremony and the eviction. These pin TODAY's behavior (invariants, not magic numbers):

 1. Each undue message costs exactly 5 minutes toward the next milestone (`daySchedule.minutesUntil`).
 2. The board never moves to a LATER phase early: a phase change is on the message that brings the previous milestone due (<= 5 minutes away before it) or after it was due. A non-card beat (an NPC HOH's
    nominations, the veto competition without the player) RUNS on that due message itself.
 3. A decision card (comp-round, eviction-vote, any card the player answers) is staged only on a message where the schedule is due - never before the due hour.
 4. Readiness spam at a due card ("I'm ready", "start it") does not progress the board, duplicate the card or double-fire it; the player's decision is what moves it.
 5. Eviction night is reached only after its own due time (evening) and the vote card is the one the engine stages there.
 6. From what the ENGINE reports (the public ceremony state: the HOH, the nominees, the veto holder, who has left the house), every week-1 result - the HOH, the nominations, the veto, the veto
    ceremony, the eviction - lands only on a step where its milestone was due, or on the message that brought it due. Never early. A player ON THE BLOCK (or the HOH) gets no eviction-vote card at
    all: their walk ends when the engine reports the evictee, and that eviction must have evicted exactly one final nominee inside the due eviction.

The week-1 PATH follows the season. The player votes in most seasons but is often on the block (5 of 14 seeds in one scan of this loop) or the HOH, and then no vote card exists for them, so an
unseeded walk that waited for one ran on into week 2 and failed at random. Each test therefore walks an ordered list of explicit seeds picked for its path (the /new-game door's `seed`) and
uses the first whose season takes it: one walk per path, both under the same clock checks.

Mismatch report (observed, not asserted): at the veto-ceremony due moment `timeOfDay` already reads "evening" while the milestone's own `phase` reads "afternoon". Roles only. Needs the built engine bundle.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from test_p0h_day1_clock_e2e import _engine, _schedule, _send, _session, _start_day
from test_a40_due_ceremony_real_loop import _fresh
from _a64_decisions import answer_for

# Pinned season seeds, picked by walking THIS real loop with THIS driver in this file's order. A seed fixes a season's rolls, but a restart on the same stack also carries what ran before it:
# the engine keeps earlier seasons' houseguest names out of the new cast (NAME-1, which shifts the seeded draws) and the FE's per-user loop state (e.g. the silent-advance streak) outlives a
# /new-game. So a rerun, a -k selection or an engine change can still move a seed onto another path. Each test walks its list in order and takes the first seed whose season keeps to its path,
# dropping a seed as soon as the engine reports that path ruled out (a dropped walk is still held to the clock). Only when NO seed takes the path does the test fail - re-pick the list then.
def _scan(hints, upto=40):
    """ORW-880 on the Python side (pick the seed, don't pin it): the hint seeds first, in order, then 1..upto, each once. A fixed order, so the pick is still deterministic; a
    gameplay change moves the pick instead of breaking the test, and the walk names the seed it took when the first hint no longer qualifies (update the hint then)."""
    return tuple(dict.fromkeys([*hints, *range(1, upto + 1)]))


NOMINEE_SEEDS = _scan((30, 5, 27, 32))   # ORW-702: on the rebalanced house (less early scheming) only seed 30 of 1-30 takes this path when walked FIRST on a fresh stack (a season depends on what ran before it in the stack: ORW-921), so it leads. an NPC HOH nominates the player: no eviction-vote card is theirs. Re-picked for ORW-711 (the new floor plan shifts the seeded week-1 path: 16 and 31 no longer reach the block; a 40-seed scan found 5, 27, 32 and 36 that do). Earlier, ORW-705 re-picked (16, 31, 32): the one-step premiere pacing shifts the seeded week-1 path (seeds 5 and 17 no longer reach the block; seeds 1-15 and 17-30 do not either). Earlier re-pick: ORW-656.
VOTER_SEEDS = _scan((30012, 2, 4))      # an NPC HOH, the player is not on the block: week 1 ends on the player's own eviction-vote card


def _decide(stack, p):
    """Answer ANY pending kind the engine emits (the player may be evicted in week 1, which opens an exit-interview / goodbye-message / spectator-choice). A kind with no
    scripted answer raises loudly (see tests/_a64_decisions.py + test_a64_decisions_cover_every_pending_kind.py)."""
    if p.get("kind") == "ceremony-step":  # ORW-281: a staged ceremony step is a WATCH step - answered by advanceGame, refused by submitDecision
        return _engine(stack, "advanceGame", {})
    return _engine(stack, "submitDecision", answer_for(p))


def _roles(st):
    """The public week facts the checks read (Vault-free ceremony state): the player, the HOH, the FINAL nominees (after any veto replacement), the veto holder, who has left the house."""
    me = st.get("player") or {}
    cer = st.get("ceremony") or {}
    out = {h.get("id") for h in st.get("house") or [] if h.get("status") not in (None, "active")}
    if me.get("status") not in (None, "active"):
        out.add(me.get("id"))
    return {"me": me.get("id"), "hoh": (cer.get("hoh") or {}).get("id"), "nominees": [x.get("id") for x in cer.get("nominees") or []],
            "veto": ((cer.get("veto") or {}).get("holder") or {}).get("id"), "out": sorted(out),
            "cer": (((st.get("pending") or {}).get("ceremony")) or {}).get("kind"),
            "cerstep": (((st.get("pending") or {}).get("ceremony")) or {}).get("step")}


def _ruled_out(r, want):
    """From the engine's report: can this season no longer take the wanted path? A HOH player neither votes nor sits on the block. Once nominations are up, "vote" needs the player off the
    block and "block" needs them on it (a later veto save or replacement can still move them; the walk then stops there)."""
    if r["me"] == r["hoh"]:
        return True
    on_block = r["me"] in r["nominees"]
    return on_block if want == "vote" else (bool(r["nominees"]) and not on_block)


def _walk_week_one(stack, sid, want=None, stop_at_eviction_ceremony=False):
    """Drive week 1 to its eviction; returns the list of (message_index, sched, phase, pending_kind, roles) observations taken AFTER every message or decision. Ends on the player's own
    eviction-vote card when they vote, or - when they are on the block or the HOH, so no vote card is theirs - on the first observation where the engine reports the evictee. Every other card
    on the way (a comp round, the nominations, a veto decision, a tie-break...) is answered. `want` ("vote" / "block"): also stop as soon as the engine reports that path ruled out."""
    obs = []
    n = 0
    ff = 0
    seg = 0  # ORW-116: a new segment starts after every bedtime or fast-forwarded stretch; the exact-5-minute invariant is checked within a segment only
    for _ in range(600):
        s, st = _schedule(stack)
        pend = (st.get("pending") or {}).get("kind")
        roles = _roles(st)
        roles["seg"] = seg
        obs.append((n, s, st.get("phase"), pend, roles))
        if pend == "eviction-vote" or roles["out"]:
            return obs
        if stop_at_eviction_ceremony and pend == "ceremony-step" and roles.get("cer") == "eviction":
            return obs  # ORW-816: the caller steps the eviction ceremony itself (a player on the block, ballot by ballot)
        if want and _ruled_out(roles, want):
            return obs
        if pend:
            _decide(stack, st["pending"])
            continue
        if st.get("timeOfDay") in ("night", "late-night"):
            _engine(stack, "turnIn")  # ORW-116: the night is the player's - a player who goes to bed is what rolls the day (nothing else does)
            _send(stack, sid, f"Good morning {n}.", f"a64-wake-{n}")  # the first message after a turn-in is the wake itself
            seg += 1
            continue
        mu = s.get("minutesUntil") if isinstance(s, dict) else None
        if isinstance(mu, int) and mu > 60 and not s.get("due"):
            # a day is 16 awake hours (~190 messages) and nothing but the clock moves it: let the idle stretch pass as the very same player-message ticks the FE announces (engine noteMessage, 5 min each)
            # and re-enter the real chat route for the last hour before the milestone.
            # ORW-281: ids come from a running counter, NOT `n` - `n` only moves on a chat line, so two idle stretches in a row (the veto draw, then the 3 h wait for the competition) reused the same ids,
            # the engine dedupes a repeated messageId, and the second stretch advanced NOTHING (the walk then spun on "minutesUntil=180" until its budget ran out).
            # ORW-414: the engine serialises these (each bills one step; ids are unique and the count is fixed), so the HTTP round trips run on 8 threads instead of one after another
            ids = [f"a64-ff-{ff + k + 1}" for k in range(mu // 5 - 12)]
            ff += len(ids)
            with ThreadPoolExecutor(max_workers=8) as ex:
                list(ex.map(lambda mid: _engine(stack, "noteMessage", {"messageId": mid}), ids))
            seg += 1
            continue
        _send(stack, sid, f"Plain chat line {n}.", f"a64-{n}")
        n += 1
    raise AssertionError(f"week 1 never reached its eviction (no vote card, no evictee): last={obs[-1]}")


def _path(obs):
    """Which week-1 path a walk took, read from what the engine reported at its end: "votes" (their own vote card), "on-the-block" / "evicted" (a nominee), "hoh", "not-on-the-block" (a walk
    dropped once the nominations left the player off the block), or "voter-without-card" - a BUG: the eviction ran and a player who could vote never got their card."""
    _, _, _, pend, r = obs[-1]
    if pend == "eviction-vote":
        return "votes"
    if r["me"] == r["hoh"]:
        return "hoh"
    if r["me"] in r["nominees"]:
        return "evicted" if r["me"] in r["out"] else "on-the-block"
    return "voter-without-card" if r["out"] else "not-on-the-block"


# (6) each week-1 milestone and the engine-reported fact that says its result has LANDED
_LANDED = (
    ("hoh-competition", lambda s, r: r["hoh"] is not None),
    ("nominations", lambda s, r: bool(r["nominees"])),
    ("veto-competition", lambda s, r: r["veto"] is not None),
    ("veto-ceremony", lambda s, r: s["next"] == "eviction"),
    ("eviction", lambda s, r: bool(r["out"])),
)


def _assert_steps_honour_the_clock(obs):
    """(1)-(3) step by step, and (6) for every result the walk saw land. Holds on any walk, a dropped seed's partial one included."""
    prev = None
    for (n, s, phase, pend, roles) in obs:
        if prev is not None:
            pn, ps, pphase, ppend, proles = prev
            if phase != pphase:
                # (2) a phase change happens only on the message that BRINGS the previous milestone due (<= one 5-minute message away) or after it was due - never earlier
                assert ps["due"] is True or ppend or ps["minutesUntil"] <= 5, f"phase {pphase} -> {phase} at message {n} but the previous milestone was not due: {ps}"
            elif ps["next"] == s["next"] and not ps["due"] and not s["due"] and ppend is None and pend is None and proles.get("seg") == roles.get("seg") and ps["phase"] == s["phase"]:  # (ORW-116: not across a bedtime/fast-forward, nor the veto draw -> veto comp re-target)
                # (1) an undue message in the same milestone costs exactly 5 minutes
                assert ps["minutesUntil"] - s["minutesUntil"] in (5, 0), f"message {n}: {ps} -> {s}"
        if pend:
            # ORW-281: a staged ceremony's watch step belongs to a ceremony that opened when ITS milestone was due; by the time later steps are on screen the schedule's `next` has already moved on to
            # the following milestone (so `due` describes THAT one). Anchored to the card's OWN ceremony: the OPENING step (step 1) must land with its milestone due or be the engine's reported event of
            # the day (`todaysEvent`); a LATER step (step > 1) is allowed only as the continuation of the SAME ceremony kind the previous observation already showed at the step before (or the same step
            # again). An early step of a different ceremony, or a step with no opening, still fails. Every non-ceremony card still needs its milestone due.
            ccer = roles.get("cer")
            cstep = roles.get("cerstep") or 0
            opening_ok = pend == "ceremony-step" and ccer is not None and s.get("todaysEvent") == ccer
            continuing = (pend == "ceremony-step" and ccer is not None and cstep > 1 and prev is not None
                          and prev[4].get("cer") == ccer and (prev[4].get("cerstep") or 0) in (cstep - 1, cstep))
            assert s["due"] is True or opening_ok or continuing, f"(3) a {pend} card ({ccer} step {cstep}) was staged at message {n} before the milestone was due: {s}"
        prev = (n, s, phase, pend, roles)
    # (6) from what the ENGINE reports: each result lands on a step where its milestone was due, or on the message that brought it due - never early
    for milestone, landed in _LANDED:
        k = next((i for i, (_, s, _, _, r) in enumerate(obs) if landed(s, r)), None)
        if k is None:
            continue  # not reached by this walk
        assert k > 0, f"(6) the {milestone} result was already on the board when the day started (not a fresh season?): {obs[0]}"
        ps = obs[k - 1][1]
        assert ps["next"] == milestone and (ps["due"] is True or ps["minutesUntil"] <= 5), \
            f"(6) the {milestone} result landed at message {obs[k][0]} before it was due: {ps} -> {obs[k][1]} {obs[k][4]}"


def _assert_week_one_honours_the_clock(obs):
    """A whole week-1 walk, on whichever path its seed took: the step checks above, (5) every phase visited in order with the eviction last, and (6) every result up to the eviction
    reported (only the eviction may be missing: a voter's walk stops on their vote card, before anyone leaves)."""
    _assert_steps_honour_the_clock(obs)
    saw_phases = []
    for (_, _, phase, _, _) in obs:
        if phase not in saw_phases:
            saw_phases.append(phase)
    # (5) every week-1 phase was visited in order and the eviction came last
    assert saw_phases[:1] in (["premiere"], ["hoh-competition"])  # ORW-116: the premiere is exited when the first HOH comes due on Day 2
    for want in ("nominations", "veto-competition", "veto-ceremony", "eviction"):
        assert want in saw_phases, f"week 1 skipped {want}: {saw_phases}"
    assert saw_phases.index("nominations") < saw_phases.index("veto-competition") < saw_phases.index("veto-ceremony") < saw_phases.index("eviction")
    for milestone, landed in _LANDED:
        if milestone != "eviction":
            assert any(landed(s, r) for (_, s, _, _, r) in obs), f"(6) week 1 reached its eviction but the engine never reported the {milestone} result: last={obs[-1]}"


def _assert_the_eviction_landed(obs):
    """(5) a player who votes ends week 1 on THEIR due eviction-vote card. (6) a player who cannot vote (on the block, or the HOH) gets no vote card: the eviction ran without them,
    evicted exactly one of the final nominees, and the evictee is reported inside the due eviction."""
    n, s, phase, pend, r = obs[-1]
    if pend == "eviction-vote":
        assert s["due"] is True and s["next"] == "eviction", f"(5) the eviction-vote card is not the due one: {s}"
        return
    assert r["me"] == r["hoh"] or r["me"] in r["nominees"], f"(6) the eviction ran with no vote card for the player, yet the player was neither the HOH nor on the block: {r}"
    assert len(r["out"]) == 1 and r["out"][0] in r["nominees"], f"(6) week 1's eviction must evict exactly one of the final nominees: {r}"
    assert phase == "eviction" and s["next"] == "eviction" and s["due"] is True, f"(6) the evictee was reported outside a due eviction: phase={phase} {s}"


_PATHS = {"vote": ("votes",), "block": ("on-the-block", "evicted")}


def _walk_seeded_week(stack, seeds, want, label, stop_at_eviction_ceremony=False):
    """Walk week 1 on the first of `seeds` whose season takes the wanted path ("vote": the player keeps their eviction vote; "block": an NPC HOH puts the player on the block); returns
    (sid, obs). A seed is dropped only for a legitimate other path, and its partial walk must still honour the clock. A voter whose eviction ran without their card is a BUG, so it fails
    here as one - never as "re-pick the seeds"."""
    for seed in seeds:
        _fresh(stack, seed)
        sid = _session(stack, f"{label}-{seed}")
        _start_day(stack, sid)
        obs = _walk_week_one(stack, sid, want=want, stop_at_eviction_ceremony=stop_at_eviction_ceremony)
        path = _path(obs)
        if path in _PATHS[want]:
            if seed != seeds[0]:
                print(f"[a64-walk] the hint seed {seeds[0]} no longer takes the {want!r} path; seed {seed} does (update the hint)")
            return sid, obs
        assert path != "voter-without-card", \
            f"(6) the eviction ran with no vote card for the player, yet the player was neither the HOH nor on the block (seed {seed}): {obs[-1]}"
        _assert_steps_honour_the_clock(obs)
    raise AssertionError(f"none of the seeds {seeds[:3]}... (then 1..{max(s for s in seeds if s < 10000)}) takes the {want!r} path any more (the last walked {path!r}) - the scan ran out: look at why")
