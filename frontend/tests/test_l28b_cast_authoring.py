"""Feature 0058 / L28b (FE half) — the producer-LLM authoring pipeline.

The orchestrator takes INJECTED llm + write functions, so the whole pipeline is testable without a
live model or engine. We pin: the producer prompt (player-independence), the tolerant JSON parser
(schema-only, type-coerced), and the orchestration (writes each NPC, skips the player, best-effort
per houseguest, only forwards engine-accepted fields).
"""
import asyncio
import json

from conftest import _run
from src import orwell_cast_authoring as A


# ── the producer prompt ───────────────────────────────────────────────────────

def test_l28b_prompt_is_producer_framed_and_player_independent():
    msgs = A.build_authoring_messages({"id": "npc:1", "name": "Dana Reyes", "vocation": "welder"})
    assert msgs[0]["role"] == "system"
    assert "CASTING PRODUCER" in msgs[0]["content"]
    assert "JSON" in msgs[0]["content"]
    user = msgs[1]["content"]
    assert "Dana Reyes" in user
    # the public skeleton is passed through to build FROM
    assert "welder" in user


def test_l28b_prompt_grounds_the_hidden_life_in_the_specific_character():
    """P1 — NPC story coherence: the producer prompt must INSTRUCT the model to GROUND the
    secrets/true-goals/weakness in THIS houseguest's own occupation / archetype / age / backstory
    (the fix for generic, cast-repeating hidden material), while STILL carrying every grounding
    facet through the skeleton and STILL coupling to no player. The permanent grounding gate."""
    npc = {
        "id": "npc:5", "name": "Dana Reyes", "age": 34, "vocation": "pastry chef",
        "hometown": "Detroit, MI", "archetype": "villain", "demeanor": "deadpan and dry",
    }
    msgs = A.build_authoring_messages(npc)
    system = msgs[0]["content"].lower()
    user = msgs[1]["content"]

    # (a) the system prompt drives grounding the HIDDEN material in the individual's specifics.
    assert "ground" in system  # the explicit "GROUND EVERYTHING IN THIS SPECIFIC PERSON" instruction
    assert "occupation" in system
    assert "archetype" in system
    assert "age" in system
    # the secrets/goals/weakness are named as the things to ground
    assert "secret" in system and "weakness" in system

    # (b) every grounding facet is actually passed through to the model (build FROM this).
    for facet in ("pastry chef", "villain", "34", "Detroit, MI", "deadpan and dry"):
        assert facet in user, facet

    # (c) STILL no player coupling — the grounding change must not reintroduce a protagonist. T0-6
    # added `taken`/`hand` (the FacetLedger steering) — legitimate, Vault-free, player-independent
    # params — so the gate now asserts NO "player"-shaped parameter exists, rather than pinning the
    # exact param list closed.
    import inspect
    params = list(inspect.signature(A.build_authoring_messages).parameters)
    assert params[0] == "npc"
    assert not any("player" in p.lower() for p in params), params
    assert "player" not in user.lower() or "no protagonist" in user.lower()


def test_s4c_pins_genderpresentation_into_the_authoring_skeleton():
    """S4c (RC5, #1599): the committed IDENTITY HEADER — the pinned `genderPresentation` — is threaded
    into the authoring skeleton as immutable context, so the model cannot author a secret bible that
    re-genders the houseguest (the bundle's "man" + "her past" drift). The pin appears in the passed
    skeleton AND the prompt spells out that every self-reference must use the matching pronouns."""
    npc = {
        "id": "npc:7", "vocation": "court reporter", "archetype": "underdog",
        "genderPresentation": "man",
    }
    msgs = A.build_authoring_messages(npc)
    user = msgs[1]["content"]
    # the pin is carried in the skeleton the model builds FROM, and the pronoun rule names it explicitly.
    assert "genderPresentation" in user
    assert "man" in user
    assert "pronoun" in user.lower()

    # A woman-pinned houseguest gets the woman pin (not a hard-coded string); a missing pin adds no rule.
    woman = A.build_authoring_messages({"id": "npc:8", "vocation": "welder", "genderPresentation": "woman"})[1]["content"]
    assert "woman" in woman and "pronoun" in woman.lower()
    no_pin = A.build_authoring_messages({"id": "npc:9", "vocation": "welder"})[1]["content"]
    assert "pinned gender presentation" not in no_pin.lower()


