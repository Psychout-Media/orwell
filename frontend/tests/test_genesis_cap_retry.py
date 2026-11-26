"""2026-07-13 prod fix — the cast-genesis output cap, retry-on-length, salvage, latch & kick seams.

Live bundle (post-#1550): cast genesis died with ``no-usable-proposal`` because the full-cast SKETCH
call — ONE completion carrying the whole 15-NPC skeleton JSON — ran at the ``background-authoring``
class cap (3000, sized for ONE NPC's profile) and ended ``finish_reason=length`` at out=3000/cap=3000:
truncated JSON → unparseable → committed 0 → the strict pre-finalize gate refused casting. Pins:

  (a) the sketch call class resolves an output cap ≥ ``GENESIS_SKETCH_MIN_OUTPUT_TOKENS`` (8000),
      while the per-NPC deep-authoring cap stays 6000 (ALSO a golden-fixture pin:
      the committed fixture holds the per-NPC calls at max_tokens=3000 (ORW-1025 moved the class cap to 6000) — max_tokens is part of the
      replay request key, so the class cap must not move);
  (b) a ``finish_reason=length`` completion triggers EXACTLY ONE doubled-cap retry, bounded by
      ``LENGTH_RETRY_MAX_TOKENS`` (16000) — never a second retry, never past the ceiling;
  (c) a FAILED genesis followed by a successful retry COMMITS — no permanent given-up latch (the
      strict-failed latch clears at the head of every fresh run; the idempotency latch engages only
      on commit);
  (d) the salvage guard: a truncated sketch reply still yields its COMPLETE leading npc entries
      (the engine envelope natively supports a partial commit — it floors the unproposed slots);
  (e) the kick seams stay non-blocking/single-flight: two concurrent ``run_genesis`` kicks for the
      same (user, seed) share ONE in-flight run (no double sketch grind), and a slow background
      authoring task never blocks a concurrent coroutine (the chat turn) on the same loop.

All LLM calls are mocked. Roles only — no names ingested as data.
"""
import asyncio
import json

import src.endpoint_resolver as er
from src import llm_core as lc
from src import orwell_cast_authoring as A
from src import orwell_cast_genesis as G
from src import token_policy as tp


def _run(coro):
    # FE convention: drive on the EXISTING session loop (never asyncio.run, which closes the loop).
    return asyncio.get_event_loop().run_until_complete(coro)


_ROSTER = [{"id": f"npc:{i}"} for i in range(1, 16)]
_VALID_IDS = {n["id"] for n in _ROSTER}

_OR_URL = "https://openrouter.ai/api/v1/chat/completions"


def _valid_proposal_json() -> str:
    """A full, envelope-plausible 15-NPC proposal as the model would emit it (strict JSON object)."""
    npcs = []
    for i, n in enumerate(_ROSTER):
        npcs.append({
            "id": n["id"],
            "name": f"Casey Slot{i:02d}on",
            "identity": f"a distinct houseguest, slot {i}, unmistakably their own person",
            "archetype": ["comp-beast", "floater", "mastermind", "social-butterfly"][i % 4],
            "vocation": "court reporter",
            "hometown": "Tulsa, OK",
            "demeanor": "warm but guarded",
            "biography": "Grew up on a farm. Moved to the city for work. Loves a long-game bluff.",
            "appearance": "tall, close-cropped hair, easy smile",
            "age": 25 + (i % 30),
            "stats": {"physical": 0.3 + (i % 5) * 0.1, "mental": 0.8 - (i % 4) * 0.1,
                      "social": 0.4 + (i % 4) * 0.1},
            "hiddenElements": [
                {"kind": "secret-motive", "detail": f"secretly playing for someone back home, slot {i}"},
                {"kind": "divergent-persona", "detail": f"sweet in public, ruthless in private, slot {i}"},
            ],
        })
    return json.dumps({"npcs": npcs, "ties": []})


