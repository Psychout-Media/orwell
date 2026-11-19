"""ORW-109 - the PURE parts of the formal live-run short tier (no browser, no model, no network): the per-turn engine-vs-narration comparator, the stall and
livelock rules, the in-harness budget (spend and turn caps), and the scrubbed pass/fail report. Unit-tested offline in frontend/tests/test_live_compare.py.

A "turn" is the dict live_short.play() records: label, text (the reply), phase_before, phase, ds (the engine's daySchedule), nominees, veto_holder, evicted (names the
engine records as evicted at the end of the turn), finalists, winner, finished, cast (every houseguest name the engine knows), player, hoh_name. Roles only: nothing
here names a houseguest; the names it compares come from the engine's own state.
"""
from __future__ import annotations

import html
import json
import re

# --- the stall rule (docs/live-run-pass-bar.md S1) ---------------------------------------------------------------------------------------------------------
STALL_WINDOW = 3          # an event whose due hour has passed must fire within this many player turns
ASKED_WINDOW = 1          # after the player explicitly asked for it, within this many
LIVELOCK_RUN = 3          # the same reply this many turns in a row is a livelock
EVENT_PHASES = ("nominations", "veto-ceremony", "eviction", "hoh-competition", "veto-competition", "final-eviction", "finale")
ASK_RE = re.compile(r"(?i)\b(let'?s (?:go|do it|start)|run it|call (?:it|the)|start (?:it|the)|do it now|right now|hang out until)\b")


class BudgetExceeded(Exception):
    """Raised by Budget.check; the harness catches it, writes a CAPPED report with the spend so far, and exits cleanly."""

    def __init__(self, kind, value, limit):
        super().__init__(f"{kind} cap reached: {value} >= {limit}")
        self.kind, self.value, self.limit = kind, value, limit


class Budget:
    """The in-harness caps: --max-spend (dollars, as estimated by spend_fn, which reads the model-call archive at a deliberately high rate) and --max-turns.
    check() runs BEFORE each model-costing step; at or past a cap it raises BudgetExceeded, so a run stops cleanly at the cap and reports what it spent."""

    def __init__(self, max_spend=None, max_turns=None, spend_fn=None):
        self.max_spend, self.max_turns, self.spend_fn, self.turns = max_spend, max_turns, spend_fn, 0
        for name, v in (("max_spend", max_spend), ("max_turns", max_turns)):
            if v is not None and not (isinstance(v, (int, float)) and v > 0):
                raise ValueError(f"{name} must be a positive number (a run without a working cap is never started), got {v!r}")

    def spent(self):
        try:
            return float(self.spend_fn()) if self.spend_fn else 0.0
        except (TypeError, ValueError, OSError):
            return 0.0   # an unreadable spend file never lets the harness run on blind: the out-of-process guard (spend_guard.py) still stops it by PID

    def check(self):
        if self.max_turns is not None and self.turns >= self.max_turns:
            raise BudgetExceeded("turn", self.turns, self.max_turns)
        s = self.spent()
        if self.max_spend is not None and s >= self.max_spend:
            raise BudgetExceeded("spend", round(s, 4), self.max_spend)

    def note_turn(self):
        self.turns += 1

    def summary(self):
        return {"spent_usd": round(self.spent(), 4), "max_spend_usd": self.max_spend, "turns": self.turns, "max_turns": self.max_turns}


# --- names ---------------------------------------------------------------------------------------------------------------------------------------------
def _first(n):
    return (n or "").split()[0].lower() if n else ""


def _same(a, b):
    """Two houseguest references are the same person: equal full names, or one is the other's first name."""
    a, b = (a or "").lower().strip(), (b or "").lower().strip()
    return bool(a and b and (a == b or a == _first(b) or b == _first(a) or _first(a) == _first(b) and (" " not in a or " " not in b)))


def _known(name, cast):
    return any(_same(name, c) for c in cast)


