"""Feature 0116 (phase 2, FE half) — the model-authoring DRIVER for model-authored cast GENESIS.

The producer-LLM proposes the ENTIRE cast SKELETON (names, freeform identities, personas, hidden
elements, BANDED stats, the pre-show tie graph); the ENGINE validates/clamps/commits it (tested on the
engine side: tests/unit/castGenesis*.test.ts). This FE pipeline takes INJECTED llm + write functions, so
it is testable with no live model or engine. We pin:
  * the seeded season brief — a FAITHFUL port of src/engine/castGenesis.generateSeasonBrief (byte-equal);
  * the producer prompt (player-BLIND, producer-framed, banded stats, closed hidden-element kinds);
  * the tolerant parser (recognized-only, unknown-id / bad-stat / out-of-set-nature dropped);
  * the orchestrator (best-effort, fail-soft; bounded re-roll echoes engine violations);
  * DETERMINISTIC-FLOOR byte-neutrality: no model ⇒ NO write-back (the engine floor is untouched);
  * the LOUD gate under the strict enrichment policy (strict-failed latch + a ledger entry).

Roles only — no names ingested as data; the cast is proposed PLAYER-BLIND (anti-sycophancy #3).
"""
import asyncio
import inspect

from src import orwell_cast_genesis as G


def _run(coro):
    # FE convention: drive on the EXISTING session loop (never asyncio.run, which closes the loop).
    return asyncio.get_event_loop().run_until_complete(coro)


# The warmed FLOOR roster the driver binds proposals to — engine ids only (obviously-fake role ids).
_ROSTER = [{"id": f"npc:{i}"} for i in range(1, 16)]
_VALID_IDS = {n["id"] for n in _ROSTER}


def _valid_proposal_json() -> str:
    """A full, envelope-plausible 15-NPC proposal as the model would emit it (strict JSON object)."""
    import json
    npcs = []
    for i, n in enumerate(_ROSTER):
        npcs.append({
            "id": n["id"],
            "name": f"Casey Slot{i:02d}on",  # two plausible tokens, unique, deny-list-clear
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
                {"kind": "pre-game-tie", "detail": f"once crossed paths with a rival, slot {i}"},
            ],
        })
    return json.dumps({"npcs": npcs, "ties": [
        {"a": "npc:1", "b": "npc:2", "nature": "casting-callback", "backstory": "met at a callback"}]})


# ── the seeded season brief (a faithful engine port — the load-bearing correctness claim) ───────────────

def test_season_brief_matches_the_engine_byte_for_byte():
    # Reference values captured from src/engine/castGenesis.generateSeasonBrief (NODE_OPTIONS=--import tsx).
    # Same seed ⇒ same brief, so the FE steers with the SAME brief the engine records as the artifact.
    # (The old house-wide `ensembleVibe` was removed — the ensemble mood now rides per-slot as an accent,
    # see assign_genesis_slots; the demographic + regional pools were widened, re-pinning these values.)
    ref = {
        108108: {"demographicSkew": "a youth-forward house with a couple of seasoned outliers",
                 "regionalFlavor": "a Midwest-heartland core"},
        0: {"demographicSkew": "a mostly-thirties professional class at a crossroads",
            "regionalFlavor": "a Deep-South and Appalachian core"},
        5: {"demographicSkew": "a house anchored by forty- and fifty-somethings with real careers",
            "regionalFlavor": "a mix of small-town roots and big-city transplants"},
        2147483647: {"demographicSkew": "a college-age-to-late-twenties house, few over thirty",
                     "regionalFlavor": "a Pacific-Northwest-leaning cast"},
    }
    for seed, want in ref.items():
        assert G.generate_season_brief(seed) == want, seed


def test_season_brief_is_deterministic_and_seed_dependent():
    assert G.generate_season_brief(42) == G.generate_season_brief(42)  # same seed ⇒ same brief
    # Different seeds steer different directions (the finite space can collide, but not everywhere).
    briefs = {tuple(sorted(G.generate_season_brief(s).items())) for s in range(0, 40)}
    assert len(briefs) > 10, "the brief should vary meaningfully across seeds"


