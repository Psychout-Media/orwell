# 0068 — Admin "Public deployment / Connect to the internet" (UI-driven exposure)

**Status:** 🚧 **Built · follow-on owed (host smoke)** · **gate: FE (pytest) + scripts (deploy)** — a
recorded deviation from the BDD-default (like 0066/0067): the behaviour is admin-UI + ops + host config,
gated by the FE pytest suite (`test_public_deployment_routes.py` · `test_public_deployment_ui.py` ·
`test_public_deployment_ops.py`) and the deploy-script lints (`opsPrivateRepo.test.ts`), not a new
Cucumber world. The TS engine is **unchanged**. Built in three lanes (routes / deploy-ops / UI). Owed:
the real-host smoke of an actual Cloudflare token → Connect (folds into 0010).
**Executable spec:** [`0068-admin-public-deployment.feature`](./0068-admin-public-deployment.feature)
**Provenance:** ADR [`0007`](../decisions/0007-public-internet-exposure.md) (public exposure) + feature
[`0067`](./0067-public-internet-exposure.md) (the hardening floor this drives); PO direction 2026-06-21
(*"ALL of that needs to be wired into UI before it can go to prod… Full"* — the settings panel **plus** a
token-paste Connect wizard with live status).

## 1. Summary

Make the 0067 public deployment **configurable from the admin UI** — no SSH, no hand-editing
`data/.env`, no manual `cloudflared`. A **"Public deployment"** card in **Settings → System** with a
security-posture checklist and a **"Connect to the internet"** wizard that: takes a **Cloudflare
remotely-managed tunnel token**, applies the public profile, installs & runs the connector through the
**existing privileged ops mechanism**, restarts the FE to apply, and shows **live tunnel + public-URL
status**. Cloudflare-account-side steps (add the domain, create the tunnel + hostname, Access/WAF) stay
in Cloudflare's dashboard — the wizard links to them and collects the resulting token.

Nothing here reads the Vault, moves an outcome, or relaxes isolation. It is an **operator console** over
the 0067 floor; the default (non-public) deploy is unchanged until an admin acts.

## 2. Why a *remotely-managed* tunnel (the key simplification)

A **locally-managed** cloudflared needs interactive `tunnel login` (browser OAuth *on the box*) +
`tunnel create` + a hand-edited `config.yml` + `route dns` — none of it UI-shaped. A **remotely-managed
tunnel** moves all of that into the Cloudflare Zero Trust dashboard; the box side collapses to a single
`cloudflared service install <TOKEN>`. So the UI surface becomes **paste token → Connect**. This is
ADR 0007's recommended option, made UI-shaped — and it's why "wire it into the UI" is a focused panel,
not a huge build.

## 3. The boundary — what the UI can and cannot automate

- **In-app, automated (the box side):** the public-profile env
  (`ORWELL_PUBLIC`/`ALLOWED_HOSTS`/`ALLOWED_ORIGINS`/`SECURE_COOKIES`), installing + running cloudflared
  with the token, restarting the FE to apply, and surfacing status — all via the **root ops mechanism**.
- **Cloudflare-account, guided not automated:** sign up, add the domain (nameserver change at the
  registrar), create the tunnel + map the public hostname → `http://127.0.0.1:8080`, and add Access/WAF.
  The wizard shows these as steps with deep links and an **"I've done this — paste my connector token"**
  field. **Orwell never holds your Cloudflare account** (no API token, no account creds) — by design.

## 4. What exists today (reuse, don't reinvent)

From the FE admin/ops recon (2026-06-21):

- **Admin settings modal** — `frontend/static/index.html`, the **System** panel (`data-settings-panel="system"`)
  already hosts Data Backup / Transcripts / **Health & Logs** / **Danger Zone** cards. The new card slots
  here. JS in `frontend/static/js/admin.js`; `initHealthLogs()` is the panel template; `open(tab)` is the entry.
- **Settings store** — `frontend/src/settings.py` (`data/settings.json`, per-request + 2s cache). **But the
  public-profile knobs are env/boot-read** (`AUTH_ENABLED`, `ALLOWED_ORIGINS`, `ORWELL_PUBLIC`,
  `ALLOWED_HOSTS`; `SECURE_COOKIES` per-request), so applying them is an **`.env` write + FE restart**, not
  a `settings.json` write.
