"""T0-3 (issue #1778, D1 2026-07-21 owner ruling) — the FE half of the BeatAnnouncement chyron.

ADR 0003 amendment: every committed closed-set ceremony fact is emitted by the engine as a
Vault-free `BeatAnnouncementView` (src/ports/GameSession.ts) on the SAME `advanceGame`/
`submitDecision` tool result the g15 seam already reads. This file pins:

  (1) the wire: chat.js dispatches a NEW `orwell:announcements` event carrying that SAME tool
      result's `announcements`, from the SAME branch that already dispatches `orwell:pending` —
      no new poll, no new transport (F5 two-window parity is inherited via the existing SSE mirror);
  (2) orwellDecision.js extends the shipped decision-card kit with a chyron renderer that listens
      for that event, dedups by announcement id (F4: exactly once, reload-resilient via a DOM
      `data-chyron-id` check), and stages multiple announcements card-by-card;
  (3) it never invents a second `orwell:gamechanged` dispatcher (g15's own hard rule stays intact
      — this file adds a belt-and-suspenders direct check alongside `test_g15_gamechanged.py`'s
      scoped regex);
  (4) a REAL browser behavioral test (`test_chyron_renders_and_dedups_in_a_real_browser`) proves the
      renderer actually paints the DOM and dedups, not just that the source strings exist.

Source-pinned checks (no DOM runtime needed) mirror this codebase's established convention for JS
wiring (see test_c20_decision_guardrail.py, test_j4_decision_card_a11y.py).
"""

import asyncio
import importlib
import os

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
agent_loop = importlib.import_module("src.agent_loop")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ── (1) the wire: chat.js dispatches orwell:announcements alongside orwell:pending ──────────── #

def test_chat_dispatches_announcements_from_the_same_branch_as_pending():
    js = _read("static", "js", "chat.js")
    assert "orwell:pending" in js
    assert "orwell:announcements" in js
    # Both dispatches must read the SAME parsed tool result (`_adv`) inside the SAME
    # advanceGame/submitDecision branch — not a second, independent parse/poll.
    idx_branch = js.index("json.tool === 'advanceGame' || json.tool === 'submitDecision'")
    idx_pending = js.index("orwell:pending", idx_branch)
    idx_announcements = js.index("orwell:announcements", idx_branch)
    assert idx_pending < idx_announcements < idx_branch + 2000, \
        "orwell:announcements must dispatch inside the SAME advanceGame/submitDecision branch as orwell:pending"
    block = js[idx_branch:idx_branch + 2000]
    assert "_adv.announcements" in block
    assert "orwellAdvanceView(json.tool, json.output)" in block  # ORW-264: the shared pure parse


def test_announcements_dispatch_is_guarded_and_never_throws_on_malformed_output():
    js = _read("static", "js", "chat.js")
    idx = js.index("orwell:announcements")
    # The dispatch sits inside the SAME try/catch that already guards the JSON.parse for
    # orwell:pending (fail-open by construction — a malformed tool result must never break the
    # stream loop).
    before = js[max(0, idx - 1400):idx]
    after = js[idx:idx + 200]
    assert "try {" in before
    assert "} catch (_) {}" in after or "} catch (_) {}" in js[idx:idx + 400]


# ── (2) orwellDecision.js: the chyron renderer ───────────────────────────────────────────────── #

def test_orwell_decision_defines_the_chyron_renderer():
    card = _read("static", "js", "orwellDecision.js")
    assert 'window.addEventListener("orwell:announcements"' in card
    assert "window.OrwellChyron" in card
    # Renders into the SAME #chat-history the rest of the conversation lives in (a broadcast, not
    # a separate window/dashboard — ADR 0003).
    assert 'getElementById("chat-history")' in card


def test_chyron_dedups_by_announcement_id():
    card = _read("static", "js", "orwellDecision.js")
    assert "_chyronSeen" in card
    assert "_chyronSeen.has(a.id)" in card
    assert "_chyronSeen.add(a.id)" in card
    # F4 reload-resilience: also checked against the DOM, not only the in-memory Set (which resets
    # on every fresh page load — a transcript replay must still render each chyron exactly once).
    assert "data-chyron-id" in card
    assert 'querySelector(\'[data-chyron-id="\'' in card or "data-chyron-id" in card


def test_chyron_stages_multiple_announcements_card_by_card():
    card = _read("static", "js", "orwellDecision.js")
    idx = card.index("_renderChyronBatch")
    block = card[idx:idx + 700]
    assert "setTimeout" in block, "a batch of announcements must stage card-by-card, not all-at-once"


