"""N-6 (playtest, Med) - the A2 scene circuit-breaker must not cut an out-of-character `((...))` production answer.

Evidence (run-20261103-1447 persisted seq 53, 55, 71, 75, 85, 6x): the cutaway line ("The live feeds cut away - a slow pan over the empty
backyard...") fired on a direct OOC question ("who are the nominees, who holds the veto?") and on ceremony beats; the real answer then followed
with a stray `))`. A production answer RESTATES the board ("The nominees are X and Y; Z holds the veto") - it narrates no event - yet its
sentences match the closed-set claim regexes, and the stream is sentence-buffered so an aside is split across chunks (`((The nominees are...`
then `...holds the veto.))`).

Fix (agent_loop): track whether the stream is INSIDE a `((...))` aside across chunks (`_ooc_outside_text`) and run the breaker + per-sentence
guard only on text OUTSIDE an aside (`_guard_stream_chunk`). A chunk that is entirely an aside streams as-is; real narration that asserts an
unbacked board change is still cut. The Vault walls (knowledge/presence) are untouched - they run after this at the call sites.
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


# -- the guarded chunk wrapper ----------------------------------------------------------------------

def _stub_breaker(monkeypatch, *, cut):
    calls = []

    async def fake(user, text):
        calls.append(text)
        return "RE-GROUND" if cut else None

    monkeypatch.setattr(chat_helpers, "screen_streamed_scene_break", fake)

    async def fake_sentence(text, owner):
        calls.append("sentence:" + text)
        return text

    monkeypatch.setattr(agent_loop, "_pre_emission_outcome_guard", fake_sentence)
    return calls


def test_a_pure_aside_chunk_is_never_cut_and_never_screened(monkeypatch):
    calls = _stub_breaker(monkeypatch, cut=True)  # a breaker that WOULD cut anything it sees
    text = "((The nominees are Cole and Alejandro. Arjun holds the veto.))"
    g, open_ = _run(agent_loop._guard_stream_chunk(text, "u", ooc_open=False, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert g.text == text and g.scene_broken is False and g.cutaway_emitted is False
    assert open_ is False
    assert calls == [], "an aside must not even reach the breaker"


def test_an_aside_split_across_chunks_is_screened_as_neither(monkeypatch):
    calls = _stub_breaker(monkeypatch, cut=True)
    g1, o1 = _run(agent_loop._guard_stream_chunk("((The nominees are Cole and Alejandro.", "u", ooc_open=False, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert g1.text.startswith("((The nominees") and o1 is True and g1.scene_broken is False
    g2, o2 = _run(agent_loop._guard_stream_chunk(" Arjun holds the veto.))", "u", ooc_open=o1, scene_broken=False, emitted_visible=True, cutaway_emitted=False))
    assert g2.text == " Arjun holds the veto.))" and o2 is False and g2.scene_broken is False
    assert calls == []


def test_real_narration_with_an_unbacked_board_claim_is_still_cut(monkeypatch):
    _stub_breaker(monkeypatch, cut=True)
    g, open_ = _run(agent_loop._guard_stream_chunk("Dawn wins Head of Household and the room erupts.", "u", ooc_open=False, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert g.scene_broken is True, "narration outside an aside is still screened and cut"
    assert g.text == agent_loop._SCENE_CUTAWAY_LINE
    assert open_ is False


def test_mixed_chunk_screens_the_narration_not_the_aside(monkeypatch):
    calls = _stub_breaker(monkeypatch, cut=False)
    g, _ = _run(agent_loop._guard_stream_chunk("She nods. ((Arjun holds the veto.)) The room goes quiet.", "u", ooc_open=False, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    screened = [c for c in calls if not c.startswith("sentence:")]
    assert screened and all("Arjun holds the veto" not in c for c in screened), "the aside text is not what the breaker sees"
    assert "Arjun holds the veto" in g.text, "the aside text itself is still emitted"


def test_wired_at_both_stream_call_sites():
    src = open(agent_loop.__file__, encoding="utf-8").read()
    assert src.count("_guard_stream_chunk(") >= 3, "definition + the mid-loop emit + the trailing flush"
    assert "_ooc_open = False" in src, "per-round aside state is initialised"
