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
_SUBJ = {"he": MAN, "she": WOMAN, "they": NB}  # the subject forms: a casting answer on their own

# Between "I'm" and the noun nothing may point at someone else or at an errand: "I'm looking for the girl", "I'm the new guy".
_BLOCK = {"my", "our", "his", "her", "their", "your", "is", "are", "was", "were", "has", "have", "had", "be", "the", "for", "to", "with",
          "at", "in", "on", "by", "from", "about", "into", "than", "like", "looking", "going", "gonna", "talking", "trying", "find",
          "meet", "see", "here", "there", "that", "this", "those", "these", "when", "if", "because", "so", "but"}
_NEG = {"not", "never", "no", "isnt", "arent", "wasnt", "cant", "dont"}
_NOT_AFTER = {"band", "bands", "scout", "scouts", "next", "figure", "friend", "power"}  # "boy band", "girl scout", "father figure"
_ANCHOR_RE = re.compile(r"(?<![\w'])(?:i\s*'?m|i\s+am|identify\s+as|i\s+was\s+born\s+an?|born\s+an?)(?![\w'])")
_AS_RE = re.compile(r"^\s*as\s+an?\s+([\w'-]+)\s*,")  # "As a woman, I ..." (only at the start, only with the comma)
_PRON_PAIR_RE = re.compile(r"(?<![\w])(he|she|they)\s*(?:/|\bor\b|\band\b)\s*(him|her|them)(?![\w])")
# A pronoun statement ends the phrase: "use her name" / "call me he-man's friend" state nothing.
_PRON_STMT_RE = re.compile(
    r"(?<![\w])(?:pronouns?\s*(?:are|is|:|=)?|use|go(?:es)?\s+by|going\s+by|call\s+me)\s+(?:the\s+)?(he|she|they|him|her|them)"
    r"(?=\s*(?:[,.!?;/]|$|\band\b|\bor\b|\bplease\b|\bpronouns?\b))")
_LEAD = {"it's", "its", "a", "an", "just", "regular", "plain", "ordinary", "simple", "normal", "yes", "yeah", "yep", "proud", "also", "actually", "i",
         "i'm", "im", "am", "use", "call", "me", "go", "by", "pronouns", "pronoun", "my", "are", "is"}
_TRAIL = {"here", "and", "proud", "of", "too", "please", "myself", "thanks", "thank", "you", "yes", "one", "two", "three", "four", "five", "six",
          "kids", "boys", "girls", "children"}


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


_NOT_FUZZY = {"other", "others", "feral", "gentle", "bother", "mothers"}  # real words one edit from a closed-list word


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


def _norm(line: str) -> str:
    t = line.lower().replace("’", "'")
    return re.sub(r"\bnon[\s-]+binary\b", "nonbinary", t)


def _bare_turn(low: str):
    """A turn that is JUST the answer: "woman", "female here", "Mom of two", "Woman and proud", "just a regular dude", "they", "he/him",
    "pronouns: he". A lone him / her / them states nothing."""
    t = re.sub(r"[^a-z'/\- ]", " ", low)
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return None
    m = re.fullmatch(r"(he|she|they)\s*/\s*(him|her|them)", t)
    if m:
        return _SUBJ[m.group(1)]
    toks = t.split(" ")
    i = 0
    while i < len(toks) - 1 and toks[i] in _LEAD:
        i += 1
    head = toks[i]
    rest = toks[i + 1:]
    if any(w not in _TRAIL for w in rest):
        return None
    if head in _SUBJ and not rest:
        return _SUBJ[head]
    if head in _SUBJ:
        return None
    return _noun_gender(head)


def _anchor_statements(text: str, base: int):
    out = []
    m0 = _AS_RE.match(text)
    if m0 and _noun_gender(m0.group(1)):
        out.append((base, _noun_gender(m0.group(1))))
    for am in _ANCHOR_RE.finditer(text):
        toks = re.findall(r"[\w'’-]+|,", text[am.end():])[:9]
        neg = False
        skip = False  # a blocked clause is skipped up to its comma; the next clause starts fresh ("I'm from Ohio, a mom of two")
        for idx, tok in enumerate(toks):
            if tok == ",":
                skip = False
                neg = False
                continue
            if skip:
                continue
            bare = tok.replace("'", "").replace("’", "")
            if bare in _NEG or (bare.endswith("nt") and len(bare) > 3):
                neg = True
                continue
            if tok in _BLOCK:
                skip = True
                continue
            if tok in _SUBJ:  # "I'm a she": only straight after the anchor (or one article)
                if idx == 0 or (idx == 1 and toks[0] in ("a", "an")):
                    if not neg:
                        out.append((base + am.start(), _SUBJ[tok]))
                break
            g = _noun_gender(tok)
            if g:
                nxt = toks[idx + 1] if idx + 1 < len(toks) else ""
                if not neg and nxt not in _NOT_AFTER:
                    out.append((base + am.start(), g))
                break
    return out


def _statements(words: str) -> list:
    found: list = []  # (position, gender)
    offset = 0
    for line in (words or "").replace("\r", "\n").split("\n"):
        low = _norm(line)
        g = _bare_turn(low)
        if g:
            found.append((offset, g))
        for m in _PRON_PAIR_RE.finditer(low):
            found.append((offset + m.start(), _SUBJ[m.group(1)]))
        for m in _PRON_STMT_RE.finditer(low):
            found.append((offset + m.start(), _PRONOUN[m.group(1)]))
        for sent in re.finditer(r"[^.!?;]+", low):
            found.extend(_anchor_statements(sent.group(0), offset + sent.start()))
        offset += len(line) + 1
    found.sort(key=lambda x: x[0])
    return found


def stated_gender(words: str):
    """The gender the player stated in their own words, or None. The LATEST statement wins ("I'm a guy" ... "sorry, I'm a woman"
    is woman); a negation ("I'm not a man") states nothing. Never inferred from a name."""
    found = _statements(words)
    return found[-1][1] if found else None


def any_gender_stated(words: str) -> bool:
    """True when ANY line of the player's words states a gender. The heal of a saved season clears a recorded gender ONLY when this is
    False: a disagreement between the latest reading and the saved value never clears and never changes it."""
    return bool(_statements(words))


def player_stated_genders(words: str) -> set:
    g = stated_gender(words)
    return {g} if g else set()
