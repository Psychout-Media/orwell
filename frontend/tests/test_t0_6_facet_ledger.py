"""T0-6 — the ONE Casting Bible (FacetLedger). Pins the backlog item's acceptance criteria
(docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md §T0-6/§T9;
docs/design/2026-07-21-moonshot-refactor-synthesis.md §P3):

  * a cast-wide seeded FacetLedger, minted BEFORE any LLM call, dealing every slot a hand from
    stratified per-cast budgets (vocation family, region/hometown, heightBuild, skinTone, hair,
    voice tics, name phonology) — deterministic (same seed ⇒ same hands), no Date.now()/random();
  * zero facet triple-dups (the structural FACET_DUP_CAP guarantee) across a sweep of seeds;
  * zero duplicate COMMITTED hometowns/vocations even in a single 15-wide wave (the collision-drop
    added to `_gather_chunked_proposal`);
  * a 15-NPC cast now runs genesis in ONE full-width wave, not 3 sequential chunks;
  * `author_cast` threads each NPC's dealt hand + the cast-wide taken-list into its prompt, and the
    transactional adopt-or-regenerate guard (never graft) fires on a closed-facet conflict.

Roles only — no names ingested as data. All LLM calls in the async sections are stubbed.
"""
import asyncio

from src import orwell_cast_authoring as A
from src import orwell_cast_genesis as G
from src import orwell_facet_ledger as L


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── the pure ledger: determinism + the stratified-budget collision guarantees ───────────────────

def test_ledger_is_deterministic_same_seed_same_hands():
    a = L.mint_facet_ledger(108108, 15)
    b = L.mint_facet_ledger(108108, 15)
    assert a == b
    assert a is not b  # not the same object — a fresh, byte-identical mint each time


def test_ledger_is_player_blind_and_pure_no_wallclock_no_global_rng():
    # Two independent mints off the same inputs must be byte-identical — proves no Date.now()/
    # random() (or any other hidden global state) leaks into the deal.
    for seed in (1, 2, 3, 108108, 999999):
        first = L.mint_facet_ledger(seed, 15, [False] * 15)
        second = L.mint_facet_ledger(seed, 15, [False] * 15)
        assert first == second, f"seed {seed} minted non-deterministically"


def test_different_seeds_mint_different_ledgers():
    a = L.mint_facet_ledger(1, 15)
    b = L.mint_facet_ledger(2, 15)
    assert a != b


def test_hand_for_matches_the_full_mint_by_slot():
    seed, count = 42, 15
    ledger = L.mint_facet_ledger(seed, count)
    for i in range(1, count + 1):
        assert L.hand_for(seed, count, f"npc:{i}") == ledger[i - 1]
    assert L.hand_for(seed, count, "npc:16") is None  # out of roster range
    assert L.hand_for(seed, count, "player") is None  # not a numbered slot


def test_zero_facet_triple_dups_across_a_seed_sweep():
    """The structural FACET_DUP_CAP guarantee (moonshot §P3 acceptance: "zero facet triple-dups")."""
    facet_keys = ["vocationFamily", "region", "townSize", "heightBuild", "skinToneCue", "hair"]
    for seed in range(30):
        ledger = L.mint_facet_ledger(seed, 15)
        assert len(ledger) == 15
        for key in facet_keys:
            values = [hand[key] for hand in ledger]
            for v in set(values):
                assert values.count(v) <= L.FACET_DUP_CAP, (
                    f"seed {seed} facet {key!r} value {v!r} landed on "
                    f"{values.count(v)} slots (cap is {L.FACET_DUP_CAP})")


def test_voice_tic_and_name_phonology_are_unique_per_cast():
    """These two lanes are dealt via `_deal_unique` — no duplicates at all, ever (the "San Diego x2" /
    default-name-clustering class this ledger exists to kill)."""
    for seed in range(15):
        ledger = L.mint_facet_ledger(seed, 15)
        tics = [h["voiceTic"] for h in ledger]
        phon = [h["namePhonology"] for h in ledger]
        assert len(set(tics)) == len(tics), f"seed {seed} dealt a duplicate voice tic"
        assert len(set(phon)) == len(phon), f"seed {seed} dealt a duplicate name phonology"