- **Privileged ops mechanism** — flag-file → root `.path` unit → root oneshot `.service` → deploy script →
  progress JSON (`data/ops/<action>-status.json` via `orwell-ops-progress.sh`) + `ops-<action>.log`.
  Routes template: `frontend/routes/admin_update_routes.py` (`_trigger_via_flag` / `_watcher_installed` /
  `_write_failed_status`); status `frontend/routes/admin_ops_status_routes.py` (`GET /api/admin/ops-status`);
  the `/admin/status` page already renders the ops timeline. Actions today: **update, factory-reset,
  update-reset**. **This is exactly the seam a "Connect" action reuses.**
- **Health** — `GET /api/admin/health` (engine/frontend/images tiers). `require_admin` gates the ops routes
  (entitlements 0029 exist; `manage_deployment` is a future split — reuse `require_admin` for parity now).
- **The 0067 floor** — `assert_public_profile_safe` (validate a proposed env, fail closed), `ORWELL_BIND_HOST`,
  `client_ip`, `TrustedHostMiddleware` — all already in place to build on.

## 5. Design

### 5.1 The panel (Settings → System → "Public deployment")

- **Status row** (from §5.3): public on/off · FE bind · cloudflared service state (active/inactive) · the
  public URL (if known) · a green/amber **security checklist** (auth on, secure cookies, host pinned).
- **Connect wizard** (stepper modal): (1) Cloudflare account + add-domain (links + a "done" checklist);
  (2) create a tunnel & map the public hostname → `http://127.0.0.1:8080` (instructions + link); (3) paste
  the **connector token** + the **domain(s)** → **Connect**. Progress streams via the existing ops UI.
- **Disconnect** button → back to LAN-only (stop the connector, flip `ORWELL_PUBLIC` off) via the same path.

### 5.2 Apply via a NEW ops action (root); config + secret are side-inputs (the flag stays existence-only)

`POST /api/admin/public-deployment/apply` (`require_admin`):
1. Build the **proposed env** (`ORWELL_PUBLIC=1`, `ALLOWED_HOSTS=<domains>`, `ALLOWED_ORIGINS=https://<domain>`,
   `SECURE_COOKIES=true`).
2. **Validate at request time** with `assert_public_profile_safe(proposed)` → **400 with the named reason**
   if unsafe (e.g. no domain ⇒ unpinned host). Fail closed **before** writing — never persist an unsafe combo.
3. Write the **non-secret** config to `data/ops/public-deployment.json`; write the **connector token** (if
   present) to `data/ops/cloudflared-token` (mode `600`, owned `orwell`); write the **existence-only** flag
   `data/ops/public-deployment-requested`. Return `{started, via:"flag-trigger", log:"ops-public-deployment.log"}`
   (reuse `_trigger_via_flag`; `_write_failed_status` if no watcher installed).

`orwell-ops-public-deployment.service` (root oneshot, modeled on `orwell-ops-update.service`): `ExecStartPre`
removes the flag, `flock -n`, logs to `ops-public-deployment.log`. It runs
**`deploy/orwell-ops-public-deployment.sh`**, which: reads the side config; **idempotently upserts** the keys
into `/opt/orwell/data/.env`; if a token file is present → ensures cloudflared is installed (apt, idempotent)
+ `cloudflared service install <token>` + `enable --now`; **`systemctl restart orwell-frontend`** (so the new
env applies); **shreds** the token file; writes progress via `orwell-ops-progress.sh`.

`POST /api/admin/public-deployment/disconnect` → its own flag → set `ORWELL_PUBLIC` off in `.env`,
`systemctl disable --now cloudflared` (leave it installed), restart the FE.

### 5.3 Status

`GET /api/admin/public-deployment-status` (`require_admin`) →
`{enabled, bindHost, allowedHosts, secureCookies, authEnabled, hostPinned, tunnel:{installed, active, publicUrl?}, lastApply}`.
`tunnel.active` is a **read-only** `systemctl is-active cloudflared`; `lastApply` reads
`data/ops/public-deployment-status.json`. Add `"public-deployment"` to `admin_ops_status_routes`'s known
actions so the existing progress UI covers the apply. **The token is NEVER returned** by any GET.

