"""ORW-223 part C, slice C1 - the scene-plan schema and the pure checker (no behavior change).

Nothing in the agent loop calls this yet (C2 will, in shadow mode). PURE: no I/O, no model call, no globals
mutated, no import of the agent loop. Same input, same output; the input is never mutated.

THE PLAN (plain dicts)::

    ScenePlan = {
      "participants": [engineId, ...],        # who is IN the scene (NPC ids; "player" is implicit and tolerated)
      "act": "talk"|"go-to-bed"|"move"|"ask-production"|"ooc"|"other",
      "effects": [Effect, ...],
      "note": "<=160 chars, optional",
    }
    Effect (discriminated by "type" - NOT "kind", because the record effect has its own "kind"):
      {"type": "record", "withIds": [id...], "kind": <RECORD_KINDS>, "consequence": {...}?}
          consequence is EXACTLY the engine's Vault-free descriptor (src/ports/EngineCommands.ts):
          {"edges": [{"toward": id, "direction": <DIRECTIONS>, "emphasis": <EMPHASES>?}],
           "aboutEdges": [{"holder": id, "about": id, "direction": ..., "emphasis": ...?}],
           "rationale": str?}   (no number ever; the engine owns the magnitude)
      {"type": "move", "who": "player"|npcId, "room": roomId}
      {"type": "deal-offer", "with": id, "kind": <DEAL_KINDS>, "terms": "<=120 chars"}
      {"type": "disclosure", "from": id, "factId": str}   # only a fact the ENGINE already surfaced this turn

THE VIEW (built by the caller from game_state / whereabouts; Vault-free)::

    {"present": [ids in the player's room], "awake": [ids not turned in], "known_ids": [all houseguest ids],
     "rooms": [room ids], "asleep": [ids], "pending": <open decision kind str> | None, "phase": str,
     "time_of_day": str, "surfaced_facts": [fact ids the engine surfaced this turn]}
    ("player" is always a known id. phase / time_of_day are carried for later slices; C1 rules do not read them.)

CHECKER CONTRACT: ``check_plan`` may only REJECT or TRIM. It never adds a participant, effect or field
(ADR 0005 / the owner's "error-correct the omission, never engine-author content"). The trimmed plan is a deep
subset of the input (strings may be whitespace-stripped / clipped). The ENGINE remains the final authority at commit:
this module does NOT check that an NPC's move is adjacent/possible, that a deal is legal now, or that a record
passes the witness rules; it only drops what is plainly illegal against the small view.

REJECTION CODES (stable): plan-shape, effect-shape, unknown-id, participant-absent, participant-asleep,
effect-kind, effect-outside-scene, effect-empty, unknown-room, record-kind, deal-kind, disclosure-not-rolled,
closed-set-claim, pending-blocks-effects, ooc-no-effects.
Rule order: shape -> participants (unknown-id, asleep, absent) -> act gates (ooc / go-to-bed+pending) -> per effect
(kind whitelist, ids, per-kind rules, closed-set text) -> note.

CLOSED-SET WORD LIST (conservative, word-boundary): "nominated", "evicted", "voted to evict", "vetoed",
"the winner", "wins/won the (competition|comp|HOH|head of household|veto|power|POV)". DECISION: a bare "won" does
NOT fire ("won the argument", "won her over" are ordinary talk); only a win of a closed-set prize does. The cost of a
false positive is one dropped effect / blanked note, so "nominated"/"evicted" fire even in hypotheticals.
"""
from __future__ import annotations

import copy
import json
import re
from typing import Any, NamedTuple, Optional

ACTS = ("talk", "go-to-bed", "move", "ask-production", "ooc", "other")
EFFECT_TYPES = ("record", "move", "deal-offer", "disclosure")
RECORD_KINDS = ("bonding", "betrayal", "conflict", "strategy", "alliance", "gossip", "showmance")
DIRECTIONS = ("warmer", "cooler", "more-trust", "less-trust", "more-threatened", "less-threatened",
              "more-aligned", "less-aligned")
EMPHASES = ("slight", "notable", "strong")
DEAL_KINDS = ("safety", "vote", "final-two", "target-other", "comp-throw", "veto-save", "protect-third",
              "conditional", "information")

