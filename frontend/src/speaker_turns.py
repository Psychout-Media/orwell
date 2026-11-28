"""ORW-1028 - one speaker-turn seam for every guard that edits a reply.

A reply is a run of paragraphs. A SPEAKER TURN is one paragraph that opens with a speaker tag (`@[Name] - "line." narration "more line."`): the tag, every quote and the
narration after them belong to that one speaker. The reply guards (presence wall, role-claim strip, knowledge wall, player-voice guard, confession guard, the pre-display
withhold, the outcome guard) cut at SENTENCE level. When one of them cut the first sentence of a turn (the one that carries the tag) the rest of the turn stayed behind: a line
with no speaker, a quote with no opening mark. The player could not tell who was speaking.

`TurnSeam` sits after ALL the guards on the streamed chunk. It is given the chunk as the guards received it (`pre`) and as they left it (`post`), finds which sentences were
cut, and applies ONE rule: a turn that lost its head loses its whole body (the turn goes whole or not at all). It then keeps each paragraph's quote marks balanced (an orphan
closing mark is removed; a quote still open at the end of its paragraph is closed) and removes the blank lines a drop leaves behind. With `pre == post` (a whole stored text, an
offline replay) the same code reads the text on its own: a paragraph that starts with a blank is the residue of a head that was cut earlier.

Pure and fail-open: any hiccup returns `post` unchanged. No model call, no engine read."""
import re
from typing import List, Optional

TAG_RE = re.compile(r"@\[[^\]]+\]")
_SENT_SPLIT = re.compile(r"(?<=[.!?\n])")
_OPENER_PREV = " \t\n\u00a0-\u2013\u2014:([{*_"
_LEAD_CLOSER_RE = re.compile(r"^[ \t]*[\"\u201d\u2019']+")
_CLOSER_FOR = {'"': '"', "“": "”"}


def split_parts(text: str) -> List[str]:
    """The sentence split every guard uses (a newline ends a part)."""
    return [p for p in _SENT_SPLIT.split(text or "") if p != ""]


def _align(pre: str, post: str) -> Optional[List[tuple]]:
    """[(part, kept_text_or_None)] for the sentences of `pre`, matched in order to what `post` kept.

    ORW-1028: a guard that REWRITES a sentence (confession deflection, role-claim strip, the player-voice guard) leaves text in `post` that is no part of `pre`. That used to fail the whole
    alignment, so the chunk was read on its own and a head cut in the same chunk was never seen (the headless lines reached the player). Now the text a rewrite put in is carried as
    its own kept part, and the sentences matched around it stay aligned. Returns None only when nothing of `pre` can be found in a non-empty `post`."""
    pos = 0
    out = []
    matched = 0
    for bp in split_parts(pre):
        rest = post[pos:]
        hit = None
        # a guard may trim the blanks a dropped sentence leaves at a line start and an orphan closing mark (ORW-455/479)
        for cand in (bp, bp.lstrip(" \t"), _LEAD_CLOSER_RE.sub("", bp, count=1), _LEAD_CLOSER_RE.sub("", bp, count=1).lstrip(" \t")):
            if cand and rest.startswith(cand):
                hit = cand
                break
        gap = ""
        if hit is None and len(bp.strip()) >= 12:
            # not at the cursor: the text up to it may be a sentence a guard rewrote (carried as its own kept part)
            idx = rest.find(bp)
            if idx > 0:
                gap, hit = rest[:idx], bp
        if hit is not None:
            gparts = split_parts(gap)
            run = []  # the unmatched parts right before this one are what the rewrite replaced: the rewritten text takes their place, in order
            while len(run) < len(gparts) and len(out) > len(run) and out[len(out) - 1 - len(run)][1] is None:
                run.append(len(out) - 1 - len(run))
            for slot, g in zip(reversed(run), gparts[:len(run)]):
                out[slot] = (out[slot][0], g)
            for g in gparts[len(run):]:
                out.append((g, g))
            out.append((bp, hit))
            pos += len(gap) + len(hit)
            matched += 1
            continue
        out.append((bp, None))
    tail = post[pos:]
    if tail.strip():
        if not matched and (pre or "").strip():
            return None
        for g in split_parts(tail):  # text a guard put in after the last matched sentence
            out.append((g, g))
    return out