def _install_stream_fake(monkeypatch, scripts: list, calls: list) -> None:
    """Replace ``llm_core.stream_llm_with_fallback`` with a scripted fake.

    ``scripts`` is a list of per-call SSE-chunk lists (the last script repeats for any extra call);
    every call appends ``{"max_tokens": ..., "messages": ...}`` to ``calls``. `_resolve_llm_fn`
    binds the symbol at build time (``from src.llm_core import stream_llm_with_fallback``), so the
    patch must land BEFORE the resolver is invoked — which these tests do."""

    async def _fake(candidates, messages, temperature=None, policy=None,
                    max_tokens=0, response_format=None, **kw):
        idx = min(len(calls), len(scripts) - 1)
        calls.append({"max_tokens": max_tokens, "messages": list(messages)})
        for chunk in scripts[idx]:
            yield chunk

    monkeypatch.setattr(lc, "stream_llm_with_fallback", _fake)


def _pin_endpoints(monkeypatch) -> None:
    monkeypatch.setattr(er, "resolve_endpoint",
                        lambda prefix, owner=None: (_OR_URL, "stub-chat-model", {}))
    monkeypatch.setattr(er, "resolve_utility_fallback_candidates", lambda owner=None: [])
    monkeypatch.setattr(er, "_resolve_fallback_candidates", lambda key, owner=None: [])


def _delta(text: str) -> str:
    return "data: " + json.dumps({"delta": text}) + "\n\n"


def _finish(reason: str) -> str:
    return "data: " + json.dumps({"type": "finish", "reason": reason}) + "\n\n"


# ── (a) the sketch call class resolves a cap ≥ the genesis floor; per-NPC stays 3000 ────────────────────

def test_genesis_sketch_call_resolves_cap_at_least_the_floor(monkeypatch):
    _pin_endpoints(monkeypatch)
    calls: list = []
    _install_stream_fake(monkeypatch, [[_delta("{}"), _finish("stop")]], calls)

    fn = _run(G._resolve_llm_fn("u-cap"))  # the REAL genesis resolver → the authoring resolver
    assert fn is not None
    _run(fn([{"role": "user", "content": "sketch the cast"}]))
    assert len(calls) == 1
    assert calls[0]["max_tokens"] >= tp.GENESIS_SKETCH_MIN_OUTPUT_TOKENS >= 8000, calls[0]


def test_per_npc_authoring_cap_is_byte_identical_at_6000(monkeypatch):
    """The golden-fixture pin: the committed fixture replays the per-NPC deep-authoring calls at
    max_tokens=3000 and max_tokens is part of the replay request key — the DEFAULT authoring cap
    must not move. Only the genesis sketch (not in the fixture) carries the larger floor."""
    _pin_endpoints(monkeypatch)
    calls: list = []
    _install_stream_fake(monkeypatch, [[_delta("{}"), _finish("stop")]], calls)

    fn = _run(A._resolve_llm_fn("u-npc"))  # the default (per-NPC / zeitgeist / identity) build
    assert fn is not None
    _run(fn([{"role": "user", "content": "author this houseguest"}]))
    assert len(calls) == 1
    assert calls[0]["max_tokens"] == 6000, calls[0]


def test_admin_override_larger_than_the_floor_wins(monkeypatch):
    """ADR 0010 #1: an in-band admin ``max_tokens_budget`` override LARGER than the genesis floor
    still wins (the floor is max-not-replace)."""
    _pin_endpoints(monkeypatch)
    import src.settings as st
    real_get = st.get_setting

    def _get(key, default=None, *a, **k):
        if key == "max_tokens_budget":
            return {"background-authoring": 12000}
        return real_get(key, default, *a, **k)

    monkeypatch.setattr(st, "get_setting", _get)
    calls: list = []
    _install_stream_fake(monkeypatch, [[_delta("{}"), _finish("stop")]], calls)

    fn = _run(G._resolve_llm_fn("u-admin"))
    assert fn is not None
    _run(fn([{"role": "user", "content": "sketch the cast"}]))
    assert calls[0]["max_tokens"] == 12000, calls[0]