PLAYER = "player"
NOTE_MAX = 160
TERMS_MAX = 120
RATIONALE_MAX = 200
CONTENT_MAX = 2000
ID_MAX = 64
MAX_PARTICIPANTS = 8
MAX_EFFECTS = 6
MAX_EDGES = 8

_CLOSED_SET_RE = re.compile(
    r"\b(?:nominated|evicted|voted\s+to\s+evict|vetoed|the\s+winner"
    r"|(?:won|wins)\s+the\s+(?:competition|comp|hoh|head\s+of\s+household|veto|power|pov))\b",
    re.IGNORECASE,
)


class PlanVerdict(NamedTuple):
    plan_trimmed: Optional[dict]
    rejections: list


def states_closed_set_outcome(text: object) -> bool:
    return isinstance(text, str) and _CLOSED_SET_RE.search(text) is not None


# ----------------------------------------------------------------------------------------------- shape

def _clip(s: object, n: int) -> Optional[str]:
    if not isinstance(s, str):
        return None
    t = re.sub(r"\s+", " ", s).strip()
    return t[:n].strip() or None


def _id(v: object) -> Optional[str]:
    return _clip(v, ID_MAX)


def _id_list(v: object, cap: int) -> Optional[list]:
    if not isinstance(v, list):
        return None
    out: list = []
    for x in v:
        i = _id(x)
        if i is not None and i not in out:
            out.append(i)
        if len(out) >= cap:
            break
    return out


def _norm_consequence(c: object) -> Optional[dict]:
    if not isinstance(c, dict):
        return None
    out: dict = {}
    edges = []
    for e in c.get("edges") if isinstance(c.get("edges"), list) else []:
        if not isinstance(e, dict):
            continue
        toward, direction = _id(e.get("toward")), e.get("direction")
        if toward is None or direction not in DIRECTIONS:
            continue
        item = {"toward": toward, "direction": direction}
        if e.get("emphasis") in EMPHASES:
            item["emphasis"] = e["emphasis"]
        edges.append(item)
        if len(edges) >= MAX_EDGES:
            break
    if edges:
        out["edges"] = edges
    about = []
    for e in c.get("aboutEdges") if isinstance(c.get("aboutEdges"), list) else []:
        if not isinstance(e, dict):
            continue
        holder, ab, direction = _id(e.get("holder")), _id(e.get("about")), e.get("direction")
        if holder is None or ab is None or direction not in DIRECTIONS:
            continue
        item = {"holder": holder, "about": ab, "direction": direction}
        if e.get("emphasis") in EMPHASES:
            item["emphasis"] = e["emphasis"]
        about.append(item)
        if len(about) >= MAX_EDGES:
            break
    if about:
        out["aboutEdges"] = about
    r = _clip(c.get("rationale"), RATIONALE_MAX)
    if r:
        out["rationale"] = r
    return out or None


def _norm_effect(e: object) -> tuple:
    """-> (effect | None, problem | None). Unknown types are KEPT (type only) so the checker can reject them."""
    if not isinstance(e, dict):
        return None, "not an object"
    t = _clip(e.get("type"), 32)
    if t is None:
        return None, "missing type"
    if t not in EFFECT_TYPES:
        return {"type": t}, None
    if t == "record":
        ids = _id_list(e.get("withIds"), MAX_PARTICIPANTS)
        if ids is None:
            return None, "record: withIds must be a list"
        out: dict = {"type": t, "withIds": ids}
        if isinstance(e.get("kind"), str):
            out["kind"] = _clip(e["kind"], 32) or ""
        cons = _norm_consequence(e.get("consequence"))
        if cons:
            out["consequence"] = cons
        if isinstance(e.get("content"), str) and e["content"].strip():  # C5: the free text of the record (checked for closed-set claims)
            out["content"] = e["content"].strip()[:CONTENT_MAX]
        return out, None
    if t == "move":
        who, room = _id(e.get("who")), _id(e.get("room"))
        if who is None or room is None:
            return None, "move: needs who and room"
        return {"type": t, "who": who, "room": room}, None
    if t == "deal-offer":
        w, k = _id(e.get("with")), _clip(e.get("kind"), 32)
        if w is None or k is None:
            return None, "deal-offer: needs with and kind"
        out = {"type": t, "with": w, "kind": k}
        terms = _clip(e.get("terms"), TERMS_MAX)
        if terms:
            out["terms"] = terms
        return out, None
    f, fid = _id(e.get("from")), _id(e.get("factId"))
    if f is None or fid is None:
        return None, "disclosure: needs from and factId"
    return {"type": t, "from": f, "factId": fid}, None


