"""ORW-1169 (plan 3.10): an invited houseguest who declines is named in the move line, so the story says who stayed and that they said no. Roles only; invented labels; no model."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

W = {"room": "kitchen", "present": [{"name": "GuestA RoleA"}], "nearby": [], "roomNames": {}}


def test_a_declined_invite_is_voiced():
    out = ch._whereabouts_barrier_directive(W, None, {"from": "living-room", "to": "kitchen", "declined": ["GuestB RoleB"]})
    assert "DECLINED THE INVITE" in out and "GuestB RoleB" in out and "do not write them in" in out
