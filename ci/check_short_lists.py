#!/usr/bin/env python3
"""ORW-511: the short-list guard. Fails when the code gains
  (a) a string list that feeds a random / hash / modulo pick and has fewer than LIMIT items, or
  (b) an example line ("e.g.", "for example", "such as") or a closed menu inside a STRING (prompt text),
unless ci/short_list_allowlist.json carries an entry for it with an owner and a written reason. See ci/short_list_scan.py for exactly what is detected.

An allowlist entry is {path, kind, name, max, owner, reason}: `max` is a ceiling on how many hits of that kind/name the file may hold (text hits use name "text"),
so a NEW example in an already-listed file still fails. An owner's PR removes its entries as it fixes the sites; an entry whose ceiling is above the real count is
reported (not failed) so the ratchet is visibly loose. Usage: check_short_lists.py [--list] [--write-allowlist] (exit 1 on a violation)."""
from __future__ import annotations

import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import short_list_scan as S  # noqa: E402

ALLOWLIST = S.ROOT / "ci" / "short_list_allowlist.json"
MIN_REASON = 20

# Seed rules for --write-allowlist: first match wins. (path regex, kind or "*", owner, reason)
OWNER_RULES = [
    (r"^src/engine/(characterFactory|deepProfile|characters|castGenesis|genesisConstants|diversityConstants|seededRelationships)\.ts$|^src/domain/", "list", "ORW-508", "cast and character pool (ORW-508 audit); moves to world tables / per-person authoring"),
    (r"^frontend/src/orwell_facet_ledger\.py$", "*", "ORW-508", "front-end facet ledger menu (ORW-508 audit C27)"),
    (r"^frontend/src/orwell_(cast_authoring|cast_genesis)\.py$", "*", "ORW-480", "cast-text authoring prompt and tables, rewritten by the ORW-480 PRs"),
    (r"^frontend/src/orwell_portrait|^src/engine/(portraitPrompts|imageConstants)\.ts$", "*", "ORW-480", "photo track: portrait prompt tables and shot brief"),
    (r"^src/engine/(alliances|confessionals|zeitgeist|reserveTwists)\.ts$", "*", "ORW-509", "world-side list (alliance names, confessional fallbacks, world snapshot, twist pool)"),
    (r"^src/engine/momentPrompts\.ts$|^frontend/src/agent_loop\.py$", "*", "ORW-510", "live narrator / moment prompt text"),
    (r"^src/engine/producerPersona\.ts$", "list", "ORW-511", "component of a composed floor: each producer field is a first clause (5-6) times a second clause (8) drawn on its own, and the live writer overlay authors the real persona"),
    (r"^src/engine/(dealConsent|juryMinds)\.ts$", "list", "ORW-511", "mechanics: internal key order or archetype keys, never shown to a player"),
    (r"^frontend/(mcp_servers|routes/email|src/document_processor)", "list", "ORW-511", "mechanics: file/folder/model name candidates tried in order, never shown to a player"),
    (r"^frontend/src/orwell_cast_identity\.py$", "menu", "ORW-511", "closed by design: structural enumerations the response validator checks (gender, orientation); not an example the model copies"),
    (r"^src/adapters/mcp/McpServer\.ts$", "menu", "ORW-511", "closed by design: tool argument schema message, not model-visible prose"),
    (r"^frontend/(static/js|src/(tool_|deep_research|teacher|visual|integrations|ai_interaction|youtube|chroma|goal|task_|memory)|routes|services|core|mcp_servers|app\.py|setup\.py|src/orwell_open)", "*", "ORW-511", "non-game assistant/admin surface (tool schemas, settings hints, route help) by path: not creative text for the game player; ORW-511 sweeps these for copyable examples as they are touched"),
    (r"^src/adapters/mcp/", "*", "ORW-511", "tool schema text, not game prose"),
]


