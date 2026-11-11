"""Issue #1733 (E1) — cast-authoring emits garbled/gender-incoherent voice cues rendered verbatim as
authoritative identity by the narrator. BB-Nerd audit F7/F8: a 32-year-old WOMAN authored "patient and
fatherly" (a gendered self-descriptor with no pronoun — the existing #1660 F2 pronoun-only lint never
sees it), mixed-script junk landed in a voice cue ("缺乏 voice — static and unboiling"), and a raw
"empty" dial value (`humor: "none"`) rendered as grammatically-broken "none humor" through the fixed
`voiceFingerprint` template. Root cause pinned to the cast-authoring call running at a hot sampling
temperature (`cast_authoring_temperature`, default 1.0, owner ruling 2026-07-20).

This extends the F2 author-time coherence lint (`orwell_cast_authoring.coherence_conflicts` /
`voice_conflicts`) and adds a gender-agnostic genesis-time lint (`orwell_cast_genesis.
_is_garbled_or_gendered`, wired into `parse_genesis_proposal`) so none of the three garble classes ever
reach `recordCastProfile` / `recordCastGenesis` — a rejected field is DROPPED (never persisted) and
falls to the deterministic seeded floor, matching the existing fail-soft "no model ⇒ floor stands"
pattern. Roles only — every probe string is generic (no houseguest names).
"""

import asyncio
import importlib
import json

import pytest

ca = importlib.import_module("src.orwell_cast_authoring")
cg = importlib.import_module("src.orwell_cast_genesis")
enrichment_policy = importlib.import_module("src.enrichment_policy")
log_rings = importlib.import_module("src.log_rings")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _clear_rings():
    for ring in (log_rings.OVERSEER, log_rings.LLMIO, log_rings.IO, log_rings.LIVE):
        ring.buf.clear()


def _overseer_kinds_failed_for(user):
    _, lines = log_rings.OVERSEER.since(0, limit=100000)
    return {e.get("kind") for e in lines if e.get("ok") is False and e.get("user") == user}


@pytest.fixture
def _clean_ledger():
    enrichment_policy.clear_failures()
    _clear_rings()
    yield
    enrichment_policy.clear_failures()


def _phys(mark="a small compass tattoo on the left wrist", **overrides):
    base = {
        "heightBuild": "average height, lean", "skinTone": "olive", "hair": "short dark",
        "facialFeatures": "sharp jaw", "distinguishingMark": mark, "ageLook": "looks about forty",
        "style": "understated",
    }
    base.update(overrides)
    return base


def _voice(**overrides):
    base = {
        "register": "crude", "rhythm": "measured", "energy": "manic", "directness": "diplomatic",
        "humor": "dry", "stressTell": "goes quiet",
        "signature": "keeps it short and lets the silence do the work",
        "lexicon": ["honestly", "listen"],
    }
    base.update(overrides)
    return base


# ══════════════════════ gendered SELF-DESCRIPTOR (no pronoun) — F7's exact shape ══════════════════════


def test_gendered_descriptor_flip_catches_a_pronoun_free_contradiction():
    # The bundle shape: a WOMAN authored "patient and fatherly" — no pronoun involved at all, so the
    # existing pronoun-only `_gender_flip` would miss it; the new descriptor scan catches it.
    npc = {"id": "npc:1", "genderPresentation": "woman", "age": 32}
    bio = ("She is patient and fatherly with the younger houseguests, always offering calm, steady "
           "advice before a vote.")
    assert ca.coherence_conflicts({"biography": bio}, npc) == ["biography"]
    # The mirror: a "maternal" descriptor on a pinned man.
    npc2 = {"id": "npc:2", "genderPresentation": "man"}
    bio2 = "He is maternal and warm with the house, always checking in on everyone after a blindside."
    assert ca.coherence_conflicts({"biography": bio2}, npc2) == ["biography"]


