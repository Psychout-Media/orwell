"""ORW-1028: no reply reaches the player with a speaker-less line, an orphaned quote or an unbalanced quote mark.

Every reply guard cuts at sentence level; a turn is `@[Name] - "line." narration "more."`. When a guard cut the sentence that carries the tag, the rest of the turn stayed behind
(a headless line). `src/speaker_turns.TurnSeam` runs after all the guards on the streamed chunk and removes a turn whole when it lost its head. Names and lines below are synthetic."""
import asyncio
import importlib
import random
import re

import pytest

from src import orwell_engine
from src.speaker_turns import TAG_RE, TurnSeam, malformed, split_parts, wellformed

chat_helpers = importlib.import_module("routes.chat_helpers")
rc = importlib.import_module("src.role_claims")
_USER = "u-orw1028"


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _stream(chunks_pre_post):
    """Feed the seam chunk by chunk; returns (emitted text, seam)."""
    seam = TurnSeam()
    out = "".join(seam.feed(pre, post) for pre, post in chunks_pre_post)
    return out + seam.finish(), seam


def _cut_sentences(text, pred):
    """A guard that removes the sentences `pred` selects (the guards' own split)."""
    return "".join(p for p in split_parts(text) if not pred(p))


REPLY = ('The kitchen smells of toast.\n\n'
         '@[Ava Ray] — "Morning. Did you sleep?" She slides a mug across. "Coffee is hot."\n\n'
         '@[Ben Cole] — "Not really." He rubs his eyes. "The walls are thin."\n\n'
         'Sunlight crawls over the counter.\n\n'
         '@[Cy Dunn] — "Plans today?" Cy leans on the fridge. "I have a few."')


# ---- the guards: one case each ------------------------------------------------------------------------------------------------------------------------
def _presence_state():
    return {"whereabouts": {"room": "kitchen", "present": [{"id": "npc:1", "name": "Ava Ray"}, {"id": "npc:3", "name": "Cy Dunn"}], "nearby": []},
            "house": [{"name": "Ava Ray", "status": "active"}, {"name": "Ben Cole", "status": "active"}, {"name": "Cy Dunn", "status": "active"}]}


def _guard_presence(monkeypatch, text):
    async def gs(user=None):
        return _presence_state()
    monkeypatch.setattr(orwell_engine, "get_game_state", gs)
    return _run(chat_helpers.screen_presence_wall(_USER, text, carry={}))


def _guard_role_claim(monkeypatch, text):
    sig = {"phase": "nominations", "activeNames": ["Ava Ray", "Ben Cole", "Cy Dunn"], "evictedNames": [], "playerName": "Pat Player",
           "hohName": "Ava Ray", "vetoHolderName": None, "nomNames": [], "playerStatus": "active"}
    return rc.screen_role_units(text, sig, None)[0]


def _guard_cut(name):
    """The knowledge wall, player-voice guard, confession guard and pre-display withhold all return the chunk minus whole sentences: modelled by cutting the sentence that carries the
    tag of the named houseguest (their own tests pin what each one selects; this pins what happens to the rest of the turn)."""
    return lambda monkeypatch, text: _cut_sentences(text, lambda p: TAG_RE.search(p) and name in p)


PRESENCE_TEXT = ('The front door goes.\n\n@[Ben Cole] — "Ben here. I just got in." He drops his bag. "Long night."\n\n@[Ava Ray] — "Morning." Ava lifts a mug.')
ROLE_TEXT = ('The room goes quiet.\n\n@[Ben Cole] — "I heard Ava Ray is the Head of Household." He lowers his voice. "Everyone knows."\n\n@[Cy Dunn] — "Maybe." Cy shrugs.')

GUARD_CASES = [
    ("presence wall (real)", _guard_presence, PRESENCE_TEXT, "Ben"),
    ("role-claim strip (real)", _guard_role_claim, ROLE_TEXT, None),
    ("knowledge wall (cut)", _guard_cut("Ben Cole"), REPLY, "Ben"),
    ("player-voice guard (cut)", _guard_cut("Ava Ray"), REPLY, "Ava"),
    ("confession guard (cut)", _guard_cut("Cy Dunn"), REPLY, "Cy"),
    ("pre-display withhold (cut)", _guard_cut("Ben Cole"), REPLY, "Ben"),
]


@pytest.mark.parametrize("label,guard,text,gone", GUARD_CASES, ids=[c[0] for c in GUARD_CASES])
def test_after_each_guard_the_turn_goes_whole_or_stays_whole(monkeypatch, label, guard, text, gone):
    post = guard(monkeypatch, text)
    out, _ = _stream([(text, post)])
    assert malformed(out) == [], f"{label}: {out!r}"
    # every kept turn is whole: a tag is always followed by its quote
    for para in [p for p in out.split("\n") if p.strip()]:
        if TAG_RE.search(para):
            assert re.search(r'"|“', para), para
        else:
            assert not para[0].isspace(), para


