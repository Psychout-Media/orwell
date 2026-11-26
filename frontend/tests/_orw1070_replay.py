"""ORW-1070: replay one confide / expose / trade fixture case through the real belt code.

The model call is the only thing replaced: `llm` is an async callable taking the belt's messages and returning
the raw reply (the recorded reply in CI; a live call in scripts/orw1070_rerecord.py). The engine is stubbed to the
fixture's facts and presence, and the lever calls the belt makes are recorded.
"""
import hashlib
import json
import os

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "orw1070_extractor_cases.json")


def load():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def house_of(fx):
    return [{"id": k, "name": v, "status": "active"} for k, v in fx["house"].items()]


def gate_pass(al, belt, line, house, regex_only=False):
    """Would the pipeline hand this line to the extractor? Old gate = the regex; new = regex OR structural."""
    from src import secret_belt_gates as sbg
    rx = {"confide": al._CONFIDE_PRESS_RE, "expose": al._EXPOSE_SIGNAL_RE, "trade": al._TRADE_SIGNAL_RE}[belt]
    hit = bool(rx.search(line or ""))
    if regex_only:
        return hit
    return hit or sbg.structural_signal(belt, line, house)


async def run_case(al, oe, belt, case, fx, llm, monkeypatch, legacy_guards=False):
    """Returns (levers, messages): the engine lever calls the belt made and the prompt it sent."""
    levers, sent = [], []
    house = house_of(fx)

    async def vis(user=None, **k):
        return {"knowledge": [{"id": fid, "content": f["content"], "subject": f["subject"]}
                              for fid, f in fx["facts"].items()]}

    async def where(user=None, **k):
        return {"room": "living-room", "present": [{"id": i} for i in case["present"]]}

    async def belt_llm(**kw):
        sent.append(kw["messages"])
        return await llm(kw["messages"])

    async def backfill(owner, fn, *a, **k):
        levers.append((fn.__name__, list(a), {x: y for x, y in k.items() if x in ("fact_id", "ask_kind")}))
        return {"disclosed": True, "exposed": True, "accepted": True}

    monkeypatch.setattr(oe, "get_visible_state", vis)
    monkeypatch.setattr(oe, "whereabouts", where)
    monkeypatch.setattr(al, "_belt_llm", belt_llm)
    monkeypatch.setattr(al, "_backfill_with_cas", backfill)
    monkeypatch.setattr(al, "_meter_user", lambda o: None)
    fn = {"confide": al._auto_confide, "expose": al._auto_expose_secret, "trade": al._auto_trade_secret}[belt]
    await fn(case["n"], case["u"], house, "url", "m", {}, "owner-1070")
    return levers, sent


def outcome(belt, levers):
    """What the belt did, in the fixture's expectation shape."""
    if not levers:
        return None
    name, args, kw = levers[0]
    if belt == "confide":
        return args[0]
    if belt == "expose":
        return kw.get("fact_id")
    return {"fact": kw.get("fact_id"), "to": args[0]}


def prompt_sha(messages):
    return hashlib.sha256(messages[0]["content"].encode("utf-8")).hexdigest()[:16]


def score(belt, cases, got):
    """Precision and recall of `got` (one outcome per case) against each case's expectation."""
    tp = fp = fn = 0
    for c, g in zip(cases, got):
        exp = c["expect"]
        if exp is None:
            fp += g is not None
        elif g is None:
            fn += 1
        elif g == exp:
            tp += 1
        else:
            fp += 1
            fn += 1
    p = tp / (tp + fp) if tp + fp else 1.0
    r = tp / (tp + fn) if tp + fn else 1.0
    return {"tp": tp, "fp": fp, "fn": fn, "P": round(p, 2), "R": round(r, 2)}