def test_per_slot_directives_match_the_engine_byte_for_byte():
    # Reference captured from src/engine/castGenesis.assignGenesisSlots(108108, 15) (NODE_OPTIONS=--import tsx).
    # The seeded CROSS-CAST constraints (casting-role quota / age curve / accented 20-30% / delivery axes /
    # amplified-loud contingent) are dealt up front and injected per NPC; the FE must mirror the engine
    # byte-for-byte.
    slots = G.assign_genesis_slots(108108, 15)
    assert slots[0] == {
        "role": "floater", "roleNote": "drifts to whoever holds power, never a target, never a leader",
        "archetype": "floater", "physical": False, "ageLo": 21, "ageHi": 26,
        "accent": "a hopeless romantic wired for a showmance", "amplified": True,
        "energy": "high-energy and bouncy", "register": "polished and articulate",
        "expressiveness": "loud and impossible to ignore",
        "emotionalRegister": "hot-reactive — quick to laugh, cry, or blow up",
        "selfAwareness": "insecure, quietly underrates themselves",
        "socialGravity": "a natural center of attention",
        "ink": False, "lookFeature": "no single notable mark — a plain, clean look"}
    assert slots[4] == {
        "role": "flirt", "roleNote": "charming and touchy, plays the social-romantic angle",
        "archetype": "flirt", "physical": False, "ageLo": 27, "ageHi": 33,
        "accent": "a stoic lone-wolf who keeps their cards close and their distance closer",
        "amplified": False, "energy": "steady and even-keeled", "register": "clipped and economical",
        "expressiveness": "reserved and hard to read", "emotionalRegister": "cold and hard to rattle",
        "selfAwareness": "insecure, quietly underrates themselves",
        "socialGravity": "a magnetic main-character who fills the room",
        "ink": False, "lookFeature": "a chipped front tooth"}
    assert G.assign_genesis_slots(7, 15) == G.assign_genesis_slots(7, 15)  # deterministic


def test_look_lane_deals_a_small_inked_minority_with_features_for_the_rest():
    # 2026-07-21 prompt audit (the cast-uniformity index case): a seeded 2-4 slots per cast carry the
    # visible-ink grant; every other slot is explicitly no-ink and carries a suggested feature.
    for seed in (108108, 0, 5, 7, 42, 999, 2147483647):
        slots = G.assign_genesis_slots(seed, 15)
        ink = sum(1 for s in slots if s["ink"])
        assert 2 <= ink <= 4, (seed, ink)
        for s in slots:
            if s["ink"]:
                assert s["lookFeature"] == ""
            else:
                assert s["lookFeature"], s


def test_look_line_renders_into_the_casting_card():
    slots = G.assign_genesis_slots(108108, 15)
    inked = next(s for s in slots if s["ink"])
    plain = next(s for s in slots if not s["ink"])
    assert "visible tattoos ARE part of their look" in G.render_slot_directive("npc:9", inked)
    plain_line = G.render_slot_directive("npc:2", plain)
    assert "NO visible tattoos" in plain_line and plain["lookFeature"] in plain_line


def test_prompt_injects_used_facet_ledgers():
    # 2026-07-21 (the "San Diego x2" defect): the hometown/vocation ledgers thread between waves like
    # the name ledger, so per-NPC calls stop landing on the model's default picks.
    brief = G.generate_season_brief(108108)
    msgs = G.build_genesis_messages(_ROSTER, brief, None, None, None,
                                    {"hometowns": ["San Diego, CA"], "vocations": ["barista"]})
    user = msgs[1]["content"]
    assert "Hometowns ALREADY used" in user and "San Diego, CA" in user
    assert "Vocations ALREADY used" in user and "barista" in user
    # back-compatible: omitted ⇒ absent.
    plain = G.build_genesis_messages(_ROSTER, brief)[1]["content"]
    assert "Hometowns ALREADY used" not in plain and "Vocations ALREADY used" not in plain