def test_l28b_prompt_carries_no_player_coupling_and_no_protagonist():
    """ANTI-SYCOPHANCY (mandate #3): an NPC's STORYLINE is authored as if the player does not exist.
    The prompt must (a) take no player identity at all, and (b) instruct the model that the cast is a
    set of equals with no protagonist — secrets/goals/weakness must never revolve around a 'player'.
    This is the permanent gate against player-centric NPC storyline authoring."""
    import inspect
    # The function signature itself no longer accepts a player name (player-independent by construction).
    # T0-6 added `taken`/`hand` (the cast-wide FacetLedger steering — Vault-free, player-independent);
    # the gate is that NO parameter is player-shaped, not that the param list is frozen shut.
    params = list(inspect.signature(A.build_authoring_messages).parameters)
    assert params[0] == "npc", params
    assert not any("player" in p.lower() for p in params), params

    # A distinctive player name could only appear in the messages if it were threaded in — it is not.
    player_name = "Zzqx The Player"
    msgs = A.build_authoring_messages({"id": "npc:1", "name": "Dana Reyes", "vocation": "welder"})
    blob = (msgs[0]["content"] + " " + msgs[1]["content"]).lower()
    assert player_name.lower() not in blob

    system = msgs[0]["content"].lower()
    # the storyline-independence instruction is present (no protagonist / own independent life)
    assert "independent" in system
    assert "protagonist" in system or "only a cast" in system
    # and the player's Day-1 read is NOT authored here (the engine owns the seeded floor)
    assert "dayoneperception" not in system.replace(" ", "")
    assert "dayOnePerception" not in A._HIDDEN_KEYS


# ── the parser ────────────────────────────────────────────────────────────────

_FULL = {
    "biography": "A blunt welder from Detroit who came up the hard way. Friends call her loyal to a fault.",
    "physicalCharacteristics": {
        "heightBuild": "stocky and powerful", "skinTone": "warm tan complexion", "hair": "a close-cropped fade",
        "facialFeatures": "a square jaw", "distinguishingMark": "a wrist tattoo", "ageLook": "settled, thirties",
        "style": "sturdy workwear",
    },
    "secrets": ["is in real financial trouble", "recognized another houseguest from before"],
    "trueGoals": ["reach the end quietly", "build one secret final two"],
    "weakness": "is too loyal once committed",
    "dayOnePerception": "reads the player as harmless but socially useful",
}


def test_l28b_parser_extracts_the_full_schema_with_the_id():
    prof = A.parse_authored_profile(json.dumps(_FULL), "npc:7")
    assert prof["houseguestId"] == "npc:7"
    assert prof["biography"].startswith("A blunt welder")
    assert set(prof["physicalCharacteristics"].keys()) == set(A._PHYS_KEYS)
    assert prof["secrets"] == _FULL["secrets"]
    assert prof["trueGoals"] == _FULL["trueGoals"]
    assert prof["weakness"] == _FULL["weakness"]
    # ANTI-SYCOPHANCY: the parser NEVER forwards a player-coupled Day-1 read even if a model returns
    # one — the engine owns the seeded, balanced read. So `dayOnePerception` is dropped on the floor.
    assert "dayOnePerception" not in prof


def test_l28b_parser_tolerates_fenced_json_and_chatter():
    text = "Sure! Here's the bible:\n```json\n" + json.dumps(_FULL) + "\n```\nHope that helps."
    prof = A.parse_authored_profile(text, "npc:2")
    assert prof and prof["biography"].startswith("A blunt welder")


def test_l28b_parser_drops_a_partial_physical_facet_but_keeps_other_fields():
    partial = dict(_FULL)
    partial["physicalCharacteristics"] = {"hair": "long dark waves"}  # incomplete facet
    prof = A.parse_authored_profile(json.dumps(partial), "npc:3")
    # the facet is the text<->image source of truth — only written WHOLE, never half
    assert "physicalCharacteristics" not in prof
    # but the rest of the authored profile still lands
    assert prof["biography"] and prof["secrets"]


