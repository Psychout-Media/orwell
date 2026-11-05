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
    real = [u for u in out if u["roles"]]
    assert len(real) == 1 and "uncommitted" in real[0]["reason"]  # (+ the unit's own closing `"**`, reported so it is mirrored too)
    assert "The yard makes a sound." in kept and "She looks up." in kept  # neighbours untouched
    assert kept.count("**") == 2 and '"**' not in kept.replace('Veto..."**', ""), "no dangling closing wrapper left behind"


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
    # found by the live re-run: the narrator's object/verb vary ("medallion", "holds up", "lifts", "around her neck")
    ("Hoh Person holds up the medallion with one hand and doesn't even stand up.", sig()),
    ("Other Delta lifts the veto above her head.", sig(vetoHolderName="Vetoer Gamma")),
    ("Nom Beta wears the Power of Veto around his neck like a dare.", sig(vetoHolderName="Vetoer Gamma")),
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
    ("The veto meeting takes place tonight and Hoh Person is already pacing.", sig(vetoHolderName="Vetoer Gamma")),
    ("Vetoer Gamma holds up the medallion with one hand.", sig(vetoHolderName="Vetoer Gamma")),
    # found by the live re-run: the eviction EVENT is not an evictee assertion
    ("**Nom Alpha and Nom Beta**, the eviction is tonight.", sig(phase="eviction")),
    ("*The eviction vote is yours to cast — Nom Alpha or Nom Beta.*", sig(phase="eviction")),
    ("A vote to evict Nom Beta, read aloud by Hoh Person.", sig(phase="eviction")),
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


# ── BALLOTS BEFORE THE PLAYER'S CARD (A-15 rehearsal, top priority — the N-14/N-15 ordering class) ─────────────────
def ev_sig(**kw):
    return sig(phase="eviction", nomNames=["Nom Alpha", "Nom Beta"], evictionBallots=0, pending="eviction-vote", **kw)


BALLOT_LINES = [
    '@[Hoh Person] "Nom Alpha."',                                   # bare-name ballot readout (the real rehearsal shape)
    '**"Nom Beta."**',
    '@[Hoh Person] "The last vote… Nom Alpha."',
    "That's eight votes for Nom Alpha, six for Nom Beta.",           # tally
    "Hoh Person reads the next ballot: a vote to evict Nom Beta.",
    "The envelope opens. Nom Alpha. Nom Alpha. Nom Beta.",
]


@pytest.mark.parametrize("line", BALLOT_LINES)
def test_ballots_and_tallies_are_stripped_until_the_engine_has_revealed_a_ballot(line):
    kept, out, _ = stripped(line + "\n", ev_sig())
    assert out and "ballot" in out[0]["reason"], f"must strip: {line!r}"


@pytest.mark.parametrize("line", BALLOT_LINES)
def test_the_same_ballots_pass_once_the_engine_has_revealed_ballots(line):
    s = sig(phase="eviction", nomNames=["Nom Alpha", "Nom Beta"], evictionBallots=3, pending=None)
    kept, out, _ = stripped(line + "\n", s)
    assert not [o for o in out if "ballot" in o["reason"]], f"engine already revealed ballots: {line!r}"


def test_the_card_prompt_and_scene_setting_are_not_ballots():
    for t in ['*The eviction vote is yours to cast — Nom Alpha or Nom Beta.*',
              "Hoh Person sets the lidded bowl on the table; the room is very still.",
              "@[Hoh Person] \"Player Epsilon. You're up.\""]:
        kept, out, _ = stripped(t + "\n", ev_sig())
        assert not out, f"must pass: {t!r} -> {out}"


def test_a_bare_name_line_is_not_a_ballot_outside_the_eviction_phase():
    kept, out, _ = stripped('@[Hoh Person] "Nom Alpha."\n', sig(phase="veto-competition", evictionBallots=0))
    assert not out


# ── review (cubic) on #2033 ─────────────────────────────────────────────────────────────────────────────────────────
def test_a_cue_binds_only_the_name_attached_to_it():
    s = sig(vetoHolderName="Hoh Person")
    t = "Nom Beta is furious that Hoh Person won the veto.\n"
    kept, out, _ = stripped(t, s)
    assert not out and kept == t, "Nom Beta is not the subject of the veto cue"
    kept, out, _ = stripped(t, sig(vetoHolderName="Vetoer Gamma"))
    assert out and "Hoh Person" in out[0]["reason"] and "Nom Beta" not in out[0]["reason"]


