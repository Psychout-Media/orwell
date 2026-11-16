"""T0-5 (#1771 F3) — the inline-planning / debugger-monologue reasoning-leak scrub.

Live playtest evidence: GLM-4.7 via some providers returns `reasoning_content` EMPTY every
round (reasoning_chars=0) and instead emits its planning trace INLINE as ordinary content, so
the thinking-channel split (`round_reasoning` / `_scrub_active`) never engages — there is no
reasoning delta to split off. Player-visible bubbles carried debugger monologues verbatim:
"I need to ground myself in the actual game state before I say anything else." and raw
engine-field jargon: "holder is null, players array is empty". `_scrub_game_leak` (the existing
operator-aside scrub) does not catch this class — its markers are tool NAMES and explicit
tool-process verbs, not generic reasoning/debugger language.

Per the T9 resiliency doctrine (owner ruling 2026-07-21) this is a PERMANENT defense-in-depth
layer — kept even after provider capability pinning (T0-4) restores a genuinely separated
reasoning channel for models that support it, which is why every trigger here is gated on
`reasoning_empty` and is a no-op when a real reasoning channel is present.

Roles only — proper nouns inside narration strings are throwaway tokens, never canonical data.
"""
from src.agent_loop import _scrub_inline_planning_leak


FRONTEND = __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__)))


def _read(*rel):
    import os
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ── The two known playtest leak strings are scrubbed ──────────────────────────

def test_ground_myself_leak_dropped_at_bubble_start_when_reasoning_empty():
    leak = "I need to ground myself in the actual game state before I say anything else."
    out = _scrub_inline_planning_leak(leak, reasoning_empty=True, at_bubble_start=True)
    assert out.strip() == ""


def test_ground_myself_leak_dropped_but_following_narration_survives():
    # the leak is a LEADING clause, not the whole bubble — the narration that follows it must
    # survive untouched (mirrors scrubReasoningPreamble's "preamble only" contract).
    text = ("I need to ground myself in the actual game state before I say anything else. "
            "The room falls quiet as Delia sets down her mug.")
    out = _scrub_inline_planning_leak(text, reasoning_empty=True, at_bubble_start=True)
    assert "I need to ground myself" not in out
    assert "The room falls quiet as Delia sets down her mug." in out


def test_holder_null_players_array_jargon_dropped_anywhere_when_reasoning_empty():
    leak = ("The room settles into evening light. Wait, holder is null, players array is "
            "empty. Griffin leans against the counter.")
    out = _scrub_inline_planning_leak(leak, reasoning_empty=True, at_bubble_start=False)
    assert "holder is null" not in out
    assert "players array is empty" not in out
    # the real narration on either side survives byte-identical
    assert "The room settles into evening light." in out
    assert "Griffin leans against the counter." in out


def test_engine_jargon_dropped_even_as_the_leading_sentence():
    leak = "holder is null, players array is empty. You look up at the monitor overhead."
    out = _scrub_inline_planning_leak(leak, reasoning_empty=True, at_bubble_start=True)
    assert "holder is null" not in out
    assert "players array is empty" not in out
    assert "You look up at the monitor overhead." in out


# ── Legitimate in-fiction prose is NOT scrubbed ────────────────────────────────

def test_npc_saying_i_need_to_think_is_protected_by_the_quote_guard():
    # a quoted line is dialogue, never the model's own planning voice.
    dialogue = '"I need to think about this," Delia says quietly.'
    out = _scrub_inline_planning_leak(dialogue, reasoning_empty=True, at_bubble_start=True)
    assert out == dialogue


def test_ordinary_narration_untouched():
    prose = ("You walk into the kitchen. Delia is chopping vegetables in silence, "
             "the knife tapping a steady rhythm against the board.")
    out = _scrub_inline_planning_leak(prose, reasoning_empty=True, at_bubble_start=True)
    assert out == prose


