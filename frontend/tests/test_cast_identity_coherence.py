"""Issue #1660 — cast-identity coherence: the FE belt that stops deep-authoring from committing a
houseguest whose photo contradicts their narration.

Pins the three tractable fixes for the 2026-07-16 debug bundle (5 gender-flipped houseguests, a
retired-principal 22-year-old):

  * F2 — the author-time WRITE-BACK coherence lint (this PR): an authored profile whose
    self-referential prose contradicts the houseguest's PINNED identity is refused (the contradicting
    field is dropped to the coherent seeded floor) BEFORE `recordCastProfile`, and a RED-eligible
    `identity-incoherence` health event is recorded (#1599). A coherent dossier is a byte-identical no-op.
  * F3 — reasoning-channel salvage (landed #1662, pinned here): when the visible body is empty but the
    model MISROUTED the JSON answer into the reasoning channel, the paid-for content is USED, not
    discarded, and a RED reasoning-channel-misroute event is recorded.
  * F4 — genesis token budget (landed #1662, pinned here): the full-cast genesis sketch output floor
    clears the ~4400-token skeleton with headroom, so the whole-cast skeleton is never chopped at the
    one-NPC-sized 3000 cap (`finish_reason=length` → committed nothing).

Roles only — every probe string is generic (no houseguest names).
"""

import asyncio
import importlib
import json

import pytest

ca = importlib.import_module("src.orwell_cast_authoring")
enrichment_policy = importlib.import_module("src.enrichment_policy")
log_rings = importlib.import_module("src.log_rings")
token_policy = importlib.import_module("src.token_policy")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _clear_rings():
    for ring in (log_rings.OVERSEER, log_rings.LLMIO, log_rings.IO, log_rings.LIVE):
        ring.buf.clear()


def _overseer_kinds_failed():
    _, lines = log_rings.OVERSEER.since(0, limit=100000)
    return {e.get("kind") for e in lines if e.get("ok") is False}


@pytest.fixture
def _clean_ledger():
    enrichment_policy.clear_failures()
    _clear_rings()
    yield
    enrichment_policy.clear_failures()


# A well-formed authored profile whose PROSE is authored for the OPPOSITE gender — the bundle's
# gender-flip shape (a "man" houseguest narrated as "she"). The bio clears the quality floor so it is
# parsed into the write-back (and is therefore the field the lint must strip).
_FEM_BIO = ("She grew up in a small coastal town and always loved a good challenge. She applied on a "
            "whim and never once looked back, chasing her own quiet ambition all season.")
_MASC_BIO = ("He grew up in a small coastal town and always loved a good challenge. He applied on a "
             "whim and never once looked back, chasing his own quiet ambition all season.")


def _phys(mark="a small compass tattoo on the left wrist"):
    """A complete 7-key physical facet (the engine folds it whole-or-nothing). `mark` is neutral by
    default; pass a gendered mark to exercise the facet-drop path."""
    return {
        "heightBuild": "average height, lean", "skinTone": "olive", "hair": "short dark",
        "facialFeatures": "sharp jaw", "distinguishingMark": mark, "ageLook": "looks about forty",
        "style": "understated",
    }


# ══════════════════════════ F2 — the author-time write-back coherence lint ══════════════════════════


def test_coherence_conflicts_flags_a_gender_flipped_biography():
    # The pure lint: a feminine self-referential bio contradicts a pinned "man".
    npc = {"id": "npc:1", "genderPresentation": "man"}
    assert ca.coherence_conflicts({"biography": _FEM_BIO}, npc) == ["biography"]
    # ...and the mirror: a masculine bio contradicts a pinned "woman".
    assert ca.coherence_conflicts({"biography": _MASC_BIO}, {"genderPresentation": "woman"}) == ["biography"]


