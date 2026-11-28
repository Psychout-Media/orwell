"""ORW-1130 - the narrator voiced a run of toasts past the released batch (the prod case, as codes): the reply names speakers the engine has not released. The turn path reports them on the next advance, and the
engine (stubbed here with its documented rule) never releases a houseguest who already toasted. Real chain: note_premiere_turn -> note_premiere_narration -> maybe_release_premiere_arrival -> orwell_engine.advance_game
-> the engine call. Roles only; invented labels; no model."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

USER = "u-orw1130"
NAMES = [f"Guest{chr(65 + i)} Role{chr(65 + i)}" for i in range(15)]
ITEMS = ["host"] + NAMES[:7] + ["player"] + NAMES[7:]
BATCH = 2


class Engine:
    def __init__(self):
        self.spoke = 0
        self.last = []
        self.ahead = set()
        self.released = []
        self.closed = False

    async def call(self, name, args, user=None, timeout=None):
        assert name == "advanceGame"
        for v in args.get("toastVoiced") or []:
            if v in NAMES[:] and v in [x for x in ITEMS[self.spoke:]]:
                self.ahead.add(v)
        if self.spoke >= len(ITEMS):
            self.closed = True
            return {"event": {"beat": "premiere-toast"}}
        batch = []
        while self.spoke < len(ITEMS) and len(batch) < BATCH * int(args.get("toastBatches") or 1):
            x = ITEMS[self.spoke]
            self.spoke += 1
            if x in self.ahead:
                continue
            batch.append(x)
        self.last = batch
        self.released += [x for x in batch if x not in ("host", "player")]
        return {"event": {"beat": "premiere-toast"}}

    def state(self):
        if self.closed:
            return {"phase": "premiere", "pending": None, "premiere": {"entrance": {"stage": "done", "index": 16, "total": 16, "arrivedNames": NAMES}}}
        ent = {"stage": "toast", "index": 16, "total": 16, "playerPosition": 4, "arrivedNames": NAMES}
        if self.last:
            ent["speakers"] = [{"name": "The host", "host": True} if x == "host" else ({"id": "me", "name": "Player", "isPlayer": True} if x == "player" else {"id": x, "name": x}) for x in self.last]
        return {"phase": "premiere", "pending": None, "premiere": {"entrance": ent}}


@pytest.fixture(autouse=True)
def _clean():
    stores = [ch._ARRIVALS_NAMED, ch._ARRIVALS_FRAMED, ch._ARRIVAL_VOICE_HOLDS, ch._SCHEDULE_STEER, ch._CEREMONY_UNVOICED, ch._PREMIERE_ENTRANCE_STAGE, ch._PRE_RESOLVED_ADVANCE,
              al._TURNS_SINCE_PROGRESS, ch._PREMIERE_RELEASED_THIS_TURN, ch._TOAST_BATCH_NAMED, ch._PREMIERE_TOAST_SPEAKERS, ch._ENTRANCE_FRAMES, oe._ENTRANCE_VOICED, ch._ARRIVED_NAMES, oe._TOAST_VOICED_PENDING]
    for d in stores:
        d.clear()
    yield
    for d in stores:
        d.clear()


def _turn(eng, msg, narration=None):
    ch._PRE_RESOLVED_ADVANCE.clear()
    s = eng.state()
    ch.note_premiere_turn(USER, s)
    asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg=msg))
    if narration is not None:
        ch.note_premiere_narration(USER, narration)


def test_a_toast_voiced_past_the_released_batch_is_never_released_again(monkeypatch):
    eng = Engine()

    async def call(name, args, user=None, timeout=None):
        return await eng.call(name, args, user=user, timeout=timeout)

    async def fetch(user, retry=False):
        return eng.state()

    monkeypatch.setattr(oe, "_call", call)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)
    _turn(eng, "here we go")
    first = list(eng.released)
    overrun = NAMES[3:9]  # the reply toasts six houseguests the engine has not released
    story = " ".join(f"{n} raises a glass and gives a toast." for n in first + overrun)
    ch.note_premiere_narration(USER, story)
    for _ in range(12):
        if eng.closed:
            break
        _turn(eng, "next", narration="The host nods and the circle goes on.")
    assert eng.closed
    for n in overrun:
        assert eng.released.count(n) == (1 if n in first else 0), f"{n} is not released after the reply voiced the toast"
    assert all(eng.released.count(n) <= 1 for n in NAMES), "no houseguest is released twice"
    assert set(eng.released) | set(overrun) == set(NAMES), "everyone toasts exactly once"


def test_a_name_in_a_sentence_that_is_not_a_toast_is_not_counted():
    assert ch._toast_voiced_ahead("GuestE RoleE waves from the sofa. GuestF RoleF raises a glass to the house.", NAMES, []) == {NAMES[5]}