def test_mid_paragraph_planning_shaped_sentence_not_at_bubble_start_is_left_alone():
    # the opener-shaped sentence is REAL only when it's genuinely the round's leading text —
    # `at_bubble_start=False` means real narration has already streamed this round, so a later
    # sentence sharing the opener's shape (a coincidence, or narration ABOUT a character
    # thinking) must not be misread as the model's own planning preamble.
    text = ("Griffin considers his options. I need to ground myself in the actual game state "
            "before continuing.")
    out = _scrub_inline_planning_leak(text, reasoning_empty=True, at_bubble_start=False)
    assert out == text


def test_engine_jargon_words_alone_do_not_trigger_without_the_debug_predicate():
    # "state"/"roster"/"players" are ordinary BB vocabulary — only paired with a code-ish
    # predicate ("is null"/"is empty"/"array is empty"/…) do they read as debugger jargon.
    prose = ("The house's state of mind shifted after the veto. The roster gathered in the "
             "living room, and the players traded uneasy glances.")
    out = _scrub_inline_planning_leak(prose, reasoning_empty=True, at_bubble_start=False)
    assert out == prose


# ── The gate: a no-op whenever the reasoning channel was NOT empty ────────────

def test_noop_when_reasoning_channel_had_content():
    # a model WITH a genuine separated reasoning channel is already covered by the existing
    # thinking-channel split — this defense-in-depth layer must never ALSO touch its content,
    # so it stays a true no-op (byte-identical) whenever `reasoning_empty` is False.
    leak = "I need to ground myself in the actual game state before I say anything else."
    assert _scrub_inline_planning_leak(leak, reasoning_empty=False, at_bubble_start=True) == leak
    jargon = "holder is null, players array is empty."
    assert _scrub_inline_planning_leak(jargon, reasoning_empty=False, at_bubble_start=False) == jargon


def test_empty_text_is_a_noop():
    assert _scrub_inline_planning_leak("", reasoning_empty=True, at_bubble_start=True) == ""
    assert _scrub_inline_planning_leak(None, reasoning_empty=True, at_bubble_start=True) is None


# ── The wiring: both streaming call sites thread the gate through ─────────────

def test_wired_at_both_scrub_game_leak_call_sites():
    src = _read("src", "agent_loop.py")
    assert src.count("_scrub_inline_planning_leak(") >= 2
    # both call sites must pass the reasoning-emptiness gate derived from THIS round's
    # reasoning accumulator, not a stale/global flag.
    assert "reasoning_empty=not round_reasoning.strip()" in src
    # the bubble-start tracker exists and is set once real narration actually flushes.
    assert "_round_visible_emitted" in src


# ── Greptile P1 (#1774) — the scrub's drop must be MIRRORED into round_response, or the ──
# scrubbed leak REAPPEARS after reload (the ADR-0015 live-vs-reload drift class). Live-stream
# filtering only touches `full_response`/what the player sees THIS turn; `round_response` is the
# raw per-round accumulator that `cleaned_round = strip_tool_blocks(round_response)` derives
# `round_texts` from — the text persisted and re-served on history reload. Without mirroring the
# drop back (the SAME `_mirror_wall_drop` fix #1746 applies for the knowledge/presence wall
# guards), a leak invisible live would resurface verbatim the next time the session reloads.

from src.agent_loop import _scrub_game_leak, _mirror_wall_drop
from src.tool_parsing import strip_tool_blocks


def test_scrubbed_leak_is_mirrored_into_round_response_live_equals_reload():
    complete = ("I need to ground myself in the actual game state before I say anything else. "
                "The room falls quiet as Delia sets down her mug.")
    # The SAME pipeline the streaming loop runs: scrub → scrub → mirror the drop back.
    clean = _scrub_game_leak(complete)
    clean = _scrub_inline_planning_leak(clean, reasoning_empty=True, at_bubble_start=True)
    round_response = complete  # the raw per-round accumulator, pre-mirror
    round_response = _mirror_wall_drop(round_response, complete, clean)

    live_text = clean.strip()
    reload_text = strip_tool_blocks(round_response).strip()

    assert "I need to ground myself" not in live_text
    assert "I need to ground myself" not in reload_text, (
        "the scrubbed planning leak reappeared in the reload/persisted text even though the "
        "player never saw it live — the exact ADR-0015 live-vs-reload drift class"
    )
    # LIVE == RELOAD for a scrubbed turn: what the player saw live is exactly what a later
    # reload re-serves from history.
    assert reload_text == live_text