def test_physical_slots_are_aligned_to_a_physically_credible_vocation_family():
    fam_physical = {f: phys for f, _n, phys in L.VOCATION_FAMILIES}
    for seed in range(10):
        physical = [(i % 3 == 0) for i in range(15)]  # a deterministic physical/non-physical spread
        ledger = L.mint_facet_ledger(seed, 15, physical)
        for i, is_physical in enumerate(physical):
            if not is_physical:
                continue
            fam = ledger[i]["vocationFamily"]
            # Either the family is genuinely physically-credible, OR (rare) the seeded outlier
            # vocation landed here instead — outliers are drawn only onto NON-physical candidates
            # by construction, so a physical slot's family is always a real VOCATION_FAMILIES entry.
            assert fam_physical.get(fam, False), (
                f"seed {seed} slot {i} is PHYSICAL but got the non-credible family {fam!r}")


def test_render_hand_and_render_taken_are_vault_free_and_never_empty_for_a_real_hand():
    ledger = L.mint_facet_ledger(5, 15)
    rendered = L.render_hand(ledger[0])
    assert rendered and "vocation family" in rendered and "name phonology" in rendered
    assert L.render_hand(None) == ""
    taken = L.render_taken(ledger, exclude_index=0)
    assert taken and "DEALT ACROSS THE REST OF THE CAST" in taken
    # Excluding everyone leaves nothing to aggregate.
    assert L.render_taken([]) == ""


# ── the 15-wide single wave (genesis) ───────────────────────────────────────────────────────────

def test_genesis_chunk_size_is_the_full_cast_width():
    assert G.GENESIS_CHUNK_SIZE == 15


_ROSTER15 = [{"id": f"npc:{i}"} for i in range(1, 16)]


def test_a_15_npc_cast_runs_genesis_in_one_full_wide_wave_not_three_chunks():
    """Collisions are structurally impossible with pre-dealt hands, so `GENESIS_CHUNK_SIZE` no longer
    needs to bound concurrency into 3 sequential waves of 5 — one wave now covers the whole cast."""
    in_flight = 0
    max_in_flight = 0
    call_count = 0

    async def llm_fn(_messages):
        nonlocal in_flight, max_in_flight, call_count
        call_count += 1
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(0)  # yield so concurrent calls actually overlap
        in_flight -= 1
        # one_ids is embedded in the LAST user message by build_genesis_messages; just answer minimally
        return "not-json-so-it-retries-once"

    async def go():
        return await G._gather_chunked_proposal(
            _ROSTER15, {"season": "test"}, llm_fn, {n["id"] for n in _ROSTER15},
            None, G.GENESIS_CHUNK_SIZE)

    _run(go())
    # All 15 calls were in flight AT ONCE — a single 15-wide wave, never split into smaller chunks.
    assert max_in_flight == 15, f"expected one 15-wide wave, saw a peak concurrency of {max_in_flight}"


def test_duplicate_committed_hometown_and_vocation_are_dropped_even_within_one_wave():
    """T0-6 collision-drop: two houseguests proposing the SAME committed hometown/vocation in the
    SAME wave (concurrent calls can't see each other) still commit with zero duplicates — the later
    entry's colliding field is dropped so the engine floors it."""
    async def llm_fn(messages):
        # The single-id call always carries its own id in the messages; read it back out.
        user_msg = messages[-1]["content"]
        for i in range(1, 16):
            if f"npc:{i}" in user_msg:
                import json
                return json.dumps({"npcs": [{
                    "id": f"npc:{i}",
                    "hometown": "Tulsa, OK",   # EVERY slot proposes the same town on purpose
                    "vocation": "court reporter",  # EVERY slot proposes the same job on purpose
                }], "ties": []})
        return "{}"

    async def go():
        return await G._gather_chunked_proposal(
            _ROSTER15, {"season": "test"}, llm_fn, {n["id"] for n in _ROSTER15}, None, 15)

    result = _run(go())
    npcs = result.get("npcs") or []
    towns = [n.get("hometown") for n in npcs if n.get("hometown")]
    jobs = [n.get("vocation") for n in npcs if n.get("vocation")]
    # Only the FIRST slot to land keeps the field; every later colliding proposal had it dropped.
    assert len(towns) == 1, f"expected exactly one committed hometown to survive the collision-drop, got {towns}"
    assert len(jobs) == 1, f"expected exactly one committed vocation to survive the collision-drop, got {jobs}"


# ── author_cast: every lane's prompt gets its NPC's hand + the taken-list ───────────────────────

