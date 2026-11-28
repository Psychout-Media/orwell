"""Issue #1391 — prompt-scale dilution: a token-count regression gate on the narrator prompt.

MECHANISM this guards against. Every player turn ships the SAME fixed narrator
rulebook (`BASE_GAME_MASTER_PROMPT` in `src/engine/momentPrompts.ts`) — assembled
with the per-turn context it becomes a ~17-20k-token prompt. An LLM's per-rule
COMPLIANCE decays as the rulebook grows: the more instructions crammed into one
always-injected block, the less reliably the model honors ANY single one. That
decay is exactly what the FE under-call belt family (`agent_loop.py`, the forced
`tool_choice` rung, `docs/design/undercall-seam-structural.md`) has to keep
error-correcting — a bigger prompt means MORE skipped tool calls to catch, not
fewer. So the size of the fixed per-turn prompt is a real reliability lever, and
it must not grow SILENTLY: every added rule dilutes the rest.

WHAT THIS GATE DOES. It reads the narrator-prompt SOURCE as text (it never imports
or executes the TypeScript), extracts the `BASE_GAME_MASTER_PROMPT` string literal
(and the sibling casting-phase prompt), measures its assembled size, and asserts it
stays under a pinned ceiling. The audit measured BASE ≈ 43,406 chars (~10.9k tokens)
when #1391 was filed; the assembled literal on this branch measures ~45,144 chars
(~11,286 by the chars/4 token proxy — see below). The ceiling is pinned at the
current measured size plus a modest margin.

RATCHET DIRECTION — this gate only ratchets DOWN.
  * A GROWN prompt (size above the ceiling) FAILS — a new rule block cannot land
    silently; it forces a conscious "trim, move to a fragment, or raise the ceiling
    with rationale" decision.
  * A SHRUNK prompt always PASSES (a smaller prompt is under any ceiling). Trimming
    the rulebook is exactly the win this gate wants; it never penalizes a shrink.

TOKEN PROXY. Real token counts need the model's tokenizer; here we use the standard
rough estimate chars/4 and report it for context only. The HARD assertion is on the
CHARACTER count (deterministic, tokenizer-free, no flake). "~N tokens" in any message
is the chars/4 proxy, NOT an exact tokenization.

SCOPE. This file only GUARDS the size. The prompt RESTRUCTURE itself — moving BASE
rules out into per-beat moment fragments so the always-injected block shrinks — is
SEPARATE, fenced work (issue #1391, other lane). This gate does not touch the prompt.

This is a plain non-browser `fe-unit` test: source-text only, fast, deterministic —
no server, no Playwright. It mirrors the defensive style of the FE source-pin gates
(`test_1412_mutating_manifest.py`, `test_g15_gamechanged.py`): if the literal can't
be located (the file shape changed), it FAILS loudly with an actionable message
rather than silently passing.
"""
import re
from pathlib import Path

# frontend/tests/ -> frontend -> repo root (matches test_1412_mutating_manifest.py).
FE = Path(__file__).resolve().parents[1]
REPO = FE.parent
MOMENT_PROMPTS = REPO / "src" / "engine" / "momentPrompts.ts"
SRC = MOMENT_PROMPTS.read_text(encoding="utf-8")

# The array-literal terminator shared by every `const NAME = [ "...", ... ].join("\n")`
# prompt block in momentPrompts.ts.
JOIN_TERMINATOR = '].join("\\n");'

# ── the two always-injected prompt blocks we pin ─────────────────────────────
# BASE is shipped on EVERY turn; the casting prompt on every turn of the casting
# phase. Both are `[ "line", "line", ... ].join("\n")` array literals.
BASE_DECL = "export const BASE_GAME_MASTER_PROMPT = ["
CASTING_DECL = "const CASTING_INTERVIEW_PROMPT = ["

# Minimum string-literal counts — an INTEGRITY signal, not a size budget. A working
# extractor pulls hundreds (BASE) / ~100 (casting) literals; a broken parser that
# matched a stray fragment would pull a handful. These floors stay far below any
# realistic content edit (so a legit trim still passes) but well above a fragment
# match, so a broken extractor can never silently pass as "under budget". They do
# NOT ratchet — they only prove the block was actually parsed.
BASE_MIN_LITERALS = 50      # measured 487 on this branch
CASTING_MIN_LITERALS = 20   # measured 102 on this branch