_NAME = r"([A-Z][a-z'-]+(?: [A-Z][a-z'-]+)?)"
WIN_VETO_RE = re.compile(_NAME + r"\s+(?:wins|won|has won|takes|took|claims|holds|is the holder of)\s+the\s+(?:Power of Veto|veto|Veto)\b")
VETO_HOLDER_RE = re.compile(r"(?i:the veto (?:holder|winner) is)\s+" + _NAME)
BLOCK_RE = re.compile(_NAME + r"\s+(?:is|are|was|were|has been|have been)\s+(?:now\s+|officially\s+)?(?:on the block|nominated|a nominee)\b")
EVICTED_RE = re.compile(_NAME + r"\s+(?:is|has been|was)\s+(?:now\s+)?(?:evicted|voted out|eliminated)\b")
CROWN_RE = re.compile(_NAME + r"\s+(?:wins|won|is crowned|has won|takes home)\s+(?:the\s+)?(?:season|game|Big Brother|jury vote|the title|the crown)", re.I)
# a sealed ballot read as per-voter attribution (E12): "X voted to evict Y", "X's vote was for Y"
BALLOT_ATTR_RE = re.compile(_NAME + r"(?:'s vote (?:was|went) (?:to evict|against|for)|\s+(?:voted|votes) (?:to evict|against|for|out))\s+" + _NAME)
# reasoning or operator text that must never reach the public bubble (the machinery list live_short's T3 holds is checked there; these are the narrator-voice leaks)
REASONING_RE = re.compile(r"(?i)<think|</think|^\s*(?:thinking|reasoning)\s*:|\[\s*(?:ooc|operator|system)\b|\(\s*ooc\b|as the game master|note to self|the engine (?:says|state|has)|stale-beat|\bHTTP 409\b|\bbeatSeq\b")


def _claimed(rx, text):
    return [m.group(1) for m in rx.finditer(text or "")]


def compare_turn(t):
    """Compare one turn's narration with the engine's own state. Returns a list of {id, ok, severity, detail}. A claim is only judged when it names a houseguest the
    engine knows (t['cast']); capitalized words that are not the cast are never flagged. Each check has a planted-mismatch unit test (a positive control)."""
    lab, text = t.get("label", "?"), t.get("text") or ""
    cast = list(t.get("cast") or [])
    out = []

    def add(cid, ok, detail, sev="fail"):
        out.append({"id": f"{cid}[{lab}]", "ok": bool(ok), "severity": sev, "detail": detail})

    holder = t.get("veto_holder")
    holder_name = holder.get("name") if isinstance(holder, dict) else holder
    for said in _claimed(WIN_VETO_RE, text) + _claimed(VETO_HOLDER_RE, text):
        if not _known(said, cast):
            continue
        ok = bool(holder_name) and _same(said, holder_name)
        add("B1-veto-holder", ok, f"narration names a veto winner; the engine {'has a different holder' if holder_name else 'has not committed a veto result'}")
    nominees = list(t.get("nominees") or [])
    if t.get("phase") not in (None, "setup", "premiere", "hoh-competition"):
        for said in _claimed(BLOCK_RE, text):
            if _known(said, cast) and nominees and not any(_same(said, n) for n in nominees) and not (t.get("phase") == "veto-ceremony" and t.get("replacement_open")):
                add("B2-nominees", False, f"narration puts a houseguest on the block who is not among the engine's {len(nominees)} nominees")
    elif any(_known(x, cast) for x in _claimed(BLOCK_RE, text)) and not nominees:
        add("B2-nominees", False, "narration puts a houseguest on the block while the engine has committed no nominees")
    evicted = list(t.get("evicted") or [])
    for said in _claimed(EVICTED_RE, text):
        if _known(said, cast) and not any(_same(said, e) for e in evicted):
            add("B3-evictee", False, "narration evicts a houseguest the engine has not recorded as evicted")
    if t.get("phase") in ("eviction", "final-eviction"):
        for m in BALLOT_ATTR_RE.finditer(text):
            voter = m.group(1)
            if _known(voter, cast) and not _same(voter, t.get("player")) and not _same(voter, t.get("hoh_name")):
                add("B4-sealed-ballot", False, "narration attributes a sealed eviction ballot to a named voter (E12: attribution unseals only in the retrospective)")
    for said in _claimed(CROWN_RE, text):
        w = t.get("winner")
        winner_name = w.get("name") if isinstance(w, dict) else w
        if _known(said, cast) and not (t.get("finished") and winner_name and _same(said, winner_name)):
            add("B5-winner", False, "narration crowns a winner the engine has not recorded")
    m = REASONING_RE.search(text)
    add("B6-no-reasoning-or-operator-text", not m, f"matched {m.group(0)!r}" if m else "clean")
    return out


def _norm(text):
    return re.sub(r"\W+", " ", (text or "").lower()).strip()