def _npc(i: int, **overrides) -> dict:
    base = {
        "id": f"npc:{i}",
        "name": f"Slot{i:02d}",
        "vocation": f"job-{i}",
        "hometown": f"Town-{i}, ST",
        "physicalCharacteristics": {
            "heightBuild": "average height, athletic build", "skinTone": "warm brown",
            "hair": "short and neat", "facialFeatures": "an open face",
            "distinguishingMark": "none notable", "ageLook": "settled, thirties presence",
            "style": "casual and comfortable",
        },
    }
    base.update(overrides)
    return base


def _clean_profile_json(i: int) -> str:
    import json
    return json.dumps({
        "houseguestId": f"npc:{i}",
        "biography": f"A grounded backstory for slot {i}, no closed-facet surprises.",
        "physicalCharacteristics": {
            "heightBuild": "average height, athletic build", "skinTone": "warm brown",
            "hair": "short and neat", "facialFeatures": "an open face",
            "distinguishingMark": "none notable", "ageLook": "settled, thirties presence",
            "style": "casual and comfortable",
        },
    })


def test_author_cast_threads_the_dealt_hand_and_taken_list_into_every_prompt():
    cast = [_npc(i) for i in range(1, 4)]
    seen_messages: dict = {}

    async def llm_fn(messages):
        user_text = messages[-1]["content"]
        for n in cast:
            if f"flesh out: {n['name']}." in user_text:
                seen_messages[n["id"]] = user_text
                return _clean_profile_json(int(n["id"].split(':')[1]))
        return "{}"

    async def write_fn(profile):
        return {"accepted": True, "publicFields": [], "hiddenFields": []}

    _run(A.author_cast(cast, llm_fn, write_fn, concurrency=3, seed=108108))

    assert len(seen_messages) == 3
    for hid, msg in seen_messages.items():
        # Every prompt carries its OWN dealt hand (T0-6).
        assert "DEALT FACETS" in msg, f"{hid}'s prompt is missing its dealt hand"
        # And the cast-wide taken-list of the SIBLINGS' committed vocation/hometown.
        assert "CAST-WIDE TAKEN LIST" in msg or "TAKEN LIST" in msg, (
            f"{hid}'s prompt is missing the taken-list")


def test_transactional_adopt_or_regenerate_never_grafts_a_closed_facet_conflict():
    """The skeleton (npc dict) grants NO ink; the first authored draft smuggles a tattoo into the
    biography. The regenerate attempt still can't clear it ⇒ the biography is DROPPED (adopt the
    skeleton), never committed beside a clean physicalCharacteristics block (never graft)."""
    npc = {**_npc(1), "biography": "A seeded floor biography that the engine keeps when the writer omits its own."}
    calls = {"n": 0}

    async def llm_fn(messages):
        calls["n"] += 1
        import json
        # Both the first call AND the regenerate keep proposing ink in the biography — simulates a
        # model that can't clear the conflict even after corrective feedback. Two sentences / 80+
        # chars so it clears the biography QUALITY FLOOR and actually reaches the facet guard.
        return json.dumps({
            "houseguestId": "npc:1",
            "biography": ("Grew up skating and getting a full sleeve of tattoos before culinary "
                          "school changed everything. Now they run the kitchen at a busy downtown bistro."),
            "physicalCharacteristics": npc["physicalCharacteristics"],
        })

    written_profiles = []

    async def write_fn(profile):
        written_profiles.append(profile)
        return {"accepted": True, "publicFields": [], "hiddenFields": []}

    written = _run(A.author_cast([npc], llm_fn, write_fn, concurrency=1))
    assert written == 1
    assert calls["n"] == 2, "expected exactly one regenerate attempt on top of the first call"
    assert "biography" not in written_profiles[0], (
        "a biography that still conflicts after the regenerate must be DROPPED, never committed")
    # physicalCharacteristics still committed — the engine's per-field guard is the backstop for it.
    assert "physicalCharacteristics" in written_profiles[0]


def test_transactional_guard_adopts_the_regenerate_when_it_lands_clean():
    npc = _npc(2)
    calls = {"n": 0}

    async def llm_fn(messages):
        calls["n"] += 1
        import json
        if calls["n"] == 1:
            return json.dumps({
                "houseguestId": "npc:2",
                "biography": ("A full sleeve of tattoos tells the story of years on the road. Every "
                              "panel marks a city they played before landing here."),
                "physicalCharacteristics": npc["physicalCharacteristics"],
            })
        # The regenerate lands clean — no more ink anywhere.
        return json.dumps({
            "houseguestId": "npc:2",
            "biography": ("Years on the road built a name for themself long before the house. Every "
                          "city taught them something new about performing for a crowd."),
            "physicalCharacteristics": npc["physicalCharacteristics"],
        })

    written_profiles = []

    async def write_fn(profile):
        written_profiles.append(profile)
        return {"accepted": True, "publicFields": [], "hiddenFields": []}

    written = _run(A.author_cast([npc], llm_fn, write_fn, concurrency=1))
    assert written == 1
    assert calls["n"] == 2
    assert written_profiles[0].get("biography") == (
        "Years on the road built a name for themself long before the house. Every "
        "city taught them something new about performing for a crowd.")