def test_chyron_covers_every_weekly_loop_announcement_kind():
    card = _read("static", "js", "orwellDecision.js")
    for kind in (
        "hoh-winner", "nominations", "veto-winner", "veto-decision",
        "replacement-nominee", "eviction-ballot", "eviction-result",
    ):
        assert f'"{kind}"' in card, f"orwellDecision.js is missing chyron copy for kind={kind!r}"


def test_chyron_never_adds_a_second_gamechanged_dispatcher():
    # Belt-and-suspenders alongside test_g15_gamechanged.py's own scoped regex: the chyron addition
    # to orwellDecision.js must not introduce a second `new CustomEvent('orwell:gamechanged', ...)`.
    card = _read("static", "js", "orwellDecision.js")
    assert "new CustomEvent(\"orwell:gamechanged\"" not in card
    assert "new CustomEvent('orwell:gamechanged'" not in card


def test_chyron_calls_orwell_announce_on_render():
    """R-A11Y-2: a rendered chyron must call window.orwellAnnounce with the kicker:headline."""
    card = _read("static", "js", "orwellDecision.js")
    assert "window.orwellAnnounce" in card, \
        "the chyron renderer must call the app's SR-broadcast helper"
    assert "esc(kicker) + ': ' + esc(a.headline" in card or \
           "orwellAnnounce(esc(kicker" in card, \
        "announcement text must include the kicker and headline"


def test_chyron_batch_never_announces_per_card():
    """R-A11Y-3: a batch of announcements must call orwellAnnounce at most ONCE, not per-card."""
    card = _read("static", "js", "orwellDecision.js")
    idx = card.index("_renderChyronBatch")
    block = card[idx:idx + 2000]
    count = block.count("orwellAnnounce")
    assert count <= 1, \
        f"batch must call orwellAnnounce at most ONCE (for the coalesced summary), got {count}"


def test_batch_coalesces_homogeneous_kinds_into_summary():
    """R-A11Y-3: a batch of same-kinder items announces a count summary, not per-item text."""
    card = _read("static", "js", "orwellDecision.js")
    assert "allSameKicker" in card or "rendered.length" in card, \
        "batch coalesce must count same-kind items for the summary"


def test_chyron_renders_no_machinery_or_raw_ids():
    # C14/immersion: the chyron's own template code must never leak an engine field name or a raw
    # npc:<id> token into the player-visible markup it builds (the headline itself is Vault-free,
    # already-humanized text from the engine's own `BeatAnnouncementView.headline`).
    card = _read("static", "js", "orwellDecision.js")
    idx = card.index("_renderChyron(a)")
    block = card[idx:idx + 1600]
    assert "npc:" not in block
    assert "beatSeq" not in block  # a counter is not player-facing copy


# ── (4) a REAL browser behavioral test ───────────────────────────────────────────────────────── #