def test_a_hypothetical_marker_is_scoped_to_its_own_clause():
    kept, out, _ = stripped("If it helps, Other Delta is the new Head of Household.\n", sig())
    assert out, "the 'if' belongs to the first clause; the HOH assertion is in the second"
    kept, out, _ = stripped("If Vetoer Gamma wins the veto, Nom Alpha could be saved.\n", sig(vetoHolderName=None))
    assert not out


def test_nominee_claims_need_a_committed_set_and_the_hoh_is_not_a_nominee():
    assert stripped("Other Delta is on the block.\n", sig(nomNames=[]))[1], "no committed nominees ⇒ uncommitted ⇒ strip"
    assert stripped("Hoh Person is on the block.\n", sig())[1], "the HOH is not a nominee"
    assert not stripped("Nom Alpha and Nom Beta are on the block.\n", sig())[1]
    assert not stripped("Hoh Person nominates Nom Alpha and Nom Beta.\n", sig())[1], "the subject of 'nominates' is not judged"
    assert stripped("Hoh Person nominates Nom Alpha and Other Delta.\n", sig())[1]


def test_a_named_non_continuation_consumes_the_carry():
    s = sig()
    _, _, carry = stripped('**"The winner of the Power of Veto..."**\n', s)
    assert carry["ttl"] > 0
    _, _, carry = stripped("Other Delta laughs at something.\n", s, carry)
    assert carry["ttl"] == 0 and not carry["roles"]
    _, o, _ = stripped('**"...is Player Epsilon."**\n', s, carry)
    assert not o, "a stale cue must not strip a later unrelated named unit"


def test_noun_forms_of_the_eviction_result_are_cues_when_a_name_follows():
    s = sig(phase="eviction", evictedNames=["Nom Alpha"])
    assert stripped("The eviction goes to Nom Beta.\n", s)[1]
    assert stripped("Tonight's eviction: Nom Beta.\n", s)[1]
    assert not stripped("The eviction goes to Nom Alpha.\n", s)[1]
    assert not stripped("Nom Alpha and Nom Beta, the eviction is tonight.\n", s)[1]


def test_unrelated_verbs_near_the_word_veto_are_not_veto_claims():
    t = "During the veto ceremony, Other Delta holds the door open for the host.\n"
    kept, out, _ = stripped(t, sig(vetoHolderName="Vetoer Gamma"))
    assert not out and kept == t


@pytest.mark.parametrize("verb", ["earns", "earned", "claims", "claimed", "lifts", "wears"])
def test_the_veto_verbs_are_matched(verb):
    assert stripped(f"Other Delta {verb} the Power of Veto.\n", sig(vetoHolderName="Vetoer Gamma"))[1]


# ── the mirror stays in lockstep (`_mirror_wall_drop` over the SAME parts) ───────────────────────────────────────────
MIRROR_CASES = [
    'Before. **"The winner of the Power of Veto..."** "...is Player Epsilon." After one. After two.\n',
    "A calm sentence. Player Epsilon takes the veto. Another calm one.\n",
    'He said hi." "Player Epsilon takes the veto." Then left.\n',
    '**"The winner of the Power of Veto..."**\n\nShe looks up.\n\n**"...is Player Epsilon."**\n\nThe yard makes a sound.\n',
]


@pytest.mark.parametrize("text", MIRROR_CASES)
def test_the_stripped_text_mirrors_back_into_the_persisted_round_text_without_over_deleting(text):
    agent_loop = importlib.import_module("src.agent_loop")
    kept, out, _ = stripped(text, sig())
    assert out, "fixture must strip something"
    g = agent_loop._GuardedScene(kept, False, False, tuple(u["unit"] for u in out), kept)
    mirrored = agent_loop._apply_mirror_ops(text, agent_loop._scene_ops(text, g))
    assert mirrored == kept, f"persisted round text must equal what streamed:\n{mirrored!r}\n!=\n{kept!r}"


def test_split_units_are_unions_of_the_mirrors_own_parts():
    import re
    for t in MIRROR_CASES:
        parts = [p for p in re.split(r"(?<=[.!?\n])", t) if p]
        pos = 0
        bounds = set()
        for p in parts:
            pos += len(p); bounds.add(pos)
        end = 0
        for orig, _u in rc.split_units(t):
            end += len(orig)
            assert end in bounds, "a unit must end on a mirror part boundary"


# ── review round 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
def test_winning_the_hoh_competition_is_a_hoh_claim_but_the_hoh_room_is_not():
    assert stripped("Other Delta wins the HOH competition.\n", sig(hohName="Hoh Person"))[1]
    assert stripped("Other Delta won the Head of Household competition!\n", sig(hohName="Hoh Person"))[1]
    assert not stripped("Other Delta wins the HOH competition.\n", sig(hohName="Other Delta"))[1]
    assert not stripped("Other Delta heads up to the HOH room.\n", sig(hohName="Hoh Person"))[1]
    assert not stripped("The first Head of Household competition begins; Other Delta stretches.\n", sig(hohName=None))[1]


