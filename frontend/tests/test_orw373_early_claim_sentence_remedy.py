"""ORW-373: when the scene circuit-breaker catches an EARLY ceremony claim (a crown, a nomination, the veto won, a competition result announced one beat
before the engine commits it) the player must still get the scene. Only the offending sentence(s) are dropped (the ORW-358 approach, extended); a genuinely
wrong claim or a claim that cannot be isolated still cuts the whole scene. The five fixtures are REAL narrator replies from the 2026-11-15 rehearsal
(scene circuit-breaker HELD at 03:01, 03:03, 03:05, 03:09, 03:17), houseguest names replaced by roles. Roles only."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
agent_loop = importlib.import_module("src.agent_loop")

_USER = "u-orw373"

HOH_COMP_RULES = '''The living room has been transformed. On a stand at the front, a screen cycles two words: **HOLD THE LINE.**

@[Houseguest A] "Oh, that's not a puzzle." He says it like a man reading a weather report. "That's a body thing."

The voice comes down from everywhere at once.

"Houseguests — welcome to your first Head of Household competition. **Hold the Line.** Each of you takes a lane on the platform. The panels beneath you go dark in sequence, on a rhythm, and when yours goes dark you move — or you're out. The rhythm tightens every round. There is no sitting this one out and there is no second chance. Last person standing on the platform is the new Head of Household."

"Sixteen of you. Step onto your lanes."

The first panel goes dark.

How are you playing this one — going for the win, playing it safe, or throwing it?
'''

HOH_CROWN = '''Then it's two. You and Hoh Person, on opposite ends of the platform, and the sun is brutal and nobody in that yard is breathing.

The rhythm goes. She doesn't blink. The grid stutters — a half-beat out of nowhere — and both of you lurch, and only one of you catches it.

Hoh Person catches it.

"**Hoh Person — you are the new Head of Household.**"

The yard comes apart. Houseguest B is hollering, and Hoh Person steps off the platform and puts her hands on her hips and just breathes for a second.

@[Hoh Person] "Okay. Okay! Wow." She looks around at all of you. "You were right there with me. Genuinely. That was *close.*"
'''

KEY_RITUAL = '''The living room has been set. Fifteen faces settle into a ring, and at the head of it stands Hoh Person, a small wooden box in her hands.

@[Hoh Person] "All right." Her voice is clipped and even, and she doesn't fill the silence — she lets it sit. "This is the part where I'm supposed to say something nice about everybody. I'm going to skip that, because you all know what it is." A pause, and her eyes go around the ring, unhurried, resting on no one. "I'm going to turn the first key now."

She steps to the box and turns it. The room holds its breath.

@[Hoh Person] "The first person I'm keeping safe is—"

She stops. Her hand rests flat on the lid.

@[Hoh Person] "Actually. Before I do this." The box stays shut under her palm. "I want to hear the room first."
'''

VETO_WIN = '''The sequence comes faster. One of the last two steps half a beat late, the panel stays dark, and the chime sounds soft across the yard. That leaves one.

Gamma Person doesn't celebrate. She steps off the platform, exhales once, and production's voice rolls across the backyard: Gamma Person wins the Power of Veto.

@[Gamma Person] "Okay." That's all she says at first, and then, quieter, to nobody in particular: "Okay. Now it gets complicated."

The yard breaks up. Chairs scrape, towels get gathered, and the whole group drifts back through the glass doors into the cool of the house.

((The veto ceremony is tomorrow evening — tonight is yours.))
'''

TIME_JUMP = '''The front door closes behind you and the hallway light goes dim, and that's it — the house is behind you, and the season goes on without you.

---

Week 2 belonged to Hoh Person. She outlasted the whole house in the Head of Household competition, and she put Nom Alpha and Nom Beta on the block. Gamma Person won the veto and left it in her pocket, and when the ballots were read, Nom Beta walked out the door — six votes to four.

Now it's 6:30 in the evening on Day 6, and the house has found a reason to be loud. Somebody's birthday — the kitchen counter is covered in a lopsided cake.

@[Nom Beta] "Hey. I've been meaning to catch you before this week gets loud." She sets the plate down. "So. What am I missing?"
'''

NAMES = ["Hoh Person", "Nom Alpha", "Nom Beta", "Gamma Person", "Houseguest A", "Houseguest B"]


def _sig(**over):
    base = {"week": 1, "phase": "nominations", "pending": None, "hoh": "npc:1", "hohName": "Hoh Person", "noms": [], "nomNames": [],
            "activeNames": list(NAMES), "evicted": 0, "evictedNames": [], "finished": False, "ballotCounts": None, "evictionEvictee": None,
            "playerIsHoh": False, "playerHasVeto": False, "vetoHolder": None, "vetoHolderName": None}
    base.update(over)
    return base


# fixture, board the engine held, the sentence(s) that must go, and sentences that must survive
CASES = {
    "hoh-rules-quote": (HOH_COMP_RULES, _sig(phase="hoh-competition", pending="comp-round", hoh=None, hohName=None), ["Last person standing"],
                        ["no second chance.", '"Sixteen of you. Step onto your lanes."', "The first panel goes dark.", "How are you playing this one"]),
    "hoh-crown": (HOH_CROWN, _sig(phase="nominations"), ["you are the new Head of Household"],
                  ["Hoh Person catches it.", "The yard comes apart.", "That was *close.*"]),
    "key-ritual": (KEY_RITUAL, _sig(phase="nominations"), ["turn the first key now"],
                   ["I'm going to skip that", "She steps to the box and turns it.", "I want to hear the room first."]),
    "veto-won": (VETO_WIN, _sig(phase="veto-ceremony", noms=["npc:2", "npc:3"], nomNames=["Nom Alpha", "Nom Beta"], vetoHolder="npc:4", vetoHolderName="Gamma Person"),
                 ["wins the Power of Veto"], ["Gamma Person doesn't celebrate.", "Now it gets complicated.", "The yard breaks up.", "tonight is yours.))"]),
    "comp-result-recap": (TIME_JUMP, _sig(phase="hoh-competition", pending="comp-round", hoh=None, hohName=None), ["She outlasted the whole house", "six votes to four"],
                          ["Week 2 belonged to Hoh Person.", "Now it's 6:30 in the evening", "What am I missing?"]),
}


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _state(monkeypatch):
    for d in (ch._LAST_BEAT_SIG, ch._DESYNC_REGROUND, ch._SCENE_REWRITE, ch._EARLY_DROPS):
        d.pop(_USER, None)

    async def cap(user=None):
        return dict(cap.sig)
    cap.sig = _sig()
    monkeypatch.setattr(ch, "_capture_beat_signature", cap)

    def arm(sig, before=None):
        cap.sig = sig
        ch._LAST_BEAT_SIG[_USER] = dict(before if before is not None else sig)
    cap.arm = arm
    yield cap
    for d in (ch._LAST_BEAT_SIG, ch._DESYNC_REGROUND, ch._SCENE_REWRITE, ch._EARLY_DROPS):
        d.pop(_USER, None)


@pytest.mark.parametrize("name", list(CASES))
def test_real_reply_keeps_its_sound_sentences_and_loses_only_the_early_claim(name, _state):
    text, sig, gone, kept_bits = CASES[name]
    _state.arm(sig)
    assert ch._narration_claims_outcome(text, sig, sig)  # the old whole-scene cut trigger
    assert _run(ch.screen_streamed_scene_break(_USER, text)) is None  # not cut
    kept = ch.take_scene_rewrite(_USER)
    assert kept
    for g in gone:
        assert g not in kept
    for k in kept_bits:
        assert k in kept
    assert len(kept) > len(text) * 0.6  # the scene, not a stub
    assert agent_loop.close_open_markup(kept) == ""  # never an open quote / bold span
    assert not ch._narration_claims_outcome(kept, sig, sig)  # the stripped text passes the SAME verifier
    assert not ch._DESYNC_REGROUND.get(_USER)  # prose and board agree again: nothing to re-ground
    assert ch.cut_streak(_USER) == 0


def test_a_dropped_closing_quote_is_kept_so_the_span_opened_earlier_still_closes():
    text, sig, _g, _k = CASES["hoh-rules-quote"]
    kept, n = ch.drop_early_claim_sentences(text, sig, sig)
    assert n == 1
    para = [p for p in kept.split("\n\n") if "Houseguests — welcome" in p][0]
    assert para.endswith('no second chance."')


def test_paragraph_break_of_a_dropped_last_sentence_survives():
    sig = CASES["veto-won"][1]
    text = "Before it. Gamma Person wins the Power of Veto.\n\nAfter it."
    assert ch.drop_early_claim_sentences(text, sig, sig) == ("Before it.\n\nAfter it.", 1)


def test_a_chunk_that_is_only_the_claim_rewrites_to_nothing_but_its_closer(_state):
    text, sig, _g, _k = CASES["hoh-rules-quote"]
    _state.arm(sig)
    chunk = ' Last person standing on the platform is the new Head of Household."\n'
    assert _run(ch.screen_streamed_scene_break(_USER, chunk)) is None
    assert ch.take_scene_rewrite(_USER) == '"\n'


def test_whole_stream_chunk_by_chunk_keeps_the_scene_and_balanced_quotes(_state):
    """The live path: the stream is cut into sentence chunks, each screened alone; no chunk may halt the scene."""
    for name in ("hoh-rules-quote", "hoh-crown", "key-ritual", "veto-won", "comp-result-recap"):
        text, sig, gone, kept_bits = CASES[name]
        _state.arm(sig)
        buf, shown, raw, broken = text, "", text, False
        while buf:
            done, buf = agent_loop._split_complete_sentences(buf)
            if not done:
                done, buf = buf, ""
            g = _run(agent_loop._emit_guarded_scene(done, _USER, scene_broken=broken, emitted_visible=bool(shown.strip()), cutaway_emitted=False))
            broken = g.scene_broken
            shown += g.text
            raw = agent_loop._apply_mirror_ops(raw, agent_loop._scene_ops(done, g))
        assert not broken, name
        assert agent_loop._SCENE_CUTAWAY_LINE not in shown
        for gsub in gone:
            assert gsub not in shown, name
            assert gsub not in raw, name  # persisted text equals what was shown
        for k in kept_bits:
            assert k in shown, (name, k)
        assert agent_loop.close_open_markup(shown) == ""
        assert shown.count('"') % 2 == 0, name


def test_emit_helper_streams_the_kept_scene_not_a_cutaway(_state):
    text, sig, _g, _k = CASES["hoh-crown"]
    _state.arm(sig)
    out = _run(agent_loop._emit_guarded_scene(text, _USER, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert out.scene_broken is False and out.text != agent_loop._SCENE_CUTAWAY_LINE
    assert "Hoh Person catches it." in out.text and "you are the new Head of Household" not in out.text


# ---- negative controls: strictness is unchanged for everything that is not an isolatable early claim ----

def test_a_wrong_crowned_identity_is_still_cut_whole(_state):
    before = _sig(phase="hoh-competition", hoh=None, hohName=None)
    after = _sig(phase="hoh-competition", hoh="npc:1", hohName="Hoh Person")
    _state.arm(after, before)
    d = _run(ch.screen_streamed_scene_break(_USER, 'The yard erupts. Nom Alpha wins Head of Household.\n\nThe yard is quiet.'))
    assert d and "WRONG" in d
    assert ch.take_scene_rewrite(_USER) is None


def test_a_wrong_evictee_next_to_an_early_claim_is_still_cut_whole(_state):
    sig = _sig(phase="hoh-competition", pending="comp-round", hoh=None, hohName=None)
    _state.arm(sig)
    d = _run(ch.screen_streamed_scene_break(_USER, "Nom Beta is evicted from the house tonight.\n\nThe yard is quiet. Hoh Person is the new Head of Household."))
    assert d
    assert ch.take_scene_rewrite(_USER) is None


def test_a_flagged_sentence_with_a_mid_sentence_dangling_quote_is_cut_whole(_state):
    sig = CASES["veto-won"][1]
    _state.arm(sig)
    text = 'The yard goes still. He says "ready, set, Gamma Person wins the Power of Veto. Then nothing.'
    assert ch.drop_early_claim_sentences(text, sig, sig) is None
    assert _run(ch.screen_streamed_scene_break(_USER, text))
    assert ch.take_scene_rewrite(_USER) is None


def test_when_the_stripped_text_still_claims_the_outcome_the_scene_is_cut_whole(_state, monkeypatch):
    text, sig, _g, _k = CASES["hoh-crown"]
    _state.arm(sig)
    # a drop that leaves a claim behind (here: nothing could be removed) must not rescue: the re-verify of the stripped text is the gate
    monkeypatch.setattr(ch, "drop_early_claim_sentences", lambda t, b, a: (t, 1))
    d = _run(ch.screen_streamed_scene_break(_USER, text))
    assert d and ch.take_scene_rewrite(_USER) is None


def test_a_correct_claim_at_the_right_beat_is_untouched(_state):
    before = _sig(phase="hoh-competition", hoh=None, hohName=None)
    after = _sig(phase="hoh-competition", hoh="npc:1", hohName="Hoh Person")  # the crown really committed this turn
    _state.arm(after, before)
    text = 'Hoh Person is the new Head of Household.\n\nThe yard comes apart.'
    assert _run(ch.screen_streamed_scene_break(_USER, text)) is None
    assert ch.take_scene_rewrite(_USER) is None  # streams as-is, no rewrite
    assert ch.drop_early_claim_sentences(text, before, after) is None


def test_a_reply_with_no_claim_is_untouched(_state):
    _state.arm(_sig(phase="hoh-competition", hoh=None, hohName=None))
    assert _run(ch.screen_streamed_scene_break(_USER, "The yard is quiet. Houseguest A stretches.")) is None
    assert ch.take_scene_rewrite(_USER) is None


def test_a_self_crown_that_does_not_name_the_real_hoh_is_a_genuine_lie_and_is_cut_whole(_state):
    sig = _sig(phase="hoh-competition", pending="comp-round", hoh="npc:1", hohName="Hoh Person")
    _state.arm(sig)
    d = _run(ch.screen_streamed_scene_break(_USER, "The feeds swing to you - you won HOH! Everyone erupts."))
    assert d and "HEAD OF HOUSEHOLD" in d
    assert ch.take_scene_rewrite(_USER) is None


def test_a_scene_full_of_claim_sentences_is_cut_whole_once_the_per_turn_budget_is_spent(_state):
    sig = CASES["key-ritual"][1]
    _state.arm(sig)
    claim = ' Hoh Person turns the first key. '
    assert _run(ch.screen_streamed_scene_break(_USER, "Fine." + claim)) is None  # 1st drop
    assert _run(ch.screen_streamed_scene_break(_USER, "Fine." + claim)) is None  # 2nd drop
    ch.take_scene_rewrite(_USER)
    d = _run(ch.screen_streamed_scene_break(_USER, "Fine." + claim))  # 3rd claim sentence in one turn: a fabricated scene, not one early sentence
    assert d and ch.take_scene_rewrite(_USER) is None
    _state.arm(sig)  # a new turn (a fresh baseline) gets a fresh budget
    assert _run(ch.screen_streamed_scene_break(_USER, "Fine." + claim)) is None
    assert ch.take_scene_rewrite(_USER)
