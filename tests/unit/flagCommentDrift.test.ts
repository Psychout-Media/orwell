import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_FLAGS } from "../../src/featureFlags";

/** ORW-547 - a comment must not call a default-ON flag "default OFF" / "OFF unless exactly =1" / "never-flipped". Source scan, comment-only. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
const STALE = /OFF unless|never-flipped|default[- ]OFF|off by default/i;

describe("flag comments do not contradict the registry", () => {
  const on = FEATURE_FLAGS.filter((f) => f.parser === "defaultOn" || f.parser === "inverted").map((f) => f.envKey);
  it("no line naming a default-ON flag also calls it default OFF", () => {
    const bad: string[] = [];
    for (const f of files(root)) readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (STALE.test(line) && on.some((k) => line.includes(k))) bad.push(`${f.slice(root.length + 1)}:${i + 1}`);
    });
    expect(bad).toEqual([]);
  });
  it("the comment block above a default-ON registry entry never says OFF unless / never-flipped", () => {
    const lines = readFileSync(join(root, "featureFlags.ts"), "utf8").split("\n");
    const bad: string[] = [];
    lines.forEach((line, i) => {
      const m = /envKey: '(ORWELL_[A-Z0-9_]+)'/.exec(line);
      if (!m || !on.includes(m[1])) return;
      for (let j = i - 1; j >= 0 && lines[j].trim().startsWith("//"); j--) if (/OFF unless|never-flipped/i.test(lines[j])) bad.push(`${m[1]}:${j + 1}`);
    });
    expect(bad).toEqual([]);
  });
});
