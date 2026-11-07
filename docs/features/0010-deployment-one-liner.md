# 0010 — One-liner deployment & update (Proxmox, containerized)

> **Status:** Built (see the [README status index](./README.md#index)). **Priority:** **MVP-1 (blocking)** — per product call, the deploy + update
> scripts are part of MVP 1, not a later add-on.
> **Executable spec:** [`0010-deployment-one-liner.feature`](./0010-deployment-one-liner.feature)

## 1. Summary

Two one-liners, run from the **Proxmox host shell**, in the spirit of the Proxmox VE
community-scripts:

```bash
# install (the repo is PRIVATE — ruling #17). EXPORT the token so the $(…) substitution — expanded
# by the OUTER shell — actually sees it; fetch via the GitHub contents API, not raw.githubusercontent
# (which 404s for fine-grained PATs). Works with a fine-grained (Contents: Read) OR classic (repo) PAT.
export GIT_TOKEN=github_pat_xxx
bash -c "$(curl -fsSL -H "Authorization: Bearer $GIT_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/Psychout-Media/orwell/contents/deploy/orwell.sh?ref=main")"
# update — run the LOCAL checked-out copy (no GitHub fetch; audit E84)
bash /opt/orwell/deploy/orwell-update.sh
```

The install creates a **container** and brings up Orwell (the TS engine **and** the Orwell
front-end, wired over local MCP per feature 0009); the update pulls, rebuilds, and restarts
**without losing the save**. Easy to deploy, easy to update.

The scripts live in [`deploy/`](../../deploy/) (`orwell.sh`, `orwell-install.sh`, `orwell-update.sh`,
`systemd/`). They target the engine's `npm run build` / `npm start` contract and **verify it
before building**. What remains for an end-to-end game is the engine's HTTP MCP transport and the
Orwell → engine MCP-client wiring; validation is an **install smoke test on a real Proxmox host**
(not the dev sandbox; not BDD).

## 2. Approach (containerization)

**Primary: Proxmox LXC** (community-scripts idiom — matches the referenced one-liner, lightest,
cleanest UX). One LXC runs both tiers as **systemd services**, wired over local MCP (stdio or
`127.0.0.1` HTTP):

```
 Proxmox host ──one-liner──► LXC (Debian)
                               ├─ orwell-engine.service     (Node: MCP server, feature 0009)
                               └─ orwell-frontend.service   (Python: uvicorn app:app — Orwell)
                               data: /opt/orwell/data  (SQLite save + souls; persists across updates)
```

*Alternative (noted, not primary): Docker-compose inside an LXC/VM* — reuses container images
for the two tiers; heavier, less idiomatic for the one-liner. Pick LXC unless we want image-based
distribution.

## 3. Install script — `deploy/orwell.sh` (host) + `deploy/orwell-install.sh` (in-container)

**Host side** (`orwell.sh`): create a Debian 12 LXC (sensible CPU/RAM/disk defaults, DHCP),
then run `orwell-install.sh` inside. Structurally aligns with community-scripts `build.func`
(can source it, or stay self-contained).

**In-container** (`orwell-install.sh`):
1. `apt update`; install `curl git build-essential`, **Node 22** (nodesource), **Python 3.12** + `venv`.
2. `git clone` Orwell → `/opt/orwell`.
3. **Engine:** `npm ci` → `npm run build` → provides `orwell-engine` (the MCP server entrypoint, 0009).
4. **Front-end:** `python -m venv frontend/.venv` → `frontend/.venv/bin/pip install -r frontend/requirements.txt`.
5. **Config:** copy `frontend/.env.example` → `/opt/orwell/data/.env`; set ports, LLM provider
   (Ollama host or Anthropic API key), and the engine MCP endpoint.
6. **Services:** write + enable `orwell-engine.service` and `orwell-frontend.service`; start both.
7. Print: `Orwell is running at http://<container-ip>:<port>`.

## 4. Update script — `deploy/orwell-update.sh` (idempotent, data-safe)

Inside the container: `cd /opt/orwell` → `git pull` → `npm ci && npm run build` →
`frontend/.venv/bin/pip install -r frontend/requirements.txt` → `systemctl restart orwell-engine
orwell-frontend`. **`/opt/orwell/data` is never touched** (saves/souls preserved — ties to #7
non-degradation). Re-running install is also safe (detects an existing install → updates).

## 5. Config & secrets

- All config via env / `/opt/orwell/data/.env` (LLM provider + keys, ports, MCP endpoint). **No
  secret is ever committed or baked into a script.** `.env.example` documents every variable.
- The container **is** the sandbox (one game namespace); each game's state lives under `data/`.

## 6. Acceptance criteria / Definition of Done

- [x] On a **fresh Proxmox host**, the install one-liner creates the container and brings the UI
      up reachable on its port, with **no manual steps** beyond entering LLM config.
      *(Owner-confirmed 2026-11-02: the deploy runs in production on the owner's Proxmox host, which
      exercises LXC provisioning and the `pct`/`pvesh` bridge end to end. `deploy/smoke.sh` in CI still
      covers build → probe → update only.)*
- [x] The update one-liner pulls + rebuilds + restarts and the **existing save survives**
      (`data/` is never touched; asserted by the smoke).
- [x] Both scripts are **idempotent** (safe to re-run).
- [x] Secrets come only from env/`.env`; nothing sensitive is committed *(static guard:
      `tests/unit/secrets.test.ts`)*.
- [x] An install **smoke test** passes — `deploy/smoke.sh` (build → start → probe HTTP MCP →
      exercise game tools → channel isolation → update) runs in CI (`.github/workflows/ci.yml`).
      Full Proxmox-LXC provisioning remains the on-host test (no LXC in GitHub Actions).

## 7. Dependencies (why this is sequenced after 0009)

The scripts are **designed now**; they go **functional** once the app is runnable end-to-end:
- **0009** built — the engine exposes a **`orwell-engine` MCP-server entrypoint** + `npm run build`
  / start scripts (the engine currently runs via `tsx` with no `build`/`start` — that lands with 0009).
- The **Orwell front-end wired** to the engine (per `frontend/INTEGRATION.md`) with a known
  run command (`uvicorn app:app`) and the MCP endpoint configured.
- **#7** persistence: a stable `data/` save path.

So the **MVP-1 critical path** is: build 0009 → engine `start` entrypoint + front-end wiring →
finalize + smoke-test these scripts. MVP 1 is **not done until these are green**.

## 8. Traceability

The referenced Proxmox community-scripts one-liner pattern; feature 0009 (topology); feature
0007 (persistent save); `frontend/INTEGRATION.md` (the two tiers); `CLAUDE.md` sandboxing
("each running game is its own isolated sandbox").
