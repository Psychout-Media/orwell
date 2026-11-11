"""ORW-168: the post-turn `loadSessions()` (GET /api/sessions + sidebar re-render after EVERY turn) only runs while the session still has a
placeholder name the server will replace. Behavioural: the real `sessionMayNeedRename` is lifted out of sessions.js and run under node. Roles only."""
import os
import re
import shutil
import subprocess

import pytest

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")
SESS = open(os.path.join(JS, "sessions.js"), encoding="utf-8").read()
CHAT = open(os.path.join(JS, "chat.js"), encoding="utf-8").read()


def _fn():
    m = re.search(r"export function sessionMayNeedRename\(id\) \{.*?\n\}\n", SESS, re.S)
    assert m, "sessionMayNeedRename missing"
    return m.group(0).replace("export function", "function", 1)


@pytest.mark.skipif(not shutil.which("node"), reason="node unavailable")
def test_only_placeholder_names_need_the_refetch():
    prog = _fn() + """
let sessions = [
  { id: 'a', name: 'Season 2' }, { id: 'b', name: 'Casting interview' }, { id: 'c', name: 'Chat: 2026-11-11' },
  { id: 'd', name: 'model 10:42:07 AM' }, { id: 'e', name: '' }, { id: 'f', name: 'The Alliance' },
];
console.log(JSON.stringify(['a','b','c','d','e','f','zz'].map(sessionMayNeedRename)));
"""
    out = subprocess.run(["node", "-e", prog], capture_output=True, text=True, check=True).stdout.strip()
    # named -> skip; placeholder/unknown -> refetch
    assert out == "[false,true,true,true,true,false,true]"


def test_the_post_turn_refetch_is_gated_on_it():
    i = CHAT.index("ORW-168: only while the session still has a placeholder name")
    block = CHAT[i:i + 700]
    assert "sessionMayNeedRename" in block and "loadSessions()" in block
    assert "sessionMayNeedRename," in SESS  # exported on the module object