def test_casting_plan_respects_quota_and_extremes():
    from collections import Counter
    _CEREBRAL = {"mastermind", "analyst", "superfan gamebot"}
    for seed in (108108, 0, 5, 7, 42, 999, 2147483647):
        slots = G.assign_genesis_slots(seed, 15)
        roles = Counter(s["role"] for s in slots)
        # cap ANY casting role at 2 across the cast (owner quota)
        assert all(v <= G.GENESIS_ROLE_MAX_PER_CAST for v in roles.values()), (seed, dict(roles))
        # combined cerebral (mastermind + analyst + superfan) capped at ~3
        assert sum(v for r, v in roles.items() if r in _CEREBRAL) <= G.GENESIS_CEREBRAL_MAX_PER_CAST, seed
        # 3-4 genuine physical comp threats exist (not a desk-job-only cast)
        assert 3 <= sum(1 for s in slots if s["physical"]) <= 4, seed
        # the ensemble accent is a seeded 20-30% minority
        assert 0.20 * 15 - 0.5 <= sum(1 for s in slots if s["accent"]) <= 0.30 * 15 + 0.5, seed
        # a loud/reactive/main-character contingent is GUARANTEED (>=4 amplified big personalities)
        assert sum(1 for s in slots if s["amplified"]) >= G.GENESIS_AMPLIFIED_MIN, seed
        louds = sum(1 for s in slots
                    if any(w in s["expressiveness"] for w in ("loud", "unfiltered", "over-sharing"))
                    or "main-character" in s["socialGravity"])
        assert louds >= 4, (seed, louds, "the cast must not be uniformly reserved")


def test_age_curve_fills_the_middle():
    # the seeded age curve targets a believable real-world spread and explicitly fills the 27-45 zone.
    slots = G.assign_genesis_slots(108108, 15)
    mids = sum(1 for s in slots if 27 <= s["ageLo"] <= 45 or 27 <= s["ageHi"] <= 45)
    assert mids >= 6, mids  # the un-tuned cast left this empty; the curve fills it


# ── the producer prompt (player-BLIND, producer-framed) ─────────────────────────────────────────────────

def test_prompt_is_producer_framed_banded_and_player_blind():
    brief = G.generate_season_brief(108108)
    msgs = G.build_genesis_messages(_ROSTER, brief)
    assert msgs[0]["role"] == "system"
    system = msgs[0]["content"].lower()
    assert "casting director" in system and "json" in system
    # banded stats + the closed hidden-element kinds are steered.
    assert "physical" in system and "mental" in system and "social" in system
    for kind in ("secret-motive", "pre-game-tie", "divergent-persona"):
        assert kind in system, kind
    # the legacy-Bible deny-list names are called out; the pronoun-consistency wording is present.
    assert "ryne" in system and "marcus" in system and "felix" in system
    assert "chosen pronouns" in system
    # the softened name policy: no whole-cast redraw threat, no centripetal anchoring language.
    assert "unremarkable" not in system
    assert "redrawn" not in system and "re-rolled" not in system
    assert "contemporary american" not in system  # dropped "prefer common CONTEMPORARY American"
    user = msgs[1]["content"]
    # the brief steers the sketch; the roster ids bind the proposals.
    assert brief["demographicSkew"] in user and brief["regionalFlavor"] in user
    assert "npc:1" in user and "npc:15" in user
    # PLAYER-BLIND: no player identity anywhere (the whole cast is designed as if the player doesn't exist).
    whole = (msgs[0]["content"] + user).lower()
    for leak in ("the player", "player's name", "casting answer", "player profile"):
        assert leak not in whole, leak