def test_l28b_parser_returns_none_on_garbage():
    assert A.parse_authored_profile("not json at all", "npc:1") is None
    assert A.parse_authored_profile(json.dumps({"unrelated": 1}), "npc:1") is None
    assert A.parse_authored_profile("", "npc:1") is None


# ── the orchestrator (injected fakes) ─────────────────────────────────────────

def test_l28b_author_cast_writes_each_npc_and_skips_the_player():
    cast = [
        {"id": "player", "name": "The Player"},
        {"id": "npc:1", "name": "A One"},
        {"id": "npc:2", "name": "B Two"},
    ]
    writes = []

    async def llm_fn(messages):
        return json.dumps(_FULL)

    async def write_fn(profile):
        writes.append(profile)
        return {"accepted": True, "publicFields": ["biography"], "hiddenFields": ["secrets"]}

    n = _run(A.author_cast(cast, llm_fn, write_fn))
    assert n == 2  # both NPCs, never the player
    assert [w["houseguestId"] for w in writes] == ["npc:1", "npc:2"]
    # the write-back carries the authored schema, never a stray key (and never the Day-1 read)
    for w in writes:
        assert set(w).issubset({"houseguestId", *A._PUBLIC_KEYS, *A._HIDDEN_KEYS})
        assert "dayOnePerception" not in w


def test_l28b_author_cast_is_best_effort_per_houseguest():
    cast = [{"id": "npc:1", "name": "A"}, {"id": "npc:2", "name": "B"}, {"id": "npc:3", "name": "C"}]
    writes = []

    async def llm_fn(messages):
        # the middle houseguest's model call blows up — the others must still author. Match the skeleton
        # name token exactly (not a bare "B", which now also appears in prompt prose like "IMMUTABLE").
        if '"name": "B"' in messages[1]["content"]:
            raise RuntimeError("model timeout")
        return json.dumps(_FULL)

    async def write_fn(profile):
        writes.append(profile["houseguestId"])
        return {"accepted": True}

    n = _run(A.author_cast(cast, llm_fn, write_fn))
    assert n == 2
    assert writes == ["npc:1", "npc:3"]


def test_l28b_author_cast_does_not_count_a_refused_write():
    cast = [{"id": "npc:1", "name": "A"}]

    async def llm_fn(messages):
        return json.dumps(_FULL)

    async def write_fn(profile):
        return {"accepted": False, "reason": "mirrors the player"}  # the engine refused (the wall held)

    n = _run(A.author_cast(cast, llm_fn, write_fn))
    assert n == 0


def test_l28b_author_cast_skips_an_npc_the_model_could_not_author():
    cast = [{"id": "npc:1", "name": "A"}]

    async def llm_fn(messages):
        return "the model rambled and produced no JSON"

    async def write_fn(profile):  # pragma: no cover - must never be called
        raise AssertionError("must not write a profile that did not parse")

    n = _run(A.author_cast(cast, llm_fn, write_fn))
    assert n == 0


def test_l28b_engine_client_method_exists():
    # the FE engine client exposes the write-back seam the orchestrator forwards to
    from src import orwell_engine
    assert hasattr(orwell_engine, "record_cast_profile")


# ── A1 (ship-blocker, "the phantom-houseguest root") ───────────────────────────
#
# The engine structurally refuses to rename an ALREADY-INTRODUCED houseguest
# (`recordCastProfile`'s durable `introducedNames` lock — GameSessionAdapter.ts): the call still
# succeeds (`accepted: True`) but the response reports which fields actually sealed. `author_cast` is a
# best-effort orchestrator that only branches on `accepted` (never on which individual public/hidden
# field names came back) — this test PINS that contract so a future change to its accept-handling can't
# silently regress it back into assuming every requested field is echoed back accepted.
# (#1660: a genuine RENAME is now dropped FE-side by `identity_contradictions` BEFORE the write-back —
# covered by `test_cast_identity_coherence`; so this test authors the COMMITTED name to isolate the
# accept-only-branching contract from the name guard.)

