"""N-6 (playtest, Med) - the A2 scene circuit-breaker must not cut an out-of-character `((...))` production answer.

Evidence (run-20261103-1447 persisted seq 53, 55, 71, 75, 85, 6x): the cutaway line ("The live feeds cut away - a slow pan over the empty
backyard...") fired on a direct OOC question ("who are the nominees, who holds the veto?") and on ceremony beats; the real answer then followed
with a stray `))`. A production answer RESTATES the board ("The nominees are X and Y; Z holds the veto") - it narrates no event - yet its
sentences match the closed-set claim regexes, and the stream is sentence-buffered so an aside is split across chunks (`((The nominees are...`
then `...holds the veto.))`).

Fix (agent_loop): track whether the stream is INSIDE a `((...))` aside across chunks and split each chunk into narration and aside segments
(`_ooc_segments`, `_guard_stream_chunk`). Asides are exempt ONLY from the scene circuit-breaker and its cutaway line - they are NOT exempt from
the truth: each aside sentence is checked claim-by-claim against the live board STATE (`chat_helpers._aside_claim_contradicts_board`). A TRUE
restatement (nominees / veto holder / HOH matching the board) streams; a contradicted claim (a fabricated veto winner, a wrong nominee) is
stripped - and the rest of that aside with it, so no half-aside or stray `))` survives. Narration outside an aside is screened exactly as before.
The Vault walls (knowledge/presence) are untouched - they run after this at the call sites.
"""
import asyncio
import importlib

agent_loop = importlib.import_module("src.agent_loop")
chat_helpers = importlib.import_module("routes.chat_helpers")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# -- the segmenter ----------------------------------------------------------------------------------

def test_segments_reproduce_the_chunk_and_flag_the_asides():
    f = agent_loop._ooc_segments
    segs, open_ = f("She nods. ((Production note.)) The room goes quiet.", False)
    assert "".join(t for t, _a in segs) == "She nods. ((Production note.)) The room goes quiet."
    assert [a for _t, a in segs] == [False, True, False] and open_ is False
    segs2, open2 = f("((The nominees are X.", False)
    assert segs2 == [("((The nominees are X.", True)] and open2 is True
    segs3, open3 = f(" Y holds the veto.)) Then silence.", True)
    assert segs3 == [(" Y holds the veto.))", True), (" Then silence.", False)] and open3 is False


# -- the guarded chunk wrapper ----------------------------------------------------------------------

LIVE = {
    "week": 2, "phase": "veto", "hoh": "npc:1", "hohName": "Hoh", "nomNames": ["Nominee1", "Nominee2"],
    "vetoHolder": "npc:5", "vetoHolderName": "Vetoholder", "evictedNames": [],
    "activeNames": ["Hoh", "Nominee1", "Nominee2", "Vetoholder", "Houseguest1", "Houseguest2"],
}


def _stub(monkeypatch, *, cut_narration=False, live=LIVE):
    log = {"breaker": [], "capture": 0}

    async def breaker(user, text):
        log["breaker"].append(text)
        return "RE-GROUND" if cut_narration else None

    async def capture(user):
        log["capture"] += 1
        return live

    async def sentence(text, owner):
        return text

    monkeypatch.setattr(chat_helpers, "screen_streamed_scene_break", breaker)
    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", capture)
    monkeypatch.setattr(agent_loop, "_pre_emission_outcome_guard", sentence)
    return log


def _g(text, state="", **kw):
    args = dict(scene_broken=False, emitted_visible=False, cutaway_emitted=False)
    args.update(kw)
    return _run(agent_loop._guard_stream_chunk(text, "u", ooc_open=state, **args))


def test_a_TRUE_restatement_in_an_aside_streams_and_never_reaches_the_breaker(monkeypatch):
    log = _stub(monkeypatch, cut_narration=True)  # a breaker that WOULD cut anything it sees
    text = "((The nominees are Nominee1 and Nominee2. Vetoholder holds the veto and Hoh is the HOH.))"
    g, st = _g(text)
    assert g.text == text and g.scene_broken is False and g.cutaway_emitted is False and st == ""
    assert log["breaker"] == [], "an aside is exempt from the scene circuit-breaker"