def test_prompt_injects_per_slot_casting_cards_and_used_names_ledger():
    brief = G.generate_season_brief(108108)
    slots = G.assign_genesis_slots(108108, len(_ROSTER))
    directives = {n["id"]: slots[i] for i, n in enumerate(_ROSTER)}
    msgs = G.build_genesis_messages(_ROSTER, brief, None, directives, ["Dana Whitfield"])
    user = msgs[1]["content"]
    # the seeded casting card is injected per slot (role + archetype tag + axes present, no pronoun token).
    assert "CASTING CARDS" in user
    assert "cast as:" in user and "archetype tag:" in user and "energy:" in user and "social-gravity:" in user
    assert "pronouns:" not in user  # gender is NOT seeded — the model chooses it (course-correction)
    # F3: the cross-chunk used-names ledger is injected so later chunks avoid collisions.
    assert "Dana Whitfield" in user and "ALREADY taken" in user
    # back-compatible: omitting directives/used_names ⇒ no card / no ledger.
    plain = G.build_genesis_messages(_ROSTER, brief)[1]["content"]
    assert "CASTING CARDS" not in plain and "ALREADY taken" not in plain


def test_reroll_prompt_echoes_the_violations():
    brief = G.generate_season_brief(1)
    msgs = G.build_genesis_messages(_ROSTER, brief, "houseguest npc:3: duplicate name within the cast")
    assert "duplicate name within the cast" in msgs[1]["content"]


def test_driver_source_carries_no_player_coupling():
    src = inspect.getsource(G)
    # 'player' appears ONLY in the player-BLIND documentation, never as a threaded field.
    assert "player-blind" in src.lower()
    assert "player_name" not in src and "playerName" not in src


# ── the tolerant parser (recognized-only) ──────────────────────────────────────────────────────────────

def test_parser_keeps_valid_shapes_and_drops_garbage():
    proposal = G.parse_genesis_proposal(_valid_proposal_json(), _VALID_IDS)
    assert len(proposal["npcs"]) == 15
    first = proposal["npcs"][0]
    assert first["id"] == "npc:1" and first["name"] == "Casey Slot00on"
    assert set(first["stats"].keys()) == {"physical", "mental", "social"}
    assert len(first["hiddenElements"]) == 3
    assert proposal["ties"][0]["nature"] == "casting-callback"


def test_parser_aliases_the_legacy_showmance_tie_nature_and_accepts_the_new_ones():
    """#1909: the pre-show romance nature is 'prior-romance' now (the in-house Showmance ARC keeps the word); an older
    prompt/model output that still says 'showmance' is aliased forward, and the broadened natures pass through."""
    import json
    base = json.loads(_valid_proposal_json())
    cases = [("showmance", "prior-romance")] + [(n, n) for n in G._TIE_NATURES]  # EVERY canonical nature must survive the parser
    assert {"old-friend", "former-teammate", "prior-romance"} <= set(G._TIE_NATURES)
    for raw, expected in cases:
        base["ties"] = [{"a": "npc:1", "b": "npc:2", "nature": raw, "backstory": "x"}]
        out = G.parse_genesis_proposal(json.dumps(base), _VALID_IDS)
        assert out["ties"][0]["nature"] == expected, raw
    assert "showmance" not in G._TIE_NATURES  # the arc keeps that word; the nature has its own
    base["ties"] = [{"a": "npc:1", "b": "npc:2", "nature": "not-a-nature"}]
    out = G.parse_genesis_proposal(json.dumps(base), _VALID_IDS)
    assert "nature" not in out["ties"][0]  # an unknown nature is dropped, the tie itself survives