def normalize_plan(raw: object) -> tuple:
    """Shape/type validation. -> (plan | None, [problem str]). Unknown keys dropped, strings clipped, never raises."""
    problems: list = []
    if not isinstance(raw, dict):
        return None, ["plan is not an object"]
    parts = _id_list(raw.get("participants"), MAX_PARTICIPANTS)
    if parts is None:
        return None, ["participants must be a list"]
    act = raw.get("act")
    if act not in ACTS:
        return None, [f"act must be one of {list(ACTS)}"]
    effects: list = []
    raw_effects = raw.get("effects", [])
    if not isinstance(raw_effects, list):
        problems.append("effects must be a list")
        raw_effects = []
    for i, e in enumerate(raw_effects[:MAX_EFFECTS]):
        ne, prob = _norm_effect(e)
        if ne is None:
            problems.append(f"effects[{i}]: {prob}")
        else:
            effects.append(ne)
    plan: dict = {"participants": parts, "act": act, "effects": effects}
    note = _clip(raw.get("note"), NOTE_MAX)
    if note:
        plan["note"] = note
    return plan, problems


# ------------------------------------------------------------------------------------------------ parse

def _balanced_end(text: str, s: int) -> int:
    """Index of the brace that closes the object opening at ``s`` (string-aware), or -1."""
    depth, in_str, esc = 0, False, False
    for j in range(s, len(text)):
        ch = text[j]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return j
    return -1


def _last_object(reply: str) -> Optional[dict]:
    """The LAST top-level brace-balanced JSON object that parses (reasoning prefix / fence / trailing text
    tolerated; objects nested inside an earlier object do not count as separate answers)."""
    text, i, last = reply or "", 0, None
    while True:
        i = text.find("{", i)
        if i < 0:
            return last
        j = _balanced_end(text, i)
        if j > 0:
            try:
                obj = json.loads(text[i:j + 1])
            except ValueError:
                obj = None
            if isinstance(obj, dict):
                last, i = obj, j + 1
                continue
        i += 1


def parse_plan(raw: object) -> tuple:
    """Model reply (str) or an already-parsed dict -> (plan | None, [problem]). Never raises. A missing `act`
    is not coerced: a plan that does not say what the player's act was is not a plan."""
    try:
        obj = raw if isinstance(raw, dict) else _last_object(raw if isinstance(raw, str) else "")
        if obj is None:
            return None, ["no JSON object found"]
        return normalize_plan(obj)
    except Exception as e:  # pure + total: a parser must never take the turn down
        return None, [f"parse error: {type(e).__name__}"]


# ----------------------------------------------------------------------------------------------- checker

