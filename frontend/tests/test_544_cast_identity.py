"""Issue #544 (FE half) — the AI-driven cast-identity seed.

The producer-LLM PROPOSES the whole cast's DESCRIPTIVE identity facets (heritage / gender presentation /
orientation / disclosure / age) to U.S.-population rates and writes them BACK; the ENGINE validates/repairs/
folds (tested on the engine side). This FE pipeline takes INJECTED llm + write functions, so it is testable
with no live model or engine. We pin: the producer prompt (US-rate, player-independent, descriptive-only),
the tolerant parser (recognized-only, type-coerced, unknown-id/sub-floor dropped), the orchestration
(best-effort, fail-soft no-op when no model), and the prewarm wiring (identity runs BEFORE authoring).

Roles only — no names ingested as data; the player is always skipped (only the player's profile is
human-authored). Nothing about hidden game weights / the player is ever proposed (anti-sycophancy #3).
"""
import asyncio
import inspect

from src import orwell_cast_identity as I


def _run(coro):
    # FE convention: drive on the EXISTING session loop (never asyncio.run, which closes the loop).
    return asyncio.get_event_loop().run_until_complete(coro)


_CAST = [
    {"id": "npc:1", "name": "Houseguest One", "age": 27, "vocation": "nurse", "hometown": "Phoenix, AZ"},
    {"id": "npc:2", "name": "Houseguest Two", "age": 41, "vocation": "contractor", "hometown": "Tampa, FL"},
    {"id": "player", "name": "The Player"},
]


# ── the producer prompt ───────────────────────────────────────────────────────

def test_prompt_is_us_rate_framed_descriptive_only_and_player_independent():
    msgs = I.build_identity_messages(_CAST)
    assert msgs[0]["role"] == "system"
    system = msgs[0]["content"]
    assert "CASTING PRODUCER" in system
    assert "JSON" in system
    # US-population framing across the owner's axes (race/ethnicity, gender, sex, sexuality).
    low = system.lower()
    assert "u.s. population rates" in low
    for axis in ("race/ethnicity", "gender", "sex", "sexuality"):
        assert axis in low, axis
    # descriptive-only: the prompt offers ONLY identity keys — never a hidden game weight / Day-1 read.
    for weighty in ("day-1", "day one", "trust", "threat", "competition lean", "perception"):
        assert weighty not in low, weighty
    user = msgs[1]["content"]
    # builds FROM the public roster facets (cohere with name / hometown / vocation).
    assert "nurse" in user and "Phoenix, AZ" in user

    # NO player coupling anywhere in this module (the cast identity is proposed player-independently).
    src = inspect.getsource(I)
    assert "player" in src  # only ever to SKIP the player
    # the player roster entry is never offered to the model
    assert "The Player" not in user


# ── the tolerant parser (recognized-only) ──────────────────────────────────────

def test_parser_keeps_only_recognized_facets_for_known_ids():
    valid = {"npc:1", "npc:2"}
    text = (
        '{"npc:1": {"ethnicity": "Korean American", "genderPresentation": "woman", '
        '"orientation": "bisexual", "out": true, "age": 41},'
        '"npc:2": {"ethnicity": "Black American", "age": 30}}'
    )
    facets = I.parse_identity_facets(text, valid)
    assert facets["npc:1"] == {
        "ethnicity": "Korean American", "genderPresentation": "woman",
        "orientation": "bisexual", "out": True, "age": 41,
    }
    assert facets["npc:2"] == {"ethnicity": "Black American", "age": 30}


def test_parser_drops_unknown_values_unknown_ids_and_sub_floor_ages():
    valid = {"npc:1"}
    text = (
        '{"npc:1": {"ethnicity": "Atlantean", "genderPresentation": "robot", '
        '"orientation": "not-real", "age": 12},'
        '"npc:99": {"ethnicity": "Irish American"},'      # unknown id
        '"player": {"ethnicity": "Irish American"}}'      # never the player
    )
    facets = I.parse_identity_facets(text, valid)
    # npc:1 had ONLY unrecognized values + a sub-floor age ⇒ nothing usable ⇒ dropped entirely.
    assert "npc:1" not in facets
    assert "npc:99" not in facets
    assert "player" not in facets


