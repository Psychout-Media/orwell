"""ORW-184: the cast-authoring voice check dropped whole authored voices and left the thin seeded default.

Root cause, from replaying the 2026-11-06 authoring replies through `voice_conflicts`:

* Two of the three drops were the model echoing the engine's OWN seeded humor dial. `humor: "none"` is a
  real value in the engine's controlled voice vocabulary (`VOICE_DIALS.humor` in src/engine/voice.ts;
  the roster clause renders it "none humor"). The card clause is handed to the model as its brief, the
  model copies `"none"`, and the E1 (#1733) degenerate-dial list rejects `"none"` as an empty answer, so
  the WHOLE voice was dropped. The fallback (the seeded voice) has humor "none" too: nothing was gained.
* The third drop was one of three OPTIONAL catchphrases carrying a stray CJK slip. The engine treats
  catchphrases as a bonus (a bad one is omitted, never a whole-voice failure), but the FE check dropped
  the whole voice for it.

The fix (behind `ORWELL_VOICE_REPAIR`, default off; flag off is byte-identical to the legacy check):
reason codes per field, the engine's own dial values are never "degenerate", a bad optional/list entry is
removed alone, and any other bad dial is replaced by the SEEDED dial from the card clause, so the rest of
the authored voice survives. Only an unrepairable voice (a bad signature, or no seeded dial to repair
from) still drops whole, now with its reason codes.

Roles only (no houseguest names); every probe string is generic.
"""

import asyncio
import importlib
import json
import re
from pathlib import Path

import pytest

ca = importlib.import_module("src.orwell_cast_authoring")
enrichment_policy = importlib.import_module("src.enrichment_policy")
log_rings = importlib.import_module("src.log_rings")

FLAG = "ORWELL_VOICE_REPAIR"
REPO = Path(__file__).resolve().parents[2]
VOCAB = json.loads((REPO / "frontend" / "tests" / "fixtures" / "engine_voice_vocabulary.json").read_text("utf-8"))

# A seeded roster clause, in the engine's `voiceFingerprint` format (the brief the model is given).
SEEDED_NONE_HUMOR = "talks in a crude, rambling, blunt voice — manic, none humor; under pressure gets clipped"
SEEDED_DRY_HUMOR = "talks in a polished, measured, candid voice — warm, dry humor; under pressure goes quiet"

BIO_MAN = ("He grew up in a small coastal town and always loved a good challenge. He applied on a whim "
           "and never once looked back, chasing his own ambition.")
BIO_WOMAN = ("She grew up in a small coastal town and always loved a good challenge. She applied on a whim "
             "and never once looked back, chasing her own ambition.")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _clear_rings():
    for ring in (log_rings.OVERSEER, log_rings.LLMIO, log_rings.IO, log_rings.LIVE):
        ring.buf.clear()


def _overseer_entries(user):
    _, lines = log_rings.OVERSEER.since(0, limit=100000)
    return [e for e in lines if e.get("user") == user]


@pytest.fixture
def _clean_ledger():
    enrichment_policy.clear_failures()
    _clear_rings()
    yield
    enrichment_policy.clear_failures()
    _clear_rings()


@pytest.fixture
def repair_on(monkeypatch):
    monkeypatch.setenv(FLAG, "1")


@pytest.fixture
def repair_off(monkeypatch):
    monkeypatch.delenv(FLAG, raising=False)


def _voice(**overrides):
    base = {
        "register": "crude and candid", "rhythm": "rambling", "energy": "manic intensity",
        "directness": "bluntly honest", "humor": "dry", "stressTell": "clipped and harsh",
        "signature": "keeps it short and lets the silence do the work",
        "lexicon": ["honestly", "listen"],
        "catchphrases": ["we move", "not today"],
    }
    base.update(overrides)
    return base


def _author(cast, reply, user="probe-user"):
    """Drive the real `author_cast` pipeline with a stub model reply; return the committed profiles."""
    written = []

    async def _llm(_messages):
        return json.dumps(reply)

    async def _write(profile):
        written.append(profile)
        return {"accepted": True}

    n = _run(ca.author_cast(cast, _llm, _write, user=user))
    return n, written


def _red_classes(user):
    return {r["callClass"] for r in enrichment_policy.failures(user)}


# ═══════════════════════ the two 11-06 shapes (failing first on the legacy check) ═══════════════════════


def test_echo_of_the_engines_own_none_humor_dial_keeps_the_whole_authored_voice(repair_on, _clean_ledger):
    # 11-06 shape 1 (two of the three drops): the seeded clause says "none humor"; the model sharpens the
    # brief and keeps humor "none". That is the engine's own vocabulary, not an empty answer.
    authored = _voice(humor="none")
    n, written = _author([{"id": "npc:1", "genderPresentation": "man", "voice": SEEDED_NONE_HUMOR}],
                         {"voice": authored, "biography": BIO_MAN})
    assert n == 1
    committed = written[0]
    assert committed.get("voice") == authored, "the authored voice must commit whole, humor 'none' included"
    assert "identity-incoherence" not in _red_classes("probe-user")