def check_plan(plan: object, view: object) -> PlanVerdict:
    """Trim/reject a plan against a Vault-free view (shape in the module docstring). Never adds, never mutates."""
    v = view if isinstance(view, dict) else {}

    def S(k: str) -> set:
        x = v.get(k)
        return {i for i in x if isinstance(i, str)} if isinstance(x, (list, tuple, set)) else set()

    present, awake, known, rooms = S("present"), S("awake"), S("known_ids") | {PLAYER}, S("rooms")
    asleep, surfaced = S("asleep"), S("surfaced_facts")
    pending = v.get("pending") if isinstance(v.get("pending"), str) and v.get("pending") else None

    rej: list = []

    def R(code: str, path: str, detail: str) -> None:
        rej.append({"code": code, "path": path, "detail": detail})

    norm, problems = normalize_plan(copy.deepcopy(plan))
    if norm is None:
        R("plan-shape", "", "; ".join(problems))
        return PlanVerdict(None, rej)
    for p in problems:
        R("effect-shape", "effects", p)

    # participants
    kept: list = []
    for i, pid in enumerate(norm["participants"]):
        path = f"participants[{i}]"
        if pid not in known:
            R("unknown-id", path, pid)
        elif pid != PLAYER and (pid in asleep or (pid in present and pid not in awake)):
            R("participant-asleep", path, pid)
        elif pid != PLAYER and pid not in present:
            R("participant-absent", path, pid)
        else:
            kept.append(pid)
    scene = set(kept)

    def scene_ok(i: str, path: str, allow_player: bool = True) -> bool:
        """An id an effect depends on must be known, awake, and in the scene."""
        if i not in known:
            R("unknown-id", path, i)
            return False
        if i == PLAYER:
            if not allow_player:
                R("effect-outside-scene", path, "the player cannot be the target here")
            return allow_player
        if i in asleep or (i in present and i not in awake):
            R("participant-asleep", path, i)
            return False
        if i not in scene:
            R("effect-outside-scene", path, i)
            return False
        return True

    effects_in = norm["effects"]
    out_effects: list = []
    if norm["act"] == "ooc":
        if effects_in:
            R("ooc-no-effects", "effects", f"{len(effects_in)} effect(s) dropped")
        effects_in = []
    elif norm["act"] == "go-to-bed" and pending is not None:
        if effects_in:
            R("pending-blocks-effects", "effects", f"decision '{pending}' is open; {len(effects_in)} effect(s) dropped")
        effects_in = []

    for idx, e in enumerate(effects_in):
        ep = f"effects[{idx}]"
        t = e["type"]
        if t not in EFFECT_TYPES:
            R("effect-kind", ep, t)
            continue
        if t == "record":
            ids = []
            for j, i in enumerate(e["withIds"]):
                if scene_ok(i, f"{ep}.withIds[{j}]"):
                    ids.append(i)
            if not e["withIds"] or not [i for i in ids if i != PLAYER]:
                R("effect-empty", ep, "no legal participant left")
                continue
            if len(ids) != len(e["withIds"]):
                continue  # already reported per id; a record naming people outside the scene is dropped whole
            if "kind" in e and e["kind"] not in RECORD_KINDS:
                R("record-kind", f"{ep}.kind", e["kind"])
                continue
            out = {"type": t, "withIds": ids}
            if "kind" in e:
                out["kind"] = e["kind"]
            cons = _check_consequence(e.get("consequence"), f"{ep}.consequence", known, scene_ok, R)
            if cons:
                out["consequence"] = cons
            if "consequence" in out and states_closed_set_outcome(out["consequence"].get("rationale")):
                R("closed-set-claim", f"{ep}.consequence.rationale", "closed-set outcome stated")
                del out["consequence"]["rationale"]
                if not out["consequence"]:
                    del out["consequence"]
            if "content" in e:
                kept_text = _without_closed_set_sentences(e["content"])
                if kept_text != e["content"]:
                    R("closed-set-claim", f"{ep}.content", "closed-set outcome stated")
                if kept_text:
                    out["content"] = kept_text
            out_effects.append(out)
        elif t == "move":
            if not scene_ok(e["who"], f"{ep}.who"):
                continue
            if e["room"] not in rooms:
                R("unknown-room", f"{ep}.room", e["room"])
                continue
            out_effects.append(dict(e))
        elif t == "deal-offer":
            if not scene_ok(e["with"], f"{ep}.with", allow_player=False):
                continue
            if e["kind"] not in DEAL_KINDS:
                R("deal-kind", f"{ep}.kind", e["kind"])
                continue
            if states_closed_set_outcome(e.get("terms")):
                R("closed-set-claim", f"{ep}.terms", "closed-set outcome stated")
                continue
            out_effects.append(dict(e))
        else:  # disclosure
            if not scene_ok(e["from"], f"{ep}.from", allow_player=False):
                continue
            if e["factId"] not in surfaced:
                R("disclosure-not-rolled", f"{ep}.factId", e["factId"])
                continue
            out_effects.append(dict(e))

    trimmed: dict = {"participants": kept, "act": norm["act"], "effects": out_effects}
    if "note" in norm:
        if states_closed_set_outcome(norm["note"]):
            R("closed-set-claim", "note", "closed-set outcome stated")
        else:
            trimmed["note"] = norm["note"]
    return PlanVerdict(trimmed, rej)


