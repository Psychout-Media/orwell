import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { PLAYER } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import {
  startNewGame, generateHouse, hashSeed, isPlausibleHouseguest, isPlausibleArchetype,
  dispositionOf, ENSEMBLE, CAST_SIZE, NPC_COUNT, isCorpusName, NAME_CORPORA,
} from "../../src/engine/characterFactory";
import type { Houseguest } from "../../src/engine/characterFactory";

// Legacy sample-save names that must NEVER be generated (BB_GameBible §3) — banned from the
// vendored corpora by policy (E38 / ruling #1: "the legacy Bible's names stay banned").
const FORBIDDEN_SAMPLE = ["ryne", "marcus", "felix"];

// A houseguest's full IDENTITY (E38): with real-name corpora a bare first name MAY recur across
// seeds (real names repeat in the real world); what must never carry over is the identity.
const identityOf = (n: Houseguest): string =>
  `${n.name}|${n.character.archetype}|${n.character.background}|${n.character.appearance}`;

function newHouse(world: BbWorld): void {
  world.house = startNewGame({ seed: 1001, playerName: "AuthoredPlayer" });
}

When("a new game is started", function (this: BbWorld) {
  newHouse(this);
});

When("a new house is generated", function (this: BbWorld) {
  newHouse(this);
});

Given("a house generated with seed {string}", function (this: BbWorld, seed: string) {
  this.housesBySeed ??= {};
  this.housesBySeed[seed] = generateHouse(new SeededRandom(hashSeed(seed))).npcs;
});

// --- New game / new house -----------------------------------------------------

Then("a player character is produced via character creation", function (this: BbWorld) {
  assert.ok(this.house!.player, "a player should be produced");
  assert.equal(this.house!.player.authored, "oobe");
  assert.equal(this.house!.player.id, PLAYER);
});

Then(
  "the house is populated with newly generated, randomly-named houseguests",
  function (this: BbWorld) {
    assert.equal(this.house!.npcs.length, NPC_COUNT);
    assert.ok(this.house!.npcs.every((n) => n.authored === "generated"));
    assert.ok(this.house!.npcs.every((n) => n.name.length > 0));
  },
);

Then("no identity carries over from any previous game", function (this: BbWorld) {
  const previous = generateHouse(new SeededRandom(hashSeed("a-previous-game"))).npcs;
  const current = new Set(this.house!.npcs.map(identityOf));
  assert.ok(previous.every((p) => !current.has(identityOf(p))), "no NPC identity should carry over");
});

// --- Cast composition ---------------------------------------------------------

Then("the house contains sixteen houseguests", function (this: BbWorld) {
  assert.equal(1 + this.house!.npcs.length, CAST_SIZE);
});

Then("exactly one is the player", function (this: BbWorld) {
  assert.ok(this.house!.player.id === PLAYER);
  assert.ok(this.house!.npcs.every((n) => n.id !== PLAYER));
});

Then("the other fifteen are NPCs", function (this: BbWorld) {
  assert.equal(this.house!.npcs.length, NPC_COUNT);
  assert.ok(this.house!.npcs.every((n) => n.authored === "generated"));
});

Then("the player's profile originates from OOBE authoring", function (this: BbWorld) {
  assert.equal(this.house!.player.authored, "oobe");
});

Then("every NPC profile is generated", function (this: BbWorld) {
  assert.ok(this.house!.npcs.every((n) => n.authored === "generated"));
});

// --- Plausibility & ensemble --------------------------------------------------

Then("each NPC profile is internally consistent", function (this: BbWorld) {
  assert.ok(this.house!.npcs.every(isPlausibleHouseguest), "every NPC must be internally consistent");
});

Then("each falls within plausible reality-TV contestant archetypes", function (this: BbWorld) {
  assert.ok(this.house!.npcs.every((n) => isPlausibleArchetype(n.character.archetype)));
});

Then(
  "the cast spans a spread of distinct archetypes and strategy styles",
  function (this: BbWorld) {
    const archetypes = new Set(this.house!.npcs.map((n) => n.character.archetype));
    const styles = new Set(this.house!.npcs.map((n) => n.character.strategyStyle));
    assert.ok(archetypes.size >= ENSEMBLE.MIN_DISTINCT_ARCHETYPES, `archetype spread ${archetypes.size}`);
    assert.ok(styles.size >= ENSEMBLE.MIN_DISTINCT_STYLES, `style spread ${styles.size}`);
  },
);

Then(
  "no single archetype dominates the house beyond the configured balance",
  function (this: BbWorld) {
    const counts = new Map<string, number>();
    for (const n of this.house!.npcs) counts.set(n.character.archetype, (counts.get(n.character.archetype) ?? 0) + 1);
    const max = Math.max(...counts.values());
    assert.ok(max <= ENSEMBLE.MAX_PER_ARCHETYPE, `max archetype count ${max}`);
  },
);

