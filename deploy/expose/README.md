# deploy/expose/ — putting the player tier on the internet (any domain)

Reference configs for exposing the **player front-end** over HTTPS with an internet-grade
perimeter. Governed by **ADR [`0007`](../../docs/decisions/0007-public-internet-exposure.md)** and
feature **[`0067`](../../docs/features/0067-public-internet-exposure.md)**. Full runbook:
`docs/INSTALL.md → Public deployment (any domain)`.

## Just want HTTPS on the LAN? (no domain, no internet)

If your goal is a trusted `https://orwell.lan` / `https://<lan-ip>` for the household — **not** a public
site — you don't need any of the options below. Use **local HTTPS** (feature
[`0074`](../../docs/features/0074-local-and-tunable-https.md) / ADR
[`0014`](../../docs/decisions/0014-local-and-tunable-https.md)): `orwell https --mode local` (or the
Admin "Local HTTPS" card) stands up a Caddy terminator with a built-in CA, and each device trusts the
root once (`/orwell-local-ca.crt`) to silence the browser warning. It works with or without any of the
public options here. Reference config: [`caddy/local.Caddyfile`](caddy/local.Caddyfile). The rest of
this page is about the **public internet**.

## The rule that makes this safe

Only the **front-end** is ever exposed. The **engine is engine-only** and stays bound to loopback;
it is never given a tunnel `ingress` entry, a `reverse_proxy` route, or a firewall allow rule. It
is unreachable from the internet **by simply never being named** in any file here. The FE also only
ever serves **Vault-free projections of the player's own game**, so whatever terminates TLS can see
narrated gameplay — never secret state, never another user's game.

Before exposing, the FE must run the **public profile** (`docs/INSTALL.md`): `ORWELL_PUBLIC=1`,
`AUTH_ENABLED=true`, `LOCALHOST_BYPASS=false`, `SECURE_COOKIES=true`,
`ALLOWED_HOSTS=your-domain.example,www.your-domain.example`, `ALLOWED_ORIGINS=https://your-domain.example`. The app
**refuses to boot** if any of those is unsafe.

> All targets below use the FE port **8080** (the installer default `ORWELL_PORT`). If you changed
> `ORWELL_PORT`, change it here too.

## WebSockets through the perimeter (WS Phase-1 turn-on)

The player tier ships a **multiplexed WebSocket transport** (ADR
[`0017`](../../docs/decisions/0017-multiplexed-websocket-session-transport.md); wire spec
`docs/design/websocket-phase1-protocol.md`) that re-hosts the live chat stream, the mirror
resume, and the HUD/presence pushes on **one socket per tab** at `GET /api/ws/session`. It is
**the game build's only transport** (ORW-44, 2026-11-12; it was default-on since 2026-07-10, #1357). The `ORWELL_WS_TRANSPORT` flag no longer exists: setting it
(to 0 or 1) changes nothing, and there is no SSE/poll fallback in the game build. A terminator or network that does not pass the WebSocket `Upgrade` shows the player
"this network blocks the live connection" and the game cannot be played there. (The non-game build, `ORWELL_GAME_BUILD=0`, keeps its SSE/poll stack.)