# A sentence that talks ABOUT a possible outcome (a worry, a guess, a plan) is scene texture, not a stated result: recorded
# strategy chatter is full of "afraid she'll be nominated". Only content is exempted; note / rationale / terms stay strict.
_IRREALIS_RE = re.compile(
    r"\b(?:might|may|could|would|will|going\s+to|gonna|if|whether|who|afraid|worried|scared|fear\w*|wonder\w*|"
    r"hope\w*|plan\w*|think\w*|guess\w*|rumou?r\w*|chance|risk|threat\w*)\b|'ll\b", re.IGNORECASE)


def _without_closed_set_sentences(text: str) -> str:
    """Drop the sentences that ASSERT a closed-set outcome from record content (a trim: what remains is a subset of the
    input, in order). A sentence that only speculates about one (`_IRREALIS_RE`) is kept."""
    if not states_closed_set_outcome(text):
        return text
    parts = re.split(r"(?<=[.!?])\s+", text)
    return " ".join(x for x in parts if not (states_closed_set_outcome(x) and not _IRREALIS_RE.search(x))).strip()


def _check_consequence(c: object, path: str, known: set, scene_ok, R) -> Optional[dict]:
    if not isinstance(c, dict):
        return None
    out: dict = {}
    edges = []
    for k, e in enumerate(c.get("edges", [])):
        if scene_ok(e["toward"], f"{path}.edges[{k}].toward", allow_player=False):
            edges.append(e)
    if edges:
        out["edges"] = edges
    about = []
    for k, e in enumerate(c.get("aboutEdges", [])):
        p = f"{path}.aboutEdges[{k}]"
        if not scene_ok(e["holder"], f"{p}.holder", allow_player=False):
            continue
        if e["about"] not in known:  # the third party may be elsewhere in the house, but must exist
            R("unknown-id", f"{p}.about", e["about"])
            continue
        about.append(e)
    if about:
        out["aboutEdges"] = about
    if "rationale" in c:
        out["rationale"] = c["rationale"]
    return out or None


# ------------------------------------------------------------------------------------------ JSON schema

def plan_to_json_schema() -> dict:
    """JSON-schema for a constrained-JSON plan call. Kept in sync with ``normalize_plan`` by a test."""
    sid = {"type": "string", "maxLength": ID_MAX}
    edge = {"type": "object", "additionalProperties": False, "required": ["toward", "direction"],
            "properties": {"toward": sid, "direction": {"enum": list(DIRECTIONS)},
                           "emphasis": {"enum": list(EMPHASES)}}}
    about = {"type": "object", "additionalProperties": False, "required": ["holder", "about", "direction"],
             "properties": {"holder": sid, "about": sid, "direction": {"enum": list(DIRECTIONS)},
                            "emphasis": {"enum": list(EMPHASES)}}}
    consequence = {"type": "object", "additionalProperties": False, "properties": {
        "edges": {"type": "array", "maxItems": MAX_EDGES, "items": edge},
        "aboutEdges": {"type": "array", "maxItems": MAX_EDGES, "items": about},
        "rationale": {"type": "string", "maxLength": RATIONALE_MAX}}}
    effects = [
        {"type": "object", "additionalProperties": False, "required": ["type", "withIds"],
         "properties": {"type": {"const": "record"},
                        "withIds": {"type": "array", "maxItems": MAX_PARTICIPANTS, "items": sid},
                        "kind": {"enum": list(RECORD_KINDS)}, "consequence": consequence,
                        "content": {"type": "string", "maxLength": CONTENT_MAX}}},
        {"type": "object", "additionalProperties": False, "required": ["type", "who", "room"],
         "properties": {"type": {"const": "move"}, "who": sid, "room": sid}},
        {"type": "object", "additionalProperties": False, "required": ["type", "with", "kind"],
         "properties": {"type": {"const": "deal-offer"}, "with": sid, "kind": {"enum": list(DEAL_KINDS)},
                        "terms": {"type": "string", "maxLength": TERMS_MAX}}},
        {"type": "object", "additionalProperties": False, "required": ["type", "from", "factId"],
         "properties": {"type": {"const": "disclosure"}, "from": sid, "factId": sid}},
    ]
    return {"type": "object", "additionalProperties": False, "required": ["participants", "act", "effects"],
            "properties": {
                "participants": {"type": "array", "maxItems": MAX_PARTICIPANTS, "items": sid},
                "act": {"enum": list(ACTS)},
                "effects": {"type": "array", "maxItems": MAX_EFFECTS, "items": {"oneOf": effects}},
                "note": {"type": "string", "maxLength": NOTE_MAX}}}


