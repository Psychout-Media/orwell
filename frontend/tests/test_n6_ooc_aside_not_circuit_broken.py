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


# -- the pure aside-state tracker -------------------------------------------------------------------

def test_outside_text_and_state_across_chunks():
    f = agent_loop._ooc_outside_text
    assert f("Dawn laughs.", False) == ("Dawn laughs.", False)
    assert f("((The nominees are Cole and Alejandro.))", False) == ("", False)
    # an aside split across sentence-sized chunks
    out1, st1 = f("((The nominees are Cole and Alejandro.", False)
    assert out1 == "" and st1 is True
    out2, st2 = f(" Arjun holds the veto.))", st1)
    assert out2 == "" and st2 is False
    # narration before/after an aside in one chunk keeps only the outside text
    out3, st3 = f("She nods. ((Production note.)) The room goes quiet.", False)
    assert "She nods." in out3 and "The room goes quiet." in out3 and "Production note" not in out3 and st3 is False
    # a stray close with no open never flips the state
    assert f("leftover.))", False) == ("leftover.", False)


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
    "week": 2, "phase": "veto", "hoh": "npc:1", "hohName": "Dawn Whitaker", "nomNames": ["Cole Marchetti", "Alejandro Cho"],
    "vetoHolder": "npc:5", "vetoHolderName": "Arjun Kessler", "evictedNames": [],
    "activeNames": ["Dawn Whitaker", "Cole Marchetti", "Alejandro Cho", "Arjun Kessler", "Ian Shea", "Luna Ortiz"],
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
    text = "((The nominees are Cole Marchetti and Alejandro Cho. Arjun Kessler holds the veto and Dawn Whitaker is the HOH.))"
    g, st = _g(text)
    assert g.text == text and g.scene_broken is False and g.cutaway_emitted is False and st == ""
    assert log["breaker"] == [], "an aside is exempt from the scene circuit-breaker"


def test_a_FALSE_winner_aside_is_stripped_not_replaced_by_the_cutaway(monkeypatch):
    log = _stub(monkeypatch, cut_narration=True)
    g, st = _g("((Ian Shea won the veto and will use it.))")
    assert g.text == "", "the fabricated outcome is stripped"
    assert g.scene_broken is False and g.cutaway_emitted is False and g.text != agent_loop._SCENE_CUTAWAY_LINE
    assert st == "" and log["breaker"] == []


def test_wrong_nominee_and_wrong_veto_holder_and_wrong_hoh_asides_are_stripped(monkeypatch):
    _stub(monkeypatch)
    for lie in ("((The nominees are Ian Shea and Cole Marchetti.))", "((Ian Shea holds the veto.))", "((Luna Ortiz is the HOH.))",
                "((Ian Shea was evicted last night.))"):
        g, _ = _g(lie)
        assert g.text == "", lie


def test_a_stripped_aside_split_across_chunks_drops_its_tail_too(monkeypatch):
    _stub(monkeypatch)
    g1, s1 = _g("((Ian Shea won the veto.")
    assert g1.text == "" and s1 == "drop"
    g2, s2 = _g(" He will use it tonight.))", s1)
    assert g2.text == "" and s2 == "", "the rest of the stripped aside never streams, and no stray `))` survives"


def test_a_true_aside_split_across_chunks_streams_whole(monkeypatch):
    _stub(monkeypatch)
    g1, s1 = _g("((The nominees are Cole Marchetti and Alejandro Cho.")
    assert g1.text == "((The nominees are Cole Marchetti and Alejandro Cho." and s1 == "aside"
    g2, s2 = _g(" Arjun Kessler holds the veto.))", s1)
    assert g2.text == " Arjun Kessler holds the veto.))" and s2 == ""


def test_a_claim_free_aside_never_reads_the_board(monkeypatch):
    log = _stub(monkeypatch)
    g, _ = _g("((The competition is set for this afternoon - you are in.))")
    assert g.text.startswith("((The competition") and log["capture"] == 0


def test_an_unreadable_engine_drops_an_aside_that_makes_a_board_claim(monkeypatch):
    _stub(monkeypatch, live=None)
    g, _ = _g("((Arjun Kessler holds the veto.))")
    assert g.text == "", "an unverifiable outcome must not stream, even inside an aside"
    g2, _ = _g("((Take a breath - you are fine.))")
    assert g2.text.startswith("((Take a breath")


def test_narration_with_an_unbacked_board_claim_is_still_cut(monkeypatch):
    _stub(monkeypatch, cut_narration=True)
    g, st = _g("Dawn wins Head of Household and the room erupts.")
    assert g.scene_broken is True and g.text == agent_loop._SCENE_CUTAWAY_LINE and st == ""


def test_mixed_chunk_keeps_the_narration_and_strips_only_the_false_aside(monkeypatch):
    log = _stub(monkeypatch)
    g, st = _g("She nods slowly. ((Ian Shea won the veto.)) The room goes quiet.")
    assert "She nods slowly." in g.text and "The room goes quiet." in g.text
    assert "Ian Shea" not in g.text and "((" not in g.text and "))" not in g.text
    assert log["breaker"] and all("Ian Shea" not in b for b in log["breaker"]), "the breaker only ever sees narration"


def test_a_chunk_with_no_aside_is_screened_exactly_as_before(monkeypatch):
    log = _stub(monkeypatch)
    g, st = _g("Dawn laughs and the room relaxes.")
    assert g.text == "Dawn laughs and the room relaxes." and st == "" and log["breaker"] == ["Dawn laughs and the room relaxes."]


def test_the_state_check_is_pure_and_conservative():
    f = chat_helpers._aside_claim_contradicts_board
    assert f("Arjun Kessler holds the veto.", LIVE) is False
    assert f("Ian Shea holds the veto.", LIVE) is True
    assert f("A name nobody has, Zed Quimby, won the veto.", LIVE) is False, "an invented name is the roster guard's job"
    assert f("Nothing to see here.", LIVE) is False and f("anything", {}) is False


def test_wired_at_both_stream_call_sites():
    src = open(agent_loop.__file__, encoding="utf-8").read()
    assert src.count("_guard_stream_chunk(") >= 3, "definition + the mid-loop emit + the trailing flush"
    assert '_ooc_open = ""' in src, "per-round aside state is initialised"