def test_parser_drops_unknown_ids_bad_stats_and_out_of_set_natures():
    import json
    raw = json.dumps({
        "npcs": [
            {"id": "npc:1", "name": "Alex Reed", "stats": {"physical": "high", "mental": 0.5}},
            {"id": "npc:999", "name": "Ghost Slot"},  # unknown id ⇒ dropped
            {"id": "npc:2", "hiddenElements": [{"kind": "secret-motive"}]},  # no detail ⇒ el dropped
        ],
        "ties": [
            {"a": "npc:1", "b": "npc:1", "nature": "casting-callback"},   # self-tie ⇒ dropped
            {"a": "npc:1", "b": "npc:2", "nature": "not-a-nature"},       # bad nature ⇒ kept, no nature
            {"a": "npc:1", "b": "npc:999"},                               # unknown endpoint ⇒ dropped
        ],
    })
    proposal = G.parse_genesis_proposal(raw, _VALID_IDS)
    ids = [n["id"] for n in proposal["npcs"]]
    assert ids == ["npc:1", "npc:2"]  # npc:999 dropped
    assert "physical" not in proposal["npcs"][0].get("stats", {})  # "high" dropped; mental kept
    assert proposal["npcs"][0]["stats"] == {"mental": 0.5}
    assert "hiddenElements" not in proposal["npcs"][1]  # the detail-less element dropped the whole list
    assert len(proposal["ties"]) == 1  # only the valid distinct pair survives
    assert "nature" not in proposal["ties"][0]  # the out-of-set nature was dropped, tie kept


def test_parser_returns_empty_on_garbage():
    assert G.parse_genesis_proposal("not json at all", _VALID_IDS) == {}
    assert G.parse_genesis_proposal("", _VALID_IDS) == {}
    assert G.parse_genesis_proposal('{"npcs": []}', _VALID_IDS) == {}  # no usable npc ⇒ floor stands


# ── the orchestrator: writes back a valid proposal ─────────────────────────────────────────────────────

def test_seed_cast_genesis_writes_back_a_clean_proposal():
    seen = {}

    async def llm(_messages):
        return _valid_proposal_json()

    async def write(proposal):
        seen["proposal"] = proposal
        return {"accepted": True, "committed": len(proposal["npcs"]), "violations": [], "varianceOk": True}

    res = _run(G.seed_cast_genesis(_ROSTER, 108108, llm, write))
    assert res["accepted"] is True and res["committed"] == 15 and res["varianceOk"] is True
    assert res["rerolls"] == 0  # a clean commit does not re-roll
    assert len(seen["proposal"]["npcs"]) == 15  # the parsed proposal reached the write-back


def test_bounded_reroll_echoes_violations_then_settles():
    calls = {"llm": 0, "write": 0}
    prompts = []

    async def llm(messages):
        calls["llm"] += 1
        prompts.append(messages[-1]["content"])
        return _valid_proposal_json()

    async def write(proposal):
        calls["write"] += 1
        if calls["write"] == 1:
            # First attempt: the engine names a per-NPC re-roll violation.
            return {"accepted": True, "committed": 14, "varianceOk": True,
                    "violations": [{"scope": "npc", "npcId": "npc:3", "field": "name",
                                    "rule": "duplicate name within the cast", "action": "re-roll"}]}
        return {"accepted": True, "committed": 15, "varianceOk": True, "violations": []}

    res = _run(G.seed_cast_genesis(_ROSTER, 7, llm, write))
    assert calls["write"] == 2 and calls["llm"] == 2  # re-rolled exactly once
    assert res["committed"] == 15 and res["rerolls"] == 1
    # the second prompt echoed the violation back to the model.
    assert "duplicate name within the cast" in prompts[1]


def test_reroll_is_bounded_by_the_budget():
    calls = {"write": 0}

    async def llm(_messages):
        return _valid_proposal_json()

    async def write(_proposal):
        calls["write"] += 1  # always dirty (a cast-wide variance failure) — forces max re-rolls
        return {"accepted": True, "committed": 15, "varianceOk": False, "violations": []}

    res = _run(G.seed_cast_genesis(_ROSTER, 7, llm, write))
    # 1 initial + GENESIS_MAX_REROLLS attempts, never unbounded.
    assert calls["write"] == 1 + G.GENESIS_MAX_REROLLS
    assert res["accepted"] is True and res["varianceOk"] is False


# ── DETERMINISTIC-FLOOR byte-neutrality: no model ⇒ NO write-back ───────────────────────────────────────