class TurnSeam:
    """Per-round state for the seam. `feed(pre, post)` returns the text to emit for one chunk; `finish()` returns what closes the round (a quote still open)."""

    def __init__(self, strict_residue: bool = False):
        self.strict_residue = strict_residue  # ORW-1028: a whole stored text: a later paragraph that starts with a blank is a cut head's body and goes whole, quote or not (the live seam saw the cut; the stored text did not)
        self.head_seen = False      # some part of the current paragraph was processed
        self.tagged = False         # the current paragraph's head carries a speaker tag
        self.drop_turn = False      # the rest of the current paragraph is dropped (its head was cut)
        self.cut_head = False       # an untagged head was cut by a guard (known cause)
        self.residue = False        # the paragraph starts with a blank: the head was cut before this text reached us
        self.open_quote: Optional[str] = None
        self.prev = ""              # last character emitted in the current paragraph
        self.emitted_any = False
        self.nl_run = 0             # consecutive newlines at the end of the emitted text
        self._ahead = ""
        self.para_out = False       # something of the current paragraph was emitted
        self.cuts: List[str] = []   # kept parts the seam removed since the last `take_cuts()`
        self.dropped = 0            # parts removed beyond the guards' own cuts (for tests and logs)
        self.repaired = 0           # quote marks removed or closed

    # ----- one chunk -------------------------------------------------------------------------------------------------
    def feed(self, pre: str, post: str) -> str:
        try:
            return self._feed(pre if pre is not None else post, post or "")
        except Exception:  # failsoft-ok: the seam never blocks a reply
            return post or ""

    def _feed(self, pre: str, post: str) -> str:
        if not post and not pre:
            return post
        aligned = _align(pre, post) if pre != post else [(p, p) for p in split_parts(post)]
        if aligned is None:
            aligned = [(p, p) for p in split_parts(post)]  # a guard rewrote text: no cut information, read `post` on its own
        out: List[str] = []
        for idx, (part, kept) in enumerate(aligned):
            body = part.rstrip("\n")
            nls = len(part) - len(body)
            if kept is not None:
                kept = kept.rstrip("\n")
            if body.strip():
                self._ahead = self._paragraph_ahead(aligned, idx)
                self._content(body, kept, out)
            elif kept is not None and body:
                if not self.head_seen:
                    pass  # blanks at a paragraph head are residue: never emitted
                elif not self.drop_turn:
                    out.append(self._sweep(body))
            if nls:
                self._paragraph_end(out, nls)
        return "".join(out)

    @staticmethod
    def _paragraph_ahead(aligned, idx) -> str:
        """The kept text of the paragraph from part `idx` to its end inside this chunk."""
        buf = []
        for part, kept in aligned[idx:]:
            if kept is not None:
                buf.append(kept.rstrip("\n"))
            if part.endswith("\n"):
                break
        return "".join(buf)

    def _content(self, body: str, kept: Optional[str], out: List[str]) -> None:
        at_head = not self.head_seen
        if at_head:
            self.head_seen = True
            self.tagged = bool(TAG_RE.match(body.lstrip()))
            if kept is not None and TAG_RE.match(body.lstrip()) and not TAG_RE.search(kept):
                kept = None  # ORW-1028: a guard rewrote the head and the tag went with it: same as a cut head, the whole turn goes
            if kept is None:
                if TAG_RE.search(body):
                    self.drop_turn = True  # the head that carried the tag was cut: the whole turn goes
                    self.dropped += 1
                else:
                    self.cut_head = True   # an untagged head was cut: what follows is narration judged on its own
                return
            if kept[:1] in (" ", "\t") and not self.tagged and not self.cut_head:
                self.residue = True        # a paragraph never starts with a blank unless its head was cut before it reached us (cause unknown)
        elif kept is None:
            return  # a later sentence of a turn was cut: the turn stays (its quote marks are balanced below)
        if self.drop_turn:
            self._cut(kept)
            return
        text = kept if kept is not None else body
        lead_stripped = text.lstrip(" \t")
        if not self.para_out and (self.residue or self.cut_head):
            text = lead_stripped  # the blank a cut sentence leaves at a line start
        if self.residue and self.strict_residue and self.emitted_any and not TAG_RE.search(lead_stripped):
            self.drop_turn = True  # the body of a head that was cut before this text was read
            self._cut(kept)
            return
        if self.residue and re.search(r'["\u201c\u201d]', lead_stripped) and not TAG_RE.search(lead_stripped):
            self.drop_turn = True  # a quote with no speaker behind a head that was cut before it reached us
            self._cut(kept)
            return
        if not self.para_out and not self.tagged and lead_stripped[:1] in ('"', "\u201c"):
            if not self._narrated(self._ahead.lstrip(" \t")):
                self.drop_turn = True  # a bare quote line with no speaker and no narration around it
                self._cut(kept)
                return
        self.para_out = True
        out.append(self._sweep(text))

    def _cut(self, kept: Optional[str]) -> None:
        """A kept part the seam removes: counted, and listed in `cuts` so the caller can erase it from the stored text too."""
        self.dropped += 1
        if kept:
            self.cuts.append(kept)

    @staticmethod
    def _narrated(piece: str) -> bool:
        """A line that opens with a quote but names who speaks or what they do in the same sentence (`"Fine," Levi says.`)."""
        outside = re.sub(r'["“][^"”]*(?:["”]|$)', " ", piece)
        return len(re.findall(r"[A-Za-z]{2,}", outside)) >= 2

    def _paragraph_end(self, out: List[str], nls: int) -> None:
        if self.open_quote and not self.drop_turn:
            out.append(_CLOSER_FOR.get(self.open_quote, '"'))
            self.repaired += 1
        had_content = self.head_seen and not self.drop_turn
        self.head_seen = self.tagged = self.drop_turn = self.residue = self.para_out = self.cut_head = False
        self.open_quote = None
        self.prev = ""
        if not (had_content or self.emitted_any):
            return  # leading blank lines of a reply
        room = max(0, 2 - self.nl_run)
        take = min(nls, room)
        if take:
            out.append("\n" * take)
            self.nl_run += take

    def _sweep(self, s: str) -> str:
        """`s` with orphan closing marks removed, tracking the open quote."""
        buf = []
        for ch in s:
            if ch == '"':
                if self.open_quote == '"':
                    self.open_quote = None
                elif self.open_quote is None:
                    if self.prev == "" or self.prev in _OPENER_PREV:
                        self.open_quote = '"'
                    else:
                        self.repaired += 1
                        continue  # an orphan closing mark: its opener was cut
            elif ch == "“":
                if self.open_quote is None:
                    self.open_quote = "“"
            elif ch == "”":
                if self.open_quote == "“":
                    self.open_quote = None
                elif self.open_quote is None:
                    self.repaired += 1
                    continue
            buf.append(ch)
            self.prev = ch
        text = "".join(buf)
        if text:
            self.emitted_any = True
            self.nl_run = 0
        return text

    def take_cuts(self) -> List[str]:
        cuts, self.cuts = self.cuts, []
        return cuts

    def finish(self) -> str:
        """The end of the round: a quote still open is closed."""
        tail = ""
        if self.open_quote and not self.drop_turn:
            tail = _CLOSER_FOR.get(self.open_quote, '"')
            self.repaired += 1
        self.open_quote = None
        return tail