def test_one_bad_optional_catchphrase_costs_that_catchphrase_only(repair_on, _clean_ledger):
    # 11-06 shape 2 (the third drop): one of three optional catchphrases carries a CJK slip.
    authored = _voice(catchphrases=["at the end of the day", "we move", "I came here to patch the 漏洞."])
    n, written = _author([{"id": "npc:1", "genderPresentation": "man", "voice": SEEDED_DRY_HUMOR}],
                         {"voice": authored, "biography": BIO_MAN})
    assert n == 1
    voice = written[0].get("voice")
    assert voice is not None, "the voice must survive a bad optional entry"
    assert voice["catchphrases"] == ["at the end of the day", "we move"]
    assert {k: v for k, v in voice.items() if k != "catchphrases"} == \
        {k: v for k, v in authored.items() if k != "catchphrases"}
    assert "identity-incoherence" not in _red_classes("probe-user")


# ════════════════════════════════════ reason codes ════════════════════════════════════


@pytest.mark.parametrize("field,value,pin,code", [
    ("register", "fatherly", "woman", "gender-descriptor"),
    ("stressTell", "gets maternal", "man", "gender-descriptor"),
    ("signature", "carries a fatherly warmth into every room", "woman", "gender-descriptor"),
    ("stressTell", "缺乏 talks faster", "woman", "script"),
    ("signature", "缺乏 static and unboiling", "man", "script"),
    ("rhythm", "n/a", "man", "degenerate"),
    ("energy", "none", "man", "degenerate"),
    ("directness", "unclear", "woman", "degenerate"),
])
def test_each_reason_code_names_the_field(repair_on, field, value, pin, code):
    reasons = ca.voice_conflict_reasons({"voice": _voice(**{field: value})}, {"genderPresentation": pin})
    assert reasons == [(field, code)]


def test_list_entries_are_reported_with_their_index(repair_on):
    voice = _voice(lexicon=["honestly", "缺乏"], catchphrases=["we move", "not today", "缺乏 again"])
    reasons = ca.voice_conflict_reasons({"voice": voice}, {"genderPresentation": "woman"})
    assert reasons == [("lexicon[1]", "script"), ("catchphrases[2]", "script")]


def test_a_coherent_voice_has_no_reasons(repair_on):
    assert ca.voice_conflict_reasons({"voice": _voice()}, {"genderPresentation": "woman"}) == []
    assert ca.voice_conflict_reasons({}, {"genderPresentation": "woman"}) == []
    assert ca.voice_conflict_reasons({"voice": "not a dict"}, {}) == []


# ════════════════════════════════════ per-dial repair ════════════════════════════════════


def test_opposite_of_pin_descriptor_on_one_dial_is_replaced_by_the_seeded_dial(repair_on, _clean_ledger):
    # The K4 boundary case: a pinned woman's authored register reads "fatherly". The register falls back to
    # the SEEDED register from the card clause; every other authored part of the voice stands.
    authored = _voice(register="fatherly and stern")
    n, written = _author([{"id": "npc:1", "genderPresentation": "woman", "voice": SEEDED_DRY_HUMOR}],
                         {"voice": authored, "biography": BIO_WOMAN})
    assert n == 1
    voice = written[0]["voice"]
    assert voice["register"] == "polished", "the seeded register replaces the incoherent one"
    assert {k: v for k, v in voice.items() if k != "register"} == \
        {k: v for k, v in authored.items() if k != "register"}
    # A repaired fault is still recorded (#1599: a correction is not a cloak), as auto-corrected, not the
    # unrepaired identity-incoherence class.
    assert "identity-incoherence" not in _red_classes("probe-user")
    kinds = {e.get("kind") for e in _overseer_entries("probe-user") if e.get("ok") is False}
    assert "cast-authoring:voice-repaired" in kinds


@pytest.mark.parametrize("field,value,seeded", [
    ("rhythm", "n/a", "measured"),
    ("stressTell", "缺乏 talks faster", "goes quiet"),
    ("humor", "motherly", "dry"),
])
def test_each_failing_dial_is_repaired_from_the_seeded_clause(repair_on, _clean_ledger, field, value, seeded):
    authored = _voice(**{field: value})
    n, written = _author([{"id": "npc:1", "genderPresentation": "man", "voice": SEEDED_DRY_HUMOR}],
                         {"voice": authored, "biography": BIO_MAN})
    assert n == 1
    assert written[0]["voice"][field] == seeded