# ── ORW-464: a state per slot, distinct across the cast, on its own side stream ──────────────────

def test_every_slot_gets_a_state_inside_its_region_and_a_cast_never_repeats_one():
    for seed in range(60):
        ledger = L.mint_facet_ledger(seed, 15)
        states = [h["state"] for h in ledger]
        assert all(h["state"] in L.REGION_STATES[h["region"]] for h in ledger), seed
        assert len(set(states)) == 15, (seed, states)


# ORW-1127: skin, hair and face are now dealt as one coherent look (tests/test_orw1127_coherent_look.py), so they are outside this isolation pin
_LOOK_KEYS = ("state", "jobExamples", "skinToneCue", "hair", "lookGroup", "lookKind", "lookMixedWith", "lookSource", "hairTexture", "hairColour", "eyes", "faceFeature", "facialFeatures")


def test_dealing_the_state_moves_no_other_dealt_value():
    import hashlib
    import json
    h = hashlib.sha256()
    for seed in (1, 2, 3, 77, 2026, 4242):
        for hand in L.mint_facet_ledger(seed, 15):
            h.update(json.dumps({k: v for k, v in hand.items() if k not in _LOOK_KEYS}, sort_keys=True).encode())
    assert h.hexdigest() == "c6787c48c893490e3819292a5ec53b90d7729b41f3528c3fff59283d344aa6d6"  # equal to the hash over the same hands on main, less the look keys ORW-1127 now deals together


def test_the_hand_names_the_state_and_the_taken_list_names_the_states_in_play():
    ledger = L.mint_facet_ledger(5, 15)
    assert f"in {ledger[0]['state']} ({ledger[0]['region']})" in L.render_hand(ledger[0])
    taken = L.render_taken(ledger, exclude_index=0)
    assert "home states taken:" in taken and ledger[0]["state"] not in taken.split("home states taken:")[1].split(".")[0]


def test_a_card_that_already_has_a_hometown_gets_no_dealt_hometown_clause():
    from src import orwell_cast_authoring as ca
    ledger = L.mint_facet_ledger(5, 15)
    hand = ledger[0]
    assert "hometown:" in L.render_hand(hand) and "hometown:" not in L.render_hand(hand, hometown=False)
    base = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "man", "age": 30, "vocation": "welder"}
    with_town = ca.build_authoring_messages({**base, "hometown": "Macon, Georgia"}, hand=hand)[-1]["content"]
    without = ca.build_authoring_messages(base, hand=hand)[-1]["content"]
    assert "hometown: " + hand["townSize"] not in with_town and "vocation family:" in with_town
    assert "hometown: " + hand["townSize"] in without



# ── ORW-480: three ordinary example jobs per slot, inside the family, distinct across the cast, on their own side stream ──

def test_every_slot_gets_three_distinct_example_jobs_inside_its_family_and_no_other_value_moves():
    import hashlib
    import json
    h = hashlib.sha256()
    for seed in (1, 2, 3, 77, 2026, 4242):
        ledger = L.mint_facet_ledger(seed, 15)
        examples = [j for hand in ledger for j in hand["jobExamples"]]
        assert all(len(hand["jobExamples"]) == 3 for hand in ledger if hand["vocationFamily"] in L.FAMILY_JOBS)  # an outlier family has none
        assert all(set(hand["jobExamples"]) <= set(L.FAMILY_JOBS[hand["vocationFamily"]]) for hand in ledger if hand["vocationFamily"] in L.FAMILY_JOBS)
        for hand in ledger:
            h.update(json.dumps({k: v for k, v in hand.items() if k not in _LOOK_KEYS}, sort_keys=True).encode())
    assert h.hexdigest() == "c6787c48c893490e3819292a5ec53b90d7729b41f3528c3fff59283d344aa6d6"  # equal to the hash over the same hands on main, less the look keys ORW-1127 now deals together


def test_the_hand_offers_the_example_jobs():
    hand = L.mint_facet_ledger(5, 15)[0]
    assert "for example " + hand["jobExamples"][0] in L.render_hand(hand)