def quote_open_at_end(text: str) -> bool:
    """True when the last paragraph of `text` ends inside an open double quote (the seam's own reading, so a close emitted by another path is seen)."""
    seam = TurnSeam()
    seam._sweep((text or "").rsplit("\n", 1)[-1])
    return seam.open_quote is not None


def wellformed(text: str) -> str:
    """The seam over one whole text (a stored reply, an offline replay): no residue lines, no speaker-less quote lines, balanced quote marks."""
    if not text:
        return text
    seam = TurnSeam(strict_residue=True)
    return seam.feed(text, text) + seam.finish()


def malformed(text: str) -> List[str]:
    """Which defects a text shows: 'headless' (a paragraph that starts with a blank), 'bare_quote' (an untagged line that opens with a quote and names no speaker), 'unbalanced'
    (a paragraph whose quote marks do not pair). Pure; the offline count and the tests use it."""
    kinds = []
    paras = [p for p in (text or "").split("\n") if p.strip()]
    if any(p[0] in " \t" for p in paras):
        kinds.append("headless")
    if any(not TAG_RE.search(p) and p.lstrip()[:1] in ('"', "“") and not TurnSeam._narrated(p.lstrip()) for p in paras):
        kinds.append("bare_quote")
    if any(p.count('"') % 2 == 1 or p.count("“") != p.count("”") for p in paras):
        kinds.append("unbalanced")
    return kinds
