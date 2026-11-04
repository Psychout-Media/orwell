import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Lane 8 — ops & private-repo gates (audit A4/ruling #17 + E83 + E84 + E85).
 *
 * The repo flips private behind a single deploy PAT in data/.env (A4): these are the
 * structural gates that the deploy surface honors that design —
 *  - E84: no deploy script fetches branch tips from raw.githubusercontent (LOCAL-COPY bridges);
 *  - A4:  the git credential helper (token read from .env at use time) is wired by install AND
 *         update, and the update owns the one-time `--set-token` setup/rotation path;
 *  - A4:  no PAT literal is ever committed (the secrets-guard extension the audit asked for);
 *  - E83: the frontend lockfile exists, is fully pinned, and is what the scripts install;
 *  - E85: the systemd units carry the hardening set and the frontend unit has a default port;
 *  - G19b: the web-triggered update seam — flag file → root path unit → one fixed script →
 *          live log (the E85-sandboxed FE can never systemctl; existence-only trigger).
 */

const DEPLOY = "deploy";
const deployScripts = readdirSync(DEPLOY).filter((f) => f.endsWith(".sh"));

describe("E84 — no raw-GitHub fetches in deploy scripts (A4 local-copy bridges)", () => {
  it("no executable line in any deploy script touches raw.githubusercontent.com", () => {
    for (const script of deployScripts) {
      const lines = readFileSync(join(DEPLOY, script), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line)) return; // comments may DOCUMENT the bootstrap one-liner
        if (/\bgrep\b/.test(line)) return; // smoke.sh's own E84 lint greps for the hostname
        expect(
          /raw\.githubusercontent\.com/.test(line),
          `${script}:${i + 1} still fetches from raw.githubusercontent.com`,
        ).toBe(false);
      });
    }
  });

  it("no deploy script pipes a remote script into a shell (curl … | bash)", () => {
    for (const script of deployScripts) {
      const lines = readFileSync(join(DEPLOY, script), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        expect(
          /curl[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(line),
          `${script}:${i + 1} pipes a remote fetch into a shell`,
        ).toBe(false);
      });
    }
  });
});

