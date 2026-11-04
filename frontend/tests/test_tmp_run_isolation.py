"""Guard for the /tmp leak: the FE suite runs under a private per-process TMPDIR that is removed at exit (conftest.py)."""
import os
import tempfile


def test_tempdir_is_the_private_per_run_dir():
    assert os.path.basename(tempfile.gettempdir()).startswith("orwell-run-")
    d = tempfile.mkdtemp(prefix="orwell-leaky-test-")
    assert os.path.dirname(d) == tempfile.gettempdir()
