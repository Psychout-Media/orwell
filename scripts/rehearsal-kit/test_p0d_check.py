import re, pathlib

SRC = (pathlib.Path(__file__).parent / "p0d_check.py").read_text()


def _verdict():
    start = SRC.index("def stale_beat_verdict"); end = SRC.index("try: ok409")
    ns = {"re": re}; exec(SRC[start:end], ns); return ns["stale_beat_verdict"]


def test_a_handful_of_reconciled_409s_passes_but_an_unreconciled_one_fails():
    v = _verdict()
    assert v("")[0]
    assert v("INFO reconciled a stale-beat 409 for user=u\n" * 3)[0]
    assert not v("POST 409 stale-beat refused\nINFO reconciled a stale-beat 409\n")[0]
    assert not v("INFO reconciled a stale-beat 409\n" * 6)[0]