def test_l28b_author_cast_tolerates_the_engine_dropping_the_name_field():
    """The engine's write-back accepts the call but the `publicFields` it reports back omit "name" (only
    "biography" landed). `author_cast` must still count this houseguest as authored — it never inspects
    `publicFields`/`hiddenFields`, only `accepted` — and must call `on_authored` exactly as it would for
    a fully-accepted write."""
    cast = [{"id": "npc:1", "name": "Marcus Webb"}]
    authored_callback_ids = []

    async def llm_fn(messages):
        # Authors the COMMITTED name (no rename) — the FE name guard is a no-op, so the name is forwarded
        # and the scenario isolates author_cast's accept-only branching (a rename-drop is tested apart).
        return json.dumps({**_FULL, "name": "Marcus Webb"})

    async def write_fn(profile):
        assert profile.get("name") == "Marcus Webb"
        return {"accepted": True, "publicFields": ["biography"], "hiddenFields": ["secrets", "trueGoals", "weakness"]}

    n = _run(A.author_cast(cast, llm_fn, write_fn, on_authored=lambda hid: authored_callback_ids.append(hid)))
    assert n == 1  # still counted as authored — accepted is accepted, regardless of which fields stuck
    assert authored_callback_ids == ["npc:1"]  # the per-NPC completion callback still fires normally


# ── #5 — bounded-concurrency authoring ────────────────────────────────────────

def test_author_cast_authors_all_npcs_with_bounded_concurrency():
    """#5: NPCs author IN PARALLEL (not serial), but never more than the semaphore bound in flight."""
    cast = [{"id": f"npc:{i}", "name": f"N{i}"} for i in range(8)]
    state = {"inflight": 0, "max_inflight": 0}

    async def llm_fn(messages):
        state["inflight"] += 1
        state["max_inflight"] = max(state["max_inflight"], state["inflight"])
        await asyncio.sleep(0)  # yield so concurrent calls overlap (proves it isn't serial)
        await asyncio.sleep(0)
        state["inflight"] -= 1
        return json.dumps(_FULL)

    writes = []

    async def write_fn(profile):
        writes.append(profile["houseguestId"])
        return {"accepted": True}

    n = _run(A.author_cast(cast, llm_fn, write_fn, concurrency=3))
    assert n == 8  # every NPC authored
    assert sorted(writes) == sorted(npc["id"] for npc in cast)
    # parallel (more than one in flight at once) AND bounded (never exceeds the semaphore)
    assert state["max_inflight"] > 1, "authoring ran serially — bounded concurrency not applied"
    assert state["max_inflight"] <= 3, "concurrency exceeded the semaphore bound"


def test_author_cast_fires_on_authored_per_successful_write():
    """#7 seam: the per-NPC callback fires once per engine-accepted write-back (never for the player,
    never for a refused write, never for an NPC that didn't parse)."""
    cast = [
        {"id": "player", "name": "P"},
        {"id": "npc:1", "name": "A"},
        {"id": "npc:2", "name": "B"},  # this one's write is refused
        {"id": "npc:3", "name": "C"},  # this one produces no JSON
    ]
    authored = []

    async def llm_fn(messages):
        # Match the skeleton name token exactly (a bare "C" now also appears in prompt prose).
        if '"name": "C"' in messages[1]["content"]:
            return "no json here"
        return json.dumps(_FULL)

    async def write_fn(profile):
        if profile["houseguestId"] == "npc:2":
            return {"accepted": False, "reason": "refused"}
        return {"accepted": True}

    n = _run(A.author_cast(cast, llm_fn, write_fn, lambda hid: authored.append(hid)))
    assert n == 1  # only npc:1 was accepted
    assert authored == ["npc:1"]  # the callback fired only for the accepted write-back


# ── #3 — the FE-side quality floor ────────────────────────────────────────────

def test_quality_floor_drops_a_thin_biography_so_it_cannot_overwrite_the_seeded_floor():
    """#3: a 1-sentence / short authored biography is OMITTED from the parsed profile (so the engine's
    richer deterministic floor stands), while the rest of the authored profile still lands."""
    thin = dict(_FULL, biography="Short bio.")  # one sentence, well under the char floor
    prof = A.parse_authored_profile(json.dumps(thin), "npc:9")
    assert prof is not None
    assert "biography" not in prof, "a thin biography would overwrite the seeded floor"
    # the rest of the authored material is unaffected by the biography floor
    assert prof["secrets"] and prof["physicalCharacteristics"]