describe("A4 — the single-PAT credential design is wired", () => {
  const install = readFileSync(join(DEPLOY, "orwell-install.sh"), "utf8");
  const update = readFileSync(join(DEPLOY, "orwell-update.sh"), "utf8");
  const bootstrap = readFileSync(join(DEPLOY, "orwell.sh"), "utf8");

  it("install + update + bootstrap wire the credential helper reading GIT_TOKEN from .env", () => {
    for (const [name, text] of [["orwell-install.sh", install], ["orwell-update.sh", update], ["orwell.sh", bootstrap]] as const) {
      expect(text, `${name} must configure the credential helper`).toContain("credential.helper");
      expect(text, `${name} must authenticate as x-access-token`).toContain("username=x-access-token");
      expect(text, `${name} must read GIT_TOKEN from .env at use time`).toMatch(/GIT_TOKEN=.*\.env|\.env.*GIT_TOKEN/s);
    }
  });

  it("the token never rides a remote URL (no token-in-URL clone anywhere in deploy)", () => {
    for (const script of deployScripts) {
      const text = readFileSync(join(DEPLOY, script), "utf8");
      expect(text, `${script} embeds a credential in a git URL`).not.toMatch(/https:\/\/[^\s"']*@github\.com/);
    }
  });

  it("orwell-update.sh owns the one-time --set-token setup/rotation path", () => {
    expect(update).toContain("--set-token");
  });

  it("no PAT literal is committed anywhere in the tree (the E78-scope secrets extension)", () => {
    const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
    const patPatterns = [/github_pat_[A-Za-z0-9_]{30,}/, /\bghp_[A-Za-z0-9]{30,}\b/, /\bgho_[A-Za-z0-9]{30,}\b/];
    // Redaction/scrubbing test fixtures (0071) carry example tokens by design — exempt them by EXACT
    // path (auditable; a real PAT committed anywhere else is still caught). Kept in sync with the same
    // allowlist in tests/unit/secrets.test.ts.
    const REDACTION_TEST_FIXTURES = new Set([
      "features/step_definitions/defensive_hardening.steps.ts",
      "frontend/tests/test_secret_redaction.py",
    ]);
    for (const file of tracked) {
      if (REDACTION_TEST_FIXTURES.has(file)) continue;
      let text: string;
      try {
        if (statSync(file).size > 5 * 1024 * 1024) continue; // skip big binaries
        text = readFileSync(file, "utf8");
      } catch {
        continue; // unreadable/binary
      }
      for (const p of patPatterns) {
        expect(p.test(text), `${file} appears to contain a committed GitHub token`).toBe(false);
      }
    }
  });
});

describe("E83 — the frontend dependency lockfile", () => {
  const lock = readFileSync("frontend/requirements.lock.txt", "utf8");

  it("every requirement line is exactly pinned (==)", () => {
    const lines = lock.split("\n");
    let pinned = 0;
    lines.forEach((line, i) => {
      if (/^\s*(#|$)/.test(line)) return; // comments/blank
      if (/^\s+/.test(line)) return; // pip-compile "via" continuations are indented comments
      expect(
        /^[A-Za-z0-9._-]+(\[[^\]]+\])?==\S+/.test(line),
        `requirements.lock.txt:${i + 1} is not exactly pinned: "${line}"`,
      ).toBe(true);
      pinned++;
    });
    expect(pinned).toBeGreaterThan(50); // the real closure, not a stub
  });

  it("the lockfile covers every top-level requirement", () => {
    const wanted = readFileSync("frontend/requirements.txt", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.replace(/\[.*$/, "").replace(/[<>=!~;].*$/, "").trim().toLowerCase().replace(/_/g, "-"));
    const locked = new Set(
      lock
        .split("\n")
        .filter((l) => /^[A-Za-z0-9._-]+(\[[^\]]+\])?==/.test(l))
        .map((l) => l.replace(/\[.*$/, "").split("==")[0]!.trim().toLowerCase().replace(/_/g, "-")),
    );
    for (const dep of wanted) {
      expect(locked.has(dep), `lockfile is missing top-level dep "${dep}"`).toBe(true);
    }
  });

  it("install and update scripts install from the lockfile", () => {
    for (const script of ["orwell-install.sh", "orwell-update.sh"]) {
      expect(readFileSync(join(DEPLOY, script), "utf8")).toContain("requirements.lock.txt");
    }
  });
});

describe("E85 — systemd hardening", () => {
  const HARDENING = [
    "CapabilityBoundingSet=",
    "RestrictAddressFamilies=",
    "SystemCallFilter=@system-service",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
  ];

  for (const unit of ["orwell-engine.service", "orwell-frontend.service"]) {
    it(`${unit} carries the full hardening set`, () => {
      const text = readFileSync(join(DEPLOY, "systemd", unit), "utf8");
      for (const directive of HARDENING) {
        expect(text, `${unit} is missing ${directive}`).toContain(directive);
      }
      // Node/ONNX JIT needs W+X — the unit must take an explicit, documented position, not omit it.
      expect(text).toContain("MemoryDenyWriteExecute=no");
    });
  }

  it("the frontend unit defaults ORWELL_PORT (its EnvironmentFile is optional)", () => {
    const text = readFileSync(join(DEPLOY, "systemd", "orwell-frontend.service"), "utf8");
    expect(text).toContain("Environment=ORWELL_PORT=8080");
    // …and the default must come BEFORE the EnvironmentFile so the .env value wins when present.
    expect(text.indexOf("Environment=ORWELL_PORT=8080")).toBeLessThan(text.indexOf("EnvironmentFile="));
  });

  it("E32 — the installer turns multi-user identity on by default", () => {
    expect(readFileSync(join(DEPLOY, "orwell-install.sh"), "utf8")).toContain("ORWELL_ENGINE_MULTIUSER=1");
  });
});

describe("privileged UI port (<1024, e.g. 80) — the drop-in seam", () => {
  // The hardened unit drops ALL capabilities (E85), so a non-root uvicorn cannot bind a port
  // below 1024 — install AND update must reconcile a CAP_NET_BIND_SERVICE drop-in against the
  // configured port (granted only when needed, removed otherwise; the base unit stays audited).
  for (const script of ["orwell-install.sh", "orwell-update.sh"]) {
    it(`${script} writes the CAP_NET_BIND_SERVICE drop-in only below 1024 — and removes it otherwise`, () => {
      const text = readFileSync(join(DEPLOY, script), "utf8");
      expect(text).toContain("10-privileged-port.conf");
      expect(text).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
      expect(text).toContain("CapabilityBoundingSet=CAP_NET_BIND_SERVICE");
      expect(text).toMatch(/< 1024/); // the gate — not unconditional
      expect(text).toMatch(/rm -f "\$\{?FRONTEND_DROPIN\}?"/); // the un-grant when the port moves back
    });
  }

  it("the update script reads the CURRENT port from data/.env (repairs pre-fix installs)", () => {
    const text = readFileSync(join(DEPLOY, "orwell-update.sh"), "utf8");
    expect(text).toMatch(/ORWELL_PORT=.*p.*\$ENV_FILE/); // sed of the live env, not a baked-in value
  });

  it("the base frontend unit keeps the audited empty bounding set (the grant lives in the drop-in)", () => {
    const text = readFileSync(join(DEPLOY, "systemd", "orwell-frontend.service"), "utf8");
    expect(text).toMatch(/^CapabilityBoundingSet=$/m);
  });
});

describe("install-script quality — the post-incident hardening (a real install died silently)", () => {
  // A real box's install died between the engine build and service registration, leaving a
  // half-install whose only symptom was "connection refused". These pin the framework that
  // makes that failure mode impossible: loud located failure, a persisted log, and a success
  // banner that is EARNED by verification rather than reached by falling off the end.
  const inst = readFileSync(join(DEPLOY, "orwell-install.sh"), "utf8");

  it("fails loudly and located: ERR trap (inherited into functions) + per-step tracking", () => {
    expect(inst).toContain("set -Eeuo pipefail"); // -E so the trap fires inside functions
    expect(inst).toContain("trap 'on_err $LINENO' ERR");
    expect(inst).toContain("INSTALL FAILED during: ${STEP}");
    expect(inst).toMatch(/idempotent/i); // the trap tells the operator a re-run resumes
  });

  it("persists every run to an install log (pct exec output scrolls away)", () => {
    expect(inst).toMatch(/tee -a "\$INSTALL_LOG"/);
  });

  it("verifies the install before claiming success: units active + both health probes", () => {
    // The bare invocation line — the definition alone is not enough (mutation-verified: the
    // toContain form stayed green when the CALL was deleted from main()).
    expect(inst).toMatch(/^\s*verify_install\s*$/m);
    expect(inst).toMatch(/is-active --quiet orwell-engine/);
    expect(inst).toMatch(/is-active --quiet orwell-frontend/);
    expect(inst).toContain('"ok":true'); // the engine /health contract (same probe as smoke.sh)
    expect(inst).toContain("/openapi.json"); // the FE liveness contract (same probe as smoke.sh)
    // …and a verification failure surfaces the WHY (status + journal tails), not just a code.
    expect(inst).toMatch(/journalctl -u/);
  });

  it("guards up front: root required, ports validated before anything runs", () => {
    expect(inst).toMatch(/id -u.*-eq 0.*\|\|/s);
    expect(inst).toContain("is not a valid port");
  });

  it("git safe.directory is wired (the orwell-owned checkout must stay updatable by root git)", () => {
    expect(inst).toContain("safe.directory");
  });

  it("the UPDATER self-heals safe.directory before its first git call (F4 hit a real box)", () => {
    // Boxes installed before the F4 fix have an orwell-owned checkout and a root updater —
    // git >=2.35 refuses the very fetch that would deliver the fixed installer. The updater
    // must wire the exception itself, ahead of any git use.
    const upd = readFileSync(join(DEPLOY, "orwell-update.sh"), "utf8");
    expect(upd).toContain("wire_safe_directory");
    expect(upd).toMatch(/git config --system --add safe\.directory "\$APP_DIR"/);
    // The call precedes the first real git invocation (rollback's reset / the update fetch).
    expect(upd.indexOf("wire_safe_directory")).toBeLessThan(upd.indexOf('git -C "$APP_DIR" reset'));
  });

  it("ownership covers DATA_DIR explicitly (it is overridable to outside APP_DIR)", () => {
    expect(inst).toMatch(/chown -R orwell:orwell "\$\{APP_DIR\}" "\$\{DATA_DIR\}"/);
  });

  it("the drop-in/verification key on the EFFECTIVE port from data/.env, not the env arg", () => {
    // A re-run with a different env ORWELL_PORT must not drift the capability grant away from
    // the port the unit actually reads (its EnvironmentFile).
    expect(inst).toMatch(/\(\( EFFECTIVE_PORT < 1024 \)\)/);
    expect(inst).toMatch(/EFFECTIVE_PORT="\$\(sed -n 's\/\^ORWELL_PORT=\/\/p' "\$\{DATA_DIR\}\/\.env"/);
  });

  it("re-runs restart the services (a re-run after a rebuild must not keep stale processes)", () => {
    expect(inst).toContain("systemctl restart orwell-engine orwell-frontend");
  });

  it("the final message prints a browsable address, never 0.0.0.0", () => {
    expect(inst).toMatch(/hostname -I/);
    expect(inst).not.toContain("http://0.0.0.0");
  });
});

describe("container console access — the root password seam (orwell.sh)", () => {
  const text = readFileSync(join(DEPLOY, "orwell.sh"), "utf8");

  it("supports an optional CT_ROOT_PASSWORD (env + interactive prompt), applied via stdin", () => {
    expect(text).toContain("CT_ROOT_PASSWORD");
    expect(text).toContain("wt_password");
    // Applied through chpasswd on stdin — the password must never ride a pct command line
    // (pct create --password / a pct exec argv would land it in host ps).
    expect(text).toMatch(/printf 'root:%s\\n' "\$CT_ROOT_PASSWORD" \| pct exec/);
    expect(text).not.toMatch(/pct\s+(create|exec)[^\n]*--password/);
  });

  it("tells the operator how to get in either way (password set or not: pct enter always works)", () => {
    expect(text).toContain("pct enter");
    expect(text).toContain("-- passwd");
  });
});

describe("G19b ops trigger — web-requested update via the root path unit", () => {
  // The FE runs inside the E85-hardened unit (User=orwell, empty CapabilityBoundingSet=) and
  // structurally CANNOT systemctl or self-update. The sanctioned pattern: the web tier writes a
  // FLAG FILE (data/ops/update-requested); a root-side systemd PATH unit watches it and runs the
  // ONE fixed maintenance script, output appended to data/ops-update.log — the same data/*.log
  // surface the admin status page tails live (G1b). These gates pin the design's load-bearing
  // edges: existence-only trigger, flag-removed-before-run, the lock, the live log, and that
  // BOTH maintenance scripts reconcile the units onto existing boxes.
  const pathUnit = readFileSync(join(DEPLOY, "systemd", "orwell-ops-update.path"), "utf8");
  const svcUnit = readFileSync(join(DEPLOY, "systemd", "orwell-ops-update.service"), "utf8");
  const install = readFileSync(join(DEPLOY, "orwell-install.sh"), "utf8");
  const update = readFileSync(join(DEPLOY, "orwell-update.sh"), "utf8");

  it("both units exist and are non-trivial", () => {
    expect(pathUnit.length).toBeGreaterThan(100);
    expect(svcUnit.length).toBeGreaterThan(100);
  });

  it("the path unit watches the flag by EXISTENCE only — and documents that contract", () => {
    expect(pathUnit).toContain("PathExists=/opt/orwell/data/ops/update-requested");
    expect(pathUnit).toContain("Unit=orwell-ops-update.service");
    expect(pathUnit).toContain("WantedBy=multi-user.target");
    // The commission's safety line: the flag's content is ignored — never parsed or executed.
    expect(pathUnit).toMatch(/existence[- ]only/i);
  });

  it("the service removes the flag FIRST (no PathExists= retrigger loop), then runs", () => {
    expect(svcUnit).toContain("ExecStartPre=/bin/rm -rf --one-file-system -- /opt/orwell/data/ops/update-requested");
    expect(svcUnit.indexOf("ExecStartPre=/bin/rm -rf --one-file-system -- /opt/orwell/data/ops/update-requested"))
      .toBeLessThan(svcUnit.indexOf("ExecStart=/bin/bash"));
  });

  it("only the ONE fixed script path runs — the web tier picks WHEN, never WHAT", () => {
    expect(svcUnit).toContain("bash /opt/orwell/deploy/orwell-update.sh");
    // The flag may appear in Exec lines ONLY as the removal target — never read/sourced/run.
    const flagExecLines = svcUnit
      .split("\n")
      .filter((l) => l.startsWith("Exec") && l.includes("update-requested"));
    expect(flagExecLines).toEqual(["ExecStartPre=/bin/rm -rf --one-file-system -- /opt/orwell/data/ops/update-requested"]);
  });

  it("overlapping triggers no-op on the lock (flock) instead of stacking a second build", () => {
    expect(svcUnit).toMatch(/flock -n/);
    expect(svcUnit).toContain("exit 0"); // the no-op arm, not a failure
  });

  it("stdout+stderr append LIVE to the log the status page tails, with a per-run timestamp header", () => {
    expect(svcUnit).toContain("StandardOutput=append:/opt/orwell/data/ops-update.log");
    expect(svcUnit).toContain("StandardError=append:/opt/orwell/data/ops-update.log");
    expect(svcUnit).toMatch(/date -Is/); // the timestamped header per run
  });

  it("the service is a oneshot, ROOT by documented design (it must git/npm/systemctl)", () => {
    expect(svcUnit).toContain("Type=oneshot");
    // RemainAfterExit would pin the unit "active" and the path unit could never re-trigger.
    expect(svcUnit).not.toMatch(/^RemainAfterExit=/m);
    // Root is the point, not an oversight: no User= drop, and the WHY is written into the unit.
    expect(svcUnit).not.toMatch(/^User=/m);
    expect(svcUnit).toMatch(/deliberately root/i);
  });

  for (const [name, text] of [["orwell-install.sh", install], ["orwell-update.sh", update]] as const) {
    it(`${name} reconciles both ops units idempotently (the drop-in pattern)`, () => {
      expect(text).toMatch(/install -m 644 "[^"]*orwell-ops-update\.path"\s+\/etc\/systemd\/system\/orwell-ops-update\.path/);
      expect(text).toMatch(/install -m 644 "[^"]*orwell-ops-update\.service"\s+\/etc\/systemd\/system\/orwell-ops-update\.service/);
      // The TRIGGER is the path unit — enabled; the service is started by the watcher only.
      expect(text).toContain("enable --now orwell-ops-update.path");
      expect(text).not.toContain("enable --now orwell-ops-update.service");
    });

    it(`${name} creates the orwell-owned flag dir (the FE writes the flag) + the readable live log`, () => {
      expect(text).toMatch(/install -d -m 750 "[^"]*\/ops"/);
      expect(text).toMatch(/chown orwell:orwell "[^"]*\/ops"/); // the data/ops ownership line
      expect(text).toMatch(/touch "[^"]*ops-update\.log"/);
      expect(text).toMatch(/chmod 644 "[^"]*ops-update\.log"/);
      // `install` TRUNCATES an existing file — the live run log must never be created that way.
      expect(text).not.toMatch(/install [^\n]*ops-update\.log/);
    });
  }
});