def test_a_FALSE_winner_aside_is_stripped_not_replaced_by_the_cutaway(monkeypatch):
    log = _stub(monkeypatch, cut_narration=True)
    g, st = _g("((Houseguest1 won the veto and will use it.))")
    assert g.text == "", "the fabricated outcome is stripped"
    assert g.scene_broken is False and g.cutaway_emitted is False and g.text != agent_loop._SCENE_CUTAWAY_LINE
    assert st == "" and log["breaker"] == []


def test_wrong_nominee_and_wrong_veto_holder_and_wrong_hoh_asides_are_stripped(monkeypatch):
    _stub(monkeypatch)
    for lie in ("((The nominees are Houseguest1 and Nominee1.))", "((Houseguest1 holds the veto.))", "((Houseguest2 is the HOH.))",
                "((Houseguest1 was evicted last night.))"):
        g, _ = _g(lie)
        assert g.text == "", lie


def test_a_false_aside_split_across_chunks_is_held_then_dropped_entirely(monkeypatch):
    _stub(monkeypatch)
    g1, s1 = _g("((Houseguest1 won the veto.")
    assert g1.text == "" and s1.startswith("(("), "an unterminated aside is HELD, never emitted half-open"
    g2, s2 = _g(" He will use it tonight.))", s1)
    assert g2.text == "" and s2 == "", "the whole aside is dropped: no opener already emitted, no stray `))`"


def test_a_true_aside_split_across_chunks_streams_whole_and_balanced(monkeypatch):
    _stub(monkeypatch)
    g1, s1 = _g("((The nominees are Nominee1 and Nominee2.")
    assert g1.text == "" and s1 == "((The nominees are Nominee1 and Nominee2."
    g2, s2 = _g(" Vetoholder holds the veto.))", s1)
    assert g2.text == "((The nominees are Nominee1 and Nominee2. Vetoholder holds the veto.))" and s2 == ""
    assert g2.consumed == g2.text


def test_a_false_sentence_late_in_a_true_aside_drops_the_whole_aside(monkeypatch):
    _stub(monkeypatch)
    g, st = _g("((The nominees are Nominee1 and Nominee2. Houseguest1 holds the veto.))")
    assert g.text == "" and st == ""


def test_flush_closes_and_screens_an_unterminated_aside(monkeypatch):
    _stub(monkeypatch)
    g1, s1 = _g("((Take a breath")
    assert g1.text == ""
    g2, s2 = _run(agent_loop._guard_stream_chunk("", "u", ooc_open=s1, scene_broken=False, emitted_visible=False, cutaway_emitted=False, flush=True))
    assert g2.text == "((Take a breath))" and s2 == ""
    g3, _ = _run(agent_loop._guard_stream_chunk("", "u", ooc_open="((Houseguest1 won the veto.", scene_broken=False, emitted_visible=False,
                                                 cutaway_emitted=False, flush=True))
    assert g3.text == ""


def test_stray_closers_are_scrubbed_on_the_no_aside_fast_path(monkeypatch):
    _stub(monkeypatch)
    g, st = _g("leftover.))")
    assert g.text == "leftover." and st == ""
    g2, _ = _g("She nods.)) ((Production note.)) Quiet.))")
    assert "She nods." in g2.text and "Quiet." in g2.text and "))" in g2.text and g2.text.count("))") == 1  # only the balanced aside keeps its marker


def test_a_claim_free_aside_never_reads_the_board(monkeypatch):
    log = _stub(monkeypatch)
    g, _ = _g("((The competition is set for this afternoon - you are in.))")
    assert g.text.startswith("((The competition") and log["capture"] == 0


def test_an_unreadable_engine_drops_an_aside_that_makes_a_board_claim(monkeypatch):
    _stub(monkeypatch, live=None)
    g, _ = _g("((Vetoholder holds the veto.))")
    assert g.text == "", "an unverifiable outcome must not stream, even inside an aside"
    g2, _ = _g("((Take a breath - you are fine.))")
    assert g2.text.startswith("((Take a breath")


def test_narration_with_an_unbacked_board_claim_is_still_cut(monkeypatch):
    _stub(monkeypatch, cut_narration=True)
    g, st = _g("Houseguest1 wins Head of Household and the room erupts.")
    assert g.scene_broken is True and g.text == agent_loop._SCENE_CUTAWAY_LINE and st == ""


