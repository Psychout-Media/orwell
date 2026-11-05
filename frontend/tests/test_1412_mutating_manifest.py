"""Issue #1412 (this half) — the mutating-tool manifest drift guard.

chat.js's tool-result seam used to carry a HAND-CODED array of "which tools fire a
HUD refresh (orwell:gamechanged)". A newly-wired mutating tool could silently leave
that array stale, so the status HUD lagged a whole poll period after that tool ran.

The fix (this half): a shared manifest `ORWELL_MUTATING_TOOLS` in platform.js —
DERIVED from the engine tool registry (`src/surfaces/tools/registry.ts`) and PINNED
to it by THIS test. chat.js then consumes `window.orwellIsMutatingTool(name)` (the
OTHER half of #1412) in place of its inline array; `test_g15_gamechanged.py` keeps
the single-`orwell:gamechanged`-dispatcher invariant.

The "by construction" guarantee: registry.ts has NO `mutating` flag, so the split
between HUD-mutating tools and pure reads / non-HUD write-backs is the one irreducible
human judgment — pinned here as READ_ONLY_TOOLS. EVERY other PLAYER_TOOL is treated as
mutating and MUST appear in the manifest. So ANY new registry tool trips this test
until it is classified: add it to ORWELL_MUTATING_TOOLS if its success moves the HUD,
else to READ_ONLY_TOOLS below. A new *mutating* tool therefore cannot ship without the
manifest being updated — and the HUD stays fresh by construction, not by hope.
"""
import re
from pathlib import Path

FE = Path(__file__).resolve().parents[1]
REPO = FE.parent
PLATFORM = (FE / "static" / "js" / "platform.js").read_text(encoding="utf-8")
REGISTRY = (REPO / "src" / "surfaces" / "tools" / "registry.ts").read_text(encoding="utf-8")


# ── registry.ts extraction ───────────────────────────────────────────────────

def _names(block: str) -> set[str]:
    return set(re.findall(r'name:\s*"([^"]+)"', block))


def _player_tool_names() -> set[str]:
    block = REGISTRY[REGISTRY.index("export const PLAYER_TOOLS"):REGISTRY.index("export const ADMIN_TOOLS")]
    names = _names(block)
    assert names, "failed to parse PLAYER_TOOLS from registry.ts — parser or file shape changed"
    return names


def _admin_tool_names() -> set[str]:
    block = REGISTRY[REGISTRY.index("export const ADMIN_TOOLS"):REGISTRY.index("export interface DebugVaultToolDescriptor")]
    names = _names(block)
    assert names, "failed to parse ADMIN_TOOLS from registry.ts"
    return names


# ── the ONE irreducible classification ───────────────────────────────────────
# Registry PLAYER_TOOLS that are NOT HUD-mutating: pure reads / projections, plus the
# FE write-backs and confirmations that move only hidden / off-screen / pre-warm state
# the status HUD never renders (deliberately kept out of the refresh set — matching the
# behavior chat.js has always had). A new PLAYER_TOOL that is NOT listed here is treated
# as mutating and MUST be in the manifest — see the module docstring.
READ_ONLY_TOOLS = frozenset({
    # Pure reads / Vault-free projections.
    "getGameState", "gameStatus", "stateDelta", "playerTagline", "finaleView",
    "getMomentPrompt", "recallSceneMemories", "getVisibleStateFor", "renderScene",
    "socialRead", "socialInitiatives", "whereabouts", "premiereIntros", "seasonRecap",
    "dailyRecap", "seasonRetrospective", "npcVoice", "getPortraitPrompt",
    # #1800 / #1793: pure reads of the player's OWN Diary-Room record.
    "playerReceipts", "playerDossier",
    # (sealedFromHouse / knowledgeScopeManifest moved to INFRA_TOOL_NAMES, #1870 — no longer PLAYER_TOOLS.)
    "askProducers", "endOfSessionSummary", "worldSnapshotView", "getOffscreenSceneSkeletons",
    "competitionStagingView",
    # State changes the player HUD does NOT render: raised/cleared confirmations, hidden /
    # off-screen texture write-backs, and cast pre-warm authoring.
    "requestSelfEviction", "cancelSelfEviction", "confide",
    "preSeedCast", "preSeedNextSeason", "recordCastProfile", "recordCastIdentity",
    # 0116 (model-authored cast genesis): an FE-driven PRE-GAME cast-authoring write-back (the
    # producer-LLM proposes the cast skeleton; the engine validates/clamps/folds), moving only the
    # pre-warm cast the status HUD never renders — NOT a HUD-mutating lever, exactly like its sibling
    # recordCastIdentity / recordCastProfile above. (Classified here to clear the #1412 drift guard,
    # which an engine-only PR skips — the lever-drift trap — so it landed latent on main until an
    # FE-touching PR ran fe-unit.)
    "recordCastGenesis",
    "recordWorldSnapshot", "recordOffscreenSceneTexture", "recordCompetitionFiction",
    # #1626 (increment 3): `recordProducerProfile` is an FE-driven write-back that DEEPENS the
    # OFF-CAMERA producer persona — it moves only the seeded producer's public voice prose, which
    # the status HUD never renders — NOT a HUD-mutating lever, exactly like its sibling
    # recordWorldSnapshot / recordCastProfile above. (Classified here to clear the #1412 drift
    # guard, which an engine-only PR skips — the lever-drift trap — so #1631 landed the tool in
    # registry.ts INFRA_LEVERS latent on main until an FE-touching PR ran fe-unit.)
    "recordProducerProfile",
})

