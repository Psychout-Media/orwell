"""ORW-307 / ADR 0022 gates 3 and 5 - a reusable leak harness for EVERY per-houseguest model call.

Any call the FE (or, later, the engine) makes on behalf of ONE houseguest or ONE houseguest-pair scene (the 0070 texture lane today; a nightly
private reflection, scene wording or habits tomorrow) must be proven to carry only what THAT houseguest knows and to return data, not player-facing
text. This module holds the checks; a lane's test supplies a call recorder and the planted tokens.

Roles only (CLAUDE.md testing rule): tokens are opaque sentinel strings, never names.

The checks (each raises AssertionError with the call index and the offending token):
  * ``assert_call_inputs_scoped``  (gate 3a + 3b) - for EVERY call keep the (NPC, input) pairing; every planted token found in a call's input must be
    allowed for THAT call's NPC. A producer-only / Vault token (``allowed=None``) appears in NO call. A raw union of all inputs is never the assertion.
  * ``assert_output_is_data``      (gate 5 i) - a call's output validates against a declared data schema; any field the schema does not declare, any
    undeclared free text, and (for a ``strict`` schema) any prose at all is rejected.
  * ``assert_no_funnel_bleed``     (gate 5 iii) - a token private to NPC B's residual never reaches NPC A's line or any player-visible text.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

# token -> the set of NPC keys allowed to see it, or None for a producer-only / Vault token (allowed for nobody).
Tokens = dict


@dataclass
class Call:
    """One recorded per-NPC call: WHO it was made for, the messages it carried, and (optionally) what came back."""
    npc: str
    messages: list
    output: Any = None


@dataclass
class Recorder:
    """An llm_fn stand-in that records every call. ``npc_of`` maps the call's messages to the NPC (or scene) key it was built for - derived from the
    prompt's own public participant ids, NOT from the planted tokens, so the pairing the assertion relies on is independent of what it checks."""
    npc_of: Callable[[list], str]
    reply: Callable[[list], str] = lambda messages: "ok"
    calls: list = field(default_factory=list)

    async def __call__(self, messages: list) -> str:
        out = self.reply(messages)
        self.calls.append(Call(npc=self.npc_of(messages), messages=messages, output=out))
        return out


def input_text(messages: Iterable) -> str:
    """Everything a model call can read: every message's content (strings and text parts)."""
    parts = []
    for m in messages or []:
        c = m.get("content") if isinstance(m, dict) else m
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            parts.extend(p.get("text", "") for p in c if isinstance(p, dict))
        else:
            parts.append(json.dumps(c, default=str))
    return "\n".join(parts)


def assert_call_inputs_scoped(calls: list, tokens: Tokens) -> None:
    """Gate 3: per-call knowledge scope + the aggregate (NPC, input) fan-out check + producer-only tokens in no call."""
    assert calls, "no per-NPC calls were recorded - the harness proved nothing"
    for i, call in enumerate(calls):
        text = input_text(call.messages)
        for token, allowed in tokens.items():
            if token not in text:
                continue
            assert allowed is not None, f"call {i} (npc {call.npc!r}) carries the producer-only token {token!r}"
            assert call.npc in allowed, f"call {i} (npc {call.npc!r}) carries {token!r}, which only {sorted(allowed)} may know"


def assert_planted_tokens_reached_their_owner(calls: list, tokens: Tokens) -> None:
    """A positive control: every allowed token shows up in at least one call of an NPC allowed to see it. Without this a harness whose recorder
    silently dropped the planted scene would pass vacuously."""
    for token, allowed in tokens.items():
        if allowed is None:
            continue
        assert any(token in input_text(c.messages) and c.npc in allowed for c in calls), f"planted token {token!r} never reached any allowed call"


def assert_output_is_data(output: Any, schema: dict, *, strict: bool = False, max_text: int = 400) -> dict:
    """Gate 5 (i): the call's output is data under ``schema``.

    ``schema`` maps field -> one of: ``int``, ``float``, ``bool``, ``("enum", {values})``, ``("id",)`` (a short ``kind:n``-style id), or ``("text",)`` (one
    declared, bounded free-text field - refused when ``strict``, which is how a cognition call is checked: no prose at all). A JSON string output is parsed
    first. Any field not in the schema is rejected, and any string value that is not an enum/id is refused unless the field is declared ``text``."""
    data = json.loads(output) if isinstance(output, str) else output
    assert isinstance(data, dict), f"output is not a data object: {type(data).__name__}"
    extra = sorted(set(data) - set(schema))
    assert not extra, f"output carries undeclared fields {extra}"
    for key, spec in schema.items():
        if key not in data:
            continue
        v = data[key]
        if spec in (int, float):
            assert isinstance(v, (int, float)) and not isinstance(v, bool), f"{key} is not a number"
        elif spec is bool:
            assert isinstance(v, bool), f"{key} is not a bool"
        elif isinstance(spec, tuple) and spec[0] == "enum":
            assert v in spec[1], f"{key}={v!r} is not one of {sorted(spec[1])}"
        elif isinstance(spec, tuple) and spec[0] == "id":
            assert isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", v), f"{key} is not an id"
        elif isinstance(spec, tuple) and spec[0] == "text":
            assert not strict, f"{key} is free text, and a strict (cognition) call may emit no prose"
            assert isinstance(v, str) and len(v) <= max_text and "\n" not in v, f"{key} is not one bounded line of text"
        else:
            raise AssertionError(f"unknown schema spec for {key}: {spec!r}")
    return data


def assert_no_funnel_bleed(private_tokens: dict, lines_by_npc: dict, player_visible: Iterable[str]) -> None:
    """Gate 5 (iii): ``private_tokens`` maps token -> the ONE NPC whose cognition residual holds it. It may appear in that NPC's own line, and nowhere else:
    not in any other NPC's line, not in any player-visible text."""
    visible = list(player_visible)
    for token, owner in private_tokens.items():
        for npc, line in lines_by_npc.items():
            if npc != owner:
                assert token not in (line or ""), f"{token!r} (private to {owner!r}) bled into {npc!r}'s line"
        for j, text in enumerate(visible):
            assert token not in (text or ""), f"{token!r} (private to {owner!r}) reached player-visible text #{j}"