def test_coherence_conflicts_is_conservative_about_relatives():
    # A bio that MENTIONS an opposite-gender relative but self-refers in the pinned gender is NOT a flip
    # (the subject's own pronoun is present) — the lint must not false-positive here.
    npc = {"id": "npc:1", "genderPresentation": "man"}
    bio = ("He runs a bakery with his wife; she keeps the books while he works the ovens. He never "
           "misses a farmers market.")
    assert ca.coherence_conflicts({"biography": bio}, npc) == []
    # A coherent, pin-matching bio + neutral facet is a clean no-op.
    assert ca.coherence_conflicts({"biography": _MASC_BIO, "physicalCharacteristics": _phys()}, npc) == []


def test_coherence_conflicts_flags_a_gender_flipped_distinguishing_mark():
    # The portrait reads the physical facet; a distinguishingMark self-referring in the opposite gender
    # drops the WHOLE facet to the coherent floor (whole-or-nothing).
    npc = {"id": "npc:1", "genderPresentation": "man"}
    profile = {"physicalCharacteristics": _phys(mark="a faded tattoo on her left forearm")}
    assert ca.coherence_conflicts(profile, npc) == ["physicalCharacteristics"]


def test_coherence_conflicts_flags_an_elder_life_stage_on_a_young_age():
    # The bundle's Donna shape: a young pinned age beside a retired / decades-long-career self-bio.
    npc = {"id": "npc:1", "age": 22}
    bio = ("She is a retired principal who spent thirty years in the classroom before this. She now "
           "spends her days gardening.")
    assert ca.coherence_conflicts({"biography": bio}, npc) == ["biography"]
    # An age-appropriate bio at the same young age is fine.
    ok = ("She is a first-year teacher who just finished her degree. She loves a good debate and a "
          "long run.")
    assert ca.coherence_conflicts({"biography": ok}, npc) == []


