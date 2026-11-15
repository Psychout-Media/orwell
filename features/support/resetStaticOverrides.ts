import { After } from "@cucumber/cucumber";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-213: the adapter keeps a handful of PROCESS-WIDE test overrides (static `...Override` fields). A scenario that sets one and does not restore it changes every scenario that runs after
 * it - the same seed then gives a different season depending on what ran before it in the cucumber process. Reset ALL of them to "unset" after EVERY scenario. (tests/unit/staticOverridesReset.test.ts
 * pins that this list covers every static override the adapter declares.)
 */
After(function () {
  GameSessionAdapter.setSeededTieSurfacingEnabled(null);
  GameSessionAdapter.setTieRevealEnabled(null);
  GameSessionAdapter.setGossipConsequenceEnabled(null);
  GameSessionAdapter.setSecretPacingEnabled(null);
  GameSessionAdapter.setTimeOfDayEnabled(null);
  GameSessionAdapter.setShowrunnerReweightEnabled(null);
});
