"""ORW-437 (review of #2728): closing the bounded stream during a keepalive wait must cancel the pending upstream read and close the upstream."""
import asyncio

from src.agent_loop import _pd_bounded_stream


def test_closing_mid_keepalive_cancels_the_pending_read_and_closes_upstream():
    state = {"closed": False, "cancelled": False}

    async def upstream():
        try:
            yield "a"
            await asyncio.sleep(30)
            yield "b"
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise
        finally:
            state["closed"] = True

    async def run():
        gen = _pd_bounded_stream(upstream(), armed=lambda: True, drain={}, wait_s=5.0, beat_s=0.05)
        got = [await gen.__anext__(), await gen.__anext__()]  # "a" then a keepalive while the next read is pending
        await gen.aclose()
        return got

    got = asyncio.new_event_loop().run_until_complete(run())
    assert got[0] == "a" and "keepalive" in got[1]
    assert state["cancelled"] and state["closed"]