def test_quality_floor_keeps_a_rich_biography():
    """#3: a coherent biography (>= 2 sentence terminators AND >= 80 chars) IS kept."""
    prof = A.parse_authored_profile(json.dumps(_FULL), "npc:10")
    assert prof["biography"] == _FULL["biography"]


def test_quality_floor_drops_a_one_word_weakness_and_trivial_secrets():
    """#3: the light floor on hidden entries — a one-word weakness and trivially-short secrets are
    dropped so a degraded list never replaces the seeded hidden material."""
    degraded = dict(_FULL, weakness="loyal", secrets=["x", "no"])
    prof = A.parse_authored_profile(json.dumps(degraded), "npc:11")
    assert prof is not None
    assert "weakness" not in prof, "a one-word weakness would overwrite the seeded value"
    assert "secrets" not in prof, "all-trivial secrets would overwrite the seeded list"
    # a rich biography still survives alongside the dropped hidden fields
    assert prof["biography"] == _FULL["biography"]


# ── #849 — the PUBLIC occupation (vocation) is authored in lockstep with the biography ─────────────

def test_849_prompt_instructs_vocation_lockstep_with_the_biography():
    """#849: the producer prompt must (a) request a `vocation` key, and (b) instruct the model to keep
    the public occupation and the biography naming the SAME job (so the engine's hidden stakes, keyed
    off vocation, cohere with the job the player reads)."""
    msgs = A.build_authoring_messages({"id": "npc:1", "name": "Dana Reyes", "vocation": "welder"})
    system = msgs[0]["content"]
    assert '"vocation"' in system
    low = system.lower()
    assert "occupation" in low and "same job" in low
    # vocation is a PUBLIC field the parser forwards (it crosses to the player, in lockstep with the bio)
    assert "vocation" in A._PUBLIC_KEYS


def test_849_parser_forwards_an_authored_vocation():
    prof = A.parse_authored_profile(json.dumps(dict(_FULL, vocation="court reporter")), "npc:7")
    assert prof["vocation"] == "court reporter"


def test_849_parser_collapses_whitespace_and_drops_a_runaway_vocation():
    # a clean noun phrase has its internal whitespace/newlines collapsed
    prof = A.parse_authored_profile(json.dumps(dict(_FULL, vocation="  court\n reporter ")), "npc:7")
    assert prof["vocation"] == "court reporter"
    # a runaway paragraph masquerading as an occupation is dropped (the seeded vocation then stands)
    runaway = "a court reporter who also " + ("moonlights " * 20)
    prof2 = A.parse_authored_profile(json.dumps(dict(_FULL, vocation=runaway)), "npc:7")
    assert "vocation" not in prof2
    # an empty / blank vocation is simply not forwarded
    assert "vocation" not in A.parse_authored_profile(json.dumps(dict(_FULL, vocation="   ")), "npc:7")


# ── #1395: the idiolect VOICE fingerprint carries an OPTIONAL catchphrase set ──────────────────────
# A complete authored voice: six dials + a prose signature + a habitual lexicon + characteristic catchphrases.
_VOICE = {
    "register": "plainspoken", "rhythm": "clipped", "energy": "warm", "directness": "blunt",
    "humor": "dry", "stressTell": "goes quiet", "signature": "lands every point like it's the last word",
    "lexicon": ["honestly", "for real"], "catchphrases": ["at the end of the day", "we move"],
}


def test_1395_prompt_asks_for_catchphrases_in_the_voice_idiolect():
    system = A._SYSTEM.lower()
    assert "catchphrases" in system
    # framed as authentic phrasings, NOT comedy bits
    assert "not comedy bits" in system or "authentic verbal habits" in system