def test_scrubbed_engine_jargon_is_mirrored_into_round_response_live_equals_reload():
    complete = ("The room settles into evening light. Wait, holder is null, players array is "
                "empty. Griffin leans against the counter.")
    clean = _scrub_game_leak(complete)
    clean = _scrub_inline_planning_leak(clean, reasoning_empty=True, at_bubble_start=False)
    round_response = _mirror_wall_drop(complete, complete, clean)

    live_text = clean.strip()
    reload_text = strip_tool_blocks(round_response).strip()

    assert "holder is null" not in reload_text
    assert "players array is empty" not in reload_text
    assert reload_text == live_text


def test_wholly_scrubbed_round_leaves_round_response_empty_after_mirror():
    # the entire chunk was planning preamble — round_response must end up empty too, not just
    # `full_response` — otherwise a reload would show the leak even though the live turn showed
    # nothing at all for this chunk.
    complete = "I need to ground myself in the actual game state before I say anything else."
    clean = _scrub_game_leak(complete)
    clean = _scrub_inline_planning_leak(clean, reasoning_empty=True, at_bubble_start=True)
    assert clean.strip() == ""
    round_response = _mirror_wall_drop(complete, complete, clean)
    assert strip_tool_blocks(round_response).strip() == ""


def test_mirror_call_wired_at_both_scrub_call_sites_before_cleaned_round_derives():
    src = _read("src", "agent_loop.py")
    # both streaming call sites must mirror the scrub's drop back into round_response, using the
    # SAME semicolon-aware split_pattern the scrubs themselves split on (#1774 follow-up — see the
    # semicolon-clause tests below for why the default [.!?\n]-only pattern is wrong here)...
    assert src.count(
        "round_response = _mirror_wall_drop(\n"
        "                                    round_response, _complete, _clean, "
        'split_pattern=r"(?<=[.!?\\n;])")') == 1
    assert src.count(
        "round_response = _mirror_wall_drop(\n"
        '                round_response, _pre_scrub_tail, _clean, split_pattern=r"(?<=[.!?\\n;])")'
    ) == 1
    # ...and both mirror calls must appear BEFORE `cleaned_round` is derived from round_response,
    # so the persisted/reload text reflects the mirrored drop.
    # ORW-453: the stored round text is derived in ONE place from `_store_src`, which is `round_response` itself (normal path) or `round_response[:_oi]` (the opener-cut path). Pin all three so
    # neither path can derive the stored text before the mirrors ran, and no second derivation can appear unpinned. (Behaviour tests of the order: test_orw408_sentence_rewrite.py
    # test_orw453_*, which drive the real loop and compare shown with stored.)
    assert src.count("cleaned_round = strip_tool_blocks(") == 1
    assert src.count("cleaned_round = strip_tool_blocks(_store_src).strip()") == 1
    normal_src_at = src.index("_store_src = round_response\n")
    opener_src_at = src.index("_store_src = round_response[:_oi]")
    derive_at = src.index("cleaned_round = strip_tool_blocks(_store_src).strip()")
    assert normal_src_at < opener_src_at < derive_at
    assert src.index("_oi = tool_call_opener_index(round_response)") > src.index(
        "round_response = _mirror_wall_drop(\n                round_response, _pre_scrub_tail, _clean")  # the cut index is read after the mirrors too (review of #2784)
    cleaned_round_at = normal_src_at  # the earliest point either path reads round_response for the stored text
    mid_loop_mirror_at = src.index(
        "round_response = _mirror_wall_drop(\n                                    round_response, _complete, _clean")
    flush_mirror_at = src.index(
        "round_response = _mirror_wall_drop(\n                round_response, _pre_scrub_tail, _clean")
    assert mid_loop_mirror_at < cleaned_round_at
    assert flush_mirror_at < cleaned_round_at


