"""ORW-1057 .. ORW-1062 (audit A6): the text-editing guards must not corrupt or wrongly cut a reply. Synthetic names and lines only. Table-driven."""
import asyncio
import importlib

import pytest

from src import orwell_engine as oe
from src import player_voice_guard as pvg
from src import recital_guard as rg
from src.speaker_turns import TurnSeam, malformed

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ---- ORW-1057: the recital guard edits the first sentence; the stored round follows the edit, no stray fragment -----------------------------------------
@pytest.mark.parametrize("raw,shown", [
    ("Verbatim, the fire pit hisses. Mara looks up.", "The fire pit hisses. Mara looks up."),
    ("Keep the scene quiet and tense. The fire pit crackles.", "The fire pit crackles."),
    ("Keep the scene quiet and jittery. The fire pit crackles.", "The fire pit crackles."),
    ("Keep the answer short and plain. Mara looks up.", "Mara looks up."),
])
def test_1057_recital_shown_equals_stored_and_no_fragment(raw, shown):
    round_response, clean, hit = al._strip_leading_recital("u-1057", 1, raw, raw, "")
    assert hit and clean == shown and round_response == shown


def test_1057_a_later_chunk_is_not_touched_and_a_scene_sentence_is_kept():
    raw = "Mara looks up. Keep the scene quiet."
    assert al._strip_leading_recital("u-1057", 1, raw, raw, "")[2] is False
    t = "Write the text message to Dex, you think."
    assert rg.strip_leading_recital(t) == (t, 0)


# ---- ORW-1058: a sentence cut inside a multi-sentence quote leaves no orphan mark, at the start, middle and end -------------------------------------------
QUOTE = 'Mara murmurs, "Good call. Really good. Stay put." Dex shrugs.'


@pytest.mark.parametrize("cut", ["Mara murmurs, \"Good call.", " Really good.", " Stay put.", "\" Dex shrugs."], ids=["start", "middle", "end", "tail"])
def test_1058_a_cut_inside_a_quote_leaves_balanced_marks(cut):
    from src.speaker_turns import split_parts
    parts = split_parts(QUOTE)
    post = "".join(p for p in parts if p != cut)
    seam = TurnSeam()
    out = seam.feed(QUOTE, post) + seam.finish()
    assert malformed(out) == [], out
    assert out.count('"') % 2 == 0


def test_1058_the_player_voice_decision_drop_through_the_real_guard():
    text = 'You decide to stay, and Mara murmurs, "Good call. Really good." Dex shrugs.'
    post, dropped = pvg.screen(text, "x")
    assert dropped and post.startswith(" Really good") or post.startswith("Really good")
    seam = TurnSeam()
    out = seam.feed(text, post) + seam.finish()
    assert malformed(out) == [] and "Dex shrugs." in out


# ---- ORW-1059: the N-17 confession guard ----------------------------------------------------------------------------------------------------------------
@pytest.fixture
def conf_user():
    u = "u-1059"
    ch._GAME_WAS_ACTIVE.add(u)
    oe.clear_disclosure_turn(u)
    return u


FALSE_POSITIVES = [
    'Mara grins. "I have to confess, I just broke the endurance record on the wall." Dex whoops.',
    '"My secret is, I fired the hose at Dex last night," Mara laughs.',
    'Dex says, "I have to come clean: I was fired up all night."',
    'Mara says, "I confess I called a bad evict-night joke." Dex winces.',
]


@pytest.mark.parametrize("line", FALSE_POSITIVES)
def test_1059_ordinary_game_words_are_not_a_confession(conf_user, line):
    assert ch.screen_invented_confession(conf_user, line) == (line, [])


def test_1059_the_players_own_quoted_words_are_not_judged(conf_user):
    line = 'You say, "I have never told anyone this. I did time in prison for fraud." Mara listens.'
    assert ch.screen_invented_confession(conf_user, line) == (line, [])
    quoted = 'Mara repeats, "I have never told anyone this. I did time in prison for fraud." Dex frowns.'
    assert ch.screen_invented_confession(conf_user, quoted, 'I have never told anyone this. I did time in prison for fraud.') == (quoted, [])


def test_1059_only_the_confession_sentence_is_replaced_in_a_mixed_paragraph(conf_user, monkeypatch):
    seen = []
    from src import orwell_sync_ledger as led
    monkeypatch.setattr(led, "note_belt_fire", lambda u, b, n=1: seen.append((b, n)))
    line = 'Dex pours coffee. Mara leans in. "I have never told anyone this. I did time in prison for fraud." Dex gasps and steps back.'
    out, ops = ch.screen_invented_confession(conf_user, line)
    assert ops and "prison" not in out and "Dex pours coffee." in out and "Dex gasps and steps back." in out
    assert seen == [("invented-confession", len(ops))]  # ORW-1061: counted on an applied replacement
    seam = TurnSeam()
    assert malformed(seam.feed(line, out) + seam.finish()) == []


