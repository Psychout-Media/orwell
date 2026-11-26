"""ORW-784 (item 1): a writer-directed instruction fragment must never open the narration the player reads.

A real playtest showed replies that began with a stray instruction fragment glued to the scene ("Keep the answer short and plain in the grey of the ..." and "Verbatim, the fire pit ..."). Nothing in
our code authors those words, so they are the model reciting a directive at the head of its reply. This is a TEXT CLASSIFIER (a detector, never a pick, never player-facing text): two narrow compiled
patterns that only look at the very start of a round's first chunk, fail-open (anything uncertain is scene prose). It only decides what is dropped from the stream; nothing is authored. The one
cosmetic repair is upper-casing the first letter that remains. Vault-free: it sees the model's visible text only.

Off by ORWELL_RECITAL_GUARD=0 (default on).
"""
import os
import re

# a directive about how to write the reply: <imperative> the <reply-noun> <style adjectives>
_NOUN = r"(?:answer|reply|response|narration|scene|prose|text|opening)"
_ADJ = r"(?:short|plain|brief|simple|tight|concrete|direct|quiet|concise|sparse|terse|natural|tense|calm|vivid|moody|warm|light|grounded|subtle|still|soft|gentle|careful|measured|slow|steady|dry|clipped|cinematic|punchy|crisp|lean|spare|vivid|clear|focused|specific|grounded|immersive)"
_DIRECTIVE = re.compile(
    rf"^\s*(?:keep|make|write|stay)\s+(?:the|your|this|that)\s+{_NOUN}\s+{_ADJ}(?:\s*(?:,|and)\s*{_ADJ})*\s*(?:[.:;—-]\s*|\s+(?=\w))",
    re.IGNORECASE)
# a stray instruction word standing alone before a comma at the head of the reply
_STRAY = re.compile(r"^\s*(?:verbatim|word\s+for\s+word|as\s+instructed|as\s+requested)\s*,\s*", re.IGNORECASE)

# ORW-1057: a directive cut can leave the tail of its adjective list ("And tense.") in front of the scene; that one- or two-word fragment goes too
_TAIL_FRAGMENT = re.compile(r"^\s*(?:and|or|but)\s+[A-Za-z]+(?:\s+[A-Za-z]+)?\s*[.:;\u2014-]\s*", re.IGNORECASE)

_stripped = 0


def enabled() -> bool:
    return os.environ.get("ORWELL_RECITAL_GUARD", "1").strip().lower() not in ("0", "false", "off", "no")


def stripped_count() -> int:
    return _stripped


def strip_leading_recital(text: str) -> "tuple[str, int]":
    """Drop a leading instruction fragment from `text` (a round's first emitted chunk). Returns (kept, chars_dropped); the first remaining letter is upper-cased.
    Fail-open on any error and on a text that opens with a quote."""
    try:
        t = text or ""
        if not t.strip() or t.lstrip()[:1] in ('"', "“", "*", "(", "["):
            return text, 0
        m = _DIRECTIVE.match(t)
        is_directive = m is not None
        m = m or _STRAY.match(t)
        if not m:
            return text, 0
        end = m.end()
        tail = _TAIL_FRAGMENT.match(t[end:]) if is_directive else None
        if tail:
            end += tail.end()
        rest = t[end:]
        if rest[:1].islower():
            rest = rest[:1].upper() + rest[1:]
        return rest, end
    except Exception:  # failsoft-ok: a detector error never drops text
        return text, 0


def note_stripped() -> None:
    global _stripped
    _stripped += 1