@pytest.mark.parametrize("verb", ["has", "held", "keeps", "had"])
def test_possession_forms_of_the_veto_are_matched(verb):
    assert stripped(f"Other Delta {verb} the veto.\n", sig(vetoHolderName="Vetoer Gamma"))[1]
    assert not stripped(f"Vetoer Gamma {verb} the veto.\n", sig(vetoHolderName="Vetoer Gamma"))[1]


def test_possession_verbs_do_not_catch_the_veto_event_nouns():
    for t in ["Other Delta has the veto ceremony tonight.\n", "Other Delta has the veto competition to look forward to.\n"]:
        assert not stripped(t, sig(vetoHolderName="Vetoer Gamma"))[1], t


# ── invented nominees in ceremony dialogue (A-15 follow-up) — real strings + novel phrasings ─────────────────────────
EVS = dict(phase="eviction", nomNames=["Nom Alpha", "Nom Beta"], evictionBallots=3, pending=None)

INVENTED_NOMINEES = [
    '@[Hoh Person] "Other Delta, Vetoer Gamma — you\'ll make your case tonight. This house will decide."',   # the real rehearsal shape
    '@[Hoh Person] "Other Delta and Vetoer Gamma, facing eviction, step forward."',
    "Other Delta and Vetoer Gamma are up tonight.",
    "The nominees, Other Delta and Vetoer Gamma, take the two chairs.",
    "Other Delta pleads with the room to stay one more week.",
    "Vetoer Gamma stands to make his final case to the house.",
    "That's eight votes for Other Delta, five for Vetoer Gamma.",
    "Hoh Person casts the vote for Other Delta.",
]


@pytest.mark.parametrize("line", INVENTED_NOMINEES)
def test_dialogue_that_puts_the_wrong_people_up_at_the_eviction_is_stripped(line):
    kept, out, _ = stripped(line + "\n", sig(**EVS))
    assert out, f"must strip: {line!r}"


VALID_ADDRESS = [
    '@[Hoh Person] "Nom Alpha, Nom Beta — you\'ll make your case tonight. This house will decide."',
    "Nom Alpha and Nom Beta are up tonight.",
    "The nominees, Nom Alpha and Nom Beta, take the two chairs.",
    "Nom Beta pleads with the room to stay one more week.",
    "That's eight votes for Nom Alpha, five for Nom Beta.",
    "Other Delta tells Hoh Person he needs to make his case to the veto holder first.",   # not the eviction address cue's shape (no nominee binding)
    "Hoh Person wonders who will make a case tonight.",                                  # hypothetical clause
]


@pytest.mark.parametrize("line", VALID_ADDRESS)
def test_the_same_address_naming_the_real_nominees_passes(line):
    kept, out, _ = stripped(line + "\n", sig(**EVS))
    assert not out, f"must pass: {line!r} -> {out}"


def test_address_cues_do_not_fire_before_the_engine_committed_nominees_or_outside_the_eviction():
    # nominations phase: lobbying the HOH ("make your case") is legitimate play, and nobody is committed yet
    assert not stripped("Other Delta makes his case to Hoh Person tonight.\n", sig(phase="nominations", nomNames=[]))[1]
    assert not stripped("Other Delta makes his case to the house tonight.\n", sig(phase="veto-competition"))[1]
    assert not stripped("Other Delta makes his case to the house tonight.\n", sig(phase="eviction", nomNames=[]))[1]


# ── second person: the player told they won what the engine gave someone else (live rehearsal, week 3) ────────────────
def test_second_person_claims_are_the_players_and_judged_against_the_engine():
    s = sig(phase="hoh-competition", hohName=None)
    for t in ["The board holds green and the power's yours.\n", "You're the new Head of Household.\n", "You win the HOH competition!\n",
              "You take the Power of Veto.\n"]:
        assert stripped(t, sig(phase="veto-competition", hohName="Hoh Person", vetoHolderName="Vetoer Gamma"))[1], t
    assert not stripped("You're the new Head of Household.\n", sig(hohName="Player Epsilon"))[1], "true when the player IS the HOH"
    assert not stripped("You take the Power of Veto.\n", sig(vetoHolderName="Player Epsilon"))[1]