# ── (b) finish_reason=length ⇒ EXACTLY ONE doubled-cap retry, bounded ───────────────────────────────────

def test_finish_length_triggers_exactly_one_doubled_cap_retry(monkeypatch):
    _pin_endpoints(monkeypatch)
    calls: list = []
    _install_stream_fake(monkeypatch, [
        [_delta('{"npcs": [{"id": "npc:1", "na'), _finish("length")],   # chopped mid-JSON
        [_delta(_valid_proposal_json()), _finish("stop")],              # the doubled-cap retry
    ], calls)

    fn = _run(A._resolve_llm_fn("u-len"))
    text = _run(fn([{"role": "user", "content": "author"}]))
    assert len(calls) == 2, "finish_reason=length must trigger exactly one retry"
    assert calls[0]["max_tokens"] == 6000
    assert calls[1]["max_tokens"] == 12000  # doubled, under the 16000 ceiling
    assert text == _valid_proposal_json()  # the complete retry body wins


def test_finish_length_never_retries_twice(monkeypatch):
    _pin_endpoints(monkeypatch)
    calls: list = []
    _install_stream_fake(monkeypatch, [
        [_delta("{chopped"), _finish("length")],
        [_delta("{chopped again"), _finish("length")],  # the retry ALSO truncates — no third call
    ], calls)

    fn = _run(A._resolve_llm_fn("u-len2"))
    text = _run(fn([{"role": "user", "content": "author"}]))
    assert len(calls) == 2, "never loop more than once on finish_reason=length"
    assert text == "{chopped again"


def test_genesis_length_retry_is_bounded_by_the_ceiling(monkeypatch):
    """The genesis floor (8000) doubles to exactly the 16000 ceiling — and a cap already at the
    ceiling never retries at all."""
    _pin_endpoints(monkeypatch)
    calls: list = []
    _install_stream_fake(monkeypatch, [
        [_delta("{chopped"), _finish("length")],
        [_delta(_valid_proposal_json()), _finish("stop")],
    ], calls)
    fn = _run(G._resolve_llm_fn("u-ceil"))
    _run(fn([{"role": "user", "content": "sketch"}]))
    assert calls[0]["max_tokens"] == tp.GENESIS_SKETCH_MIN_OUTPUT_TOKENS
    assert calls[1]["max_tokens"] == min(tp.GENESIS_SKETCH_MIN_OUTPUT_TOKENS * 2,
                                         tp.LENGTH_RETRY_MAX_TOKENS)
    assert calls[1]["max_tokens"] <= tp.LENGTH_RETRY_MAX_TOKENS

    # cap already at/above the ceiling ⇒ no retry.
    import src.settings as st
    real_get = st.get_setting

    def _get(key, default=None, *a, **k):
        if key == "max_tokens_budget":
            return {"background-authoring": tp.LENGTH_RETRY_MAX_TOKENS}
        return real_get(key, default, *a, **k)

    monkeypatch.setattr(st, "get_setting", _get)
    calls2: list = []
    _install_stream_fake(monkeypatch, [[_delta("{chopped"), _finish("length")]], calls2)
    fn2 = _run(A._resolve_llm_fn("u-ceil2"))
    _run(fn2([{"role": "user", "content": "author"}]))
    assert len(calls2) == 1, "a cap at the ceiling must not retry"


def test_length_retry_records_finish_reason_in_the_ledger(monkeypatch):
    """ADR 0010 #3: each attempt logs its own ledger entry with the applied cap AND finishReason —
    the live diagnosis rode exactly this field (finish=length at out=3000 cap=3000)."""
    _pin_endpoints(monkeypatch)
    from src import orwell_token_ledger as tl
    recorded: list = []

    def _capture(user, **kwargs):
        recorded.append(dict(kwargs, user=user))
        return {}

    monkeypatch.setattr(tl, "record_turn", _capture)
    usage = "data: " + json.dumps({"type": "usage", "data": {
        "input_tokens": 10, "output_tokens": 3000}}) + "\n\n"
    calls: list = []
    _install_stream_fake(monkeypatch, [
        [_delta("{chopped"), usage, _finish("length")],
        [_delta(_valid_proposal_json()), usage, _finish("stop")],
    ], calls)
    fn = _run(A._resolve_llm_fn("u-ledger"))
    _run(fn([{"role": "user", "content": "author"}]))
    assert len(recorded) == 2
    assert recorded[0]["applied_max_tokens"] == 6000 and recorded[0]["finish_reason"] == "length"
    assert recorded[1]["applied_max_tokens"] == 12000 and recorded[1]["finish_reason"] == "stop"


