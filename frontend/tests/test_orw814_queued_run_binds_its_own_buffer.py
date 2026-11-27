"""ORW-814: out-of-order replies. Several turns start() in one loop tick (rapid sends); each queued run must publish into ITS OWN buffer.

Old code: `_drain` looked the run up with `_RUNS.get(session_id)` when it first executed, which by then was the NEWEST run, so turn 1's reply landed in turn N's buffer
(under the wrong user row) and turn N's own events followed after it."""
import asyncio
import importlib

agent_runs = importlib.import_module("src.agent_runs")


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def _gen(label):
    await asyncio.sleep(0.01)
    yield f"data: {label}\n\n"
    yield "data: [DONE]\n\n"


def test_queued_runs_started_in_one_tick_each_fill_their_own_buffer():
    async def main():
        sid = "orw814-sess"
        runs = [agent_runs.start(sid, _gen(f"reply{i}"), queue=True) for i in range(4)]   # no await between starts
        await asyncio.gather(*[r.task for r in runs])
        out = [[e for e in r.buffer if "reply" in e] for r in runs]
        for r in runs:
            r.evict_task and r.evict_task.cancel()
        agent_runs._RUNS.pop(sid, None)
        return out

    out = _run(main())
    assert out == [[f"data: reply{i}\n\n"] for i in range(4)]