def test_second_person_conditionals_and_the_veto_power_are_not_phantom_hoh_claims():
    s = sig(phase="veto-competition", hohName="Hoh Person", vetoHolderName=None)
    for t in ["You'll win the HOH if the wall holds.\n", "You'd be crowned HOH by morning, they say.\n", "Maybe you'll take the Power of Veto.\n",
              "The veto power is yours to use.\n", "The veto power's yours if you hold the medallion.\n"]:
        assert not stripped(t, s)[1], t
    # the assertive forms are still caught
    assert stripped("You're the new Head of Household.\n", s)[1]
    assert stripped("The power's yours.\n", s)[1]


def test_second_person_is_not_bound_to_the_nominee_address_cues():
    t = '@[Hoh Person] "Nom Alpha, Nom Beta — you\'ll make your case tonight."\n'
    assert not stripped(t, sig(**EVS))[1]


def test_you_inside_unrelated_prose_is_untouched():
    for t in ["Hoh Person thanks you for coming and hands you a drink.\n", "You walk across the yard and sit by the pool.\n",
              "You wonder who will win the veto.\n"]:
        assert not stripped(t, sig(vetoHolderName="Vetoer Gamma"))[1], t


def test_a_tally_during_the_veto_ceremony_is_a_phantom_ballot_readout():
    """live week 4: "That's eight votes for X, four for Y" aired DURING the veto ceremony — no ballot exists before eviction night."""
    s = sig(phase="veto-ceremony", nomNames=["Nom Alpha", "Nom Beta"], evictionBallots=0)
    assert stripped("That's eight votes for Other Delta, four for Vetoer Gamma.\n", s)[1]
    assert stripped("That's eight votes for Nom Alpha, four for Nom Beta.\n", s)[1], "even naming the real nominees: no ballot exists yet"
    assert not stripped("The veto ceremony begins; Hoh Person sets the box on the table.\n", s)[1]
    assert not stripped("That's eight votes for Other Delta, four for Vetoer Gamma.\n", sig(phase="hoh-competition", evictionBallots=0))[1]


# ── A-15 follow-up: DEPARTURE phrasing with no "evicted" in it ("X is out", "the door shuts", "has left us") ────────────────────
_EV = dict(phase="eviction", hohName="Hoh Person", nomNames=["Nom Alpha", "Nom Beta"], evictedNames=[])


@pytest.mark.parametrize("text", [
    "Nom Alpha is out.\n",
    "Nom Alpha's out, the door's shut.\n",
    "Nom Alpha walks out into the night.\n",
    "The door shuts behind Nom Alpha.\n",
    "Nom Alpha has left us.\n",
    "Nom Alpha leaves us tonight.\n",
    "Nom Alpha is leaving the house.\n",
    "Nom Alpha says her goodbyes.\n",
    "Nom Alpha is already packing.\n",
    "Nom Alpha is packing up.\n",
    "Other Delta is out.\n",  # a non-nominee, equally uncommitted
    "Nom Alpha, packing up her things, does not look back.\n",
    "The door slams on Nom Alpha.\n",
])
def test_departure_phrasing_for_someone_the_engine_has_not_evicted_is_stripped(text):
    assert stripped(text, sig(**_EV))[1], text


@pytest.mark.parametrize("text", [
    "Nom Alpha is out of breath.\n",
    "Nom Alpha is out of ideas.\n",
    "The lights are out.\n",
    "Nom Alpha is out there somewhere, pacing.\n",
    "If Nom Alpha is out, the house tilts.\n",
    "Is Nom Alpha out?\n",
    "Nom Alpha is out of the comp.\n",
    "Nom Alpha is out for blood.\n",
    "Nom Alpha is out to win it.\n",
    "Nom Alpha is out on the patio.\n",
    "Nom Alpha is out in the yard.\n",
    "Nom Alpha is out late again.\n",
])
def test_departure_lookalikes_and_hypotheticals_are_untouched(text):
    assert not stripped(text, sig(**_EV))[1], text


def test_departure_phrasing_is_kept_for_the_person_the_engine_did_evict():
    s = sig(**dict(_EV, evictedNames=["Nom Beta"]))
    assert not stripped("Nom Beta is out.\n", s)[1]
    assert not stripped("The door shuts behind Nom Beta.\n", s)[1]
    assert stripped("Nom Alpha is out.\n", s)[1], "still stripped for the one who stayed"


def test_the_loose_out_cue_is_eviction_phase_only_but_the_strong_forms_hold_in_every_phase():
    comp = sig(phase="hoh-competition", hohName=None, nomNames=[], evictedNames=[])
    assert not stripped("Other Delta is out! The wall drops away under their hands.\n", comp)[1], "a comp elimination is 'out' too"
    assert stripped("Other Delta has left us.\n", comp)[1], "'has left us' is a departure in any phase"
    assert stripped("Other Delta is leaving tonight.\n", comp)[1]
    assert stripped("Other Delta packs up and leaves.\n", comp)[1]


