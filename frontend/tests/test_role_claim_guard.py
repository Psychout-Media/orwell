"""A-15 rehearsal 2026-11-03 — the ROLE-CLAIM guard (src/role_claims.py): name + role co-occurrence against the
engine's committed roles, with ellipsis/quote-split announcements joined into one unit. Roles only — no fixed cast;
the roster below is synthetic. Includes the REAL host-PA strings that slipped through and phrasings the narrator has
not used yet (the point of not template-matching)."""
import importlib

import pytest

rc = importlib.import_module("src.role_claims")

ROSTER = ["Hoh Person", "Nom Alpha", "Nom Beta", "Vetoer Gamma", "Other Delta"]


def sig(**kw):
    base = {
        "phase": "veto-competition", "activeNames": list(ROSTER), "evictedNames": [], "playerName": "Player Epsilon",
        "hohName": "Hoh Person", "vetoHolderName": None, "nomNames": ["Nom Alpha", "Nom Beta"], "playerStatus": "active",
    }
    base.update(kw)
    return base


def stripped(text, s, carry=None):
    kept, out, new = rc.screen_role_units(text, s, carry)
    return kept, out, new


# ── the REAL strings from the rehearsal transcript (shape-preserved, names swapped for roles) ──────────────────
REAL_VETO = '**"The winner of the Power of Veto..."**\n\nShe looks up.\n\n**"...is Player Epsilon."**\n\nThe yard makes a sound.\n'
REAL_EVICT = ('**"By the votes read, the houseguest leaving the Big Brother house tonight is..."**\n\n'
              'The pause is the worst part.\n\n**"...Nom Beta."**\n\nThe yard erupts.\n')


def test_real_veto_announcement_naming_the_player_before_any_commit_is_stripped_but_the_first_half_stays():
    kept, out, _ = stripped(REAL_VETO, sig())
    assert "Player Epsilon" not in kept and "The winner of the Power of Veto" in kept
    assert len(out) == 1 and "uncommitted" in out[0]["reason"]
    assert "The yard makes a sound." in kept and "She looks up." in kept  # neighbours untouched


def test_real_veto_announcement_naming_the_wrong_holder_after_commit_is_stripped():
    t = REAL_VETO.replace("Player Epsilon", "Hoh Person")
    kept, out, _ = stripped(t, sig(vetoHolderName="Vetoer Gamma"))
    assert "Hoh Person." not in kept and out and "veto holder is not Hoh Person" in out[0]["reason"]


def test_real_evictee_announcement_naming_the_wrong_person_is_stripped():
    kept, out, _ = stripped(REAL_EVICT, sig(phase="eviction", evictedNames=["Nom Alpha"]))
    assert "Nom Beta" not in kept and out


def test_the_correct_commitment_passes_untouched():
    t = REAL_VETO.replace("Player Epsilon", "Vetoer Gamma")
    kept, out, _ = stripped(t, sig(vetoHolderName="Vetoer Gamma"))
    assert kept == t and not out
    t2 = REAL_EVICT.replace("Nom Beta", "Nom Alpha")
    kept2, out2, _ = stripped(t2, sig(phase="eviction", evictedNames=["Nom Alpha"]))
    assert kept2 == t2 and not out2


# ── phrasings the narrator has NOT used yet (no template names them) ──────────────────────────────────────────
NOVEL_STRIP = [
    ("The medal goes to Hoh Person.", sig(vetoHolderName="Vetoer Gamma")),
    ("Hoh Person clutches the Power of Veto, knuckles white.", sig(vetoHolderName="Vetoer Gamma")),
    ("Player Epsilon takes the veto.", sig()),
    ("Other Delta is the new Head of Household.", sig()),
    ("Nom Beta is packing his bags tonight.", sig(phase="eviction", evictedNames=["Nom Alpha"])),
    ("Nom Beta has been voted out of the house.", sig(phase="eviction", evictedNames=["Nom Alpha"])),
    ("Nom Beta is not using the veto.", sig(vetoHolderName="Vetoer Gamma")),
    ("Other Delta is on the block.", sig()),
]


@pytest.mark.parametrize("text,s", NOVEL_STRIP)
def test_novel_phrasings_that_assert_an_uncommitted_or_wrong_role_are_stripped(text, s):
    kept, out, _ = stripped(text + "\n", s)
    assert out, f"should strip: {text!r}"
    assert text not in kept, "the offending unit must be removed from the emitted text"