def test_1395_parser_forwards_a_wellformed_catchphrase_set_inside_the_voice():
    prof = A.parse_authored_profile(json.dumps(dict(_FULL, voice=_VOICE)), "npc:7")
    assert prof["voice"]["catchphrases"] == ["at the end of the day", "we move"]
    # the core voice still folds alongside it (whole dials + lexicon)
    assert prof["voice"]["register"] == "plainspoken"
    assert prof["voice"]["lexicon"] == ["honestly", "for real"]


def test_1395_parser_trims_and_caps_the_catchphrases():
    # FE parser strips + drops empties + caps at 3 (internal-whitespace collapse is the engine's job in
    # sanitizeAuthoredVoice, mirroring the sibling lexicon convention).
    noisy = dict(_VOICE, catchphrases=["  we move  ", "", " it is what it is ", "no cap", "one too many"])
    prof = A.parse_authored_profile(json.dumps(dict(_FULL, voice=noisy)), "npc:7")
    assert prof["voice"]["catchphrases"] == ["we move", "it is what it is", "no cap"]


def test_1395_catchphrases_are_a_bonus_never_a_gate():
    # A voice WITHOUT catchphrases still folds whole (back-compat with the #1409 authoring path).
    no_cats = {k: v for k, v in _VOICE.items() if k != "catchphrases"}
    prof = A.parse_authored_profile(json.dumps(dict(_FULL, voice=no_cats)), "npc:7")
    assert "catchphrases" not in prof["voice"]
    assert prof["voice"]["register"] == "plainspoken"
    # Garbage catchphrases are dropped but the core voice still lands.
    garbage = dict(_VOICE, catchphrases=["", "   "])
    prof2 = A.parse_authored_profile(json.dumps(dict(_FULL, voice=garbage)), "npc:7")
    assert "catchphrases" not in prof2["voice"]
    assert prof2["voice"]["register"] == "plainspoken"
    # A non-list catchphrases value is ignored the same way (core voice still folds).
    prof3 = A.parse_authored_profile(json.dumps(dict(_FULL, voice=dict(_VOICE, catchphrases="we move"))), "npc:7")
    assert "catchphrases" not in prof3["voice"]


# ── 2026-07-21 prompt audit — the LOOK BRIEF + fixed ink budget (the tattoo-uniformity index case) ──

def test_2026_07_21_seeded_physical_characteristics_thread_into_the_skeleton_as_the_look_brief():
    """The engine deals the cast-wide capped look spread (incl. the visible-ink budget); the authoring
    prompt must SEE it (the brief to sharpen) instead of inventing the whole look from the model's
    tattoo prior (the 'full sleeve of tattoos x4' live-bundle defect)."""
    phys = {"heightBuild": "stocky and powerful", "skinTone": "warm tan complexion",
            "hair": "a close-cropped fade", "facialFeatures": "a square jaw",
            "distinguishingMark": "a faint scar above one eyebrow",
            "ageLook": "settled, thirties", "style": "sturdy workwear"}
    msgs = A.build_authoring_messages({"id": "npc:1", "name": "Dana Reyes", "vocation": "welder",
                                       "physicalCharacteristics": phys})
    user = msgs[1]["content"]
    assert "a faint scar above one eyebrow" in user  # the seeded mark reaches the model as the brief
    # absent facet => no fabricated key (back-compatible skeleton assembly)
    plain = A.build_authoring_messages({"id": "npc:2", "vocation": "welder"})[1]["content"]
    assert "physicalCharacteristics" not in plain


def test_2026_07_21_system_prompt_fixes_the_ink_budget_and_widens_the_mark_menu():
    """The system prompt must state the ink budget is FIXED (no tattoo in the brief => none authored)
    and keep the distinguishing mark as dealt (ORW-480; it used to steer toward a wide menu) —
    never a default tattoo."""
    system = A.build_authoring_messages({"id": "npc:1", "vocation": "welder"})[0]["content"]
    low = system.lower()
    assert "ink budget is fixed" in low
    assert "no visible tattoos" in low
    assert "never" in low and "default to a tattoo" in low
    # ORW-480: the mark is DEALT by the engine (a pool of 44, each at most once per cast); the writer copies it and never adds its own
    for word in ("the mark is dealt", "none notable", "no scars, birthmarks or tooth gaps"):
        assert word in low, word
