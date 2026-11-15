"""ORW-476: the player has no gender unless they stated one. Pure helpers (no I/O) that decide, from the player's OWN
typed words, which gender they stated; a model-filed value is kept only when it matches the LATEST statement.
Nothing here reads a name, a houseguest's line or a hidden production cue."""
from __future__ import annotations

import re

MAN, WOMAN, NB = "man", "woman", "nonbinary"

# Words that state a gender about the speaker. Closed list; fuzzy (typo) matching is limited to FUZZY_WORDS.
_NOUNS = {
    **{w: MAN for w in ("man", "male", "guy", "dude", "boy", "gentleman", "dad", "father", "husband", "son", "brother", "daddy", "papa")},
    **{w: WOMAN for w in ("woman", "female", "girl", "lady", "gal", "mom", "mum", "mother", "wife", "daughter", "sister", "mommy", "mama")},
    **{w: NB for w in ("nonbinary", "non-binary", "enby", "genderqueer")},
}
# Typo tolerance (one edit, transposition counts) only for words long enough that a near miss is not another common word.
_FUZZY_WORDS = ("woman", "female", "girl", "gentleman", "nonbinary", "genderqueer", "husband", "mother", "father", "daughter", "brother", "sister")
_EXTRA_TYPOS = {"gurl": WOMAN, "grl": WOMAN, "gril": WOMAN, "wman": WOMAN, "womn": WOMAN}
_PRONOUN = {"he": MAN, "him": MAN, "she": WOMAN, "her": WOMAN, "they": NB, "them": NB}

_BLOCK = {"my", "our", "his", "her", "their", "your", "is", "are", "was", "were", "has", "have", "had", "be", "he", "she", "they"}
_NEG = {"not", "never", "no", "isnt", "arent", "wasnt", "cant"}
_NOT_FUZZY = {"other", "others", "feral", "gentle", "bother", "mothers"}  # real words one edit from a closed-list word
_NOT_AFTER = {"band", "bands", "scout", "scouts", "next"}  # "boy band", "girl scout", "girl next door"
_ANCHOR_RE = re.compile(r"(?<![\w'])(?:i\s*'?m|i\s+am|identify\s+as|as|being|i\s+was\s+born|born)(?![\w'])")
_PRON_PAIR_RE = re.compile(r"(?<![\w])(he|she|they)\s*(?:/|\bor\b|\band\b)\s*(him|her|them)(?![\w])")
_PRON_STMT_RE = re.compile(
    r"(?<![\w])(?:pronouns?\s*(?:are|is|:|=)?|use|go(?:es)?\s+by|going\s+by|call\s+me|goes\s+by)\s+(?:the\s+)?(he|she|they|him|her|them)(?![\w'-])")


def _osa(a: str, b: str) -> int:
    """Optimal string alignment distance (insert, delete, substitute, transpose one letter pair)."""
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            c = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[-1][-1]


def _noun_gender(tok: str):
    t = tok.strip(".,;:!?\"()[]*_").replace("’", "'")
    if t in _NOUNS:
        return _NOUNS[t]
    if t in _EXTRA_TYPOS:
        return _EXTRA_TYPOS[t]
    if len(t) >= 4 and t not in _NOT_FUZZY:
        for w in _FUZZY_WORDS:
            if abs(len(w) - len(t)) <= 1 and _osa(t, w) <= 1:
                return _NOUNS[w]
    return None


def _bare_turn(line: str):
    """A turn that is JUST the answer: "woman", "non-binary", "they", "he/him", "pronouns: he", "I'm a guy"."""
    t = line.lower().replace("’", "'").strip()
    t = re.sub(r"[^a-z'/\- ]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"^(?:it'?s|its|a|an|the|pronouns?(?: are| is)?|my pronouns?(?: are| is)?|i use|use|call me|go by|i go by)\s+", "", t).strip()
    if not t:
        return None
    if t in _PRONOUN:
        return _PRONOUN[t]
    m = re.fullmatch(r"(he|she|they)\s*/\s*(him|her|them)", t)
    if m:
        return _PRONOUN[m.group(1)]
    return _noun_gender(t) if " " not in t else None


def stated_gender(words: str):
    """The gender the player stated in their own words, or None. The LATEST statement wins ("I'm a guy" ... "sorry, I'm a woman"
    is woman); a negation ("I'm not a man") states nothing. Never inferred from a name."""
    found: list = []  # (position, gender)
    offset = 0
    for line in (words or "").replace("\r", "\n").split("\n"):
        low = line.lower().replace("’", "'")
        g = _bare_turn(low)
        if g:
            found.append((offset, g))
        for m in _PRON_PAIR_RE.finditer(low):
            found.append((offset + m.start(), _PRONOUN[m.group(1)]))
        for m in _PRON_STMT_RE.finditer(low):
            found.append((offset + m.start(), _PRONOUN[m.group(1)]))
        for sent in re.finditer(r"[^.!?;]+", low):
            text = sent.group(0)
            for am in _ANCHOR_RE.finditer(text):
                toks = re.findall(r"[\w'’-]+", text[am.end():])[:8]
                neg = False
                for tok in toks:
                    bare = tok.replace("'", "").replace("’", "")
                    if bare in _NEG or bare.endswith("nt"):
                        neg = True
                        continue
                    if tok in _BLOCK:
                        break
                    g2 = _noun_gender(tok)
                    if g2:
                        nxt = toks[toks.index(tok) + 1] if toks.index(tok) + 1 < len(toks) else ""
                        if not neg and nxt not in _NOT_AFTER:
                            found.append((offset + sent.start() + am.start(), g2))
                        break
                    if bare in ("but",):
                        break
        offset += len(line) + 1
    if not found:
        return None
    found.sort(key=lambda x: x[0])
    return found[-1][1]


def player_stated_genders(words: str) -> set:
    g = stated_gender(words)
    return {g} if g else set()