### 5.4 Secret handling (the connector token)

Write-only: accepted on apply, persisted only transiently to `data/ops/cloudflared-token` (`600`, `orwell`),
consumed + shredded by the root script, and **never echoed** in any response (status reports
`installed`/`active`, never the token) — same masking discipline as the integrations flow.

## 6. Contracts (stack-agnostic)

```
routes (require_admin):
  GET  /api/admin/public-deployment-status        -> posture booleans + tunnel{installed,active,publicUrl?} + lastApply  (NO token)
  POST /api/admin/public-deployment/apply  {domains[], allowedOrigins?, tunnelToken?}
        -> assert_public_profile_safe(proposed) [400 + named reason if unsafe] -> side files + flag -> {started,via,log}
  POST /api/admin/public-deployment/disconnect    -> flag -> {started,...}
ops:    flag   data/ops/public-deployment-requested        (existence-only)
        config data/ops/public-deployment.json             (non-secret desired env)
        secret data/ops/cloudflared-token                  (600; shredded by the root script)
        status data/ops/public-deployment-status.json + ops-public-deployment.log
units:  deploy/systemd/orwell-ops-public-deployment.{path,service}   (root oneshot, like update)
script: deploy/orwell-ops-public-deployment.sh   (.env upsert + cloudflared install/run + FE restart + token shred)
install: orwell-install.sh / orwell-update.sh install + reconcile the new units (like the other ops units)
ui:     static/index.html System-panel card + Connect stepper; static/js/admin.js initPublicDeployment()
```

## 7. Definition of Done

- `frontend/tests/test_public_deployment_routes.py` — apply **validates** with `assert_public_profile_safe`
  (unsafe ⇒ 400 + named reason, **nothing persisted**); on safe input writes the flag + config + the token
  (`600`); the token is **never** returned by the status route; all three routes are **admin-gated** (403 for
  non-admin); disconnect writes its flag.
- `frontend/tests/test_public_deployment_ops.py` (or extend `test_public_deploy_config.py`) — the new
  `.path`/`.service` carry oneshot + root + `ExecStartPre` flag-removal + `flock` + the log path; the
  installer **and** updater install them; the script passes `bash -n` and **never echoes the token**; and the
  **engine port still appears in no exposure/ops artifact** (extends 0067's structural test).
- The 0067 floor tests + the **full** FE suite (`cd frontend && python3 -m pytest tests/`) + the engine
  `npm test` stay green; the default non-public path is byte-identical (the panel only acts on an admin click).
- **Host smoke (owed, folds into 0010):** a real Cloudflare remotely-managed token → Connect brings the
  tunnel up and the public URL serves; Disconnect returns to LAN-only.

## 8. Out of scope / later items (ORW-819)

- Cloudflare **Access / WAF / DNS** config stays dashboard-side (the wizard links to it; it is account-level,
  not box-level).
- Alternative providers (ngrok, Tailscale Funnel) behind a provider selector — **cloudflared first**.
- Locally-managed tunnel (interactive `login`) — explicitly **not** pursued; the token path is the UI path.
- Bundling cloudflared in the image vs apt-install on demand — **apt on demand first**.
- Shorter session TTL + logout revocation (the 0067 item) is built and proven (`frontend/tests/test_orw819_session_lifetime.py`), independent of this panel.

## 9. Implementer handoff — open questions

1. **Provider scope:** cloudflared only (recommended) vs a small provider abstraction now.
2. **Entitlement:** reuse `require_admin` (recommended — matches the other ops routes) vs split a
   `manage_deployment` entitlement (0029) now.
3. **Action shape:** one `apply` (connect / update-config) + one `disconnect` (proposed) vs a single action
   with a mode arg.
4. **Public URL for status:** cloudflared remotely-managed doesn't expose the hostname locally, so the admin's
   typed domain (stored on apply) is the source of truth for the displayed URL — confirm that's acceptable.