def test_mixed_chunk_keeps_the_narration_and_strips_only_the_false_aside(monkeypatch):
    log = _stub(monkeypatch)
    g, st = _g("She nods slowly. ((Houseguest1 won the veto.)) The room goes quiet.")
    assert "She nods slowly." in g.text and "The room goes quiet." in g.text
    assert "Houseguest1" not in g.text and "((" not in g.text and "))" not in g.text
    assert log["breaker"] and all("Houseguest1" not in b for b in log["breaker"]), "the breaker only ever sees narration"


def test_a_chunk_with_no_aside_is_screened_exactly_as_before(monkeypatch):
    log = _stub(monkeypatch)
    g, st = _g("Houseguest1 laughs and the room relaxes.")
    assert g.text == "Houseguest1 laughs and the room relaxes." and st == "" and log["breaker"] == ["Houseguest1 laughs and the room relaxes."]


def test_the_state_check_is_pure_and_conservative():
    f = chat_helpers._aside_claim_contradicts_board
    assert f("Vetoholder holds the veto.", LIVE) is False
    assert f("Houseguest1 holds the veto.", LIVE) is True
    assert f("A name nobody has, Zed Quimby, won the veto.", LIVE) is False, "an invented name is the roster guard's job"
    assert f("Nothing to see here.", LIVE) is False and f("anything", {}) is False


def test_every_claim_in_a_sentence_is_checked_not_just_the_first():
    f = chat_helpers._aside_claim_contradicts_board
    assert f("Vetoholder holds the veto and Houseguest1 holds the veto.", LIVE) is True
    assert f("Hoh is the HOH and Houseguest2 is the HOH.", LIVE) is True
    assert f("Vetoholder holds the veto and Hoh is the HOH.", LIVE) is False


def test_hypothetical_and_conditional_sentences_are_exempt_but_plain_assertions_are_not():
    f = chat_helpers._aside_claim_contradicts_board
    for ok in ("If Houseguest1 wins the veto they could save a nominee.", "Whoever wins the veto decides; maybe Houseguest1 wins the veto.",
               "When Houseguest1 wins the veto the plan changes.", "Houseguest1 would win the veto in that case."):
        assert f(ok, LIVE) is False, ok
    for bad in ("Houseguest1 won the veto.", "Houseguest1 holds the veto.", "Houseguest2 is the HOH.", "The nominees are Houseguest1 and Nominee1."):
        assert f(bad, LIVE) is True, bad


def test_uncommitted_role_assertions_are_unbacked_and_stripped_but_hypotheticals_pass():
    """N-1: before a role is committed, an assertive 'X won/holds it' has nothing behind it -> stripped. Hypothetical/future wording passes."""
    f = chat_helpers._aside_claim_contradicts_board
    early = dict(LIVE, phase="hoh", vetoHolderName=None, vetoHolder=None, nomNames=[])
    assert f("Houseguest1 won the veto.", early) is True, "no veto holder yet: a winner claim is premature"
    assert f("Houseguest1 holds the veto.", early) is True
    assert f("The nominees are Houseguest1 and Nominee1.", early) is True
    assert f("Houseguest2 is the HOH.", early) is True, "the HOH IS committed and is someone else"
    for ok in ("Whoever wins the veto decides.", "If Houseguest1 wins the veto they could save a nominee.", "Houseguest1 might win the veto."):
        assert f(ok, early) is False, ok


def test_the_anonymized_ballot_reveal_is_not_an_eviction_claim():
    f = chat_helpers._aside_claim_contradicts_board
    ev = dict(LIVE, phase="eviction")
    assert f("The first ballot is a vote to evict Nominee1.", ev) is False
    assert f("Nominee1 was evicted.", ev) is True
    assert f("A vote to evict Houseguest1.", ev) is True, "a non-nominee is not the sanctioned reveal"


def test_wired_at_both_stream_call_sites():
    src = open(agent_loop.__file__, encoding="utf-8").read()
    assert src.count("_guard_stream_chunk(") >= 3, "definition + the mid-loop emit + the trailing flush"
    assert '_ooc_open = ""' in src, "per-round aside state is initialised"
