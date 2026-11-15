"""ORW-406: a tiny "is a turn in flight?" signal for the updater.

The updater (root) reads <data>/turns-in-flight just before it restarts the services, and waits (bounded)
until it says 0. The file holds one integer: the number of chat streams currently registered. It carries no
game or chat content. Best-effort: a write failure never affects a turn.
"""
import os
from typing import Any

from src.constants import DATA_DIR

SIGNAL_NAME = "turns-in-flight"


def signal_path() -> str:
    return os.path.join(os.environ.get("ORWELL_INFLIGHT_DIR") or DATA_DIR, SIGNAL_NAME)


def publish_inflight(count: int) -> None:
    path = signal_path()
    tmp = f"{path}.tmp{os.getpid()}"
    try:
        with open(tmp, "w") as fh:
            fh.write(f"{int(count)}\n")
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


class InflightRegistry(dict):
    """A dict of active streams that republishes its size whenever a stream is added or removed."""

    def _publish(self) -> None:
        publish_inflight(len(self))

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        self._publish()

    def __delitem__(self, key: Any) -> None:
        super().__delitem__(key)
        self._publish()

    def pop(self, *args: Any) -> Any:
        had = args[0] in self
        out = super().pop(*args)
        if had:
            self._publish()
        return out

    def clear(self) -> None:
        super().clear()
        self._publish()