def test_parser_is_fenced_json_tolerant_and_empty_on_garbage():
    valid = {"npc:1"}
    fenced = '```json\n{"npc:1": {"age": 33}}\n```'
    assert I.parse_identity_facets(fenced, valid) == {"npc:1": {"age": 33}}
    assert I.parse_identity_facets("no json here", valid) == {}
    assert I.parse_identity_facets("", valid) == {}


# ── F1: the doubled-object failure shape (the gender-drop root cause) ───────────

def test_extract_json_returns_the_first_object_of_a_doubled_reply():
    """The identity utility model sometimes emits its object TWICE (``{obj}{obj}``). The old brittle
    first-``{``→last-``}`` slice spliced that into invalid JSON → the whole parse collapsed to None → the
    engine's gender re-cohere never ran → 8/15 houseguests shipped the wrong gender. The robust extractor
    decodes and STOPS at the first complete object."""
    obj = '{"npc:1": {"genderPresentation": "woman"}}'
    doubled = obj + obj
    got = I._extract_json(doubled)
    assert got == {"npc:1": {"genderPresentation": "woman"}}
    # A single well-formed object is byte-identical (the common case must not regress).
    assert I._extract_json(obj) == {"npc:1": {"genderPresentation": "woman"}}


def test_doubled_reply_still_seeds_every_gender_end_to_end():
    """The failure shape drove the bug all the way through: a doubled reply used to parse to ``{}`` and
    ``parse_identity_facets`` returned nothing, so ``recordCastIdentity`` was never called. It must now
    yield the full facet map for EVERY houseguest (incl. a diverse spread — nonbinary preserved)."""
    valid = {"npc:1", "npc:2", "npc:3"}
    one = (
        '{"npc:1": {"genderPresentation": "woman"},'
        ' "npc:2": {"genderPresentation": "man"},'
        ' "npc:3": {"genderPresentation": "nonbinary"}}'
    )
    doubled = one + one  # the exact `{obj}{obj}` shape from the live debug bundle
    facets = I.parse_identity_facets(doubled, valid)
    assert facets == {
        "npc:1": {"genderPresentation": "woman"},
        "npc:2": {"genderPresentation": "man"},
        "npc:3": {"genderPresentation": "nonbinary"},  # diversity preserved, not flattened
    }


def test_extract_json_tolerates_chatter_around_a_doubled_object():
    text = 'Sure! Here is the cast:\n{"npc:1": {"age": 33}}{"npc:1": {"age": 99}}\nHope that helps.'
    assert I._extract_json(text) == {"npc:1": {"age": 33}}


# ── the orchestrator (best-effort, fail-soft) ──────────────────────────────────

def test_seed_writes_the_proposal_back_and_returns_applied():
    captured = {}

    async def llm(_messages):
        return '{"npc:1": {"ethnicity": "Mexican American", "age": 38}}'

    async def write(facets):
        captured["facets"] = facets
        return {"accepted": True, "applied": 1}

    n = _run(I.seed_cast_identity(_CAST, llm, write))
    assert n == 1
    # ORW-480: ages are dealt from the real distribution for every houseguest; the writer's 38 is not used
    assert captured["facets"]["npc:1"]["ethnicity"] == "Mexican American"
    assert set(captured["facets"]) == {"npc:1", "npc:2"} and all(21 <= f["age"] <= 70 for f in captured["facets"].values())
    assert "player" not in captured["facets"]


def test_seed_is_a_noop_when_nothing_usable_is_proposed():
    wrote = {"called": False}

    async def llm(_messages):
        return "the model rambled, no json"

    async def write(_facets):
        wrote["called"] = True
        return {"accepted": True, "applied": 0}

    n = _run(I.seed_cast_identity(_CAST, llm, write))
    assert n == 0
    assert wrote["called"] is False  # never writes an empty proposal — the floor stands