def detect_stall(turns, window=STALL_WINDOW, asked_window=ASKED_WINDOW):
    """The stall rule. A run of consecutive turns in which the engine reports an event DUE (ds.due, ds.next an event) and committed nothing (the phase did not move and no
    decision is pending) is a stall once it is longer than `window` turns (`asked_window` when the player's own message asked for it). Returns a list of findings.
    The ORW-10 veto stall (35 messages with the veto ceremony due) is exactly this shape."""
    out, run, start, key = [], 0, None, None
    for t in turns:
        ds = t.get("ds") or {}
        due = bool(ds.get("due")) and (ds.get("next") in EVENT_PHASES or t.get("phase") in EVENT_PHASES) and not t.get("engine_pending") and t.get("phase") == t.get("phase_before")
        k = (ds.get("next"), t.get("phase"))
        if due and (key in (None, k)):
            run, key = run + 1, k
            start = start or t.get("label")
            lim = asked_window if ASK_RE.search(t.get("msg") or "") else window
            if run == lim + 1:
                out.append({"id": f"S1-stall[{t.get('label')}]", "ok": False, "severity": "fail",
                            "detail": f"{ds.get('next') or t.get('phase')} was due and committed nothing for {run} turns in a row (from {start}); the rule allows {lim}"})
        else:
            run, start, key = (1, t.get("label"), k) if due else (0, None, None)
    return out


def detect_livelock(turns, run_len=LIVELOCK_RUN):
    """The same reply `run_len` times in a row (#1781 F2)."""
    out, same, prev = [], 0, None
    for t in turns:
        n = _norm(t.get("text"))
        same = same + 1 if n and n == prev else 1
        prev = n
        if same == run_len:
            out.append({"id": f"L1-livelock[{t.get('label')}]", "ok": False, "severity": "fail", "detail": f"the same reply {run_len} turns in a row"})
    return out


def apply_comparison(turns, check):
    """Run the comparator, the stall rule and the livelock rule over every turn and record each through `check(id, ok, detail, severity)`. Passing per-turn comparisons
    are recorded only as one summary line per rule (a long run stays readable); every failure is recorded in full."""
    n_ok = {}
    for t in turns:
        for c in compare_turn(t):
            rule = c["id"].split("[")[0]
            if c["ok"]:
                n_ok[rule] = n_ok.get(rule, 0) + 1
            else:
                check(c["id"], False, c["detail"], c["severity"])
    for rule, n in sorted(n_ok.items()):
        check(f"{rule}-summary", True, f"{n} turn(s) clean", "note")
    for c in detect_stall(turns) + detect_livelock(turns):
        check(c["id"], False, c["detail"], c["severity"])
    if not any(c for t in turns for c in [t] if (t.get("ds") or {}).get("due")):
        check("S1-stall-rule-armed", True, "no turn had an event due: the stall rule had nothing to judge", "note")


# --- the report ----------------------------------------------------------------------------------------------------------------------------------------
def scrub(text, names):
    """Replace every known houseguest name (full and first) with a role word, so a report never carries a cast name."""
    out = text or ""
    for n in sorted({x for x in names if x}, key=len, reverse=True):
        for part in {n, n.split()[0]}:
            out = re.sub(r"\b" + re.escape(part) + r"\b", "[houseguest]", out)
    return out


def verdict_of(checks, error=None, capped=False):
    if error:
        return "COULD NOT RUN"
    if any(not c["ok"] and c["severity"] == "fail" for c in checks):
        return "FAIL"
    return "CAPPED" if capped else "PASS"