def test_chyron_renders_and_dedups_in_a_real_browser(tmp_path):
    """Loads orwellDecision.js in a real headless page (no server needed — a bare #chat-history
    host is enough to exercise the render path), dispatches TWO orwell:announcements batches — the
    second re-delivering one announcement already rendered (the exact reload/re-dispatch shape the
    dedup exists for) — and asserts: both cards paint, the staged second card lands after a beat,
    and the duplicate id never paints twice."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        import pytest
        pytest.skip(f"playwright unavailable: {e}")

    js_path = os.path.join(FRONTEND, "static", "js", "orwellDecision.js")
    html = f"""<!doctype html><html><body>
      <div id="chat-history"></div>
      <div id="a11y-announcer"></div>
      <script>
        window.orwellAnnounce = function(arg) {{
          var region = document.getElementById('a11y-announcer');
          if (!region) return;
          var text = (typeof arg === 'string') ? arg : (arg && arg.text ? arg.text : '');
          text = (text || '').replace(/\s+/g, ' ').trim();
          region.textContent = text || '';
        }};
      </script>
      <script src="file://{js_path}"></script>
    </body></html>"""
    page_file = tmp_path / "chyron_harness.html"
    page_file.write_text(html, encoding="utf-8")

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            import pytest
            pytest.skip(f"chromium unavailable: {e}")
        try:
            page = browser.new_page()
            page.goto(f"file://{page_file}", wait_until="load", timeout=15000)
            page.wait_for_function("() => !!window.OrwellChyron", timeout=5000)

            first = [
                {"id": "ann:0", "kind": "hoh-winner", "week": 1, "beatSeq": 5,
                 "headline": "Alex is the new Head of Household.", "subjects": [{"id": "npc:1", "name": "Alex"}]},
            ]
            page.evaluate(
                "(list) => window.dispatchEvent(new CustomEvent('orwell:announcements', { detail: { announcements: list } }))",
                first,
            )
            page.wait_for_function(
                "() => document.querySelectorAll('.ow-chyron').length === 1", timeout=5000)
            cards = page.eval_on_selector_all(".ow-chyron", "els => els.map(e => e.textContent)")
            assert len(cards) == 1
            assert "Alex is the new Head of Household." in cards[0]
            assert "npc:" not in cards[0]

            # Assert the a11y-announcer received the announcement text via orwellAnnounce
            announcer_text = page.eval_on_selector(
                "#a11y-announcer", "el => el.textContent")
            assert "Head of Household" in announcer_text, \
                f"a11y-announcer should contain the chyron text after first batch, got: {announcer_text!r}"
            assert "Alex" in announcer_text

            # A SECOND batch: a NEW announcement + a RE-DELIVERY of the SAME id already rendered
            # (the exact shape a reconnecting/second window or a resumed stream can produce).
            second = [
                {"id": "ann:0", "kind": "hoh-winner", "week": 1, "beatSeq": 5,
                 "headline": "Alex is the new Head of Household.", "subjects": [{"id": "npc:1", "name": "Alex"}]},
                {"id": "ann:1", "kind": "nominations", "week": 1, "beatSeq": 6,
                 "headline": "Alex has nominated Sam and Jo for eviction.",
                 "subjects": [{"id": "npc:2", "name": "Sam"}, {"id": "npc:3", "name": "Jo"}],
                 "detail": {"by": {"id": "npc:1", "name": "Alex"}}},
            ]
            page.evaluate(
                "(list) => window.dispatchEvent(new CustomEvent('orwell:announcements', { detail: { announcements: list } }))",
                second,
            )
            # The staged second card lands after a short delay — wait for it, then assert the
            # duplicate id from `first` never produced a second card.
            page.wait_for_function(
                "() => document.querySelectorAll('.ow-chyron').length === 2", timeout=5000)
            page.wait_for_timeout(400)  # settle past the stagger; assert no THIRD (duplicate) card ever appears
            cards2 = page.eval_on_selector_all(".ow-chyron", "els => els.map(e => e.textContent)")
            assert len(cards2) == 2, f"the re-delivered id must NOT paint a second time: {cards2}"
            assert any("nominated Sam and Jo" in c for c in cards2)
            ids = page.eval_on_selector_all(
                "[data-chyron-id]", "els => els.map(e => e.getAttribute('data-chyron-id'))")
            assert sorted(ids) == ["ann:0", "ann:1"]

            # After the second batch settles, the announcer should contain the coalesced
            # batch summary. ann:0 was deduped, so only ann:1 rendered — the single-item
            # coalesced path announces "Nominations: Alex has nominated Sam and Jo for eviction."
            page.wait_for_timeout(800)  # allow stagger (260ms) + settle buffer (300ms) + margin
            announcer2 = page.eval_on_selector(
                "#a11y-announcer", "el => el.textContent")
            assert announcer2 != announcer_text, \
                f"announcer should have been updated after second batch; was still: {announcer2!r}"
        finally:
            browser.close()


# ── the scripted-ceremony AC: a full week's model prose carries ZERO surviving outcome tokens ── #

_USER = "u-t0-3-scripted"


def test_scripted_ceremony_sequence_has_zero_closed_set_outcome_tokens_in_surviving_prose(monkeypatch):
    """The DoD/AC bar in one place: script a model narrating EVERY weekly-loop ceremony outcome in
    its own prose — HOH crown, nominations, veto win, the veto decision, an eviction vote tally, and
    the eviction result — each run through the SAME `_pre_emission_outcome_guard` the live stream
    uses, and assert NONE of the claim language survives to what the player sees. The chyron
    (dispatched separately off `AdvanceView.announcements`, proven above) is the only surviving
    voice for each fact; the model's restatement is hard-dropped outright, regardless of whether the
    board would have confirmed it — the AC's literal wording."""
    chat_helpers._LAST_BEAT_SIG.pop(_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)

    async def fake_status(user=None):
        return {"week": 4, "phase": "eviction", "hoh": {"id": "npc:1"},
                "nominees": [{"id": "npc:2"}, {"id": "npc:3"}],
                "veto": {"holder": {"id": "npc:2"}, "used": True, "players": []},
                "pending": None, "beatSeq": 20}

    async def fake_state(user=None, **kw):
        return {"week": 4, "phase": "eviction", "finished": False, "beatSeq": 20,
                "house": [{"id": "player", "status": "active"},
                          {"id": "npc:2", "status": "active"}, {"id": "npc:3", "status": "evicted"}]}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)

    script = [
        ("HOH", "Jordan wins the Head of Household competition, sealing the new reign."),
        ("nominations", "The new HOH nominates Priya and Marcus for eviction at the ceremony."),
        ("veto win", "In a stunning finish, Priya wins the Power of Veto."),
        ("veto used", "Priya uses the veto on herself at the ceremony."),
        ("tally", "The count comes in at nine votes to two — that's the majority."),
        ("eviction result", "By a vote of the house, Marcus is evicted and walks out the front door."),
    ]
    for label, narration in script:
        out = _run(agent_loop._pre_emission_outcome_guard(narration, _USER))
        assert out.strip() == "", f"[{label}] a closed-set outcome token survived the hard-drop rail: {out!r}"
    # The hard-drop rail never stashes a re-ground (there is nothing to reconcile — the chyron IS
    # the record); confirms none of the six turns fell through to the older verify-then-correct path.
    assert _USER not in chat_helpers._DESYNC_REGROUND