# Per-site review (ORW-511). A text site of an ORW-511 entry gets its own one-line reason: first matching rule on the text around the marker, then the path.
# (ctx regex, reason). Every reason says what the example IS and why it cannot teach a game player's text a stock phrase.
SITE_RULES = [
    (r"e\.g\. (?:'|`)?(?:Qwen|vllm|gpu|ajax|serve-|cookbook-|minimax|cyankiwi|user@)|vllm serve|repo_id|tmux session", "assistant tool schema: a model/host/session identifier format for a local-model admin tool; format sample, no prose to imitate"),
    (r"glob|\*\*/|\*\.py|\*\.ts|\*Q4", "assistant tool schema: a file-glob pattern sample for a file-search tool; syntax, not prose"),
    (r"example\.com|https?://|imap\.|smtp\.|api\.openai|api\.deepseek|localhost|100\.x|you@gmail|user@example|Gmail|Proton Mail|Miniflux|Gitea|/v1/|/api/", "assistant/admin text: a URL, host or account-name format hint for an integration form or tool; not game text"),
    (r"npc:\d|houseguest id|told-by|overheard", "game tool schema: the id/pathway FORMAT of an engine key (npc:N, overheard); a closed identifier format, not creative text"),
    (r"kitchen, living-room", "game tool schema: the real room ids the engine accepts (a closed set the engine validates); a fact list, not a sample line"),
    (r"warms one and threatens another", "game tool schema: says WHEN to use per-edge consequences (a rule's trigger case), not a line the narrator repeats"),
    (r"RRULE|FREQ=|reminder 5 min|HH:MM|0\.0-1\.0|Semver|1\.0\.0|#1a1a2e|hex", "assistant tool schema: a data-format sample (date rule, time, version, colour) for a non-game tool"),
    (r"yellow|Work, Research|Work” or|“Work|label for this account", "assistant UI hint: a label placeholder in a settings/session form; user-typed, never model-copied game text"),
    (r"Alice lives|Bob works|query one|YES —|NO —|Best for small|Install X|sub_questions|Quick Guide|Option A", "general-assistant research/memory prompt: a JSON or report-format sample for non-game output (research reports, memory facts)"),
    (r"Good examples|Bad examples|Examples: payment due|Examples: payment|court summons", "general-assistant classifier prompt (memory or email triage): labelled category samples for non-game text"),
    (r"Call with Sam|Flight to Berlin|NRT|Narita|WHAT \(e\.g\.|writing style|WRITING STYLE|acknowledge the invoice|instructions written inside|cancel, move", "email-assistant prompt (calendar extraction / reply drafting): real-world email examples for a non-game assistant feature"),
    (r"\"action\": \"create\"|\"urgency\"|\"verdict\"|\"schedule\": \"daily\"|output_target|needs_work", "assistant JSON schema: a closed enum the response parser validates (verdict, urgency, schedule); structure, not an example"),
    (r"genderPresentation|orientation", "closed by design: structural enumerations the cast-identity response validator checks; not an example the model copies"),
    (r"kind: 'safe'", "closed by design: tool-argument validation message for a closed set (safe/vote/loyal), never model-visible prose"),
    (r"skill|when_to_use|metadata|tags such as|network, installation|sample input|sample data|no document/email|nothing the skill", "skill-authoring prompt for the assistant's skill library (non-game): samples of skill triggers, tags and test inputs"),
    (r"hostnames or IPs|/home/<user>|gpu-box|placeholders|env_prefix|source ~/|docker compose|libcudart|CUDA_HOME|:Q4_K_M|cuda", "operator/error message: a sample command, path or host for an admin hint; developer-facing, not player text"),
    (r"newline|control character|cron|mid-run|ORWELL_INPROCESS|ChromaDB|base_url|sensitive directory|provide a single URL|tool name required|path is required|allowlisted binary|fence tag|tool use", "developer error or log message with a usage sample; shown to an operator or tool-calling model, never to a game player"),
    (r"Apple form conventions|opened via window|future renders|saved\.id|display:none|tokenRows|code>http|Examples: <code>", "code or markup comment captured inside a template string (not model-visible); no creative text"),
    (r"deeply research|aspects matter most|deep web research", "general-assistant research prompt: asks clarifying questions with sample topics; non-game feature"),
    (r"summarize unread email|describe the task in plain chat|Paste your local endpoint", "assistant onboarding hint in the slash-command setup flow: a sample the user may type; not model output"),
    (r"leave 1h early|pre-tagged|future events|03:45|timestamps|chat-title markdown|Chat\]\(#session|bgEffect|bgPattern|accentError|bgPattern", "assistant formatting rule: a sample of timestamp, link or theme-parameter syntax for a non-game feature"),
    (r"\"rational\"|goal-based|exactly these fields", "general-assistant goal-extraction prompt: a JSON field sample for a non-game memory feature"),
    (r"Payload template|Webhook channel", "assistant integrations help: a webhook payload-template format sample; developer-facing"),
    (r"genuinely solve the user|did NOT genuinely", "skill-teacher prompt for the assistant's skill library: a verification rule with a sample case; non-game"),
    (r"self-close|no-op if|no session_id", "code comment captured inside the HTML report template string (not model-visible); no creative text"),
    (r"safety this week|a comp throw", "FIXED in this PR: replaced by a rule (name the concrete thing asked)"),
]
PATH_FALLBACK = [
    (r"^frontend/static/js/", "front-end UI hint text shown to the user in a settings or admin form; not game output and not model-visible"),
    (r"^frontend/src/tool_(schemas|index|implementations|execution)\.py$", "assistant tool description or error: a usage sample for a tool-calling model in the general assistant, not game prose"),
    (r"^frontend/(routes|services|mcp_servers|core|app\.py|setup\.py)", "assistant/admin server text (route help, prompt for a non-game feature, log or error message)"),
]
LIST_DECISIONS = {
    ("src/engine/producerPersona.ts", "PRODUCER_DISPOSITIONS"): "(a) YES live: the producer is authored once per season start by the utility model (frontend/src/orwell_producer_authoring.py run_authoring, with seeded letter anchors); this list is the offline floor only, composed with a second clause (6 x 8)",
    ("src/engine/producerPersona.ts", "PRODUCER_WITS"): "(a) YES live (orwell_producer_authoring.py); offline floor, composed (6 x 8)",
    ("src/engine/producerPersona.ts", "PRODUCER_QUIRKS"): "(a) YES live (orwell_producer_authoring.py); offline floor, composed (6 x 8)",
    ("src/engine/producerPersona.ts", "PRODUCER_BACKSTORIES"): "(a) YES live (orwell_producer_authoring.py); offline floor, composed (5 x 8)",
    ("src/engine/producerPersona.ts", "PRODUCER_DISPOSITION_TAILS"): "(a) YES live; second clause of the offline floor for disposition",
    ("src/engine/producerPersona.ts", "PRODUCER_WIT_TAILS"): "(a) YES live; second clause of the offline floor for wit",
    ("src/engine/producerPersona.ts", "PRODUCER_QUIRK_TAILS"): "(a) YES live; second clause of the offline floor for quirk",
    ("src/engine/producerPersona.ts", "PRODUCER_BACKSTORY_TAILS"): "(a) YES live; second clause of the offline floor for backstory",
    ("src/engine/dealConsent.ts", "order"): "not player text: the tie-break order of five internal drag keys when scoring a deal; no authoring needed",
    ("src/engine/juryMinds.ts", "all"): "not player text: the five juror archetype keys scored and sorted; a closed enum, not a pick",
}


