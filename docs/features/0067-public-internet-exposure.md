# 0067 — Public internet exposure & internet-grade hardening (hiorwell.com)

**Status:** ✅ **Built · follow-on owed (host smoke)** · **gate: FE (pytest) + scripts (deploy)** — a
recorded deviation from the BDD-default (matching 0066/0055): the `.feature` is the spec of record, but
the behaviour is host/ops + FE-config, so the executable gates are the FE pytest suite and the
deploy-script lints, not a new Cucumber world. The TS engine is **unchanged** by this feature. The
**option-independent hardening floor is built** (the four FE pytest files in §6); the front-specific
exposure kit ships **Cloudflare Tunnel + Access** as the chosen default (ADR 0007). Owed: the real-host
smoke of the exposed path (folds into 0010).
**Executable spec:** [`0067-public-internet-exposure.feature`](./0067-public-internet-exposure.feature)
**Provenance:** ADR [`0007`](../decisions/0007-public-internet-exposure.md) (public internet exposure of
the player tier); PO direction 2026-06-20 ("we bought hiorwell.com — get it on the internet, HTTPS +
internet-grade security now").

## 1. Summary

Put the **player front-end** on `hiorwell.com` over HTTPS with an internet-grade perimeter, while the
**engine stays private** and **gameplay is unchanged**. Two halves (ADR 0007): an **option-independent
hardening floor** built in-repo here, and a **pluggable exposure layer** (Cloudflare Tunnel + Access
*recommended for launch*; Pangolin on a hardened VPS the self-hosted alternative; plain VPS + Caddy the
DIY fallback) that carries TLS + the public hostname and keeps the origin LXC at zero inbound ports.

Nothing here reads the Vault, moves an outcome, or relaxes cross-user isolation — it changes the
**transport and the perimeter**, not the trust model. The FE only ever handles Vault-free projections of
the player's own game, so whatever terminates TLS can only see narrated gameplay, never secret state.

## 2. What exists today

- Engine: HTTP MCP, `ORWELL_ENGINE_PORT` 8765, **already loopback** (`ORWELL_ENGINE_HOST` default
  `127.0.0.1`, `src/main.ts:59`) + optional bearer/admin tokens + multiuser guard (E1/B34). **Correct as
  is — do not change.**
- FE: uvicorn bound **`0.0.0.0:8080` plaintext** with **no TLS / no reverse proxy**
  (`deploy/systemd/orwell-frontend.service:46`). `AUTH_ENABLED` default `true`; `SECURE_COOKIES` default
  `false`; `ALLOWED_ORIGINS` default localhost (`app.py:96`); `CORSMiddleware` + `SecurityHeadersMiddleware`
  present (HSTS already set when behind TLS, `core/middleware.py:111`); **no `TrustedHostMiddleware`**.
- Login **is** throttled (`auth_routes.py:85`, `RateLimiter` 15/min) — but it keys on
  `request.client.host`, which **behind a tunnel is `127.0.0.1` for every visitor**, collapsing the
  throttle into one useless global bucket. That proxy-IP keying — not a missing limiter — is the real gap.
- `require_admin` **short-circuits when `AUTH_ENABLED=false`** — a public host with auth off silently
  unlocks God Mode. `LOCALHOST_BYPASS` (default false) bypasses auth for loopback.
- E85 systemd sandboxing on both units; `orwell-backup.sh`/`restore.sh` exist; deploy is Proxmox-LXC.

## 3. Scope

**In (built in-repo):**
- **`ORWELL_BIND_HOST`** for the FE (default **`127.0.0.1`**), replacing the hardcoded `--host 0.0.0.0`
  in the systemd unit; uvicorn `--proxy-headers --forwarded-allow-ips=<proxy>`.
- A **public-profile fail-closed boot guard** (`core.middleware.assert_public_profile_safe`): when the
  public profile is selected (`ORWELL_PUBLIC=1`), the FE **refuses to start** if `AUTH_ENABLED=false`,
  `LOCALHOST_BYPASS=true`, `SECURE_COOKIES!=true`, or `ALLOWED_HOSTS` is unpinned — naming every
  offending knob. Called at `app.py` module load ⇒ unsafe ⇒ the process exits non-zero.
- **`TrustedHostMiddleware`** with `ALLOWED_HOSTS` (default `["*"]` ⇒ no-op for dev/LAN) — Host-header
  attacks rejected on a public deploy.
- **Login brute-force fix**: the existing per-IP login/signup/setup throttles are made correct behind a
  tunnel — keyed on the **real client IP** (`src.rate_limiter.client_ip`: `CF-Connecting-IP` /
  `X-Forwarded-For` first hop / `X-Real-IP`, trusted only under `ORWELL_PUBLIC`/`TRUST_PROXY_HEADERS`),
  not the proxy's `127.0.0.1` global bucket. (Per-username lockout is deliberately **out** — it adds a
  targeted-lockout DoS; the real defense is the edge auth gate + the per-real-IP throttle.)