NOVEL_PASS = [
    ("Vetoer Gamma wins the Power of Veto.", sig(vetoHolderName="Vetoer Gamma")),
    ("The medal goes to Vetoer Gamma.", sig(vetoHolderName="Vetoer Gamma")),
    ("Nom Alpha is evicted from the Big Brother house.", sig(phase="eviction", evictedNames=["Nom Alpha"])),
    ("Hoh Person is the new Head of Household.", sig()),
    ("Nom Alpha and Nom Beta are on the block.", sig()),
    ("If Vetoer Gamma wins the veto, Nom Alpha could be saved.", sig()),                       # conditional
    ("Whoever wins the Power of Veto will decide Nom Beta's fate.", sig()),                    # future
    ("Other Delta wonders who will win the veto.", sig()),                                     # question-ish / hypothetical
    ("Hoh Person pours coffee and glares at Nom Alpha across the kitchen.", sig()),            # creative prose, no role cue
    ("@[Vetoer Gamma] — Hoh Person is going to remember that, trust me.", sig()),              # speaker tag + no cue
    ("Last week Hoh Person won the Power of Veto and used it.", sig(vetoHolderName="Vetoer Gamma")),  # past reference
]


@pytest.mark.parametrize("text,s", NOVEL_PASS)
def test_true_hypothetical_and_creative_text_passes(text, s):
    kept, out, _ = stripped(text + "\n", s)
    assert not out and kept == text + "\n", f"must pass: {text!r} -> {out}"


def test_a_farewell_scene_containing_the_real_evictee_passes_even_with_other_names():
    t = "Nom Beta hugs Nom Alpha goodbye at the door.\n"
    kept, out, _ = stripped(t, sig(phase="eviction", evictedNames=["Nom Alpha"]))
    assert not out and kept == t


def test_weak_farewell_cues_are_inert_outside_eviction_night():
    t = "Nom Beta says goodbye to the yard lights and heads inside.\n"
    kept, out, _ = stripped(t, sig(phase="veto-competition"))
    assert not out and kept == t


# ── the ellipsis halves arrive in DIFFERENT stream chunks ───────────────────────────────────────────────────
def test_split_across_chunks_needs_and_uses_the_carry():
    s = sig()
    k1, o1, carry = stripped('**"The winner of the Power of Veto..."**\n', s)
    assert not o1 and carry["ttl"] > 0 and "veto-hold" in carry["roles"]
    k2, o2, _ = stripped('**"...is Player Epsilon."**\n', s, carry)
    assert o2 and "Player Epsilon" not in k2
    # without the carry the continuation alone carries no role cue — it passes (proves the carry is load-bearing)
    k3, o3, _ = stripped('**"...is Player Epsilon."**\n', s, None)
    assert not o3


def test_carry_expires_and_does_not_leak_onto_unrelated_names():
    s = sig()
    _, _, carry = stripped('**"The winner of the Power of Veto..."**\n', s)
    _, o, carry = stripped("Time passes in the kitchen.\n", s, carry)
    _, o, carry = stripped("Birds sing outside the window.\n", s, carry)
    _, o, carry = stripped("The lamps hum all night long.\n", s, carry)
    k, o, _ = stripped("Other Delta laughs at something.\n", s, carry)
    assert not o


# ── hygiene ──────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("t", [REAL_VETO, REAL_EVICT, "plain prose.\nTwo lines... and an ellipsis…\nend", "", "no terminator"])
def test_splitting_preserves_every_byte(t):
    assert "".join(o for o, _ in rc.split_units(t)) == t


def test_fail_open_on_garbage():
    assert rc.screen_role_units("x", None)[0] == "x"
    assert rc.screen_role_units(None, {})[0] is None
    assert rc.screen_role_units("Hoh Person wins the veto.", {"activeNames": None})[0]


def test_a_speaker_tag_is_who_talks_not_who_the_sentence_is_about():
    t = "@[Hoh Person] — I'm not using the Power of Veto, don't look at me.\n"
    kept, out, _ = stripped(t, sig(vetoHolderName="Vetoer Gamma"))
    assert not out and kept == t


def test_a_unique_first_or_last_name_alone_resolves_to_the_houseguest():
    kept, out, _ = stripped("Other clutches the Power of Veto, grinning.\n", sig(vetoHolderName="Vetoer Gamma"))
    assert out and "Other" not in kept
    # …but an ambiguous token (two houseguests share it) is NOT resolved on its own
    s = sig(activeNames=["Pat Shared", "Lee Shared", "Hoh Person"], vetoHolderName="Hoh Person")
    kept2, out2, _ = stripped("Shared clutches the Power of Veto.\n", s)
    assert not out2


def test_phantom_role_claims_is_the_stable_entry_point_for_other_checks():
    s = sig(vetoHolderName="Vetoer Gamma")
    assert rc.phantom_role_claims("Hoh Person clutches the Power of Veto.", s)
    assert rc.phantom_role_claims("Vetoer Gamma holds the Power of Veto.", s) == []
    assert rc.phantom_role_claims("If Hoh Person wins the veto he could use it.", s) == []
    assert rc.phantom_role_claims("", s) == [] and rc.phantom_role_claims("x", None) == []