def site_reason(h: "S.Hit") -> str:
    for rx, reason in SITE_RULES:
        if re.search(rx, h.ctx, re.I):
            return reason
    for rx, reason in PATH_FALLBACK:
        if re.search(rx, h.path):
            return reason
    return "UNREVIEWED"


def load_allowlist() -> list[dict]:
    return json.loads(ALLOWLIST.read_text(encoding="utf8"))["entries"]


def counts(hits: list[S.Hit]) -> dict[tuple[str, str, str], int]:
    c: dict[tuple[str, str, str], int] = collections.Counter()
    for h in hits:
        name = h.name if h.kind == "list" else "text"
        c[(h.path, h.kind, name)] += 1
    return c


def check(hits: list[S.Hit], entries: list[dict]) -> tuple[list[str], list[str]]:
    """(violations, loose-ceiling notes)."""
    bad: list[str] = []
    notes: list[str] = []
    allowed = {(e["path"], e["kind"], e["name"]): e for e in entries}
    for e in entries:
        if len(str(e.get("reason", "")).strip()) < MIN_REASON or not e.get("owner"):
            bad.append(f"allowlist entry {e.get('path')}:{e.get('kind')}:{e.get('name')} needs an owner and a written reason (>= {MIN_REASON} chars)")
    got = counts(hits)
    lines = collections.defaultdict(list)
    for h in hits:
        lines[(h.path, h.kind, h.name if h.kind == "list" else "text")].append(h.line)
    for key, n in sorted(got.items()):
        e = allowed.get(key)
        where = f"{key[0]}:{','.join(map(str, lines[key][:6]))}"
        if e is None:
            what = {"list": f"string list {key[2]!r} dealt from with fewer than {S.LIMIT} items", "example": "example line inside prompt text", "menu": "closed menu inside prompt text"}[key[1]]
            fix = ("author it per moment from the game's facts or compose it from independent parts so the floor is wide, then it needs no entry" if key[1] == "list"
                   else "state the quality wanted as a rule instead of a sample the model will copy")
            bad.append(f"{where}: new {what}. Fix: {fix}; or add an entry to ci/short_list_allowlist.json with an owner and a reason.")
        elif n > int(e["max"]):
            bad.append(f"{where}: {n} hit(s), allowlist ceiling is {e['max']} (owner {e['owner']}); a NEW one was added. Fix it as above, do not raise the ceiling.")
    for key, e in allowed.items():
        if got.get(key, 0) < int(e["max"]):
            notes.append(f"loose: {key[0]} {key[1]} {key[2]} ceiling {e['max']}, found {got.get(key, 0)} (owner {e['owner']}): lower or delete the entry")
    for e in entries:
        if e.get("owner") == "ORW-511":
            if e["kind"] == "list" and len(str(e.get("decision", ""))) < MIN_REASON:
                bad.append(f"ORW-511 list entry {e['path']}:{e['name']} needs a written decision (live path or why none)")
            if e["kind"] != "list":
                sites = e.get("sites", [])
                if len(sites) < int(e["max"]) or any(len(str(x.get("reason", ""))) < MIN_REASON or x.get("reason") == "UNREVIEWED" for x in sites):
                    bad.append(f"ORW-511 entry {e['path']}:{e['kind']} needs one reviewed reason per site ({e['max']} sites, {len(sites)} reasons)")
    return bad, notes