# `manageSandbox` is the ONE admin tool in the manifest (a sandbox reset / load moves the
# whole board the HUD reads). Any manifest member outside PLAYER_TOOLS other than this is
# an error the drift test rejects.
ALLOWED_NON_PLAYER = frozenset({"manageSandbox"})


# ── the manifest, parsed from platform.js ────────────────────────────────────

def _manifest_tools() -> list[str]:
    m = re.search(r"ORWELL_MUTATING_TOOLS\s*=\s*Object\.freeze\(\[(.*?)\]\)", PLATFORM, re.S)
    assert m, "platform.js must export const ORWELL_MUTATING_TOOLS = Object.freeze([ ... ])"
    # Strip // line comments first so words in comments can never masquerade as tool names.
    body = re.sub(r"//[^\n]*", "", m.group(1))
    return re.findall(r"'([A-Za-z][A-Za-z0-9]*)'", body)


# ── tests ────────────────────────────────────────────────────────────────────

def test_manifest_has_no_duplicates():
    tools = _manifest_tools()
    assert len(tools) == len(set(tools)), f"ORWELL_MUTATING_TOOLS has duplicates: {tools}"


def test_manifest_exposes_the_lookup_and_window_globals():
    # The other half of #1412 (chat.js) consumes these; keep the shape stable.
    assert "export function orwellIsMutatingTool" in PLATFORM
    assert "window.orwellIsMutatingTool = orwellIsMutatingTool" in PLATFORM
    assert "window.ORWELL_MUTATING_TOOLS = ORWELL_MUTATING_TOOLS" in PLATFORM


def test_read_only_classification_is_current():
    # No stale exclusion: every READ_ONLY name is still a real PLAYER_TOOL.
    stale = sorted(READ_ONLY_TOOLS - _player_tool_names())
    assert not stale, f"READ_ONLY_TOOLS names no longer in registry PLAYER_TOOLS (remove them): {stale}"


def test_manifest_equals_the_registry_mutating_set_exactly():
    players = _player_tool_names()
    admins = _admin_tool_names()
    manifest = set(_manifest_tools())

    # 1. No phantoms: every manifest entry is a real registry tool (player or admin).
    phantom = sorted(manifest - players - admins)
    assert not phantom, f"manifest lists tools not present in registry.ts (phantoms): {phantom}"

    # 2. The manifest's non-player members are EXACTLY the explicitly-allowed admin tool(s).
    non_player = manifest - players
    unexpected = sorted(non_player - ALLOWED_NON_PLAYER)
    assert not unexpected, f"unexpected non-player tools in the manifest: {unexpected}"
    missing_admin = sorted(ALLOWED_NON_PLAYER - manifest)
    assert not missing_admin, f"manifest is missing the mutating admin tool(s): {missing_admin}"
    for t in ALLOWED_NON_PLAYER:
        assert t in admins, f"{t} is declared a mutating admin tool but is not in registry ADMIN_TOOLS"

    # 3. THE drift assertion — among PLAYER_TOOLS, the manifest == the mutating set EXACTLY,
    #    where mutating = every player tool NOT classified read-only. A new registry tool is
    #    mutating-by-default, so it fails here until it is classified.
    expected_player_mutating = players - READ_ONLY_TOOLS
    manifest_player = manifest & players
    missing = sorted(expected_player_mutating - manifest_player)
    extra = sorted(manifest_player - expected_player_mutating)
    assert not missing and not extra, (
        "ORWELL_MUTATING_TOOLS drifted from registry.ts.\n"
        f"  MISSING (add to ORWELL_MUTATING_TOOLS in platform.js if the tool's success "
        f"moves the HUD, else add it to READ_ONLY_TOOLS in this test): {missing}\n"
        f"  EXTRA (in the manifest but classified read-only here): {extra}"
    )


def test_the_current_mutator_set_is_pinned():
    # Belt-and-suspenders: the exact set today (this preserves the behavior chat.js:2878
    # has always had). If a legitimately-new mutating tool lands, THIS pin AND the manifest
    # update together — a silent reshuffle stays loud even if the derivation were loosened.
    expected = {
        "advanceGame", "submitDecision", "updateCasting", "createCharacter",
        "recordInteraction", "runCompetition", "surfaceInformationTo", "diaryRoom", "recordImageBeat",
        "moveTo", "moveHouseguest", "markHouseguestMet", "turnIn", "hangOut", "noteMessage",
        "makeDeal", "formAlliance", "joinAlliance", "askJuror",
        "exposeSecret", "tradeSecret", "confront", "accuseTie",
        "manageSandbox", "raiseSpectatorChoice",
    }
    assert set(_manifest_tools()) == expected