# Pinned ceilings = the measured assembled size + a modest margin. Growth past the
# ceiling fails; a shrink always passes. To RAISE a ceiling (intentional, justified
# growth) bump the constant here and say why.
#
# BASE:    measured 45,144 chars (~11,286 token-proxy) on 2026-07-12.
#          ceiling 47,200 = measured + ~2,056 (~4.6%) headroom — tight enough that a
#          new multi-line rule block trips it, loose enough that reworded lines don't.
# CASTING: measured  8,311 chars (~2,077 token-proxy) on 2026-07-12.
#          ceiling  9,000 = measured + ~689 (~8.3%) headroom.
BASE_CEILING_CHARS = 47_500  # +100 for ORW-1167 (the earshot and privacy line in the whereabouts guide), +200 for ORW-713 (the one line telling the narrator that ending the season is the player's own New Chat act, so it never offers a closed door)
CASTING_CEILING_CHARS = 9_000


def _token_proxy(chars: int) -> int:
    """Rough chars/4 token estimate — a PROXY, not the model's tokenizer."""
    return chars // 4


def _extract_joined_prompt(decl: str, min_literals: int) -> str:
    """Return the ASSEMBLED text of a `const NAME = [ "...", ... ].join("\\n")` block.

    Reads the source as TEXT (never imports/executes the TS). Fails loudly — never
    silently passes — if the declaration or its array shape can't be found (item 4
    of the #1391 gate).
    """
    idx = SRC.find(decl)
    assert idx != -1, (
        f"prompt-budget gate could not locate `{decl}` in momentPrompts.ts — the "
        f"declaration was renamed or removed; update the extractor in this test."
    )
    join_idx = SRC.find(JOIN_TERMINATOR, idx)
    assert join_idx != -1, (
        f"prompt-budget gate located `{decl}` but not its closing `{JOIN_TERMINATOR}` "
        f"— the array-literal shape changed; update the extractor in this test."
    )
    inner = SRC[idx:join_idx].split("[", 1)[1]
    # Drop comment-only lines so quoted text INSIDE `//` comments (BASE has a few) is
    # never counted as prompt content.
    kept = "\n".join(ln for ln in inner.split("\n") if not ln.lstrip().startswith("//"))
    # Single-line double-quoted JS string literals. The only escape used in these
    # blocks is \" (verified); \n excluded from the char class so a literal can't run
    # across lines and swallow a comment.
    literals = re.findall(r'"(?:[^"\\\n]|\\.)*"', kept)
    assert len(literals) >= min_literals, (
        f"prompt-budget gate parsed only {len(literals)} string literals from `{decl}` "
        f"(expected >= {min_literals}) — the array shape changed and the extractor is "
        f"matching a fragment. Update the extractor; do NOT let it silently pass."
    )
    decoded = [lit[1:-1].replace('\\"', '"') for lit in literals]
    return "\n".join(decoded)


# ── tests ────────────────────────────────────────────────────────────────────

def test_base_narrator_prompt_is_locatable():
    # The "could not locate → FAIL clearly" guard (item 4): the extractor raises an
    # actionable AssertionError if BASE_GAME_MASTER_PROMPT can't be parsed.
    base = _extract_joined_prompt(BASE_DECL, BASE_MIN_LITERALS)
    assert base.strip(), "BASE_GAME_MASTER_PROMPT extracted empty — update the extractor."


def test_base_narrator_prompt_stays_under_budget():
    base = _extract_joined_prompt(BASE_DECL, BASE_MIN_LITERALS)
    size = len(base)
    assert size <= BASE_CEILING_CHARS, (
        f"BASE_GAME_MASTER_PROMPT is {size:,} chars (~{_token_proxy(size):,} tokens by the "
        f"chars/4 proxy); the ceiling is {BASE_CEILING_CHARS:,} chars "
        f"(~{_token_proxy(BASE_CEILING_CHARS):,} tokens) — over by "
        f"{size - BASE_CEILING_CHARS:,} chars.\n"
        f"The fixed per-turn narrator prompt grew — every added rule dilutes the rest "
        f"(audit #1391): move per-beat rules into moment fragments or trim, or (if the "
        f"growth is intentional and justified) raise BASE_CEILING_CHARS in this test with "
        f"rationale."
    )


def test_casting_interview_prompt_stays_under_budget():
    casting = _extract_joined_prompt(CASTING_DECL, CASTING_MIN_LITERALS)
    size = len(casting)
    assert size <= CASTING_CEILING_CHARS, (
        f"CASTING_INTERVIEW_PROMPT is {size:,} chars (~{_token_proxy(size):,} tokens by the "
        f"chars/4 proxy); the ceiling is {CASTING_CEILING_CHARS:,} chars — over by "
        f"{size - CASTING_CEILING_CHARS:,} chars.\n"
        f"This casting-phase prompt grew (audit #1391) — every added rule dilutes the rest: "
        f"trim it or move detail into a fragment, or (if intentional and justified) raise "
        f"CASTING_CEILING_CHARS in this test with rationale."
    )
