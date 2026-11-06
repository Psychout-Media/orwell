import { expect } from "vitest";

/**
 * A9 flip (2026-11-04): `ORWELL_PREMIERE_ENTRANCES` ships DEFAULT ON (the premiere opens on ONE-AT-A-TIME entrances + the toast), which adds ~25 `advanceGame` steps before the
 * first HOH. The ~45 UNIT tests that drive a season by counting premiere advances were written against the old champagne-circle premiere and test OTHER features, so the unit lane pins
 * the flag OFF per test file (the entrance tests opt IN explicitly through `setPremiereEntrancesEnabled(true)`). The PROPERTY / UAT / CALIBRATION lanes are the "game that ships"
 * gates (juryReach, gradient, twist windows, full-game UAT): they leave the flag UNSET so they exercise the deployed default. Set explicitly both ways per file because a forked
 * worker reuses its process (and so its env) across test files.
 */
const path = String(expect.getState().testPath ?? "");
if (/[\\/]tests[\\/](property|uat|calibration)[\\/]/.test(path)) delete process.env.ORWELL_PREMIERE_ENTRANCES;
else process.env.ORWELL_PREMIERE_ENTRANCES = "0";
// Bedtime gate (turnIn refused in the morning/afternoon): the unit lane drives days by turning in at 8am; the gate has its own test that opts IN through setBedtimeGateEnabled(true).
if (!/[\\/]tests[\\/](property|uat|calibration)[\\/]/.test(path)) process.env.ORWELL_BEDTIME_GATE = "0"; else delete process.env.ORWELL_BEDTIME_GATE;