def test_wall_guard_mirror_calls_are_unchanged_default_split_pattern():
    # #1774 follow-up ask: verify the knowledge/presence wall guards' OWN mirror calls are
    # untouched — they must keep the original 3-arg form (default split_pattern=[.!?\n], matching
    # `screen_knowledge_wall`/`screen_presence_wall`'s own boundary), never the semicolon-aware one.
    src = _read("src", "agent_loop.py")
    assert src.count(
        "round_response = _mirror_wall_drop(round_response, _guarded.text, _guarded_text)") == 2


# ── Greptile P1 (#1774 follow-up) — the mirror's split boundary must match the SCRUB's boundary ──
# `_scrub_game_leak`/`_scrub_inline_planning_leak` additionally split on `;` (the #1109(b)
# semicolon-clause fix: "You can shade, spin, or play a character; the engine will take it from
# there." drops only the machinery clause, keeping the leading one). The mirror fix above used
# `_mirror_wall_drop`'s DEFAULT split (`[.!?\n]` only, the wall guards' boundary) — for a
# semicolon-joined sentence with no `.`/`!`/`?`/`\n` before the final period, that coarsens the
# whole multi-clause sentence into ONE part, so the walker misreads a partial (clause-level) drop
# as a whole-sentence drop and over-deletes the SURVIVING clause from `round_response` too — the
# inverse of the original bug (live keeps the good clauses; reload loses ALL of them).

def test_semicolon_clause_drop_preserves_survivors_and_matches_live():
    complete = "The room settles; holder is null; Griffin stays."
    clean = _scrub_game_leak(complete)
    clean = _scrub_inline_planning_leak(clean, reasoning_empty=True, at_bubble_start=False)
    # only the jargon-bearing CLAUSE is dropped — both real clauses survive live.
    assert clean == "The room settles; Griffin stays."

    # The FIXED mirror (semicolon-aware split_pattern — what the streaming call sites now pass).
    round_response = _mirror_wall_drop(complete, complete, clean, split_pattern=r"(?<=[.!?\n;])")
    reload_text = strip_tool_blocks(round_response).strip()

    assert reload_text == clean, "live == reload for a scrubbed semicolon-clause turn"
    assert "The room settles;" in reload_text, "the leading surviving clause must NOT be deleted"
    assert "Griffin stays." in reload_text, "the trailing surviving clause must NOT be deleted"
    assert "holder is null" not in reload_text


def test_mirror_without_semicolon_aware_pattern_would_over_delete_survivors():
    # Documents the bug this follow-up fixes: the wall guards' DEFAULT [.!?\n]-only split, applied
    # to a semicolon-joined sentence, coarsens the clause-level drop into a whole-sentence drop and
    # wipes the surviving clauses too — round_response ends up EMPTY even though `clean` (what
    # streamed live) still has real narration in it.
    complete = "The room settles; holder is null; Griffin stays."
    clean = "The room settles; Griffin stays."
    broken = _mirror_wall_drop(complete, complete, clean)  # default split_pattern — no `;`
    assert broken.strip() == "", (
        "pins the pre-fix behavior: without the semicolon-aware split_pattern the whole sentence "
        "is wiped from round_response, not just the dropped clause"
    )


# ── ORW-541: "get a read on the room" planning opener ─────────────────────────

def test_orw541_get_a_read_planning_line_dropped_narration_survives():
    text = ("Let me get a real read on the room before I put words in their mouths. "
            "Delia sets down her mug and looks up.")
    out = _scrub_inline_planning_leak(text, reasoning_empty=True, at_bubble_start=True)
    assert "get a real read" not in out
    assert "Delia sets down her mug and looks up." in out


def test_orw541_get_a_read_inside_dialogue_or_mid_bubble_untouched():
    quoted = '"Let me get a read on you first," the HOH says.'
    assert _scrub_inline_planning_leak(quoted, reasoning_empty=True, at_bubble_start=True) == quoted
    mid = "Let me get a real read on the room."
    assert _scrub_inline_planning_leak(mid, reasoning_empty=True, at_bubble_start=False) == mid