def seed_entries(hits: list[S.Hit]) -> list[dict]:
    out = []
    for (path, kind, name), n in sorted(counts(hits).items()):
        for rx, k, owner, reason in OWNER_RULES:
            if re.search(rx, path) and k in ("*", kind):
                break
        else:
            owner, reason = "ORW-511", "unassigned at seed time: needs a reviewer"
        e = {"path": path, "kind": kind, "name": name, "max": n, "owner": owner, "reason": reason}
        if owner == "ORW-511" and kind != "list":
            e["sites"] = [{"line": h.line, "anchor": h.ctx[:60], "reason": site_reason(h)} for h in hits if (h.path, h.kind) == (path, kind)]
        if owner == "ORW-511" and kind == "list":
            e["decision"] = LIST_DECISIONS.get((path, name)) or "mechanics: an internal candidate list tried in order (file, folder or model names); not player text"
        out.append(e)
    return out


def main(argv: list[str]) -> int:
    hits = S.scan()
    if "--write-allowlist" in argv:
        ALLOWLIST.write_text(json.dumps({"limit": S.LIMIT, "entries": seed_entries(hits)}, indent=1, ensure_ascii=False) + "\n", encoding="utf8")
        print(f"wrote {ALLOWLIST} ({len(seed_entries(hits))} entries)")
        return 0
    bad, notes = check(hits, load_allowlist())
    for n in notes:
        print("note:", n)
    for b in bad:
        print("::error::short-list guard:", b)
    print(f"short-list guard: {len(hits)} hit(s) scanned, {len(bad)} violation(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
