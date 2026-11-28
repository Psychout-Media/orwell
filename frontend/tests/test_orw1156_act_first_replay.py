"""ORW-1156 gate: the act-first PRECISION layer replayed over 200 labelled message shapes (templated roles, no player chat).
The model is replaced by an EAGER stand-in that proposes the act for ANY message that mentions a room, a person or sleep (the worst a model can do); `validate_calls` and the vetoes must still commit
exactly what the words plainly ask. Gate: 98 percent or more correct, at most 1 wrong commit per 200. Latency (added p95 of the live call) is measured live: `actFirst.latencyMsP95` on /api/admin/health."""
import itertools

from src import act_first as af
from src.house_rooms import HOUSE_ROOMS

CTX = {"here": "living-room", "people": ["Rowan", "Casey"], "room_names": None, "pending_kind": None, "sleep_ok": True}
ROOMS = ["kitchen", "backyard", "lounge", "bathroom", "dining-room"]
SAY = {"kitchen": "the kitchen", "backyard": "the backyard", "lounge": "the lounge", "bathroom": "the bathroom", "dining-room": "the dining room"}

DO_MOVE = ["I walk on into {r}.", "I stroll over to {r}.", "I move to {r}.", "I run to {r}.", "I walk over to {r}.", "I step into {r}.", "I go on into {r} now.", "Heading to {r}.", "I make my way to {r}.", "I go to {r}.", "I head to {r}.", "I walk into {r}.", "Going to {r}.", "I'm heading to {r} now."]
NO_MOVE = ["Rowan is heading to {r}.", "I hate {r}.", "Nobody is in {r}.", "I think {r} is lovely.", "Casey is walking to {r}.", "Is {r} open?", "I would never go to {r}.", "Maybe I will head to {r} tomorrow.", "I like {r}.", "Rowan, meet me in {r}.", "Should I go to {r}?", "I will go to {r} later.", "Rowan went to {r}.", "What is in {r}?", "I don't want to go to {r}.", "Rowan says he is in {r}.",
           "I was in {r} earlier.", "Do you want to go to {r}?", "I wonder what happens in {r}.", "Rowan, meet me in {r} tomorrow."]
DO_SLEEP = ["I go to bed.", "I'm going to sleep now.", "I turn in for the night.", "Time for bed, I am going to sleep."]
NO_SLEEP = ["Do you want to go to bed?", "Rowan is asleep.", "I don't want to sleep yet.", "Should I go to bed?", "Rowan says good night."]
SEARCH = ["I'm going to find {p}.", "I go look for {p}."]
NO_SEARCH = ["Is {p} nice?", "I told {p} the plan.", "{p} and I talked.", "{p} is in the kitchen.", "Tell {p} hello.", "I like {p}.", "{p} said hi to me."]
BED = ["I grab a single bed in bedroom a.", "I claim a double bed in bedroom b."]
NO_BED = ["Who has the single bed in bedroom a?", "Rowan claims the bed in bedroom a.", "I might take a bed in bedroom b later."]


def cases():
    out = []  # (text, expected acts as a tuple of tool names)
    for r, t in itertools.product(ROOMS, DO_MOVE):
        out.append((t.format(r=SAY[r]), (("moveTo", r),)))
    for r, t in itertools.product(ROOMS, NO_MOVE):
        out.append((t.format(r=SAY[r]), ()))
    out += [(t, (("turnIn",),)) for t in DO_SLEEP] + [(t, ()) for t in NO_SLEEP]
    for p, t in itertools.product(["Rowan", "Casey"], NO_SEARCH):
        out.append((t.format(p=p), ()))
    for p, t in itertools.product(["Rowan", "Casey"], SEARCH):
        out.append((t.format(p=p), (("search", p),)))
    out += [(BED[0], (("claimBed", "bedroom-a"),)), (BED[1], (("claimBed", "bedroom-b"),))]  # the eager stand-in claims in place; the plain-words path adds the move
    out += [(t, ()) for t in NO_BED]
    return out


def eager_calls(text):
    """The worst-case model: proposes an act for anything that names a room, a person or sleep."""
    calls = []
    named = af.rooms_named(text)
    beds = [r for r in named if r in af.BEDROOMS]
    if beds and "bed" in text.lower():
        calls.append({"name": "claimBed", "arguments": {"room": beds[0], "kind": "any"}})
    elif named:
        calls.append({"name": "moveTo", "arguments": {"room": named[0]}})
    for p in CTX["people"]:
        if p.lower() in text.lower() and not named:
            calls.append({"name": "search", "arguments": {"who": p}})
    if af._SLEEP_CUE.search(text) and "bed" not in " ".join(named):
        calls.append({"name": "turnIn", "arguments": {}})
    return calls


def committed(text):
    clean = af.clean_text(text)
    if af.prefilter(text) is not None:
        return ()
    acts = af.validate_calls(eager_calls(clean), text=clean, rooms=HOUSE_ROOMS, ctx=CTX) or af.plain_acts(clean, HOUSE_ROOMS, CTX)
    return tuple((t, a.get("room") or a.get("who")) if t in ("moveTo", "claimBed", "search") else (t,) for t, a in acts)


def _norm(exp):
    return tuple(e if len(e) == 1 else (e[0], e[1]) for e in exp)


def test_replay_precision_gate():
    cs = cases()
    correct = wrong = missed = 0
    bad = []
    for text, exp in cs:
        got = committed(text)
        if got == _norm(exp):
            correct += 1
        elif got:
            wrong += 1
            bad.append((text, got, exp))
        else:
            missed += 1
    n = len(cs)
    print(f"ORW-1156 act-first replay: n={n} correct={correct} ({100*correct/n:.1f}%) wrong-commits={wrong} ({200*wrong/n:.2f} per 200) missed={missed}")
    for b in bad[:10]:
        print("  wrong:", b)
    assert n >= 200, n
    assert correct / n >= 0.98, bad
    assert wrong * 200 / n <= 1.0, bad