# ── A78: the seven role-claim cues that no test depended on (a mutation sweep over `_CUES` left the suite green when any of these indices was deleted) ──────────────────────────────────────────────
# One positive (a wrong / uncommitted person => stripped) and one negative (the committed person, or a hypothetical clause => untouched) per cue, and a sweep proving each positive DEPENDS on its own cue.
# (index in rc._CUES, label, positive sentence, board kwargs, committed-person sentence, same board kwargs)
CUE_CASES = [
    (4, "veto holder/winner (is|:)", "Veto holder is Other Delta.", {}, "Veto holder is Vetoer Gamma.", {"vetoHolderName": "Vetoer Gamma"}),
    (5, "veto ... in his/her hand", "Other Delta grins, the Power of Veto in her hand.", {}, "Vetoer Gamma grins, the Power of Veto in her hand.", {"vetoHolderName": "Vetoer Gamma"}),
    (6, "veto hangs/rests around|on|from|with", "The Power of Veto hangs around Other Delta's neck.", {}, "The Power of Veto hangs around Vetoer Gamma's neck.", {"vetoHolderName": "Vetoer Gamma"}),
    (11, "new/next HOH is|was|:", "The new HOH was Other Delta.", {}, "The new HOH was Hoh Person.", {}),
    (12, "HOH is|goes to|winner|champion", "The HOH goes to Other Delta.", {}, "The HOH goes to Hoh Person.", {}),
    (16, "the nominees are|is", "The nominees are Other Delta and Nom Beta.", {}, "The nominees are Nom Alpha and Nom Beta.", {}),
    (23, "the houseguest (who is) leaving ... is", "The houseguest leaving tonight is Nom Beta.", {"phase": "eviction", "evictedNames": ["Nom Alpha"]},
     "The houseguest leaving tonight is Nom Alpha.", {"phase": "eviction", "evictedNames": ["Nom Alpha"]}),
]
HYPOTHETICAL = {
    4: "If the veto holder is Other Delta, everything changes.", 5: "If Other Delta had the Power of Veto in her hand, nothing would stand.",
    6: "Whoever the Power of Veto hangs around, Other Delta wants it.", 11: "If the new HOH was Other Delta, she would sweat.", 12: "If the HOH goes to Other Delta, the house erupts.",
    16: "If the nominees are Other Delta and Nom Beta, they will campaign.", 23: "If the houseguest leaving tonight is Nom Beta, the house will cry.",
}


@pytest.mark.parametrize("idx,label,pos,pos_kw,neg,neg_kw", CUE_CASES, ids=[f"cue{c[0]}" for c in CUE_CASES])
def test_a78_each_cue_strips_the_wrong_person_and_leaves_the_committed_one(idx, label, pos, pos_kw, neg, neg_kw):
    kept, out, _ = stripped(pos, sig(**pos_kw))
    wrong = "Nom Beta" if idx == 23 else "Other Delta"
    assert out and wrong not in kept, f"cue #{idx} ({label}): the wrong person was not stripped: {kept!r}"
    kept2, out2, _ = stripped(neg, sig(**neg_kw))
    assert kept2 == neg and not out2, f"cue #{idx} ({label}): the committed person must pass untouched: {kept2!r} {out2!r}"
    hyp = HYPOTHETICAL[idx]
    kept3, out3, _ = stripped(hyp, sig(**pos_kw))
    assert kept3 == hyp and not out3, f"cue #{idx} ({label}): a hypothetical clause must pass untouched: {kept3!r}"


@pytest.mark.parametrize("idx,label,pos,pos_kw,neg,neg_kw", CUE_CASES, ids=[f"cue{c[0]}" for c in CUE_CASES])
def test_a78_the_positive_depends_on_its_own_cue_not_on_a_shadowing_one(monkeypatch, idx, label, pos, pos_kw, neg, neg_kw):
    """The sweep, inside the suite: delete cue `idx` and its positive sentence must stop being stripped. If another cue still strips it the cue is shadowed - delete it and say so."""
    _, out_with, _ = stripped(pos, sig(**pos_kw))
    assert out_with
    monkeypatch.setattr(rc, "_CUES", [c for i, c in enumerate(rc._CUES) if i != idx])
    _, out_without, _ = stripped(pos, sig(**pos_kw))
    assert not out_without, f"cue #{idx} ({label}) is shadowed by another cue (the sentence is still stripped without it): remove the dead cue"