def test_no_usable_proposal_never_writes_back_floor_stands():
    wrote = {"n": 0}

    async def llm(_messages):
        return "the model rambled and produced no JSON whatsoever"

    async def write(_proposal):
        wrote["n"] += 1
        return {"accepted": True, "committed": 15}

    res = _run(G.seed_cast_genesis(_ROSTER, 7, llm, write))
    assert wrote["n"] == 0  # NEVER wrote back ⇒ the engine's deterministic floor is untouched
    assert res["accepted"] is False and res["committed"] == 0


def test_run_genesis_no_model_is_a_soft_no_op(monkeypatch):
    from src import enrichment_policy as ep
    G.reset_state(None)
    monkeypatch.setattr(ep, "is_strict", lambda: False)

    async def _no_model(_owner):
        return None

    monkeypatch.setattr(G, "_resolve_llm_fn", _no_model)
    wrote = {"n": 0}

    async def write(_proposal):
        wrote["n"] += 1
        return {"accepted": True}

    res = _run(G.run_genesis(_ROSTER, 7, "u-soft", write=write))
    assert res["accepted"] is False and res["reason"] == "no-model"
    assert wrote["n"] == 0                       # byte-neutral: no write-back at all
    assert G.strict_failed("u-soft") is False    # soft ⇒ the failure is silent (no latch)


# ── the LOUD gate under the strict enrichment policy (§4 / #1313 precedent) ─────────────────────────────

def test_run_genesis_no_model_under_strict_is_loud(monkeypatch):
    from src import enrichment_policy as ep
    G.reset_state(None)
    ep.clear_failures("u-strict")
    monkeypatch.setattr(ep, "is_strict", lambda: True)

    async def _no_model(_owner):
        return None

    monkeypatch.setattr(G, "_resolve_llm_fn", _no_model)
    res = _run(G.run_genesis(_ROSTER, 7, "u-strict"))
    assert res["accepted"] is False
    assert G.strict_failed("u-strict") is True   # the pre-finalize gate latch is set
    fails = ep.failures("u-strict")
    assert any(f.get("callClass") == "cast-genesis" for f in fails)  # a loud ledger entry


def test_run_genesis_ran_but_committed_nothing_under_strict_is_loud(monkeypatch):
    # A model IS wired, but every proposal is garbage (no usable JSON) ⇒ nothing commits ⇒ the floor
    # would stand. Under strict that is a LOUD failure + the pre-finalize latch (never a silent floor).
    from src import enrichment_policy as ep
    G.reset_state("u-hardfail")
    ep.clear_failures("u-hardfail")
    monkeypatch.setattr(ep, "is_strict", lambda: True)

    async def _model(_owner):
        async def llm(_messages):
            return "the model rambled; no JSON at all"
        return llm

    monkeypatch.setattr(G, "_resolve_llm_fn", _model)
    res = _run(G.run_genesis(_ROSTER, 7, "u-hardfail"))
    assert res["accepted"] is False and res["committed"] == 0
    assert G.strict_failed("u-hardfail") is True                       # the loud pre-finalize gate latches
    assert any(f.get("callClass") == "cast-genesis" for f in ep.failures("u-hardfail"))
    assert G.genesis_committed("u-hardfail", 7) is False               # nothing committed ⇒ no idempotency latch
    G.reset_state("u-hardfail")


def test_strict_latch_clears_on_a_successful_run(monkeypatch):
    from src import enrichment_policy as ep
    G.mark_strict_failed("u-2")
    assert G.strict_failed("u-2") is True
    monkeypatch.setattr(ep, "is_strict", lambda: True)

    async def _model(_owner):
        async def llm(_messages):
            return _valid_proposal_json()
        return llm

    async def write(proposal):
        return {"accepted": True, "committed": len(proposal["npcs"]), "violations": [], "varianceOk": True}

    monkeypatch.setattr(G, "_resolve_llm_fn", _model)
    res = _run(G.run_genesis(_ROSTER, 7, "u-2", write=write))
    assert res["accepted"] is True and res["committed"] == 15
    assert G.strict_failed("u-2") is False  # a successful run clears the latch