def build_report(meta, checks, beats, budget, error=None, capped=False, names=()):
    """The one concise report: (markdown, json-dict). No transcript, no names (scrubbed), no secrets (only what the caller passes: sha, flags, model, counts)."""
    v = verdict_of(checks, error, capped)
    hard = [c for c in checks if not c["ok"] and c["severity"] == "fail"]
    warn = [c for c in checks if not c["ok"] and c["severity"] == "warn"]
    data = {"verdict": v, "meta": meta, "beats": beats, "budget": budget, "failing": [{"id": c["id"], "detail": scrub(c["detail"], names)} for c in hard],
            "warnings": [{"id": c["id"], "detail": scrub(c["detail"], names)} for c in warn], "checks_total": len(checks), "error": scrub(error or "", names) or None}
    L = [f"# Live run (formal short tier) - {v}", "",
         f"- Build: `{meta.get('sha', '?')}` ({meta.get('ref', '?')}); model: {meta.get('model', '?')}; tier: short; beats: {', '.join(beats) or 'none'}",
         f"- Spend: ${budget.get('spent_usd', '?')} of a ${budget.get('max_spend_usd', '?')} cap; turns: {budget.get('turns', '?')} of {budget.get('max_turns', '?')}",
         f"- Checks: {len(checks)}; failing: {len(hard)}; warnings: {len(warn)}" + (f"; stopped: {error}" if error else ""), ""]
    if hard or warn:
        L += ["## Not passing", ""] + [f"- **{c['severity'].upper()}** `{c['id']}` - {scrub(c['detail'], names)}" for c in hard + warn] + [""]
    L += ["## Pass bar", "", "See docs/live-run-pass-bar.md (checks S1, B1-B6, V/E/F beats, T-checks).", ""]
    return "\n".join(L), data


def plane_comment_html(data):
    """The comment body for the board: the verdict line, the numbers and the failing check ids. Scrubbed already; HTML-escaped here."""
    m, b = data.get("meta", {}), data.get("budget", {})
    rows = "".join(f"<li><code>{html.escape(f['id'])}</code> - {html.escape(f['detail'])}</li>" for f in data.get("failing", [])[:20])
    return (f"<p><strong>Live run (formal short tier): {html.escape(data['verdict'])}</strong> - build <code>{html.escape(str(m.get('sha', '?')))}</code>, beats "
            f"{html.escape(', '.join(data.get('beats', [])))}, {b.get('turns', '?')} turns, spend ${b.get('spent_usd', '?')} of ${b.get('max_spend_usd', '?')}.</p>"
            + (f"<ul>{rows}</ul>" if rows else "<p>No failing checks.</p>"))


def write_report(run_dir, md, data):
    open(f"{run_dir}/bar-report.md", "w").write(md)
    json.dump(data, open(f"{run_dir}/bar-report.json", "w"), indent=1)
    open(f"{run_dir}/plane-comment.html", "w").write(plane_comment_html(data))


# --- the offline stub (what CI-safe runs use: no browser, no engine, no model, no spend) -------------------------------------------------------------------
def _stub_turn(i, phase, text, due=False, **kw):
    t = {"label": f"stub-{i}", "msg": "I wait.", "text": text, "phase": phase, "phase_before": phase, "ds": {"due": due, "next": phase}, "cast": ["Aa Bb", "Cc Dd", "Ee Ff"],
         "nominees": ["Aa Bb", "Cc Dd"], "evicted": [], "veto_holder": "Ee Ff", "player": "Gg Hh", "engine_pending": False}
    t.update(kw)
    return t


def stub_transcripts():
    """(clean, broken): a clean veto-ceremony transcript, and the same game with a planted stall and a planted phantom veto claim. Used by --dry-run and the unit tests."""
    scene = "The living room hums as the veto holder gathers everyone; the chairs scrape and the nominees wait with held breath. "
    clean = [_stub_turn(1, "veto-ceremony", scene + "The ceremony convenes.", due=True), _stub_turn(2, "veto-competition", scene + "It is over.", phase_before="veto-ceremony")]
    broken = [_stub_turn(i, "veto-ceremony", scene + f"Still waiting, beat {i}. Cc Dd wins the Power of Veto.", due=True) for i in range(1, 6)]
    return clean, broken


def selftest():
    """Run the comparator over the stub transcripts: the clean one must score no failure and the broken one must be caught (a stall and a phantom veto claim). Returns (ok, lines)."""
    clean, broken = stub_transcripts()
    res = []
    for name, ts in (("clean", clean), ("broken", broken)):
        got = []
        apply_comparison(ts, lambda cid, ok, detail, sev="fail": got.append({"id": cid, "ok": ok, "severity": sev, "detail": detail}))
        res.append((name, [c["id"].split("[")[0] for c in got if not c["ok"] and c["severity"] == "fail"]))
    ok = not res[0][1] and "S1-stall" in res[1][1] and "B1-veto-holder" in res[1][1]
    return ok, [f"stub {n}: failing {f or 'none'}" for n, f in res] + ["positive control " + ("held: the stall and the phantom veto claim were detected" if ok else "FAILED")]