> **Origin guard (CSWSH).** The WS handshake in `frontend/routes/ws_routes.py` authenticates by session cookie **and** enforces an `Origin` allowlist
> before accepting the upgrade (`_ws_origin_allowed`: a present, foreign `Origin` is refused; same-origin scheme + host + port, or an entry in `ALLOWED_ORIGINS`,
> is accepted; a non-browser client with no `Origin` is allowed). HTTP CORS middleware does not cover a WebSocket upgrade, which is exactly why the guard lives
> in the handshake. *(2026-11-12 doc fix: this block used to say the guard was "not yet met" and told operators to keep the WS flag off on public deploys. The guard
> has been in place since #1349, and the flag no longer exists, so that advice was both stale and unactionable.)*

**Every terminator here passes the upgrade with no extra config.** Turning WS on adds **no new route
and no new port** — it is the *same* FE endpoint, so the "only the front-end is ever exposed" rule
above is unchanged. What it *does* change is that an authenticated socket becomes reachable, which is
why the handshake enforces the Origin guard above.

| Terminator | WebSocket handling | Action needed |
|---|---|---|
| **Direct uvicorn** (LAN / loopback) | `websockets` is pinned in `frontend/requirements*.txt`; uvicorn's default `--ws auto` enables it. The systemd unit does **not** pass `--ws none`. | none |
| **Caddy** (`orwell https`, Option C) | `reverse_proxy` proxies the `Upgrade`/`Connection` handshake transparently, streams unbuffered, and applies no idle timeout to the hijacked connection. | none |
| **Cloudflare Tunnel** (Option A) | `cloudflared` + the Cloudflare edge proxy WebSockets natively. | none |
| **Pangolin / Newt** (Option B) | The Newt connector (Traefik-based) proxies WebSockets natively. | none |

Two things make the long-lived socket robust across any of these: the server sends an
application-level `ping` **every 20 s** (client replies `pong`), which keeps intermediaries from
idling the connection out; and a client that genuinely *cannot* upgrade (a restrictive corporate
MITM, an ancient browser) **falls back to the SSE/poll transport automatically** — that fallback
is a permanent path, not a transitional one, so a proxy that strips the upgrade degrades cleanly
rather than breaking the game.

**Verify the upgrade reaches uvicorn.** Force HTTP/1.1 (`Connection: Upgrade` is an HTTP/1.1
mechanism — over an HTTP/2 negotiation the header is invalid and the check is meaningless):

```bash
# Directly against the FE — no auth wall on loopback. Expect: 101.
curl --http1.1 --max-time 5 -sSi -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://127.0.0.1:8080/api/ws/session
# Through the terminator, swap the URL for https://your-domain.example/api/ws/session
```

Read the status code:

- **`101` Switching Protocols** — the upgrade was proxied through to uvicorn. ✅ (Unauthenticated it
  then closes immediately; the `101` still proves the pipe.)
- **`302` / `401` / `403`** — the **perimeter auth wall** answered, *not* a WS/proxy failure. An
  authenticating terminator (e.g. Cloudflare **Access**, a Pangolin gate) refuses the request before
  it reaches uvicorn. Re-run with an **authenticated session** — a real logged-in cookie, or the
  terminator's service token / bypass — to see the `101` behind it. The proxy is fine; you just have
  to get past the gate.
- **`200` / `400` / `404` / `426`** — the upgrade was **NOT** proxied (buffered, downgraded to plain
  HTTP, or the route is missing). This is the actual "WS doesn't pass" failure to fix.

## Option A — Cloudflare Tunnel + Access  *(recommended)*

Fastest path to internet-grade: an outbound-only tunnel (the origin opens **zero inbound ports**),
free unmetered DDoS + the free WAF managed ruleset + Bot Fight Mode, automatic edge HTTPS, and
Cloudflare **Access** (email-OTP / SSO) as a login wall in front of the FE.

- `cloudflared/config.yml` — the tunnel ingress (FE only; the engine is intentionally absent).

```bash
cloudflared tunnel login                       # pick the your-domain.example zone
cloudflared tunnel create orwell               # writes the UUID + credentials json
cloudflared tunnel route dns orwell your-domain.example
# copy cloudflared/config.yml to /etc/cloudflared/config.yml, fill in <TUNNEL-UUID>
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

Then in the dashboard: enable the **WAF Free Managed Ruleset** + **Bot Fight Mode**, add an
**Access** application over `your-domain.example` (email-OTP allow-list), and (optional) **Turnstile** on
the login form. Trade-off: a Cloudflare dependency and edge TLS visibility (the edge decrypts to run
the WAF). Keep large AI media served from the provider's own URLs, not proxied in bulk (CDN terms).

## Option B — Pangolin on a hardened VPS  *(self-hosted control)*

TLS terminates on a small VPS **you** run; the origin still opens zero inbound ports (the **Newt**
connector dials out over WireGuard). Adds an SSO / PIN / password / email-allow-list gate for free.

- `pangolin/newt.compose.yml` — the Newt connector for the origin host.

Install Pangolin on the VPS (`curl -fsSL https://static.pangolin.net/get-installer.sh | bash`),
create a **Site** (Newt), run the compose on the LXC, then register a single HTTP **resource**
targeting the FE — and **do not** register the engine. Trade-off: a ~$5/mo VPS you patch, and no
managed DDoS/WAF (front it with Cloudflare later, locking the VPS firewall to Cloudflare IPs).

## Option C — Plain VPS + Caddy  *(DIY fallback)*

A public VPS running Caddy (automatic Let's Encrypt), reaching the FE over WireGuard so the origin
stays private. Most manual; pick A or B unless you specifically want a bare reverse proxy.

- `caddy/Caddyfile` — auto-TLS + security headers + an optional login rate-limit.

## Host hardening (every option)

- `host-hardening.sh` — a **reference** script (review before running) for the public host: ufw
  (`default deny incoming`), fail2ban (`sshd`), and `unattended-upgrades`. Under a pure outbound
  tunnel (Option A) you open **no** inbound ports except SSH.
