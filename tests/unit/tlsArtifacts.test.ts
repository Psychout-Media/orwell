// Feature 0074 / ADR 0014 — local & tunable HTTPS deploy artifacts.
//
// Structural gates (no engine code runs): the generated Caddyfile must reference ONLY the front-end
// on loopback and NEVER the engine port 8765 (the ADR 0007 "engine never public" invariant, extended
// to the local terminator); the apply engine must upsert the ORWELL_TLS_* keys and harden the
// cookie/bind posture; the ops units must mirror the public-deployment seam; and install/update must
// reconcile the new units. Mirrors tests/unit/opsPrivateRepo.test.ts (readFileSync + regex asserts).
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY = "deploy";
const httpsSh = readFileSync(join(DEPLOY, "orwell-https.sh"), "utf8");
const opsSh = readFileSync(join(DEPLOY, "orwell-ops-tls.sh"), "utf8");
const pathUnit = readFileSync(join(DEPLOY, "systemd", "orwell-ops-tls.path"), "utf8");
const svcUnit = readFileSync(join(DEPLOY, "systemd", "orwell-ops-tls.service"), "utf8");

function genCaddyfile(extra: string): string {
  // Run the generator with --print-caddyfile (no root, no install, no .env). APP_DIR points at a
  // throwaway dir so it never reads a real environment file.
  return execSync(
    `APP_DIR="$(mktemp -d)" bash deploy/orwell-https.sh --print-caddyfile --mode local ${extra}`,
    { encoding: "utf8" },
  );
}

describe("0074 — the generated Caddyfile never names the engine", () => {
  it("local-only config proxies the FE on loopback and omits engine port 8765", () => {
    const out = genCaddyfile("--local-names orwell.lan,orwell.local");
    expect(out).toContain("reverse_proxy 127.0.0.1:8080");
    expect(out).toContain("tls internal");
    expect(out).not.toContain("8765"); // the engine MCP port — never exposed
    // Every reverse_proxy target is the FE on loopback and nothing else.
    for (const l of out.split("\n").filter((l) => l.includes("reverse_proxy")))
      expect(l).toContain("127.0.0.1:8080");
  });

  it("the publicly-trusted (DNS-01) upgrade references the env token, never the literal, and still omits the engine", () => {
    const out = genCaddyfile(
      "--local-names orwell.lan --domains hiorwell.com,www.hiorwell.com --dns-provider cloudflare --dns-token SECRET123",
    );
    expect(out).toContain("hiorwell.com, www.hiorwell.com {");
    expect(out).toContain("dns cloudflare {env.ORWELL_TLS_DNS_API_TOKEN}");
    expect(out).not.toContain("SECRET123"); // the token never lands in the config file
    expect(out).not.toContain("8765");
    // Every site block reverse-proxies the FE and nothing else.
    const proxyLines = out.split("\n").filter((l) => l.includes("reverse_proxy"));
    expect(proxyLines.length).toBeGreaterThanOrEqual(2);
    for (const l of proxyLines) expect(l).toContain("127.0.0.1:8080");
  });
});

describe("0074 — orwell-https.sh is the single apply engine", () => {
  it("upserts the ORWELL_TLS_* keys", () => {
    for (const key of [
      "ORWELL_TLS_MODE",
      "ORWELL_TLS_LOCAL_NAMES",
      "ORWELL_TLS_DOMAINS",
      "ORWELL_TLS_DNS_PROVIDER",
      "ORWELL_TLS_DNS_API_TOKEN",
    ]) {
      expect(httpsSh, `orwell-https.sh should manage ${key}`).toContain(key);
    }
  });

  it("hardens the posture on enable: Secure cookies + loopback bind", () => {
    expect(httpsSh).toMatch(/set_env_key SECURE_COOKIES "true"/);
    expect(httpsSh).toMatch(/set_env_key ORWELL_BIND_HOST "127\.0\.0\.1"/);
  });

  it("does NOT arm the public internet profile (ORWELL_PUBLIC stays the operator's separate choice)", () => {
    expect(httpsSh).not.toMatch(/set_env_key ORWELL_PUBLIC/);
  });

  it("bridges into the LXC like change-port and supports a no-root --print-caddyfile", () => {
    expect(httpsSh).toContain("pct exec");
    expect(httpsSh).toContain("--print-caddyfile");
  });
});

describe("0074 — the ops trigger mirrors the public-deployment seam", () => {
  it("the path unit watches the flag by EXISTENCE only", () => {
    expect(pathUnit).toContain("PathExists=/opt/orwell/data/ops/tls-requested");
    expect(pathUnit).toMatch(/existence[- ]only/i);
    expect(pathUnit).toContain("Unit=orwell-ops-tls.service");
  });

  it("the service removes the flag FIRST (no PathExists retrigger) and appends to the live log", () => {
    expect(svcUnit).toContain("ExecStartPre=/bin/rm -rf --one-file-system -- /opt/orwell/data/ops/tls-requested");
    expect(svcUnit).toContain("append:/opt/orwell/data/ops-tls.log");
    expect(svcUnit.indexOf("ExecStartPre=/bin/rm")).toBeLessThan(svcUnit.indexOf("ExecStart=/bin/bash"));
  });

  it("the root runner shreds the DNS token and passes it via env, never argv", () => {
    expect(opsSh).toMatch(/shred/);
    expect(opsSh).toContain("ORWELL_TLS_DNS_API_TOKEN=");
    // The token reaches orwell-https.sh through the environment, not the command line.
    expect(opsSh).not.toMatch(/--dns-token/);
  });
});

describe("0074 — install + update reconcile the new units; the menu wires the action", () => {
  const install = readFileSync(join(DEPLOY, "orwell-install.sh"), "utf8");
  const update = readFileSync(join(DEPLOY, "orwell-update.sh"), "utf8");
  const menu = readFileSync(join(DEPLOY, "orwell-menu.sh"), "utf8");

  for (const [name, text] of [["orwell-install.sh", install], ["orwell-update.sh", update]] as const) {
    it(`${name} installs + enables the ops-tls path unit`, () => {
      expect(text).toMatch(/install -m 644 "[^"]*orwell-ops-tls\.path"/);
      expect(text).toMatch(/install -m 644 "[^"]*orwell-ops-tls\.service"/);
      expect(text).toContain("orwell-ops-tls.path");
    });
  }

  it("orwell-menu.sh wires the `https` subcommand + dispatches to orwell-https.sh", () => {
    expect(menu).toMatch(/https\)\s+shift; do_https/);
    expect(menu).toContain("orwell-https.sh");
  });
});