# ── (d) the salvage guard — complete leading entries of a truncated proposal ────────────────────────────

def test_salvage_recovers_complete_leading_entries_from_a_truncated_reply():
    full = _valid_proposal_json()
    # Chop the reply mid-way through the 8th npc object (a finish_reason=length shape).
    cut = full.find('"id": "npc:8"') + 20
    truncated = full[:cut]
    proposal = G.parse_genesis_proposal(truncated, _VALID_IDS)
    npcs = proposal.get("npcs") or []
    assert 1 <= len(npcs) == 7, f"expected the 7 complete leading entries, got {len(npcs)}"
    assert [n["id"] for n in npcs] == [f"npc:{i}" for i in range(1, 8)]
    # …and each salvaged entry survived the normal per-entry filtering (shape intact).
    assert all(n.get("name") and n.get("stats") for n in npcs)


def test_salvage_returns_nothing_on_garbage():
    assert G.parse_genesis_proposal("no json here at all", _VALID_IDS) == {}
    assert G._salvage_truncated_npcs("") is None
    assert G._salvage_truncated_npcs('{"ties": [') is None


def test_salvaged_partial_commits_instead_of_no_usable_proposal(monkeypatch):
    """End-to-end: a truncated-only model still yields a PARTIAL commit (the engine floors the
    rest) — never the live bundle's ``no-usable-proposal`` wipeout."""
    full = _valid_proposal_json()
    truncated = full[:full.find('"id": "npc:8"') + 20]

    async def llm(_messages):
        return truncated

    wrote: dict = {}

    async def write(proposal):
        wrote["npcs"] = len(proposal.get("npcs") or [])
        return {"accepted": True, "committed": wrote["npcs"], "violations": [], "varianceOk": True}

    res = _run(G.seed_cast_genesis(_ROSTER, 7, llm, write))
    assert res["accepted"] is True and res["committed"] == 7
    assert wrote["npcs"] == 7


# ── (c) failed genesis → successful retry commits; no permanent latch ───────────────────────────────────

def test_failed_genesis_then_successful_retry_commits_and_clears_the_latch(monkeypatch):
    from src import enrichment_policy as ep
    G.reset_state("u-latch")
    ep.clear_failures("u-latch")
    monkeypatch.setattr(ep, "is_strict", lambda: True)

    attempt = {"n": 0}

    async def _model(_owner):
        attempt["n"] += 1
        if attempt["n"] == 1:
            async def llm_bad(_messages):
                return "the model rambled; no JSON at all"
            return llm_bad

        async def llm_good(_messages):
            return _valid_proposal_json()
        return llm_good

    async def write(proposal):
        return {"accepted": True, "committed": len(proposal["npcs"]),
                "violations": [], "varianceOk": True}

    monkeypatch.setattr(G, "_resolve_llm_fn", _model)

    # Run 1 — the cap-truncation era: nothing usable ⇒ FAILED, the strict latch engages, nothing
    # is marked committed (so the next kick re-runs — run_genesis stays idempotent per COMMIT).
    r1 = _run(G.run_genesis(_ROSTER, 7, "u-latch", write=write))
    assert r1["accepted"] is False and r1["committed"] == 0
    assert G.strict_failed("u-latch") is True
    assert G.genesis_committed("u-latch", 7) is False

    # Run 2 — the retry (e.g. the finalize belt after the cap fix): commits, and the latch CLEARS —
    # a past failure can never permanently refuse the current interview.
    r2 = _run(G.run_genesis(_ROSTER, 7, "u-latch", write=write))
    assert r2["accepted"] is True and r2["committed"] == 15
    assert G.strict_failed("u-latch") is False
    assert G.genesis_committed("u-latch", 7) is True
    G.reset_state("u-latch")