def test_a_bad_lexicon_entry_is_removed_when_another_survives(repair_on, _clean_ledger):
    n, written = _author([{"id": "npc:1", "genderPresentation": "man", "voice": SEEDED_DRY_HUMOR}],
                         {"voice": _voice(lexicon=["honestly", "缺乏"]), "biography": BIO_MAN})
    assert written[0]["voice"]["lexicon"] == ["honestly"]


def test_all_catchphrases_bad_drops_only_the_optional_key(repair_on, _clean_ledger):
    n, written = _author([{"id": "npc:1", "genderPresentation": "man", "voice": SEEDED_DRY_HUMOR}],
                         {"voice": _voice(catchphrases=["缺乏 one", "缺乏 two"]), "biography": BIO_MAN})
    voice = written[0]["voice"]
    assert "catchphrases" not in voice
    assert voice["lexicon"] == ["honestly", "listen"]


def test_the_repaired_voice_is_still_a_whole_engine_shaped_voice(repair_on, _clean_ledger):
    # The engine's `sanitizeAuthoredVoice` takes the voice whole or not at all: six dials, a signature and
    # >= 1 lexicon entry. The FE repair must hand it a complete object.
    n, written = _author([{"id": "npc:1", "genderPresentation": "woman", "voice": SEEDED_DRY_HUMOR}],
                         {"voice": _voice(register="fatherly", rhythm="n/a"), "biography": BIO_WOMAN})
    voice = written[0]["voice"]
    for key in ("register", "rhythm", "energy", "directness", "humor", "stressTell", "signature"):
        assert isinstance(voice.get(key), str) and voice[key].strip()
    assert voice["lexicon"]


# ════════════════════════════════ what still drops whole ════════════════════════════════


def test_a_bad_signature_is_unrepairable_and_drops_the_voice_with_its_reason(repair_on, _clean_ledger):
    # The card carries no seeded signature, so a bad signature cannot be repaired: the voice drops whole,
    # exactly as before, and the loud record now names the field and the reason (never the prose).
    n, written = _author([{"id": "npc:1", "genderPresentation": "woman", "voice": SEEDED_DRY_HUMOR}],
                         {"voice": _voice(signature="carries a fatherly warmth into every room"),
                          "biography": BIO_WOMAN})
    assert n == 1
    assert "voice" not in written[0]
    assert "biography" in written[0], "the coherent remainder still commits"
    rows = [r for r in enrichment_policy.failures("probe-user") if r["callClass"] == "identity-incoherence"]
    assert rows, "an unrepaired voice drop stays loud"
    assert "signature=gender-descriptor" in rows[0]["reason"]
    assert "fatherly" not in rows[0]["reason"], "the record names the field and the code, never the prose"


def test_no_seeded_clause_means_no_dial_repair(repair_on, _clean_ledger):
    n, written = _author([{"id": "npc:1", "genderPresentation": "woman"}],
                         {"voice": _voice(register="fatherly"), "biography": BIO_WOMAN})
    assert "voice" not in written[0]
    assert "identity-incoherence" in _red_classes("probe-user")


def test_every_lexicon_entry_bad_is_unrepairable(repair_on, _clean_ledger):
    n, written = _author([{"id": "npc:1", "genderPresentation": "man", "voice": SEEDED_DRY_HUMOR}],
                         {"voice": _voice(lexicon=["缺乏", "漏洞"]), "biography": BIO_MAN})
    assert "voice" not in written[0]


def test_a_seeded_dial_that_itself_fails_the_check_is_never_used(repair_on, _clean_ledger):
    # A later re-author can be briefed with an AUTHORED clause. If that floor dial would itself fail the
    # check for this pin, it is not a valid repair source.
    clause = "talks in a fatherly, measured, candid voice — warm, dry humor; under pressure goes quiet"
    n, written = _author([{"id": "npc:1", "genderPresentation": "woman", "voice": clause}],
                         {"voice": _voice(register="fatherly"), "biography": BIO_WOMAN})
    assert "voice" not in written[0]


def test_repair_log_is_vault_free_and_prose_free(repair_on, _clean_ledger):
    lines = []
    try:
        sink = ca.logger.add(lambda m: lines.append(str(m)), level="DEBUG")
    except Exception:  # pragma: no cover - the no-op logger stand-in has no sinks
        pytest.skip("loguru not installed")
    try:
        _author([{"id": "npc:1", "genderPresentation": "man", "voice": SEEDED_DRY_HUMOR}],
                {"voice": _voice(stressTell="缺乏 talks faster"), "biography": BIO_MAN})
    finally:
        ca.logger.remove(sink)
    text = "\n".join(lines)
    assert "stressTell=script" in text
    assert "缺乏" not in text, "the log names the field and the code, never the authored text"
    records = [e for e in _overseer_entries("probe-user") if e.get("kind") == "cast-authoring:voice-repaired"]
    assert records and "缺乏" not in json.dumps(records, ensure_ascii=False)