# ── Greptile P2 (PR #1830): the veto-use rail must not hard-drop open-set SPECULATIVE color ──── #

_SPEC_USER = "u-t0-3-veto-speculative"


def test_speculative_veto_use_color_survives_the_hard_drop_rail(monkeypatch):
    """`_CLAIM_VETO_USE_RE`'s FIRST cut matched bare 'use' too, so speculative/planning open-set
    texture ADR 0005 protects ('Priya wonders whether to use the veto on herself', 'if he uses the
    veto, the whole week flips') was swept into the unconditional hard-drop right alongside a genuine
    assertive claim — the exact expressive-collapse failure mode the split-authority ADR exists to
    forbid (this is the model's remaining COLOR job). None of these are outcome assertions; all must
    stream verbatim, byte-for-byte, through the SAME `_pre_emission_outcome_guard` the live stream
    uses — no board read, no stashed re-ground."""
    chat_helpers._LAST_BEAT_SIG.pop(_SPEC_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_SPEC_USER, None)

    async def boom(user=None, **kw):
        raise AssertionError("speculative veto-use color must never even reach a board read")
    monkeypatch.setattr(orwell_engine, "game_status", boom)
    monkeypatch.setattr(orwell_engine, "get_game_state", boom)

    speculative = [
        "Priya wonders whether to use the veto on herself.",
        "if he uses the veto, the whole week flips.",
        "She is debating whether to use the veto on Marcus.",
        "He is planning to use the veto on himself.",
        "She keeps thinking about using the veto all afternoon.",
        "Will you use the veto on her?",
        "I might use the veto on you, depending on how tonight goes.",
    ]
    for narration in speculative:
        out = _run(agent_loop._pre_emission_outcome_guard(narration, _SPEC_USER))
        assert out == narration, f"open-set speculative color was hard-dropped: {narration!r} -> {out!r}"
    assert _SPEC_USER not in chat_helpers._DESYNC_REGROUND


def test_assertive_veto_use_claims_still_hard_drop(monkeypatch):
    """The flip side of the test above, pinned in the SAME file so the two can never silently drift
    apart: a genuinely ASSERTIVE (declarative, committed-tense) veto-use claim still hard-drops —
    tightening the regex against speculative color must not have quietly reopened the original T0-3
    gap (the whole reason `_CLAIM_VETO_USE_RE` exists)."""
    chat_helpers._LAST_BEAT_SIG.pop(_SPEC_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_SPEC_USER, None)

    async def boom(user=None, **kw):
        raise AssertionError("an assertive weekly-loop claim must hard-drop WITHOUT ever reading the board")
    monkeypatch.setattr(orwell_engine, "game_status", boom)
    monkeypatch.setattr(orwell_engine, "get_game_state", boom)

    assertive = [
        "Priya uses the veto on herself.",
        "Priya has used the veto on herself.",
        "Marcus does not use the veto.",
        "The veto goes unused this week.",
    ]
    for narration in assertive:
        out = _run(agent_loop._pre_emission_outcome_guard(narration, _SPEC_USER))
        assert out.strip() == "", f"an assertive veto-use claim survived the rail: {narration!r} -> {out!r}"
    assert _SPEC_USER not in chat_helpers._DESYNC_REGROUND


def test_veto_use_speculative_regex_source_pin():
    """Source-pin: the speculative-clause exclusion is wired into BOTH consumers of
    `_CLAIM_VETO_USE_RE` — the hard-drop gate (`_sentence_has_chyron_covered_claim`) and the
    verify-then-correct branch (`_narration_claims_outcome`'s veto-use case) — so a future edit to
    either can't silently drop the guard from just one side."""
    src = _read("routes", "chat_helpers.py")
    assert "_veto_use_claim_is_speculative" in src
    assert "_VETO_USE_SPECULATIVE_RE" in src
    # Both consumers call the exclusion function (not just define it).
    assert src.count("_veto_use_claim_is_speculative(text)") >= 2