# ── (e) the kick seams: single-flight genesis; background authoring never blocks the turn ───────────────

def test_concurrent_genesis_kicks_share_one_in_flight_run(monkeypatch):
    """The pre-warm kick and the do_create_character pre-finalize belt can overlap (the idempotency
    latch engages only AFTER a commit). They must share ONE in-flight run — a second concurrent
    kick awaits the same task instead of starting a second full sketch grind (double LLM spend, and
    the finalize kick is awaited inside the chat turn — a fresh grind there hangs the casting chat)."""
    from src import enrichment_policy as ep
    G.reset_state("u-flight")
    monkeypatch.setattr(ep, "is_strict", lambda: False)

    release = asyncio.Event()
    calls = {"llm": 0}

    async def _model(_owner):
        async def llm(_messages):
            calls["llm"] += 1
            await release.wait()  # a slow provider mid-grind
            return _valid_proposal_json()
        return llm

    async def write(proposal):
        return {"accepted": True, "committed": len(proposal["npcs"]),
                "violations": [], "varianceOk": True}

    monkeypatch.setattr(G, "_resolve_llm_fn", _model)

    async def _drive():
        t1 = asyncio.ensure_future(G.run_genesis(_ROSTER, 7, "u-flight", write=write))
        for _ in range(10):  # let the first kick reach the (held) llm call
            await asyncio.sleep(0)
        t2 = asyncio.ensure_future(G.run_genesis(_ROSTER, 7, "u-flight", write=write))
        for _ in range(10):
            await asyncio.sleep(0)
        release.set()
        return await asyncio.gather(t1, t2)

    r1, r2 = _run(_drive())
    # The live path authors ONE houseguest per call, so ONE shared run makes len(roster) calls (not one);
    # the point is the two kicks share that SINGLE run (else it'd be double — 2×per_run).
    per_run = len(_ROSTER)
    assert calls["llm"] == per_run, "two concurrent kicks must share ONE per-NPC run, not start a second"
    assert r1["committed"] == 15 and r2["committed"] == 15
    G.reset_state("u-flight")


def test_slow_background_authoring_never_blocks_a_concurrent_turn(monkeypatch):
    """The CLAUDE.md contract for the kick path: a best-effort, fail-soft BACKGROUND task that
    never blocks game start. Pin it: with a never-resolving (until released) authoring run in
    flight, `kickoff_authoring` returns immediately and a concurrent coroutine standing in for the
    chat turn completes promptly on the same loop — no shared per-session lock, no awaited
    completion in the caller."""
    hold = asyncio.Event()
    started = asyncio.Event()
    finished = {"authoring": False}

    async def fake_run_authoring(cast, owner, on_authored=None, write=None, seed=None):
        started.set()
        await hold.wait()
        finished["authoring"] = True
        return 0

    monkeypatch.setattr(A, "run_authoring", fake_run_authoring)

    async def _drive():
        A.kickoff_authoring([{"id": "npc:1"}], "u-slow")  # must return without awaiting the run
        await asyncio.wait_for(started.wait(), timeout=2.0)
        assert not finished["authoring"], "kickoff_authoring must not have awaited the run"

        async def chat_turn():
            await asyncio.sleep(0)
            return "turn-done"

        # The concurrent "chat turn" completes while authoring is still held open.
        out = await asyncio.wait_for(chat_turn(), timeout=1.0)
        assert out == "turn-done"
        assert not finished["authoring"]
        hold.set()
        for _ in range(10):
            await asyncio.sleep(0)
        assert finished["authoring"] is True  # the background task then finishes on its own

    _run(_drive())