# ------------------------------------------------------------------------------------ C5: the extraction gate

class SceneGate(NamedTuple):
    """The trimmed scene-record proposal. ``dropped`` => record nothing. ``content`` None => the caller's own default
    sentence (the content was empty or entirely closed-set claims). ``trimmed`` is True when ANYTHING was removed."""
    dropped: bool
    ids: list
    content: Optional[str]
    consequence: Optional[dict]
    codes: list
    trimmed: bool


def _rej_index(path: str, key: str) -> Optional[int]:
    m = re.search(r"\.consequence\." + key + r"\[(\d+)\]", path)
    return int(m.group(1)) if m else None


def gate_scene_record(ids: list, kind: str, content: Optional[str], consequence: Optional[dict], view: object,
                      act: str = "talk") -> SceneGate:
    """ORW-223 C5: run the C1 checker over the scene extraction (``withIds``/kind/content/consequence the merged
    or separate extraction proposed) BEFORE it is recorded. TRIM ONLY, never add: illegal participants are dropped
    (unlike a model plan, an extraction record is trimmed to its legal participants rather than dropped whole), a
    record left with no NPC is dropped, closed-set claims leave the free text, and everything else is returned as
    the ORIGINAL objects (byte-identical when nothing is rejected). Pure, total (a checker fault returns the input
    unchanged: the gate is an extra filter, never a precondition). The first MAX_PARTICIPANTS ids are checked;
    any beyond are passed through untouched."""
    try:
        head, tail = list(ids[:MAX_PARTICIPANTS]), list(ids[MAX_PARTICIPANTS:])
        cons = consequence if isinstance(consequence, dict) else {}
        extra = [x for k, f in (("edges", "toward"), ("aboutEdges", "holder")) for e in (cons.get(k) or [])
                 if isinstance(e, dict) and isinstance(e.get(f), str) for x in [e[f]]]
        parts = list(dict.fromkeys(head + extra))[:MAX_PARTICIPANTS]
        v1 = check_plan({"participants": parts, "act": act, "effects": []}, view)
        if v1.plan_trimmed is None:
            return SceneGate(False, list(ids), content, consequence, [], False)
        kept = v1.plan_trimmed["participants"]
        codes = [r["code"] for r in v1.rejections]
        legal = [i for i in head if i in kept]
        eff: dict = {"type": "record", "withIds": legal, "kind": kind}
        if consequence:
            eff["consequence"] = copy.deepcopy(consequence)
        if content:
            eff["content"] = content
        v2 = check_plan({"participants": kept, "act": act, "effects": [eff]}, view)
        codes += [r["code"] for r in v2.rejections]
        out_eff = (v2.plan_trimmed or {}).get("effects") or []
        if not out_eff:
            return SceneGate(True, [], None, None, codes or ["effect-empty"], True)
        new_content, new_cons = content, consequence
        if any(r["path"].endswith(".content") for r in v2.rejections):
            new_content = out_eff[0].get("content")
        if consequence and any(".consequence." in r["path"] for r in v2.rejections):
            new_cons = copy.deepcopy(consequence)
            for key in ("edges", "aboutEdges"):
                drop = {_rej_index(r["path"], key) for r in v2.rejections}
                if key in new_cons:
                    new_cons[key] = [e for n, e in enumerate(new_cons[key]) if n not in drop]
                    if not new_cons[key]:
                        del new_cons[key]
            if any(r["path"].endswith("consequence.rationale") for r in v2.rejections):
                new_cons.pop("rationale", None)
            if not new_cons.get("edges") and not new_cons.get("aboutEdges"):
                new_cons = None
        return SceneGate(False, legal + tail, new_content, new_cons, codes, bool(codes))
    except Exception:
        return SceneGate(False, list(ids), content, consequence, [], False)