def test_seed_is_fail_soft_when_the_model_or_write_back_raises():
    async def llm_boom(_messages):
        raise RuntimeError("model down")

    async def write(_facets):
        return {"accepted": True, "applied": 1}

    assert _run(I.seed_cast_identity(_CAST, llm_boom, write)) == 0

    async def llm_ok(_messages):
        return '{"npc:1": {"age": 33}}'

    async def write_boom(_facets):
        raise RuntimeError("engine down")

    assert _run(I.seed_cast_identity(_CAST, llm_ok, write_boom)) == 0


def test_seed_reports_a_rejected_write_back_as_a_noop():
    async def llm(_messages):
        return '{"npc:1": {"age": 33}}'

    async def write(_facets):
        return {"accepted": False, "reason": "no cast to fold identity onto"}

    assert _run(I.seed_cast_identity(_CAST, llm, write)) == 0


def test_seed_skips_an_empty_or_player_only_cast():
    async def llm(_messages):  # pragma: no cover - never called
        raise AssertionError("should not call the model for an empty cast")

    async def write(_facets):  # pragma: no cover
        raise AssertionError("should not write for an empty cast")

    assert _run(I.seed_cast_identity([{"id": "player"}], llm, write)) == 0
    assert _run(I.seed_cast_identity([], llm, write)) == 0


# ── prewarm wiring: identity runs BEFORE authoring ─────────────────────────────

def test_prewarm_seeds_identity_before_authoring():
    """The pipeline ORDER (#544): pre_seed → AI identity → deep author. The prewarm orchestrator must
    invoke the identity seed before it kicks authoring, and a missing model must not break the chain."""
    from src import orwell_prewarm as P
    P.reset()

    order = []

    class _FakeEngine:
        def __init__(self):
            self.calls = 0

        async def pre_seed_cast(self, user=None):
            self.calls += 1
            order.append(f"pre_seed:{self.calls}")
            return {
                "warmed": True, "seed": 5,
                "house": [{"id": "npc:1", "name": "Houseguest One", "biography": "A deep bio. Two."}],
                "portraitPrompts": [{"houseguestId": "npc:1", "name": "Houseguest One", "prompt": "a portrait"}],
            }

    class _FakeIdentity:
        async def run_identity(self, cast, user, *, write=None):
            order.append("identity")
            return 1  # applied ⇒ prewarm re-fetches the roster

    class _FakeAuthoring:
        def kickoff_authoring(self, cast, user, then=None, on_authored=None, write=None, seed=None):
            order.append("author")
            if on_authored:
                for npc in (cast or []):
                    if npc.get("id") and npc.get("id") != "player":
                        on_authored(npc["id"])
            if then:
                then()

    res = _run(P.prewarm_cast("u1", engine=_FakeEngine(), authoring=_FakeAuthoring(), identity=_FakeIdentity()))
    assert res["warmed"] is True
    # identity ran AFTER the first pre_seed and BEFORE authoring; the applied re-fetch is the 2nd pre_seed.
    assert order == ["pre_seed:1", "identity", "pre_seed:2", "author"]


def test_prewarm_identity_failure_never_blocks_authoring():
    from src import orwell_prewarm as P
    P.reset()

    seen = []

    class _FakeEngine:
        async def pre_seed_cast(self, user=None):
            return {
                "warmed": True, "seed": 7,
                "house": [{"id": "npc:1", "name": "Houseguest One"}],
                "portraitPrompts": [],
            }

    class _BoomIdentity:
        async def run_identity(self, cast, user, *, write=None):
            raise RuntimeError("identity model down")

    class _FakeAuthoring:
        def kickoff_authoring(self, cast, user, then=None, on_authored=None, write=None, seed=None):
            seen.append("author")
            if then:
                then()

    res = _run(P.prewarm_cast("u1", engine=_FakeEngine(), authoring=_FakeAuthoring(), identity=_BoomIdentity()))
    assert res["warmed"] is True
    assert seen == ["author"]  # authoring still ran despite the identity failure