def test_gendered_descriptor_flip_in_physical_facet_drops_the_whole_facet():
    npc = {"id": "npc:1", "genderPresentation": "woman"}
    profile = {"physicalCharacteristics": _phys(style="carries himself with a fatherly warmth")}
    assert ca.coherence_conflicts(profile, npc) == ["physicalCharacteristics"]


def test_gendered_descriptor_matching_the_pin_is_not_flagged():
    # A descriptor that MATCHES the pin (or a neutral one) is never a contradiction.
    npc = {"id": "npc:1", "genderPresentation": "man"}
    bio = "He is patient and fatherly with the younger houseguests, offering calm advice before a vote."
    assert ca.coherence_conflicts({"biography": bio}, npc) == []
    neutral = "She is warm but no-nonsense, quick with a joke and quicker with a read on the room."
    assert ca.coherence_conflicts({"biography": neutral}, {"id": "npc:2", "genderPresentation": "woman"}) == []


def test_gendered_descriptor_end_to_end_dropped_and_red_recorded(_clean_ledger):
    async def _llm(_messages):
        return json.dumps({
            "biography": ("She is patient and fatherly with the younger houseguests, always offering "
                          "calm, steady advice before a vote. She keeps her circle small and loyal."),
            "physicalCharacteristics": _phys(),
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "woman", "age": 32}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1, "the coherent physical facet still commits"
    committed = written_profiles[0]
    assert "biography" not in committed, "the gendered-descriptor-flipped biography must be dropped"
    assert "physicalCharacteristics" in committed
    assert "identity-incoherence" in {r["callClass"] for r in enrichment_policy.failures("probe-user")}


# ══════════════════════════════ mixed-script / non-diegetic garble ══════════════════════════════


def test_script_garble_in_biography_is_dropped():
    npc = {"id": "npc:1"}
    bio = "缺乏 voice — static and unboiling, but sharp when it counts, always reading the room first."
    assert ca.coherence_conflicts({"biography": bio}, npc) == ["biography"]


def test_script_garble_in_physical_facet_drops_the_whole_facet():
    npc = {"id": "npc:1"}
    profile = {"physicalCharacteristics": _phys(mark="缺乏 tattoo along the collarbone")}
    assert ca.coherence_conflicts(profile, npc) == ["physicalCharacteristics"]


def test_script_garble_is_gender_agnostic_no_pin_needed():
    # Garble is rejected even with NO genderPresentation pin at all (unlike the pronoun/descriptor
    # checks, which require a pin to arbitrate against).
    assert ca.coherence_conflicts({"biography": "Ѐ garbled prose here, mixed in with real words."}, {}) == [
        "biography"]


def test_plain_english_prose_is_never_flagged_as_garble():
    npc = {"id": "npc:1", "genderPresentation": "man"}
    bio = ("He grew up in a small coastal town and always loved a good challenge. He applied on a "
           "whim and never once looked back, chasing his own quiet ambition all season.")
    assert ca.coherence_conflicts({"biography": bio, "physicalCharacteristics": _phys()}, npc) == []


# ══════════════════════════════ E1 — the authored VOICE fingerprint ══════════════════════════════


def test_voice_conflicts_flags_script_garble_in_any_dial():
    npc = {"id": "npc:1"}
    assert ca.voice_conflicts({"voice": _voice(stressTell="缺乏 talks faster")}, npc) is True
    assert ca.voice_conflicts({"voice": _voice(signature="缺乏 static and unboiling")}, npc) is True


def test_voice_conflicts_flags_script_garble_in_lexicon_and_catchphrases():
    npc = {"id": "npc:1"}
    assert ca.voice_conflicts({"voice": _voice(lexicon=["honestly", "缺乏"])}, npc) is True
    assert ca.voice_conflicts(
        {"voice": _voice(catchphrases=["we move", "缺乏 not today"])}, npc) is True


@pytest.fixture
def legacy_voice_drop(monkeypatch):
    """ORW-242: ORWELL_VOICE_REPAIR is default ON (repair only the failing dial). These tests pin the LEGACY whole-voice drop, now the explicit opt-out (=0); the default-ON behaviour is covered in test_orw184_voice_repair.py."""
    monkeypatch.setenv("ORWELL_VOICE_REPAIR", "0")



def test_voice_conflicts_flags_a_degenerate_dial_value(legacy_voice_drop):
    # The bundle shape: humor:"none" — a valid closed-vocab word in the ENGINE's own deterministic
    # pool, but a degenerate non-answer when an LLM hands it back verbatim (renders "none humor").
    npc = {"id": "npc:1"}
    assert ca.voice_conflicts({"voice": _voice(humor="none")}, npc) is True
    assert ca.voice_conflicts({"voice": _voice(register="n/a")}, npc) is True
    assert ca.voice_conflicts({"voice": _voice(directness="unclear")}, npc) is True
    # A degenerate value is only checked on the DIAL fields, never the free-prose signature (a real
    # sentence is never literally "none", so this never over-fires there).
    assert ca.voice_conflicts({"voice": _voice(signature="none of this matters to them, honestly")}, npc) is False


def test_voice_conflicts_flags_a_gendered_descriptor_in_the_signature():
    npc = {"id": "npc:1", "genderPresentation": "woman"}
    assert ca.voice_conflicts({"voice": _voice(signature="carries a fatherly warmth into every room")}, npc) is True


def test_voice_conflicts_flags_a_gendered_descriptor_on_a_rendered_dial():
    # P1 (Greptile on #1750): `voiceFingerprint` (src/engine/voice.ts) renders register/rhythm/
    # directness/energy/humor/stressTell DIRECTLY into the authoritative roster line — a gendered
    # descriptor landing on any of THOSE dials is the same defect as one landing in the signature,
    # and must be caught even though the earlier fix only scanned `signature`.
    npc = {"id": "npc:1", "genderPresentation": "woman"}
    assert ca.voice_conflicts({"voice": _voice(register="fatherly")}, npc) is True
    assert ca.voice_conflicts({"voice": _voice(stressTell="gets paternal")}, npc) is True
    assert ca.voice_conflicts({"voice": _voice(directness="fatherly")}, npc) is True
    assert ca.voice_conflicts({"voice": _voice(energy="fatherly")}, npc) is True
    assert ca.voice_conflicts({"voice": _voice(humor="fatherly")}, npc) is True
    assert ca.voice_conflicts({"voice": _voice(rhythm="fatherly")}, npc) is True
    # The mirror: "maternal"/"motherly" on a pinned man.
    npc_man = {"id": "npc:2", "genderPresentation": "man"}
    assert ca.voice_conflicts({"voice": _voice(register="maternal")}, npc_man) is True
    # A dial matching the pin (or neutral) is never flagged.
    assert ca.voice_conflicts({"voice": _voice(register="fatherly")}, npc_man) is False


def test_gendered_dial_dropped_end_to_end(_clean_ledger):
    # The full pipeline: a pinned woman's authored voice carries a gendered dial (not a signature) —
    # the whole voice object must be dropped before recordCastProfile, and the coherent biography
    # still commits.
    async def _llm(_messages):
        return json.dumps({
            "voice": _voice(register="fatherly", stressTell="gets paternal"),
            "biography": ("She grew up in a small coastal town and always loved a good challenge. She "
                          "applied on a whim and never once looked back, chasing her own ambition."),
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "woman"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    committed = written_profiles[0]
    assert "voice" not in committed, "a gender-incoherent dial (not just signature) must drop the whole voice"
    assert "biography" in committed, "the coherent remainder still commits"
    assert "identity-incoherence" in {r["callClass"] for r in enrichment_policy.failures("probe-user")}


def test_voice_conflicts_is_false_on_a_well_formed_coherent_voice():
    npc = {"id": "npc:1", "genderPresentation": "woman"}
    assert ca.voice_conflicts({"voice": _voice()}, npc) is False
    # No voice object at all, or a non-dict — never flagged (nothing to check).
    assert ca.voice_conflicts({}, npc) is False
    assert ca.voice_conflicts({"voice": "not a dict"}, npc) is False


def test_coherence_conflicts_drops_the_whole_voice_object(legacy_voice_drop):
    npc = {"id": "npc:1"}
    profile = {"voice": _voice(humor="none"), "biography": None}
    assert ca.coherence_conflicts(profile, npc) == ["voice"]


def test_degenerate_voice_dropped_end_to_end_coherent_remainder_still_commits(_clean_ledger, legacy_voice_drop):
    async def _llm(_messages):
        return json.dumps({
            "voice": _voice(humor="none"),  # degenerate dial — must be dropped whole
            "biography": ("He grew up in a small coastal town and always loved a good challenge. He "
                          "applied on a whim and never once looked back, chasing his own ambition."),
        })

    written_profiles = []

    async def _write(profile):
        written_profiles.append(profile)
        return {"accepted": True}

    cast = [{"id": "npc:1", "genderPresentation": "man"}]
    written = _run(ca.author_cast(cast, _llm, _write, user="probe-user"))

    assert written == 1
    committed = written_profiles[0]
    assert "voice" not in committed, "a degenerate-dial voice must never reach the write-back"
    assert "biography" in committed, "the coherent remainder still commits"
    assert "identity-incoherence" in {r["callClass"] for r in enrichment_policy.failures("probe-user")}


# ══════════════════════════ genesis-time lint (demeanor / appearance) ══════════════════════════
#
# `demeanor`/`appearance` are authored at GENESIS, before genderPresentation is pinned by the LATER
# 0063 identity call, so they cannot be pin-checked — a gendered relational-role term is rejected
# outright (never appropriate in a neutral "how they carry themselves" phrase either way).


def test_genesis_drops_a_gendered_role_demeanor():
    proposal = {"npcs": [{"id": "npc:1", "demeanor": "patient and fatherly", "vocation": "nurse"}]}
    parsed = cg.parse_genesis_proposal(json.dumps(proposal), {"npc:1"})
    npc = parsed["npcs"][0]
    assert "demeanor" not in npc, "a gendered relational-role demeanor must be dropped"
    assert npc.get("vocation") == "nurse", "the coherent remainder of the entry still commits"


def test_genesis_drops_script_garble_in_demeanor_and_appearance():
    proposal = {"npcs": [{
        "id": "npc:1",
        "demeanor": "缺乏 voice — static and unboiling",
        "appearance": "tall and lean, 缺乏 sharp features",
        "vocation": "court reporter",
    }]}
    parsed = cg.parse_genesis_proposal(json.dumps(proposal), {"npc:1"})
    npc = parsed["npcs"][0]
    assert "demeanor" not in npc
    assert "appearance" not in npc
    assert npc.get("vocation") == "court reporter"


def test_genesis_keeps_a_coherent_neutral_demeanor_and_appearance():
    proposal = {"npcs": [{
        "id": "npc:1", "demeanor": "warm but guarded", "appearance": "tall and lean, sharp features",
    }]}
    parsed = cg.parse_genesis_proposal(json.dumps(proposal), {"npc:1"})
    npc = parsed["npcs"][0]
    assert npc.get("demeanor") == "warm but guarded"
    assert npc.get("appearance") == "tall and lean, sharp features"


def test_genesis_gendered_role_matching_a_committed_pin_is_still_rejected():
    # Deliberate: genesis has NO pin to check against yet, so the term is rejected UNCONDITIONALLY —
    # even a value that happens to coincide with the eventual pin never belongs in this neutral field.
    proposal = {"npcs": [{"id": "npc:1", "demeanor": "gentlemanly and reserved"}]}
    parsed = cg.parse_genesis_proposal(json.dumps(proposal), {"npc:1"})
    assert "demeanor" not in parsed["npcs"][0]