def test_presence_wall_real_drop_leaves_no_residue(monkeypatch):
    post = _guard_presence(monkeypatch, PRESENCE_TEXT)
    out, seam = _stream([(PRESENCE_TEXT, post)])
    assert "Ben" not in out and "Long night" not in out and "drops his bag" not in out
    assert "@[Ava Ray]" in out and "The front door goes." in out


# ---- the four prod shapes (synthetic equivalents) --------------------------------------------------------------------------------------------------
SHAPES = {
    # five turns lost their tag sentence; the rest of each stayed: headless quotes and a quote with no tag
    "many drops in one reply": (
        'Dawn light fills the room.\n\n@[Ben Cole] — "Hey. You up?" He waves. "Thought so."\n\nA door clicks.\n\n@[Dee Fox] — "Hi." Dee yawns. "Slept badly."\n\n'
        '@[Ava Ray] — "Morning." Ava smiles.', ("Ben Cole", "Dee Fox")),
    # one dropped speaker; the reply opens with blank lines
    "blank lines at the top": ('\n\n@[Dee Fox] — "Over here." She points. "Quick."\n\nThe kettle clicks.\n\n@[Ava Ray] — "Tea?" Ava asks.', ("Dee Fox",)),
    # the same speaker dropped twice in one reply
    "same speaker twice": ('@[Ben Cole] — "Listen." He leans in. "Please."\n\nThe fan hums.\n\n@[Ben Cole] — "Again." He sighs. "Fine."\n\n@[Ava Ray] — "Okay." Ava nods.', ("Ben Cole",)),
    # two dropped; the player had asked to talk to one of them
    "two dropped, player asked": ('The hall is long.\n\n@[Ben Cole] — "Here." Ben waves. "Come in."\n\n@[Dee Fox] — "Me too." Dee grins. "Sit."\n\n@[Ava Ray] — "Hi." Ava nods.', ("Ben Cole", "Dee Fox")),
}


@pytest.mark.parametrize("label", list(SHAPES))
def test_prod_shape_no_headless_line_survives(label):
    text, gone = SHAPES[label]
    post = _cut_sentences(text, lambda p: any(TAG_RE.search(p) and g in p for g in gone))  # what the sentence-level wall did
    out, seam = _stream([(text, post)])
    assert malformed(out) == [] and not out.startswith("\n")
    for g in gone:
        assert g not in out
    assert "Ava" in out


def test_before_the_seam_the_cut_text_is_malformed_after_it_is_not():
    text, gone = SHAPES["many drops in one reply"]
    post = _cut_sentences(text, lambda p: any(TAG_RE.search(p) and g in p for g in gone))
    assert "headless" in malformed(post)
    out, _ = _stream([(text, post)])
    assert malformed(out) == []


# ---- streaming across chunk boundaries ---------------------------------------------------------------------------------------------------------------
def test_a_turn_cut_at_its_head_goes_whole_across_chunks():
    chunks = [('@[Ben Cole] — "Hi there.', ""), (' He waves.', ' He waves.'), (' "Come in."\n', ' "Come in."\n'), ('\n@[Ava Ray] — "Morning."\n', '\n@[Ava Ray] — "Morning."\n')]
    out, _ = _stream(chunks)
    assert "Ben" not in out and "waves" not in out and "Come in" not in out
    assert out.strip() == '@[Ava Ray] — "Morning."'


def test_a_quote_left_open_at_a_paragraph_end_is_closed():
    out, seam = _stream([('@[Ava Ray] — "Morning. The coffee is on.\n\nNext.', '@[Ava Ray] — "Morning. The coffee is on.\n\nNext.')])
    assert out.split("\n")[0].endswith('on."') and seam.repaired == 1


def test_an_orphan_closing_mark_is_removed():
    out = wellformed('Quiet.\n\nThe name was Town, State." She comes in.')
    assert '"' not in out and "She comes in." in out


def test_a_bare_quote_line_with_no_speaker_is_dropped_but_a_narrated_one_stays():
    out = wellformed('The hall is dim.\n\n"Keep it down."\n\n"Fine," Ava mutters, stepping back.\n\n@[Ben Cole] — "Sure."')
    assert "Keep it down" not in out and "Ava mutters" in out and "@[Ben Cole]" in out


def test_bold_wrapped_announcement_is_untouched():
    t = 'Echoes.\n\n**"Houseguests, the vote is final."**\n\nA hush.'
    assert wellformed(t) == t


def test_clean_text_is_returned_unchanged_and_the_pass_is_idempotent():
    assert wellformed(REPLY) == REPLY
    cut = _cut_sentences(REPLY, lambda p: TAG_RE.search(p) and "Ben Cole" in p)
    once = wellformed(cut)
    assert wellformed(once) == once