def test_reset_state_clears_the_latch():
    G.mark_strict_failed("u-3")
    assert G.strict_failed("u-3") is True
    G.reset_state("u-3")
    assert G.strict_failed("u-3") is False


# ── idempotency: genesis is kicked from BOTH the pre-warm AND the pre-finalize belt — run once ───────────

def test_run_genesis_is_idempotent_per_seed(monkeypatch):
    from src import enrichment_policy as ep
    G.reset_state("u-idem")
    monkeypatch.setattr(ep, "is_strict", lambda: False)
    calls = {"llm": 0}

    async def _model(_owner):
        async def llm(_messages):
            calls["llm"] += 1
            return _valid_proposal_json()
        return llm

    async def write(proposal):
        return {"accepted": True, "committed": len(proposal["npcs"]), "violations": [], "varianceOk": True}

    monkeypatch.setattr(G, "_resolve_llm_fn", _model)
    # The LIVE path authors ONE houseguest per call (run in bounded-concurrency waves), so one committed
    # run makes len(roster) llm calls (not one whole-cast call).
    per_run = len(_ROSTER)
    r1 = _run(G.run_genesis(_ROSTER, 7, "u-idem", write=write))
    assert r1["accepted"] is True and r1["committed"] == 15
    assert G.genesis_committed("u-idem", 7) is True
    # A SECOND kick for the SAME warmed seed (the pre-finalize belt after the pre-warm already committed)
    # is a no-op — no duplicate sketch call (the per-run count does NOT grow).
    r2 = _run(G.run_genesis(_ROSTER, 7, "u-idem", write=write))
    assert r2["reason"] == "already-committed" and calls["llm"] == per_run
    # A DIFFERENT seed (a new season / re-warm) DOES re-run — another chunked pass.
    r3 = _run(G.run_genesis(_ROSTER, 99, "u-idem", write=write))
    assert r3["committed"] == 15 and calls["llm"] == 2 * per_run
    G.reset_state("u-idem")


def test_reset_state_clears_the_committed_latch():
    G._mark_committed("u-4", 5, 15)
    assert G.genesis_committed("u-4", 5) is True
    G.reset_state("u-4")
    assert G.genesis_committed("u-4", 5) is False


# ── the prewarm pipeline order: SKELETON (genesis) → identity → author ──────────────────────────────────

def test_prewarm_runs_genesis_before_identity_and_authoring():
    from src import orwell_prewarm
    orwell_prewarm.reset(None)
    order = []

    class _Engine:
        async def pre_seed_cast(self, user=None):
            return {"warmed": True, "seed": 7, "house": list(_ROSTER), "portraitPrompts": []}

    class _Genesis:
        async def run_genesis(self, cast, seed, user, **kw):
            order.append("genesis")
            return {"accepted": True, "committed": 15}

    class _Identity:
        async def run_identity(self, cast, user):
            order.append("identity")
            return 0

    class _Authoring:
        def kickoff_authoring(self, cast, user, then=None, on_authored=None, write=None, seed=None):
            order.append("authoring")
            if then:
                then()

    _run(orwell_prewarm.prewarm_cast(
        "u-order", engine=_Engine(), authoring=_Authoring(), identity=_Identity(), genesis=_Genesis()))
    assert order.index("genesis") < order.index("identity") < order.index("authoring")
    orwell_prewarm.reset(None)


def test_orw145_genesis_appearance_is_authored_pronoun_free():
    """ORW-145: appearance is authored at genesis BEFORE the identity call pins the gender, so a pronoun in it ("her hazel eyes") contradicts the later pin and the engine's coherence repair has to fix it
    (4 of 15 houseguests repaired on every start, flagged RED-eligible). The prompt must ask for a pronoun-free, gender-neutral look phrase and must NOT promise the model a pronoun to match."""
    text = " ".join(m["content"] for m in G.build_genesis_messages(_ROSTER, G.generate_season_brief(108108)))
    assert "NO pronouns" in text and "pinned in a later step" in text
    assert "consistent with their pronouns" not in text