def test_1059_a_pure_confession_line_is_still_replaced_whole(conf_user):
    line = 'KV— "I have never told anyone this. Before the show I did eighteen months in prison for fraud."'
    out, ops = ch.screen_invented_confession(conf_user, line)
    assert ops and out in ch._CONFESSION_DEFLECTIONS


# ---- ORW-1060: the tell-faithfulness belt -------------------------------------------------------------------------------------------------------------
@pytest.fixture
def tells():
    u = "u-1060"
    oe._TELLS_TURN.clear()
    yield u
    oe._TELLS_TURN.clear()


NOT_VIOLATIONS = [
    ("withdrawn", "The kitchen is bubbly; Dex sits quietly."),
    ("withdrawn", 'Dex drops onto the slumped sofa cushions and says, "Fine."'),
    ("withdrawn", 'Mara tells Dex, "Don\'t be giddy, Dex," and Dex looks at the floor.'),
    ("withdrawn", "The crowd's bubbly cheer fills the hall while Dex waits."),
    ("none", "The giddy cheer of the crowd rolls over Dex."),
    ("none", 'Dex hears Mara say, "I was sobbing last night."'),
]


@pytest.mark.parametrize("kind,line", NOT_VIOLATIONS)
def test_1060_a_cue_about_a_room_a_thing_or_a_quote_is_not_the_npcs(tells, kind, line):
    oe._TELLS_TURN[tells] = {"Dex": [] if kind == "none" else [kind]}
    assert ch.screen_tell_faithfulness(tells, line) == (line, [])


def test_1060_only_the_contradicting_sentence_is_replaced(tells):
    oe._TELLS_TURN[tells] = {"Dex": ["withdrawn"]}
    line = 'Mara laughs. "Come on." Dex is beaming at the door. Mara waves.'
    out, ops = ch.screen_tell_faithfulness(tells, line)
    assert len(ops) == 1 and "beaming" not in out and 'Mara laughs. "Come on."' in out and out.endswith("Mara waves.")
    assert "Dex keeps a level expression" in out


# ---- ORW-1061: the walls leave a count -----------------------------------------------------------------------------------------------------------------
def test_1061_the_presence_wall_counts_an_applied_drop(monkeypatch):
    from src import orwell_sync_ledger as led
    seen = []
    monkeypatch.setattr(led, "note_belt_fire", lambda u, b, n=1: seen.append((b, n)))

    async def gs(user=None):
        return {"whereabouts": {"room": "kitchen", "present": [{"id": "npc:1", "name": "Ava Ray"}], "nearby": []},
                "house": [{"name": "Ava Ray", "status": "active"}, {"name": "Ben Cole", "status": "active"}]}
    monkeypatch.setattr(oe, "get_game_state", gs)
    out = _run(ch.screen_presence_wall("u-1061", '@[Ben Cole] — "Hi there." Ben waves.\n\n@[Ava Ray] — "Morning."', carry={}))
    assert "Hi there" not in out and ("presence-wall", 1) in seen


# ---- ORW-1062: the player-voice guard -----------------------------------------------------------------------------------------------------------------
KEPT = [
    ("x", "Whatever you decide, the house will hear it. You vote tomorrow."),
    ("x", "If you decide to stay, Mara smiles."),
    ("I want to devote my time to this", None),   # placeholder row replaced below
]


@pytest.mark.parametrize("pm,text", [(a, b) for a, b in KEPT if b])
def test_1062_a_conditional_or_future_fact_is_not_a_decision(pm, text):
    assert pvg.screen(text, pm) == (text, [])


@pytest.mark.parametrize("pm,text,withheld", [
    ("x", "You decide to stay, and Mara nods.", True),
    ("x", "You voted for Dex.", True),
    ("I want to devote my time to this", "You vote for Dex.", True),     # "devote" is not "vote"
    ("the agreement is fine", "You agreed to it.", True),                   # "agreement" is not "agreed"
    ("I will vote Dex", "You vote for Dex.", False),                        # the player did say it
    ("we agreed already", "You agreed to it.", False),
])
def test_1062_whole_word_verbs_decide_whether_the_player_said_it(pm, text, withheld):
    assert bool(pvg.screen(text, pm)[1]) is withheld


def test_1062_a_houseguest_echoing_a_question_back_is_normal_speech():
    q = "Are you sure you want to trust Dex with the vote tonight, or are you just saying that?"
    text = f'@[Mara Lee] — "{q}" Mara repeats it back to you, slowly.'
    assert pvg.screen(text, q)[1] == []
    recited = f'@[Mara Lee] — "{q}" Mara smiles.'
    assert pvg.screen(recited, q)[1], "an unattributed recital of the player's own question is still withheld"