def test_the_seam_reports_the_cuts_so_the_stored_text_can_follow():
    post = _cut_sentences(REPLY, lambda p: TAG_RE.search(p) and "Ben Cole" in p)
    seam = TurnSeam()
    seam.feed(REPLY, post)
    assert any("walls are thin" in c or "rubs his eyes" in c for c in seam.take_cuts())


def test_a_guard_that_rewrote_text_is_never_misread_as_a_cut():
    pre = '@[Ava Ray] — "I will tell you a secret."\n\n@[Ben Cole] — "Sure."'
    post = '@[Ava Ray] — "I would rather not say."\n\n@[Ben Cole] — "Sure."'
    seam = TurnSeam()
    assert seam.feed(pre, post) == post and seam.take_cuts() == []


def test_a_hiccup_emits_the_text_unchanged(monkeypatch):
    seam = TurnSeam()
    monkeypatch.setattr(seam, "_feed", lambda pre, post: (_ for _ in ()).throw(RuntimeError("x")))
    assert seam.feed("a", "b") == "b"


# ---- property: any sentence-level cut, any chunking, ends well-formed ------------------------------------------------------------------------------------
def _property_text(rng):
    names = ["Ava Ray", "Ben Cole", "Cy Dunn", "Dee Fox"]
    paras = []
    for _ in range(rng.randint(3, 7)):
        if rng.random() < 0.3:
            paras.append(rng.choice(["The air is warm.", "A door clicks. Nobody moves.", "Dishes clatter in the sink."]))
        else:
            n = rng.choice(names)
            paras.append(f'@[{n}] — "{rng.choice(["Hey.", "Okay then.", "Listen up."])} {rng.choice(["Really?", "I mean it."])}" '
                         f'{n.split()[0]} {rng.choice(["shrugs", "sighs"])}. "{rng.choice(["Fine.", "Later."])}"')
    return "\n\n".join(paras)


@pytest.mark.parametrize("seed", range(40))
def test_property_any_cut_leaves_a_well_formed_reply(seed):
    rng = random.Random(seed)
    text = _property_text(rng)
    parts = split_parts(text)
    keep = [rng.random() > 0.25 for _ in parts]
    post_parts = [p for p, k in zip(parts, keep) if k]
    # chunk the way the stream does: a few sentences at a time
    seam = TurnSeam()
    out, i = "", 0
    while i < len(parts):
        j = min(len(parts), i + rng.randint(1, 3))
        out += seam.feed("".join(parts[i:j]), "".join(p for p, k in zip(parts[i:j], keep[i:j]) if k))
        i = j
    out += seam.finish()
    assert malformed(out) == [], (seed, out)
    # nothing the guards kept in a turn that kept its head is lost
    for turn in [t for t in text.split("\n\n") if TAG_RE.search(t)]:
        head = split_parts(turn)[0]
        if head in post_parts:
            assert head.strip() in out or head.strip().lstrip() in out


def test_a_cut_untagged_head_keeps_the_narrated_quote_that_follows():
    pre = 'It was 3 a.m. "Sit down," Ana says. "This will not take long." A pause hangs.'
    post = ' "Sit down," Ana says. "This will not take long." A pause hangs.'
    out, _ = _stream([(pre, post)])
    assert out == '"Sit down," Ana says. "This will not take long." A pause hangs.'


# ---- through the real stream loop (the ORW-408 `_drive` harness): shown AND stored ---------------------------------------------------------------------
@pytest.mark.usefixtures("non_game_text_routing")
def test_real_loop_an_asleep_speaker_turn_is_removed_whole_shown_and_stored(monkeypatch):
    from tests.test_orw408_sentence_rewrite import _drive
    import src.settings as st
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")
    real = st.get_setting
    monkeypatch.setattr(st, "get_setting", lambda k, d=None: True if k == "zero_clocks" else real(k, d))
    status = {"timeOfDay": "late-night", "earlyMorning": True, "clockLabel": "5:30am, Day 3", "asleep": ["Sam Role"], "awake": ["Ana Role"], "started": True, "pending": None}
    deltas = ['Rain taps the glass.\n\n', '@[Sam Role] — ‘Good morning,’ Sam whispers, already dressed. ', 'Sam grins at you. "Sleep well."\n\n', '@[Ana Role] — "Hi." Ana waves. ']
    emitted, _cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": deltas}], redo="X", flag="0", status=status)
    shown = emitted.split("done.")[0]
    for text in (shown, stored[0]):
        assert "Sam" not in text and "Sleep well" not in text, text
        assert malformed(text.strip()) == [], text
        assert "@[Ana Role]" in text and "Rain taps the glass." in text