def test_incoherent_profile_is_refused_and_red_recorded(_clean_ledger):
    # END TO END through author_cast: a profile whose ONLY authored field is a gender-flipped bio is
    # REFUSED (nothing coherent left ⇒ the seeded floor stands) and a RED identity-incoherence health
    # event is recorded — the contradiction never reaches the write-back.
    async def _llm(_messages):
        return json.dumps({"biography": _FEM_BIO})

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "player"}, {"id": "npc:1", "name": "Some One", "genderPresentation": "man"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 0, "a dossier that contradicts the pinned identity must not commit"
    assert written_profiles == [], "the contradicting profile must never reach recordCastProfile"
    classes = {r["callClass"] for r in enrichment_policy.failures("probe-user")}
    assert "identity-incoherence" in classes, (
        "a write-back that contradicts the pinned identity must record a RED identity-incoherence event")
    assert "enrichment:identity-incoherence" in _overseer_kinds_failed()


def test_incoherent_field_is_stripped_but_coherent_fields_still_write(_clean_ledger):
    # The lint drops ONLY the contradicting field: a flipped bio is stripped, but the coherent facet +
    # secrets still commit (non-degradation — keep what is good, floor only what contradicts).
    async def _llm(_messages):
        return json.dumps({
            "biography": _FEM_BIO,  # contradicts the pinned "man" — must be dropped
            "physicalCharacteristics": _phys(),  # neutral — kept
            "secrets": ["harbors a long-held grudge from a past season", "secretly funds a rival's campaign"],
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "player"}, {"id": "npc:1", "genderPresentation": "man", "biography": "A seeded floor biography that the engine keeps when the writer omits its own."}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1, "the coherent remainder of the dossier still commits"
    assert len(written_profiles) == 1
    committed = written_profiles[0]
    assert "biography" not in committed, "the gender-flipped biography must be dropped before write-back"
    assert "physicalCharacteristics" in committed and "secrets" in committed, "coherent fields survive"
    assert "identity-incoherence" in {r["callClass"] for r in enrichment_policy.failures("probe-user")}


def test_coherent_cast_is_a_byte_identical_no_op(_clean_ledger):
    # The lint must NEVER fire on a coherent cast — a pin-matching dossier commits whole with zero
    # health events (this is what keeps soft/golden byte-identical).
    async def _llm(_messages):
        return json.dumps({
            "biography": _MASC_BIO,  # matches the pinned "man"
            "physicalCharacteristics": _phys(),
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "player"}, {"id": "npc:1", "genderPresentation": "man"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    assert "biography" in written_profiles[0], "a coherent biography is preserved"
    assert not any(r["callClass"] == "identity-incoherence" for r in enrichment_policy.failures("probe-user"))


# ══════════════════════════ F3 — reasoning-channel salvage (landed #1662) ══════════════════════════


def test_reasoning_channel_json_is_recovered_not_dropped():
    # The pure detector: a JSON answer misrouted into the reasoning channel is recovered as a JSON string.
    genesis = importlib.import_module("src.orwell_cast_genesis")
    payload = {"biography": _MASC_BIO, "vocation": "court reporter"}
    reasoning = "Let me think about this houseguest... " + json.dumps(payload) + " that should do it."
    recovered = genesis.recover_reasoning_channel_json(reasoning)
    assert recovered is not None, "content in the reasoning channel must be recovered, not dropped"
    assert json.loads(recovered)["vocation"] == "court reporter"
    # Reasoning with no JSON object at all → None (the caller then keeps the empty body ⇒ floor).
    assert genesis.recover_reasoning_channel_json("just thinking out loud, no json here") is None


def test_recover_from_reasoning_channel_uses_content_and_records_red(_clean_ledger):
    # The cast-authoring salvage: it returns the recovered JSON STRING (so the normal parser consumes it)
    # AND records a RED reasoning-channel-misroute health event — paid-for content is USED, never a
    # silent discard (#1599).
    payload = {"biography": _MASC_BIO, "vocation": "court reporter",
               "secrets": ["keeps a hidden ledger of every promise made"]}
    reasoning = "reasoning: " + json.dumps(payload)
    recovered = ca._recover_from_reasoning_channel(reasoning, "probe-user")
    assert recovered is not None, "the reasoning-channel content must be used"
    # The recovered string flows through the normal authoring parser into a usable write-back profile.
    parsed = ca.parse_authored_profile(recovered, "npc:1")
    assert parsed is not None and parsed.get("vocation") == "court reporter"
    classes = {r["callClass"] for r in enrichment_policy.failures("probe-user")}
    assert "cast-genesis" in classes, "a reasoning-channel misroute must be RED-recorded, not swallowed"
    assert "enrichment:cast-genesis" in _overseer_kinds_failed()


# ══════════════════════════ F4 — genesis token budget (landed #1662) ══════════════════════════


def test_genesis_sketch_floor_clears_the_skeleton_estimate():
    # The whole-cast genesis sketch is ONE completion carrying the ~4400-token 15-NPC skeleton; its
    # output floor must clear that with headroom (the 3000 one-NPC class cap chopped it → committed 0).
    assert token_policy.GENESIS_SKELETON_TOKEN_ESTIMATE >= 4400
    assert token_policy.GENESIS_SKETCH_MIN_OUTPUT_TOKENS >= token_policy.GENESIS_SKELETON_TOKEN_ESTIMATE, (
        "the genesis sketch output floor must clear the 15-NPC skeleton estimate")


def test_genesis_floor_exceeds_the_per_npc_class_cap_that_truncated():
    # The load-bearing fix: the genesis floor must exceed the per-NPC background-authoring class cap
    # (3000) that caused finish_reason=length on the whole-cast sketch.
    per_npc_cap = token_policy.resolve_token_policy("background-authoring").get("max_tokens")
    assert per_npc_cap == 6000, "the per-NPC background-authoring class cap is the 6000 that replaced the 3000 that truncated"
    assert token_policy.GENESIS_SKETCH_MIN_OUTPUT_TOKENS > per_npc_cap, (
        "the whole-cast genesis floor must exceed the one-NPC class cap that chopped the skeleton")
    # A finish_reason=length can grow the cap (the retry ceiling sits above the genesis floor).
    assert token_policy.LENGTH_RETRY_MAX_TOKENS >= token_policy.GENESIS_SKETCH_MIN_OUTPUT_TOKENS


def test_authoring_resolver_accepts_the_genesis_output_floor():
    # F4 plumbing: the authoring resolver takes a per-call `min_output_tokens` floor (the genesis sketch
    # raises the resolved cap to the whole-cast size); the signature is what the genesis path introspects.
    import inspect
    params = inspect.signature(ca.resolve_authoring_llm_fn).parameters
    assert "min_output_tokens" in params, (
        "resolve_authoring_llm_fn must accept min_output_tokens so genesis can raise the sketch cap")


# ══════════════════ F1 (FE) — roster-constrained authoring: identity is IMMUTABLE ══════════════════
#
# The committed roster owns each houseguest's name / gender / vocation / age BEFORE deep authoring runs
# (genesis skeleton → 0063 identity → author). Deep authoring EXTENDS that person; it must never
# re-invent them into a different one (the issue's "occupation-crosswired" houseguests). These pin the
# pure structured-field guard + its end-to-end drop-and-RED behavior + the prompt constraint.


def _overseer_kinds_failed_for(user):
    _, lines = log_rings.OVERSEER.since(0, limit=100000)
    return {e.get("kind") for e in lines if e.get("ok") is False and e.get("user") == user}


def test_identity_contradictions_drops_a_crosswired_vocation():
    # A DIFFERENT job (no shared distinctive token) is a crosswire → dropped so the committed job stands.
    npc = {"id": "npc:1", "vocation": "concierge"}
    assert ca.identity_contradictions({"vocation": "bartender"}, npc) == ["vocation"]
    # A refinement that shares a distinctive token is NOT a crosswire (kept).
    assert ca.identity_contradictions({"vocation": "court reporter"}, {"vocation": "reporter"}) == []
    assert ca.identity_contradictions({"vocation": "chef"}, {"vocation": "private chef"}) == []
    # Case / whitespace / stopword-only differences never read as a crosswire.
    assert ca.identity_contradictions({"vocation": "Senior Welder"}, {"vocation": "welder"}) == []
    # No committed vocation ⇒ nothing to contradict (an authored vocation freely EXTENDS).
    assert ca.identity_contradictions({"vocation": "bartender"}, {"id": "npc:1"}) == []
    # A coherent dossier is a clean no-op.
    assert ca.identity_contradictions({"vocation": "welder", "biography": _MASC_BIO}, {"vocation": "welder"}) == []


def test_identity_contradictions_defensive_gender_and_age():
    # DEFENSIVE structured-field guards: `parse_authored_profile` does not forward these today, but the
    # pure guard is complete + ready if a future parse path did — a value differing from the committed
    # pin is dropped (never overwriting the engine-owned identity).
    assert ca.identity_contradictions({"genderPresentation": "woman"}, {"genderPresentation": "man"}) == [
        "genderPresentation"]
    assert ca.identity_contradictions({"age": 55}, {"age": 24}) == ["age"]
    # Matching values ⇒ no drop.
    assert ca.identity_contradictions({"genderPresentation": "man", "age": 24},
                                      {"genderPresentation": "man", "age": 24}) == []


def test_authoring_prompt_carries_the_immutable_roster_constraints():
    # F1 prompt: the deep-authoring call must feed the committed name/gender/vocation/age as an IMMUTABLE
    # constraint with an EXTEND-not-overwrite instruction, so the model cannot re-invent the identity.
    npc = {"id": "npc:1", "name": "Some One", "genderPresentation": "man", "vocation": "concierge", "age": 29}
    user = ca.build_authoring_messages(npc)[1]["content"]
    low = user.lower()
    assert "immutable" in low, "the prompt must mark the committed identity IMMUTABLE"
    assert "concierge" in user, "the committed occupation is fed as a hard constraint"
    assert "extend" in low, "authored fields must be framed as EXTENDING, not overwriting, the identity"
    assert "different job" in low, "the prompt must forbid implying a different occupation (F5 source-pin)"
    # A skeleton with no immutable facets adds no constraint clause (byte-safe for a bare roster entry).
    bare = ca.build_authoring_messages({"id": "npc:2"})[1]["content"]
    assert "fixed identity" not in bare.lower()


def test_crosswired_vocation_is_dropped_and_red_recorded(_clean_ledger):
    # END TO END through author_cast: an authored profile whose vocation names a DIFFERENT job than the
    # committed roster has that vocation DROPPED (the committed job stands) while the coherent fields
    # (biography, physical facet) still commit, and a RED identity-contradiction health event is recorded.
    async def _llm(_messages):
        return json.dumps({
            "vocation": "bartender",             # crosswires the committed "concierge" — must be dropped
            "biography": _MASC_BIO,              # coherent with the pinned "man" — kept
            "physicalCharacteristics": _phys(),  # neutral — kept
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "player"},
            {"id": "npc:1", "genderPresentation": "man", "vocation": "concierge"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1, "the coherent remainder of the dossier still commits"
    committed = written_profiles[0]
    assert "vocation" not in committed, "the crosswired vocation must be dropped so the committed job stands"
    assert "biography" in committed and "physicalCharacteristics" in committed, "coherent fields survive"
    assert "cast-authoring:identity-contradiction" in _overseer_kinds_failed_for("probe-user"), (
        "a crosswired vocation must record a RED identity-contradiction event, never a silent overwrite")


def test_coherent_vocation_is_a_byte_identical_no_op(_clean_ledger):
    # A matching authored vocation (a refinement of the committed one) commits untouched with no health
    # event — this is what keeps a coherent cast byte-identical.
    async def _llm(_messages):
        return json.dumps({"vocation": "hotel concierge", "biography": _MASC_BIO,
                           "physicalCharacteristics": _phys()})

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "man", "vocation": "concierge"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    assert written_profiles[0].get("vocation") == "hotel concierge", "a coherent vocation is preserved"
    assert "cast-authoring:identity-contradiction" not in _overseer_kinds_failed_for("probe-user")


# ══════════════════ F5 — secrets constrained to the committed identity (vocation INCLUDED) ══════════════════
#
# The hidden threads (secrets / trueGoals / weakness) are authored in the SAME call as the vocation, so a
# crosswired job means they were grounded in the WRONG identity — they must not commit against the correct
# committed vocation. Dropping them lets the engine re-derive the hidden stakes off the committed job.


def test_secret_vocation_conflicts_flags_hidden_threads_on_a_crosswire():
    npc = {"id": "npc:1", "vocation": "concierge"}
    profile = {"vocation": "bartender", "secrets": ["skims from the register nightly"],
               "trueGoals": ["reach the end quietly"], "weakness": "too trusting once bought a round"}
    assert ca.secret_vocation_conflicts(profile, npc) == ["secrets", "trueGoals", "weakness"]
    # No crosswire (coherent vocation) ⇒ the hidden threads are grounded in the right job — never flagged.
    assert ca.secret_vocation_conflicts({"vocation": "concierge", "secrets": ["a real secret here"]}, npc) == []
    # A crosswire but no hidden threads present ⇒ nothing to drop.
    assert ca.secret_vocation_conflicts({"vocation": "bartender"}, npc) == []


def test_crosswired_vocation_also_drops_the_hidden_threads_end_to_end(_clean_ledger):
    # The full F5 belt: a crosswired vocation drops BOTH the vocation (F1) AND the hidden threads authored
    # around the wrong job (F5), and records a RED secret-identity-contradiction event. The engine then
    # re-grounds the secrets off the committed vocation (its seeded hidden floor stands).
    async def _llm(_messages):
        return json.dumps({
            "vocation": "bartender",  # crosswires the committed "concierge"
            "biography": _MASC_BIO,   # coherent — kept, so the write-back still commits
            "secrets": ["pockets cash from the bar tabs each shift", "hiding a gambling debt"],
            "trueGoals": ["win the money to clear the debt"],
            "weakness": "cannot resist a high-stakes bet",
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "man", "vocation": "concierge"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    committed = written_profiles[0]
    assert "vocation" not in committed, "the crosswired vocation is dropped (F1)"
    for k in ("secrets", "trueGoals", "weakness"):
        assert k not in committed, f"the hidden thread {k!r} authored around the wrong job must be dropped (F5)"
    assert "biography" in committed, "coherent fields still commit (non-degradation)"
    failed = _overseer_kinds_failed_for("probe-user")
    assert "cast-authoring:secret-identity-contradiction" in failed, (
        "hidden threads grounded in a crosswired vocation must record a RED secret-identity-contradiction")
    assert "cast-authoring:identity-contradiction" in failed, "the vocation crosswire itself is also RED"


def test_secrets_survive_a_coherent_vocation(_clean_ledger):
    # When the vocation is coherent, the secrets are generated against the committed identity and commit
    # untouched — F5 never strips a well-grounded hidden bible.
    async def _llm(_messages):
        return json.dumps({
            "vocation": "concierge", "biography": _MASC_BIO,
            "secrets": ["keeps a private ledger of every guest's secret"],
            "trueGoals": ["reach the end quietly"],
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "man", "vocation": "concierge"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    assert written_profiles[0].get("secrets"), "a coherent hidden bible is preserved"
    assert "cast-authoring:secret-identity-contradiction" not in _overseer_kinds_failed_for("probe-user")


# ══════════════════ F1 — the authored NAME may not overwrite the committed roster name ══════════════════
#
# parse_authored_profile DOES forward a reasonable authored name (out["name"] = name), so a model reply
# renaming a rostered houseguest would overwrite the committed identity — the name must be dropped like
# any other immutable field (bots on #1692).


def test_identity_contradictions_drops_a_rename_but_not_a_case_echo():
    # A genuine rename is dropped so the committed roster name stands.
    assert ca.identity_contradictions({"name": "Marcus Webb"}, {"name": "Some One"}) == ["name"]
    # A trivial case / whitespace echo of the SAME name is NOT flagged (normalized: strip + casefold).
    assert ca.identity_contradictions({"name": "some one"}, {"name": "Some One"}) == []
    assert ca.identity_contradictions({"name": "  Some One  "}, {"name": "Some One"}) == []
    # No committed name, or no authored name ⇒ nothing to contradict.
    assert ca.identity_contradictions({"name": "Marcus Webb"}, {"id": "npc:1"}) == []
    assert ca.identity_contradictions({"biography": "x"}, {"name": "Some One"}) == []


def test_a_rename_is_dropped_and_red_recorded(_clean_ledger):
    # END TO END: an authored (reasonable) name that renames the rostered houseguest is dropped before
    # the write-back so the committed name stands, and a RED identity-contradiction event is recorded.
    async def _llm(_messages):
        return json.dumps({"name": "Marcus Webb", "biography": _MASC_BIO,
                           "physicalCharacteristics": _phys()})

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "name": "Some One", "genderPresentation": "man"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1, "the coherent remainder still commits"
    committed = written_profiles[0]
    assert "name" not in committed, "a rename must be dropped so the committed roster name stands"
    assert committed.get("biography"), "coherent fields survive"
    assert "cast-authoring:identity-contradiction" in _overseer_kinds_failed_for("probe-user")


def test_a_matching_name_is_forwarded_untouched(_clean_ledger):
    # The model may echo the committed name (or a case/space variant) — it is forwarded, no health event.
    async def _llm(_messages):
        return json.dumps({"name": "Some One", "biography": _MASC_BIO})

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "name": "Some One", "genderPresentation": "man"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    assert written_profiles[0].get("name") == "Some One", "a matching name is preserved"
    assert "cast-authoring:identity-contradiction" not in _overseer_kinds_failed_for("probe-user")


# ══════════════════ F1/F5 — vocation coherence requires token CONTAINMENT, not mere intersection ══════════════════
#
# A shared GENERIC token ("engineer") is not a refinement — "software engineer" vs "civil engineer" are
# different jobs. Coherence holds only when one distinctive-token set contains the other (bots on #1692).


def test_shared_generic_token_vocation_is_a_crosswire_not_a_refinement():
    # Neither {software, engineer} nor {civil, engineer} contains the other ⇒ a crosswire (dropped),
    # even though they share the generic "engineer".
    assert ca.identity_contradictions({"vocation": "software engineer"},
                                      {"vocation": "civil engineer"}) == ["vocation"]
    # The intended refinement (containment) is STILL kept.
    assert ca.identity_contradictions({"vocation": "court reporter"}, {"vocation": "reporter"}) == []
    assert ca.identity_contradictions({"vocation": "reporter"}, {"vocation": "court reporter"}) == []


def test_shared_generic_token_crosswire_also_drops_the_secrets():
    # F5 reuses the F1 crosswire signal, so the mis-grounded secrets drop for the shared-generic case too.
    npc = {"vocation": "civil engineer"}
    prof = {"vocation": "software engineer", "secrets": ["ships a hidden backdoor"],
            "weakness": "cuts corners under deadline"}
    assert ca.secret_vocation_conflicts(prof, npc) == ["secrets", "weakness"]
    # A true refinement keeps the secrets (no crosswire).
    assert ca.secret_vocation_conflicts(
        {"vocation": "court reporter", "secrets": ["keeps a private transcript"]},
        {"vocation": "reporter"}) == []


def test_shared_generic_token_crosswire_drops_vocation_and_secrets_end_to_end(_clean_ledger):
    async def _llm(_messages):
        return json.dumps({
            "vocation": "software engineer",  # crosswires committed "civil engineer" (only "engineer" shared)
            "biography": _MASC_BIO,
            "secrets": ["ships code with a hidden backdoor", "hiding a lapsed license"],
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "man", "vocation": "civil engineer"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    committed = written_profiles[0]
    assert "vocation" not in committed, "the shared-generic-token crosswire is dropped"
    assert "secrets" not in committed, "secrets grounded in the crosswired job are dropped"
    failed = _overseer_kinds_failed_for("probe-user")
    assert "cast-authoring:identity-contradiction" in failed
    assert "cast-authoring:secret-identity-contradiction" in failed


# ══════════════ F1/F5 — a STOPWORD-ONLY committed vocation still guards against a crosswire ══════════════
#
# A committed occupation that is a single GENERIC word ("manager", "director") yields no distinctive
# token, so the distinctive-containment test would short-circuit on the empty set and never drop a
# crosswired authored vocation. The raw-token fallback (stopwords included, both sides) closes that gap
# (Greptile P1 on #1692).


def test_stopword_only_committed_vocation_still_catches_a_crosswire():
    # Committed "manager" (all-generic) vs authored "bartender" — the raw fallback still drops it.
    assert ca.identity_contradictions({"vocation": "bartender"}, {"vocation": "manager"}) == ["vocation"]
    # An exact echo of the generic committed vocation is NOT flagged.
    assert ca.identity_contradictions({"vocation": "manager"}, {"vocation": "manager"}) == []
    # A raw-superset refinement of a generic committed vocation ("senior manager") is NOT flagged.
    assert ca.identity_contradictions({"vocation": "senior manager"}, {"vocation": "manager"}) == []
    # The mirror: a distinctive committed job vs an all-generic authored one still drops (keep the real job).
    assert ca.identity_contradictions({"vocation": "manager"}, {"vocation": "engineer"}) == ["vocation"]


def test_stopword_only_committed_vocation_crosswire_dropped_and_red_end_to_end(_clean_ledger):
    # END TO END with a generic committed occupation: the crosswired vocation AND the secrets grounded in
    # the wrong job are dropped, both RED-recorded.
    async def _llm(_messages):
        return json.dumps({
            "vocation": "bartender",  # crosswires the generic committed "manager"
            "biography": _MASC_BIO,
            "secrets": ["pockets cash from the bar tabs"],
            "trueGoals": ["clear a gambling debt"],
            "weakness": "cannot resist a high-stakes bet",
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "man", "vocation": "manager"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    committed = written_profiles[0]
    assert "vocation" not in committed, "a crosswire off a generic committed vocation is dropped"
    for k in ("secrets", "trueGoals", "weakness"):
        assert k not in committed, f"the hidden thread {k!r} grounded in the wrong job must be dropped"
    failed = _overseer_kinds_failed_for("probe-user")
    assert "cast-authoring:identity-contradiction" in failed
    assert "cast-authoring:secret-identity-contradiction" in failed


def test_stopword_only_committed_vocation_f5_mirror():
    # F5 inherits the raw-token fallback: mis-grounded secrets drop when a generic committed vocation is
    # crosswired, and a matching/refinement generic vocation keeps them.
    npc = {"vocation": "manager"}
    prof = {"vocation": "bartender", "secrets": ["skims the register"],
            "trueGoals": ["reach the end"], "weakness": "trusts too fast today"}
    assert ca.secret_vocation_conflicts(prof, npc) == ["secrets", "trueGoals", "weakness"]
    # A refinement of the generic vocation keeps the secrets.
    assert ca.secret_vocation_conflicts(
        {"vocation": "senior manager", "secrets": ["a real secret here"]}, npc) == []


# ══════════ F1/F5 — SHORT-TOKEN + terminal fallbacks close the empty-token guard-skip class ══════════
#
# A 2-letter vocation ("IT", "DJ") yielded an empty raw-token set under the old {3,} raw matcher — the
# same empty-token → guard-skip pattern. The raw matcher now keeps 2+ letter tokens, and a terminal
# normalized-string fallback covers exotic phrases (1-letter / digits-only / non-latin) that yield no
# comparable token on either side (CodeRabbit on #1692).


def test_short_token_vocation_is_guarded():
    # 2-letter tokens now compare via the raw fallback.
    assert ca.identity_contradictions({"vocation": "IT"}, {"vocation": "manager"}) == ["vocation"]
    assert ca.identity_contradictions({"vocation": "IT"}, {"vocation": "IT"}) == []
    assert ca.identity_contradictions({"vocation": "DJ"}, {"vocation": "IT"}) == ["vocation"]
    # a short-token refinement of a short committed vocation is kept ("IT" ⊆ "IT support").
    assert ca.identity_contradictions({"vocation": "IT support"}, {"vocation": "IT"}) == []


def test_exotic_no_comparable_token_falls_back_to_normalized_string():
    # NEITHER side yields comparable tokens (1-letter / non-latin) — the terminal normalized fallback
    # keeps it coherent ONLY on a WHOLE-TOKEN/phrase substring or equality match, else drops.
    # (Cyrillic small "ha" — escaped so Ruff RUF001 can't flag an ambiguous literal.)
    cyr = "х"
    assert ca.identity_contradictions({"vocation": "y"}, {"vocation": cyr}) == ["vocation"]  # cyrillic vs latin
    assert ca.identity_contradictions({"vocation": cyr}, {"vocation": cyr}) == []            # identical exotic
    # a normalized WHOLE-TOKEN superset of an exotic committed vocation is a refinement (kept).
    assert ca.identity_contradictions({"vocation": f"{cyr} y"}, {"vocation": cyr}) == []
    # BOUNDARY: a 1-letter committed vocation must NOT match INSIDE a longer word — "x" ⊄ "taxi driver".
    assert ca.identity_contradictions({"vocation": "x"}, {"vocation": "taxi driver"}) == ["vocation"]
    # ...but a whole-word match IS a refinement (kept): committed "x" ⊆ authored "x ray tech".
    assert ca.identity_contradictions({"vocation": "x ray tech"}, {"vocation": "x"}) == []


def test_short_token_crosswire_dropped_and_red_end_to_end(_clean_ledger):
    # END TO END with a committed short vocation "IT" and an authored "manager" crosswire.
    async def _llm(_messages):
        return json.dumps({
            "vocation": "manager",  # crosswires the committed short "IT"
            "biography": _MASC_BIO,
            "secrets": ["reroutes the payroll system to a shell account"],
            "trueGoals": ["cover the theft before audit"],
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "man", "vocation": "IT"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    committed = written_profiles[0]
    assert "vocation" not in committed, "a crosswire off a short committed vocation is dropped"
    for k in ("secrets", "trueGoals"):
        assert k not in committed, f"the hidden thread {k!r} grounded in the wrong job must be dropped"
    failed = _overseer_kinds_failed_for("probe-user")
    assert "cast-authoring:identity-contradiction" in failed
    assert "cast-authoring:secret-identity-contradiction" in failed