Then("the mix includes personalities likely to clash and to bond", function (this: BbWorld) {
  const dispositions = new Set(this.house!.npcs.map((n) => dispositionOf(n.character.archetype)));
  assert.ok(dispositions.has("clash"), "expected at least one clash-prone personality");
  assert.ok(dispositions.has("bond"), "expected at least one bond-prone personality");
});

// --- Naming -------------------------------------------------------------------

Then("every houseguest display name is unique within the house", function (this: BbWorld) {
  const names = [this.house!.player.name, ...this.house!.npcs.map((n) => n.name)];
  assert.equal(new Set(names).size, names.length, "names must be unique within the house");
});

// E38 / ruling #1 (2026-06-10): the DETERMINISTIC factory's names are seeded samples from vendored
// REAL-NAME corpora (live casting names are model-authored + validated, Ryne 2026-11-11).
// The corpora are raw material — never a fixed cast: no full-name+persona pairing is
// hard-coded, and the legacy Bible's names stay banned (excluded from the corpora).
Then("every deterministic-factory name is sampled from the vendored real-name corpora", function (this: BbWorld) {
  for (const n of this.house!.npcs) {
    assert.ok(isCorpusName(n.name), `name "${n.name}" must be sampled from the corpora`);
    assert.match(n.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/, "names keep the display-name shape");
  }
});

Then("no legacy sample-save name is ever generated", function (this: BbWorld) {
  // Banned by construction: the legacy names are excluded from the corpora themselves…
  for (const part of [...NAME_CORPORA.given, ...NAME_CORPORA.surnames]) {
    assert.ok(!FORBIDDEN_SAMPLE.includes(part.toLowerCase()), `corpus must not carry legacy name "${part}"`);
  }
  // …and therefore never generated.
  for (const n of this.house!.npcs) {
    const first = n.name.split(" ")[0]!.toLowerCase();
    assert.ok(!FORBIDDEN_SAMPLE.includes(first), `name "${n.name}" must not come from the sample save`);
  }
});

Then("no full name and persona pairing is fixed across seeds", function (this: BbWorld) {
  // "No fixed cast" (the amended 0004 do-not): if the same full name ever recurs in another
  // seeded house, it must not arrive carrying the same persona — the pairing is the seed's draw.
  const current = new Map(this.house!.npcs.map((n) => [n.name, identityOf(n)]));
  for (const seed of ["pairing-probe-1", "pairing-probe-2", "pairing-probe-3"]) {
    for (const other of generateHouse(new SeededRandom(hashSeed(seed))).npcs) {
      const here = current.get(other.name);
      if (here !== undefined) {
        assert.notEqual(here, identityOf(other), `"${other.name}" must not be a fixed name+persona pairing`);
      }
    }
  }
});

// --- Public appearance fields (0004 amendment, wired live per PO review 2026-06-28) ----------

Then(
  "each houseguest's Character carries public appearance and presentation fields",
  function (this: BbWorld) {
    for (const n of this.house!.npcs) {
      assert.ok(
        typeof n.character.appearance === "string" && n.character.appearance.length > 0,
        "appearance must be a non-empty public string",
      );
      assert.ok(
        typeof n.character.presentation === "string" && n.character.presentation.length > 0,
        "presentation must be a non-empty public string",
      );
      assert.equal(typeof n.character.age, "number", "age must be a number");
    }
  },
);

Then(
  "those appearance fields are well-formed and within plausible reality-TV bounds",
  function (this: BbWorld) {
    for (const n of this.house!.npcs) {
      assert.ok(n.character.age >= 21 && n.character.age <= 60, `age ${n.character.age} out of band`);
      assert.ok(n.character.appearance.includes(", "), "appearance carries multiple descriptive facets");
      assert.ok(isPlausibleHouseguest(n), "the houseguest stays internally consistent");
    }
  },
);

Then(
  "those public fields leak no competition aptitude or hidden attribute",
  function (this: BbWorld) {
    for (const n of this.house!.npcs) {
      const blob = `${n.character.appearance} | ${n.character.presentation}`;
      // A public appearance descriptor never carries a numeric aptitude (stat score).
      assert.ok(!/\d/.test(blob), `appearance/presentation must carry no number: "${blob}"`);
      // No hidden-element text bleeds into the public facets.
      for (const h of n.character.hiddenElements) {
        assert.ok(!blob.includes(h.detail), `hidden element "${h.detail}" must not appear in public fields`);
      }
    }
  },
);

// --- No carryover across seeds ------------------------------------------------

Then("the two houses share no houseguest identities", function (this: BbWorld) {
  const a = new Set(this.housesBySeed!["A"]!.map(identityOf));
  assert.ok(this.housesBySeed!["B"]!.every((n) => !a.has(identityOf(n))), "houses must share no identities");
});
