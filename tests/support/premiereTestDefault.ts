import { expect } from "vitest";

/**
 * READ THIS BEFORE SEARCHING FOR A SEED (ORW-852 / ORW-841): this file makes the test's FOLDER decide two shipped flags, the premiere entrances and the bedtime
 * gate. They are on (as shipped) in tests/property, tests/uat and tests/calibration, and (since ORW-827) in tests/realpath; everywhere else they are pinned off.
 * Both change how a played season unfolds, so the same seed and sandbox name play a DIFFERENT season in a different folder: a seed found by a probe in a scratch
 * folder may not hold in the folder that runs the test. Search for a seed from the folder the test will live in (or from tests/realpath), and pin the sandbox
 * name with it: the name is part of the game's identity too (tests/realpath/README.md, "Seeds and sandbox names").
 */

/**
 * A9 flip (2026-11-04): `ORWELL_PREMIERE_ENTRANCES` ships DEFAULT ON (the premiere opens on ONE-AT-A-TIME entrances + the toast), which adds ~25 `advanceGame` steps before the
 * first HOH. The ~45 UNIT tests that drive a season by counting premiere advances were written against the old champagne-circle premiere and test OTHER features, so the unit lane pins
 * the flag OFF per test file (the entrance tests opt IN explicitly through `setPremiereEntrancesEnabled(true)`). The PROPERTY / UAT / CALIBRATION lanes are the "game that ships"
 * gates (juryReach, gradient, twist windows, full-game UAT): they leave the flag UNSET so they exercise the deployed default. Set explicitly both ways per file because a forked
 * worker reuses its process (and so its env) across test files.
 */
// ORW-827: tests/realpath runs as shipped too (unpinned, like the heavy lanes): a real-path test plays the game the deploy runs (tests/realpath/shippedDefaults.test.ts pins it).
const path = String(expect.getState().testPath ?? "");
if (/[\\/]tests[\\/](property|uat|calibration|realpath)[\\/]/.test(path)) delete process.env.ORWELL_PREMIERE_ENTRANCES;
else process.env.ORWELL_PREMIERE_ENTRANCES = "0";
// Bedtime gate (turnIn refused in the morning/afternoon): the unit lane drives days by turning in at 8am; the gate has its own test that opts IN through setBedtimeGateEnabled(true).
if (!/[\\/]tests[\\/](property|uat|calibration|realpath)[\\/]/.test(path)) process.env.ORWELL_BEDTIME_GATE = "0"; else delete process.env.ORWELL_BEDTIME_GATE;