# ═══════════════════════════════ flag off: byte-identical ═══════════════════════════════


def test_flag_off_keeps_the_legacy_whole_voice_drop(repair_off, _clean_ledger):
    # Flag off is the shipped behaviour: the 11-06 shapes still drop the whole voice, and the legacy
    # message is unchanged (no reason codes appended).
    n, written = _author([{"id": "npc:1", "genderPresentation": "man", "voice": SEEDED_NONE_HUMOR}],
                         {"voice": _voice(humor="none"), "biography": BIO_MAN})
    assert "voice" not in written[0]
    rows = [r for r in enrichment_policy.failures("probe-user") if r["callClass"] == "identity-incoherence"]
    assert rows and rows[0]["reason"] == (
        "authored dossier for npc:1 contradicts the pinned identity — dropped voice to the coherent "
        "seeded floor before write-back")
    assert ca.voice_conflicts({"voice": _voice(humor="none")}, {"genderPresentation": "man"}) is True
    assert ca.voice_conflicts({"voice": _voice(catchphrases=["缺乏"])}, {}) is True


@pytest.mark.parametrize("voice,legacy", [
    (_voice(), False),
    (_voice(humor="none"), True),          # the legacy check rejects the engine's own value (the bug)
    (_voice(register="fatherly"), True),
    (_voice(lexicon=["缺乏"]), True),
    (_voice(signature="缺乏 sig"), True),
    (_voice(catchphrases=["ok", "缺乏"]), True),
    (_voice(signature="none of this matters to them"), False),
])
def test_flag_off_keeps_every_legacy_verdict(repair_off, voice, legacy):
    npc = {"genderPresentation": "woman"}
    assert ca.voice_conflicts({"voice": voice}, npc) is legacy
    assert bool(ca.voice_conflict_reasons({"voice": voice}, npc)) is legacy


def test_flag_parsing(monkeypatch):
    for on in ("1", "true", "yes", "on", "TRUE"):
        monkeypatch.setenv(FLAG, on)
        assert ca.voice_repair_enabled() is True
    for off in ("", "0", "false", "no", "off"):
        monkeypatch.setenv(FLAG, off)
        assert ca.voice_repair_enabled() is False
    monkeypatch.delenv(FLAG, raising=False)
    assert ca.voice_repair_enabled() is False


# ═════════════════════ the shared vocabulary fixture (FE half of the drift gate) ═════════════════════


def test_every_engine_dial_value_passes_the_degenerate_check(repair_on):
    # The engine half (tests/unit/voiceVocabularyFixture.test.ts) proves this fixture equals VOICE_DIALS.
    for dial, values in VOCAB["dials"].items():
        for value in values:
            reasons = ca.voice_conflict_reasons({"voice": _voice(**{dial: value})}, {"genderPresentation": "man"})
            assert reasons == [], f"the engine's own {dial} value {value!r} must never be rejected"


def test_the_clause_parser_inverts_the_engine_fingerprint_template():
    repair = importlib.import_module("src.orwell_voice_repair")
    template = VOCAB["fingerprintTemplate"]
    dials = VOCAB["dials"]
    for humor in dials["humor"]:
        for tell in dials["stressTell"]:
            sample = {"register": dials["register"][0], "rhythm": dials["rhythm"][-1],
                      "directness": dials["directness"][1], "energy": dials["energy"][2],
                      "humor": humor, "stressTell": tell}
            assert repair.parse_voice_clause(template.format(**sample)) == sample


@pytest.mark.parametrize("clause", [
    None, "", "a plain sentence about a voice",
    "talks in a crude, rambling voice — manic, dry humor; under pressure gets clipped",       # 2 head parts
    "talks in a warm, crude, rambling, blunt voice — manic, dry humor; under pressure x",      # 4 head parts
    "talks in a crude, rambling, blunt voice — manic humor; under pressure gets clipped",      # 1 mid part
    "talks in a crude, rambling, blunt voice — manic, dry humor; under pressure ",             # empty tell
])
def test_the_clause_parser_refuses_anything_ambiguous(clause):
    repair = importlib.import_module("src.orwell_voice_repair")
    assert repair.parse_voice_clause(clause) is None


def test_the_fixture_template_matches_the_engine_source_literally():
    # Cheap FE-side tripwire on the engine template (the engine half asserts the rendered output too).
    src = (REPO / "src" / "engine" / "voice.ts").read_text("utf-8")
    m = re.search(r"return `(talks in a [^`]+)`;", src)
    assert m, "voiceFingerprint's template literal moved; update the fixture and both halves of the gate"
    as_format = re.sub(r"\$\{voice\.(\w+)\}", r"{\1}", m.group(1))
    assert as_format == VOCAB["fingerprintTemplate"]