- A **`deploy/expose/` kit** (templates, not secrets): a `cloudflared` `config.yml` (FE-only `ingress`,
  engine never listed), a Pangolin **Newt** compose, a `Caddyfile` (auto-TLS + security headers +
  optional `caddy-ratelimit`), and a host snippet (ufw `default deny incoming`, fail2ban `sshd`,
  `unattended-upgrades`). Plus a `docs/INSTALL.md` **"Public deployment (hiorwell.com)"** section.
- `.env` template + installer note for the public knobs (`SECURE_COOKIES`, `ALLOWED_ORIGINS`,
  `ORWELL_BIND_HOST`, `ALLOWED_HOSTS`, `ORWELL_PUBLIC`).

**Out (ops / owner-confirmed elsewhere):**
- Standing up the actual VPS / Cloudflare account, DNS records, and certificates — runbook, not code.
- The **exposure-layer pick** itself (ADR 0007 Open item) — the floor is built regardless; the
  front-specific wiring is finished once the owner confirms.
- Shorter session TTL + server-side revocation on logout: built (#581: a 24h default, `ORWELL_SESSION_TTL_HOURS` clamped to 1h..30d; logout revokes the token on the server), proven by `frontend/tests/test_orw819_session_lifetime.py`.
- Any DDoS/WAF beyond what the chosen front provides (Cloudflare free tier; or `caddy-ratelimit`/Coraza).

## 4. Design

- **Engine privacy is by construction, not configuration.** The engine is never named in any public
  artifact; the only thing the front routes to is the FE bind (`ORWELL_BIND_HOST:ORWELL_PORT`). A test
  greps the exposure kit for the engine port and fails if it appears.
- **The FE binds private; the front faces the world.** Under Cloudflare Tunnel / Pangolin, the connector
  runs on the LXC and reaches the FE at `127.0.0.1:8080`; under VPS+Caddy, Caddy reaches the LXC over
  WireGuard. Either way the FE never binds a public interface.
- **Fail closed.** The public profile validates its own security posture at boot and **dies loudly** on
  an unsafe combination rather than serving the game in the clear or with auth off. Default
  (non-public) behaviour is byte-identical — the guard only arms when `ORWELL_PUBLIC=1`.
- **Defense in depth on auth.** App login (already there) + edge rate-limit + (recommended) an edge
  identity gate (Cloudflare Access email-OTP / Pangolin SSO) in front. The Vault Wall and 0021 isolation
  remain the structural guarantees underneath; this only adds perimeter.
- **HSTS already handled** — `SecurityHeadersMiddleware` sets HSTS whenever the request is HTTPS
  (`X-Forwarded-Proto: https`, which `--proxy-headers` makes honest); the terminator (Cloudflare/Caddy)
  also asserts it. No new HSTS code needed.

## 5. Contracts (stack-agnostic)

```
FE env:   ORWELL_PUBLIC (default 0)        # arms the public-profile boot guard
          ORWELL_BIND_HOST (default 127.0.0.1)   # FE listen address (was hardcoded 0.0.0.0)
          AUTH_ENABLED=true · LOCALHOST_BYPASS=false · SECURE_COOKIES=true  # required when public
          ALLOWED_ORIGINS=https://hiorwell.com   # CORS
          ALLOWED_HOSTS=hiorwell.com,www.hiorwell.com   # TrustedHostMiddleware allow-list
          TRUST_PROXY_HEADERS    # also turns on real-client-IP resolution (auto-on under ORWELL_PUBLIC)
boot:     ORWELL_PUBLIC=1 + any-unsafe-knob  ⇒  refuse to start (exit non-zero, named reason)
mw:       TrustedHostMiddleware(allowed_hosts=ALLOWED_HOSTS)   # 400 on Host mismatch; default ["*"]
login:    throttle keyed on client_ip(request) → real IP behind the tunnel, not a global 127.0.0.1 bucket
engine:   ORWELL_ENGINE_HOST stays 127.0.0.1; the engine port NEVER appears in any deploy/expose/* artifact
deploy:   deploy/expose/{cloudflared/config.yml, pangolin/newt.compose.yml, caddy/Caddyfile, host-hardening.sh}
```

## 6. Definition of Done

- ✅ `frontend/tests/test_public_profile_guard.py` — the public profile **refuses to boot** with
  `AUTH_ENABLED=false`, `LOCALHOST_BYPASS=true`, `SECURE_COOKIES=false`, or an unpinned `ALLOWED_HOSTS`
  (each refusal names the offending knob); boots green when all safe; and is **dormant when
  `ORWELL_PUBLIC` is unset** (default start path byte-identical).
- ✅ `frontend/tests/test_trusted_host.py` — a Host header outside `ALLOWED_HOSTS` is rejected (400);
  the configured domain is accepted; the default `["*"]` accepts any Host.
- ✅ `frontend/tests/test_login_throttle.py` — `client_ip` returns the transport peer when proxy trust
  is off (no spoofing), and the real `CF-Connecting-IP`/`X-Forwarded-For`/`X-Real-IP` when on; two
  different real IPs get **independent** rate-limit buckets (not one global bucket).
- ✅ `frontend/tests/test_public_deploy_config.py` — the FE unit binds `${ORWELL_BIND_HOST}`
  (default `127.0.0.1`, with `--proxy-headers`), **not** `0.0.0.0`; and **no file under `deploy/expose/`
  names the engine port** (engine-never-public, structural).
- The full FE suite (`cd frontend && python3 -m pytest tests/`) and `deploy/smoke.sh` stay green with the
  FE on loopback behind the proxy/connector. The engine's `npm test` is **untouched** (no engine change),
  and the dependency-cruiser Vault-Wall + vault sentinels + 0021 isolation tests remain green.

## 7. Dependencies & traceability

- Governed by: ADR **0007** (public internet exposure); the Vault Wall (0001) + cross-user isolation
  (0021), both unchanged; private-repo ruling #17.
- Builds on: the E1/B34 engine edge guardrails (`src/main.ts`), the FE auth tier (0021/0029), the E85
  systemd hardening, `orwell-backup.sh`/`restore.sh`.
- Followed by: `docs/INSTALL.md` public section (shipped); **0010** host smoke of the exposed path
  during the private-repo flip (owed: ORW-819); session TTL and revocation are built (see above).

## 8. Decisions & remaining items (ORW-819)

1. ✅ **Exposure layer (ADR 0007):** **Cloudflare Tunnel + Access** (owner, 2026-06-20) — the
   `deploy/expose/cloudflared/` kit + the INSTALL runbook ship it as the default; Pangolin (`pangolin/`)
   and Caddy (`caddy/`) remain documented alternatives.
2. **Edge auth gate (recommended, ops):** stand up Cloudflare **Access** (email-OTP allow-list) over
   `hiorwell.com` **in addition** to the app login — cheap defense-in-depth for a low-N user base.
   Dashboard config, not code.
3. ✅ **`ORWELL_PUBLIC` ergonomics:** a single profile flag — keeps the default/dev path byte-identical
   and the guard explicit (built).
4. **Session hardening (split follow-on):** shorter session TTL + server-side revocation on logout —
   independent of exposure; tracked as ORW-819, not part of this feature.
5. **Owed:** the real-host smoke of the exposed path (folds into 0010, during the private-repo flip).
