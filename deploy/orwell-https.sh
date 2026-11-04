#!/usr/bin/env bash
#
# orwell — local & tunable HTTPS for the player tier (feature 0074 / ADR 0014).
#
# Stands up a TLS-terminating reverse proxy (Caddy) IN FRONT of the front-end on the LAN, driven by
# tunable ORWELL_TLS_* variables in data/.env. It covers three entrypoints with HTTPS and NO browser
# "your connection is not private" dialog:
#   • orwell.lan / orwell.local  — an internal CA (offline, no domain needed); trust the root once.
#   • the raw LAN IP             — same internal CA.
#   • (optional) a public domain — a publicly-trusted cert via a DNS-01 challenge (zero per-device
#                                  install), when ORWELL_TLS_DOMAINS + a DNS provider/token are set.
#
# Local HTTPS works WHETHER OR NOT the public domain is configured. The engine is NEVER named in the
# generated Caddyfile (only 127.0.0.1:${ORWELL_PORT}); engine port 8765 stays loopback-only.
#
# This is the SINGLE SOURCE OF TRUTH for the apply. Both control surfaces call it:
#   • the `orwell https` control-panel action (deploy/orwell-menu.sh), and
#   • the in-app Admin "Local HTTPS" card → orwell-ops-tls.sh (the root ops runner) → this script.
#
# Run it EITHER on the Proxmox HOST (it locates the orwell LXC and runs INSIDE it) OR directly inside
# the container — same host→container bridge as orwell-change-port.sh.
#
# Usage:
#   bash orwell-https.sh                                  # interactive (whiptail on a TTY)
#   bash orwell-https.sh --mode local                     # enable local HTTPS (internal CA + LAN IP)
#   bash orwell-https.sh --mode local --local-names orwell.lan,orwell.local
#   bash orwell-https.sh --mode local --domains hiorwell.com,www.hiorwell.com \
#                        --dns-provider cloudflare --dns-token <TOKEN>   # + publicly-trusted upgrade
#   bash orwell-https.sh --disable                        # back to plaintext HTTP (stop the terminator)
#   bash orwell-https.sh --print-caddyfile --mode local --local-names orwell.lan   # emit config; touch nothing
#   bash orwell-https.sh --mode local --yes               # no confirmation prompt (automation)
#
# Env overrides (same names the other deploy scripts honor): APP_DIR, CTID, CT_HOSTNAME,
# ORWELL_SERVICE_USER. The DNS token may also arrive as ORWELL_TLS_DNS_API_TOKEN in the environment
# (the ops runner passes it that way so it never lands in a process argv).
set -euo pipefail

MODE=""; LOCAL_NAMES=""; DOMAINS=""; DNS_PROVIDER=""; DNS_TOKEN="${ORWELL_TLS_DNS_API_TOKEN:-}"
ACME_EMAIL=""; ASSUME_YES=0; NO_RESTART=0; DRY_RUN=0; PRINT_ONLY=0; MODE_GIVEN=""
CT_HOSTNAME_SET="${CT_HOSTNAME:+1}"
CT_HOSTNAME="${CT_HOSTNAME:-orwell}"

usage() { sed -n '3,40p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          MODE="${2:-}"; MODE_GIVEN=1; shift 2 ;;
    --local-names)   LOCAL_NAMES="${2:-}"; shift 2 ;;
    --domains)       DOMAINS="${2:-}"; shift 2 ;;
    --dns-provider)  DNS_PROVIDER="${2:-}"; shift 2 ;;
    --dns-token)     DNS_TOKEN="${2:-}"; shift 2 ;;
    --acme-email)    ACME_EMAIL="${2:-}"; shift 2 ;;
    --disable)       MODE="off"; MODE_GIVEN=1; shift ;;
    --yes|-y)        ASSUME_YES=1; shift ;;
    --no-restart)    NO_RESTART=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --print-caddyfile) PRINT_ONLY=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    -*)              echo "ERROR: unknown flag: $1 (see --help)" >&2; exit 1 ;;
    *)               echo "ERROR: unexpected argument: $1" >&2; exit 1 ;;
  esac
done

# ── Optional whiptail TUI (deploy/orwell-tui.sh) ───────────────────────────────────────────────
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -n "${__lib:-}" && -r "$__lib" ]]; then . "$__lib"; break; fi
done
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }

msg()  { echo -e "==> $*"; }
warn() { echo -e "WARN: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# First install dir found here: an explicit override, then the current path, then the legacy one.
find_app() {
  local d
  for d in "${APP_DIR:-}" /opt/orwell /opt/bbai; do
    [[ -n "$d" && -d "$d/.git" ]] && { printf '%s' "$d"; return 0; }
  done
  return 1
}

# Strict hostname / IP allow-list (defense in depth: these names become Caddyfile DATA, never a
# command — but reject anything that isn't a plausible host so a typo/metacharacter can't inject a
# Caddy directive). Accepts letters/digits/dot/hyphen, a leading "*." wildcard, and dotted IPv4.
sanitize_names() {
  local raw="$1" out="" tok
  IFS=',' read -ra __toks <<< "$raw"
  for tok in "${__toks[@]}"; do
    tok="${tok//[[:space:]]/}"
    [[ -z "$tok" ]] && continue
    if [[ "$tok" =~ ^(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
      out+="${out:+,}$tok"
    else
      warn "ignoring invalid host name: '${tok}'"
    fi
  done
  printf '%s' "$out"
}

# ── Host → container bridge (identical pattern to orwell-change-port.sh) ────────────────────────
# print-only / dry-run describe the config and need no container; they run right here.
if [[ $PRINT_ONLY -eq 0 && $DRY_RUN -eq 0 ]] \
   && command -v pct >/dev/null 2>&1 && ! find_app >/dev/null 2>&1; then
  CTID="${CTID:-$(pct list 2>/dev/null | awk -v n="$CT_HOSTNAME" 'NR>1 && $NF==n {print $1}' || true)}"
  [[ -n "$CTID" || -n "$CT_HOSTNAME_SET" ]] || CTID="$(pct list 2>/dev/null | awk 'NR>1 && $NF=="bbai" {print $1}' || true)"
  [[ -n "$CTID" ]] || die "no orwell LXC found (hostname '${CT_HOSTNAME}' or legacy 'bbai'). Set CTID=<id> and retry."
  [[ "$(printf '%s' "$CTID" | wc -w)" -eq 1 ]] || die "multiple containers named '${CT_HOSTNAME}' (${CTID//$'\n'/ }). Set CTID=<id>."
  [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] || die "LXC ${CTID} is not running — start it first: pct start ${CTID}"

  msg "orwell lives in LXC ${CTID}; configuring HTTPS inside the container"
  FWD=()
  [[ -n "$MODE"          ]] && FWD+=(--mode "$MODE")
  [[ -n "$LOCAL_NAMES"   ]] && FWD+=(--local-names "$LOCAL_NAMES")
  [[ -n "$DOMAINS"       ]] && FWD+=(--domains "$DOMAINS")
  [[ -n "$DNS_PROVIDER"  ]] && FWD+=(--dns-provider "$DNS_PROVIDER")
  [[ -n "$ACME_EMAIL"    ]] && FWD+=(--acme-email "$ACME_EMAIL")
  [[ $ASSUME_YES -eq 1   ]] && FWD+=(--yes)
  [[ $NO_RESTART -eq 1   ]] && FWD+=(--no-restart)
  # The DNS token crosses as an ENV var (not argv) so it never shows in `ps`.
  FWD_ENV="export ${APP_DIR:+APP_DIR='${APP_DIR}' }ORWELL_SERVICE_USER='${ORWELL_SERVICE_USER:-}' ORWELL_TLS_DNS_API_TOKEN='${DNS_TOKEN}';"
  if [[ -n "${BASH_SOURCE[0]:-}" && -r "${BASH_SOURCE[0]:-}" ]]; then
    TMP="$(mktemp /tmp/orwell-https-XXXXXX.sh)"; cp "${BASH_SOURCE[0]}" "$TMP"
    pct push "$CTID" "$TMP" /tmp/orwell-https.sh; rm -f "$TMP"
    pct exec "$CTID" -- bash -c "${FWD_ENV} bash /tmp/orwell-https.sh $(printf '%q ' "${FWD[@]}")"
  else
    pct exec "$CTID" -- bash -c "${FWD_ENV} for d in \"\${APP_DIR:-}\" /opt/orwell /opt/bbai; do
        [ -n \"\$d\" ] && [ -f \"\$d/deploy/orwell-https.sh\" ] && exec bash \"\$d/deploy/orwell-https.sh\" $(printf '%q ' "${FWD[@]}")
      done; echo 'ERROR: no in-container deploy/orwell-https.sh found' >&2; exit 1"
  fi
  exit 0
fi

# ── In-container (or direct / print-only) ───────────────────────────────────────────────────────
APP_DIR="$(find_app || true)"; APP_DIR="${APP_DIR:-/opt/orwell}"
DATA_DIR="${ORWELL_DATA_DIR:-${APP_DIR%/}/data}"
ENV_FILE="${DATA_DIR%/}/.env"
OPS_DIR="${DATA_DIR%/}/ops"
TLS_DIR="${DATA_DIR%/}/tls"
CADDYFILE="/etc/caddy/Caddyfile"
ROOT_CA_OUT="${TLS_DIR}/local-ca.crt"

# SYMLINKS: this runs as ROOT (via the ops runner or the control panel) but reads, rewrites, chowns and
# chmods files under data/, which the unprivileged service user owns. A symlink planted at one of those
# paths must never be followed — `cat >`, chown and chmod all dereference it — so refuse, up front. A
# check alone is racy (the path can be swapped after it), so every WRITE / chown / chmod below goes through
# an O_NOFOLLOW file descriptor (python3) rather than by path; the refuse_symlink calls give the clear error.
refuse_symlink() { [[ ! -L "$1" ]] || die "$1 is a symlink — refusing to read, write, chown or chmod through it."; }
refuse_symlink "$ENV_FILE"; refuse_symlink "$TLS_DIR"; refuse_symlink "$ROOT_CA_OUT"

# Service name follows the install: prefer orwell-*, fall back to the legacy bbai-* unit.
unit_exists() { systemctl list-unit-files "$1" 2>/dev/null | grep -q "$1"; }
if   unit_exists orwell-frontend.service; then FRONTEND_SVC="orwell-frontend"
elif unit_exists bbai-frontend.service;   then FRONTEND_SVC="bbai-frontend"
else                                           FRONTEND_SVC="orwell-frontend"
fi

# Read a key's current value from data/.env (last wins), with a fallback.
read_env() { local k="$1" d="${2:-}"; local v; v="$(sed -n "s/^${k}=//p" "$ENV_FILE" 2>/dev/null | tail -n1)"; printf '%s' "${v:-$d}"; }

UI_PORT="$(read_env ORWELL_PORT 8080)"
[[ "$UI_PORT" =~ ^[0-9]+$ ]] || UI_PORT=8080

# Effective values: an explicit flag wins, else the current .env, else a default.
MODE="${MODE:-$(read_env ORWELL_TLS_MODE off)}"
LOCAL_NAMES="${LOCAL_NAMES:-$(read_env ORWELL_TLS_LOCAL_NAMES 'orwell.lan,orwell.local')}"
DOMAINS="${DOMAINS:-$(read_env ORWELL_TLS_DOMAINS '')}"
DNS_PROVIDER="${DNS_PROVIDER:-$(read_env ORWELL_TLS_DNS_PROVIDER '')}"
ACME_EMAIL="${ACME_EMAIL:-$(read_env ORWELL_TLS_ACME_EMAIL '')}"
[[ -n "$DNS_TOKEN" ]] || DNS_TOKEN="$(read_env ORWELL_TLS_DNS_API_TOKEN '')"

# ── Interactive prompts (TTY only; --yes / automation / print / dry skip them) ──────────────────
if [[ -z "${MODE_GIVEN:-}" && $PRINT_ONLY -eq 0 && $DRY_RUN -eq 0 && $ASSUME_YES -eq 0 ]] && tui_active; then
  ORWELL_TUI_TITLE="Orwell — local HTTPS"
  _m=""
  wt_menu _m "Local HTTPS for the player tier.\n\nCurrent: ${MODE}\n\nCover orwell.lan, the LAN IP, and (optionally) your domain with HTTPS and no browser warning." \
    local "Enable — HTTPS on the LAN (trusted, internal CA)" \
    off   "Disable — back to plain HTTP" \
    back  "← Cancel" || exit 0
  [[ "$_m" == back ]] && { echo "cancelled."; exit 0; }
  MODE="$_m"
  if [[ "$MODE" == "local" ]]; then
    wt_input LOCAL_NAMES "Local hostnames to cover (comma-separated). The LAN IP is added automatically." "$LOCAL_NAMES" || exit 0
    if wt_yesno "Also serve a PUBLIC domain with a publicly-trusted cert (no per-device install)?\n\nNeeds the domain + a DNS provider API token (DNS-01). Skip for local-only." --defaultno; then
      wt_input DOMAINS "Public domain(s), comma-separated (e.g. hiorwell.com,www.hiorwell.com):" "$DOMAINS" || exit 0
      wt_input DNS_PROVIDER "DNS provider for the DNS-01 challenge (e.g. cloudflare):" "${DNS_PROVIDER:-cloudflare}" || exit 0
      wt_password DNS_TOKEN "DNS provider API token (leave blank to keep the existing one):" || exit 0
      [[ -n "$DNS_TOKEN" ]] || DNS_TOKEN="$(read_env ORWELL_TLS_DNS_API_TOKEN '')"
    fi
  fi
fi

# Normalize + validate.
[[ "$MODE" == "off" || "$MODE" == "local" ]] || die "mode must be 'local' or 'off' (got '${MODE}')"
LOCAL_NAMES="$(sanitize_names "$LOCAL_NAMES")"
DOMAINS="$(sanitize_names "$DOMAINS")"
DNS_PROVIDER="${DNS_PROVIDER//[^A-Za-z0-9._-]/}"
# The token and the ACME email are written into data/.env / the Caddyfile verbatim: refuse a control
# character (a newline would start a new line there) and anything that is not a plain email address.
[[ "$DNS_TOKEN" != *[[:cntrl:]]* ]] || die "the DNS API token contains a control character — refusing."
[[ -z "$ACME_EMAIL" || "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "ACME email '${ACME_EMAIL}' is not a plain email address — refusing."
if [[ "$MODE" == "local" && -z "$LOCAL_NAMES" && -z "$DOMAINS" ]]; then
  die "no valid hostnames to cover — set --local-names and/or --domains."
fi
if [[ -n "$DOMAINS" && ( -z "$DNS_PROVIDER" || -z "$DNS_TOKEN" ) ]]; then
  warn "a public domain is set but no DNS provider+token — the domain block needs DNS-01 to get a"
  warn "publicly-trusted cert. Serving local names only; re-run with --dns-provider/--dns-token to add it."
  DOMAINS=""
fi

# The first non-loopback IPv4 (best-effort; appended to the local-name SAN so https://<ip> works too).
LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -n1 || true)"

# ── Caddyfile generator ──────────────────────────────────────────────────────────────────────────
# Emits the reverse-proxy config to stdout. References ONLY the FE on loopback — the engine
# (ORWELL_ENGINE_PORT 8765) is never named here, by construction (feature 0074 / ADR 0014 invariant).
# The header + proxy lines shared by every site (everything after the `tls` directive).
_emit_caddy_common() {
  printf '\tencode zstd gzip\n'
  printf '\theader {\n'
  printf '\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"\n'
  printf '\t\tX-Content-Type-Options "nosniff"\n'
  printf '\t\tReferrer-Policy "strict-origin-when-cross-origin"\n'
  printf '\t\t-Server\n'
  printf '\t}\n'
  printf '\treverse_proxy 127.0.0.1:%s\n' "$UI_PORT"
}
gen_caddyfile() {
  printf '%s\n' \
    "# Local & tunable HTTPS for the Orwell player tier (feature 0074 / ADR 0014)." \
    "# GENERATED by deploy/orwell-https.sh — edit the ORWELL_TLS_* vars in data/.env, not this file." \
    "# The engine is never named here: every site reverse-proxies ONLY the front-end on loopback." \
    "# WebSockets (GET /api/ws/session, WS Phase-1 / ADR 0017): Caddy's reverse-proxy passes the" \
    "# Upgrade/Connection handshake transparently — no extra directive needed. See deploy/expose/README.md."
  if [[ -n "$ACME_EMAIL" ]]; then
    printf '{\n\temail %s\n}\n' "$ACME_EMAIL"
  fi

  # ── Local names + the LAN IP: the offline INTERNAL CA (no domain needed). ──
  local local_addrs="$LOCAL_NAMES"
  [[ -n "$LAN_IP" ]] && local_addrs="${local_addrs:+${local_addrs},}${LAN_IP}"
  if [[ -n "$local_addrs" ]]; then
    printf '\n# Local names + the LAN IP — internal CA (offline; trust the root once, no warning after).\n'
    printf '%s {\n' "${local_addrs//,/, }"
    printf '\ttls internal\n'
    _emit_caddy_common
    printf '}\n'
  fi

  # ── (optional) Public domain — a publicly-trusted cert via DNS-01 (zero per-device install). ──
  if [[ -n "$DOMAINS" ]]; then
    printf '\n# Public domain — publicly-trusted cert via a DNS-01 challenge (no per-device install).\n'
    printf '%s {\n' "${DOMAINS//,/, }"
    printf '\ttls {\n'
    printf '\t\tdns %s {env.ORWELL_TLS_DNS_API_TOKEN}\n' "$DNS_PROVIDER"
    printf '\t}\n'
    _emit_caddy_common
    printf '}\n'
  fi
}

# print-only: emit + exit (no root, no .env, no install — used by the deploy test + `--print-caddyfile`).
if [[ $PRINT_ONLY -eq 1 ]]; then gen_caddyfile; exit 0; fi

# ── Plan ────────────────────────────────────────────────────────────────────────────────────────
PLAN=""
if [[ "$MODE" == "local" ]]; then
  PLAN+="  • set ORWELL_TLS_MODE=local in ${ENV_FILE}"$'\n'
  PLAN+="  • cover: ${LOCAL_NAMES}${LAN_IP:+, ${LAN_IP}}${DOMAINS:+   + domain: ${DOMAINS} (DNS-01 via ${DNS_PROVIDER})}"$'\n'
  PLAN+="  • set SECURE_COOKIES=true and pin ORWELL_BIND_HOST=127.0.0.1 (HTTPS is the only LAN entrypoint)"$'\n'
  PLAN+="  • install + enable Caddy; write ${CADDYFILE}; export the CA root to ${ROOT_CA_OUT}"$'\n'
else
  PLAN+="  • set ORWELL_TLS_MODE=off — stop the terminator, back to plain HTTP"$'\n'
  PLAN+="  • clear SECURE_COOKIES (unless the public profile needs it)"$'\n'
fi
[[ $NO_RESTART -eq 1 ]] && PLAN+="  • (--no-restart) leave services as-is"$'\n' \
                        || PLAN+="  • restart ${FRONTEND_SVC} to apply"$'\n'

if [[ $DRY_RUN -eq 1 ]]; then msg "[dry-run] would apply:"; printf '%s' "$PLAN"; echo; msg "Caddyfile:"; gen_caddyfile; exit 0; fi

# ── Confirm (interactive only) ──────────────────────────────────────────────────────────────────
if [[ $ASSUME_YES -eq 0 ]]; then
  if tui_active; then
    wt_yesno "Apply local HTTPS (${MODE}):\n\n${PLAN}\nProceed?" || { echo "cancelled."; exit 0; }
  elif [[ -t 0 ]]; then
    echo "Apply local HTTPS (${MODE}):"; printf '%s' "$PLAN"
    read -rp "Proceed? [y/N] " __ans; [[ "$__ans" =~ ^[Yy] ]] || { echo "cancelled."; exit 0; }
  fi
fi

command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this script manages the Caddy + front-end units."
[[ "$(id -u)" -eq 0 ]] || die "must run as root (edits ${ENV_FILE}, ${CADDYFILE}, and restarts services). Try: sudo bash $0 ..."

# ── .env upsert (preserve file + ownership; mirrors orwell-change-port.sh) ───────────────────────
# Replace the CONTENTS of $ENV_FILE with the file $1 — in place (same inode, owner and mode), creating it
# 0600 when absent — through an O_NOFOLLOW fd, so a symlink swapped in after the check is an error, not a write.
write_env_file() {
  python3 - "$ENV_FILE" "$1" <<'PY'
import os, sys
with open(sys.argv[2], "rb") as src:
    data = src.read()
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
try:
    os.write(fd, data)
finally:
    os.close(fd)
PY
}
set_env_key() {
  local key="$1" val="$2" tmp
  refuse_symlink "$ENV_FILE"
  mkdir -p "$(dirname "$ENV_FILE")"
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]] && grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # VAL is data: passed via the environment to awk, so a backslash or & in it is never interpreted
    # (sed's replacement would turn a literal "\n" into a real newline = an injected .env line).
    KEY="$key" VAL="$val" awk 'BEGIN { k = ENVIRON["KEY"] "="; v = ENVIRON["VAL"] } index($0, k) == 1 { print k v; next } { print }' "$ENV_FILE" > "$tmp"
  else
    { if [[ -f "$ENV_FILE" ]]; then cat "$ENV_FILE"; fi; printf '%s=%s\n' "$key" "$val"; } > "$tmp"
  fi
  write_env_file "$tmp"; rm -f "$tmp"
}
del_env_key() {
  local key="$1" tmp
  refuse_symlink "$ENV_FILE"
  [[ -f "$ENV_FILE" ]] || return 0
  tmp="$(mktemp)"; grep -v "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true; write_env_file "$tmp"; rm -f "$tmp"
}
restore_env_owner() {
  refuse_symlink "$ENV_FILE"
  local u="${ORWELL_SERVICE_USER:-}" g=""
  [[ -n "$u" ]] || u="$(systemctl show -p User --value "$FRONTEND_SVC" 2>/dev/null || true)"
  [[ -n "$u" ]] || u="orwell"
  if id "$u" >/dev/null 2>&1; then g="$(id -gn "$u" 2>/dev/null || printf '%s' "$u")"; else u=""; fi
  # fchown/fchmod on an O_NOFOLLOW fd: chown/chmod by path would follow a symlink swapped in after the check.
  python3 - "$ENV_FILE" "$u" "$g" <<'PY' 2>/dev/null || true
import grp, os, pwd, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
try:
    if sys.argv[2]:
        os.fchown(fd, pwd.getpwnam(sys.argv[2]).pw_uid, grp.getgrnam(sys.argv[3]).gr_gid)
    os.fchmod(fd, 0o600)
finally:
    os.close(fd)
PY
}

install_caddy() {
  command -v caddy >/dev/null 2>&1 && { msg "caddy already installed"; return 0; }
  msg "installing caddy"
  export DEBIAN_FRONTEND=noninteractive
  local keyring="/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
  local listfile="/etc/apt/sources.list.d/caddy-stable.list"
  if mkdir -p --mode=0755 /usr/share/keyrings 2>/dev/null \
     && curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | gpg --dearmor 2>/dev/null | tee "$keyring" >/dev/null \
     && curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' 2>/dev/null | tee "$listfile" >/dev/null \
     && apt-get update -y >/dev/null 2>&1 \
     && apt-get install -y caddy >/dev/null 2>&1; then
    msg "caddy installed from the official apt repo"; return 0
  fi
  warn "apt repo path unavailable — trying the .deb release"
  local arch deb
  arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
  deb="$(mktemp /tmp/caddy-XXXXXX.deb)"
  if curl -fsSL "https://github.com/caddyserver/caddy/releases/latest/download/caddy_$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest 2>/dev/null | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n1)_linux_${arch}.deb" -o "$deb" 2>/dev/null \
     && apt-get install -y "$deb" >/dev/null 2>&1; then
    rm -f "$deb"; msg "caddy installed from the .deb release"; return 0
  fi
  rm -f "$deb"
  die "could not install caddy (apt repo and .deb both failed). Install caddy manually and re-run."
}

# Export Caddy's internal-CA root to a world-readable file the FE serves at /orwell-local-ca.crt.
# The root is created on first cert issuance; poll briefly for it.
export_root_ca() {
  local src="" cand
  refuse_symlink "$TLS_DIR"; refuse_symlink "$ROOT_CA_OUT"
  mkdir -p "$TLS_DIR"
  for _ in $(seq 1 15); do
    for cand in \
      /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt \
      /var/lib/caddy/.config/caddy/pki/authorities/local/root.crt \
      "$HOME/.local/share/caddy/pki/authorities/local/root.crt"; do
      [[ -r "$cand" ]] && { src="$cand"; break; }
    done
    [[ -n "$src" ]] && break
    sleep 1
  done
  if [[ -n "$src" ]]; then
    refuse_symlink "$TLS_DIR"; refuse_symlink "$ROOT_CA_OUT"   # re-check: the poll above can take a while
    # Written through an O_NOFOLLOW fd (then fchmod 0644): a link planted at the name after the check is an error.
    python3 - "$src" "$ROOT_CA_OUT" <<'PY' || die "could not write ${ROOT_CA_OUT} (is it a symlink?)"
import os, sys
with open(sys.argv[1], "rb") as fh:
    data = fh.read()
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
try:
    os.write(fd, data)
    os.fchmod(fd, 0o644)
finally:
    os.close(fd)
PY
    # The FE (user orwell) reads it; keep the tls dir traversable + the file world-readable.
    python3 -c 'import os,sys; os.fchmod(os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY), 0o755)' "$TLS_DIR" 2>/dev/null || true
    msg "exported the local CA root → ${ROOT_CA_OUT} (download at /orwell-local-ca.crt)"
    # Best-effort: trust the root in the box's OWN store too (harmless on a client-less LXC).
    caddy trust >/dev/null 2>&1 || true
  else
    warn "could not locate Caddy's internal CA root yet — it appears after the first HTTPS request."
    warn "re-run 'orwell https' once the site has been hit, or check the Caddy data dir."
  fi
}

# ── Apply ────────────────────────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "local" ]]; then
  msg "enabling local HTTPS"
  set_env_key ORWELL_TLS_MODE "local"
  set_env_key ORWELL_TLS_LOCAL_NAMES "$LOCAL_NAMES"
  if [[ -n "$DOMAINS" ]]; then
    set_env_key ORWELL_TLS_DOMAINS "$DOMAINS"
    set_env_key ORWELL_TLS_DNS_PROVIDER "$DNS_PROVIDER"
    [[ -n "$DNS_TOKEN" ]] && set_env_key ORWELL_TLS_DNS_API_TOKEN "$DNS_TOKEN"
  else
    del_env_key ORWELL_TLS_DOMAINS
  fi
  [[ -n "$ACME_EMAIL" ]] && set_env_key ORWELL_TLS_ACME_EMAIL "$ACME_EMAIL"
  # HTTPS is the only LAN entrypoint: cookies Secure + the FE pinned to loopback (only Caddy faces out).
  set_env_key SECURE_COOKIES "true"
  set_env_key ORWELL_BIND_HOST "127.0.0.1"
  restore_env_owner

  install_caddy
  # If a DNS provider is configured, add its Caddy DNS module (best-effort; needs the apt build's
  # `caddy add-package`). Without it the domain block can't solve DNS-01 — local names still work.
  if [[ -n "$DOMAINS" && -n "$DNS_PROVIDER" ]]; then
    if ! caddy list-modules 2>/dev/null | grep -q "dns.providers.${DNS_PROVIDER}"; then
      msg "adding the Caddy DNS module for ${DNS_PROVIDER} (DNS-01)"
      caddy add-package "github.com/caddy-dns/${DNS_PROVIDER}" >/dev/null 2>&1 \
        || warn "could not add caddy-dns/${DNS_PROVIDER} — the domain block may fail to get a cert (local names unaffected)."
    fi
  fi

  mkdir -p "$(dirname "$CADDYFILE")"
  gen_caddyfile > "$CADDYFILE"
  msg "wrote ${CADDYFILE}"

  # The DNS token reaches Caddy as an environment variable (the Caddyfile references
  # {env.ORWELL_TLS_DNS_API_TOKEN}); make caddy.service load data/.env so it's present.
  if [[ -n "$DOMAINS" ]]; then
    local_dropin="/etc/systemd/system/caddy.service.d"
    mkdir -p "$local_dropin"
    cat > "${local_dropin}/10-orwell-env.conf" <<EOF
# Written by orwell-https.sh: let Caddy read ORWELL_TLS_DNS_API_TOKEN (for the DNS-01 challenge)
# from the same data/.env the front-end uses. Only used by the public-domain (DNS-01) site block.
[Service]
EnvironmentFile=-${ENV_FILE}
EOF
  fi

  systemctl daemon-reload
  systemctl enable --now caddy >/dev/null 2>&1 || systemctl restart caddy
  systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy
  export_root_ca
else
  msg "disabling local HTTPS — back to plain HTTP"
  set_env_key ORWELL_TLS_MODE "off"
  # Re-enable plaintext login unless the public internet profile (which mandates Secure cookies) is on.
  if [[ "$(read_env ORWELL_PUBLIC '')" =~ ^(1|true|yes|on)$ ]]; then
    msg "ORWELL_PUBLIC is on — leaving SECURE_COOKIES=true (the public profile requires it)"
  else
    set_env_key SECURE_COOKIES "false"
  fi
  restore_env_owner
  systemctl disable --now caddy >/dev/null 2>&1 || msg "caddy not active (nothing to stop)"
fi

# ── Restart the FE (so SECURE_COOKIES / ORWELL_BIND_HOST take effect) ───────────────────────────
if [[ $NO_RESTART -eq 1 ]]; then
  msg "config changed; NOT restarting (--no-restart). Apply later: systemctl daemon-reload && systemctl restart ${FRONTEND_SVC}"
  exit 0
fi
msg "restarting ${FRONTEND_SVC}"
systemctl restart "$FRONTEND_SVC"

# ── Verify + report ──────────────────────────────────────────────────────────────────────────────
echo
if [[ "$MODE" == "local" ]]; then
  ok=0
  for _ in $(seq 1 15); do
    if curl -fsS -k -o /dev/null --max-time 2 "https://127.0.0.1/api/orwell/health" 2>/dev/null \
       || (command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE '[:.]443$'); then ok=1; break; fi
    sleep 1
  done
  primary="${LOCAL_NAMES%%,*}"; primary="${primary:-${LAN_IP:-<lan-ip>}}"
  if [[ $ok -eq 1 ]]; then msg "done — HTTPS is serving on :443."; else warn "applied, but couldn't confirm :443 yet (check: journalctl -u caddy -e)."; fi
  echo
  echo "Reach the game over HTTPS:"
  for n in ${LOCAL_NAMES//,/ } ${LAN_IP:-}; do [[ -n "$n" ]] && echo "  • https://${n}"; done
  [[ -n "$DOMAINS" ]] && for n in ${DOMAINS//,/ }; do echo "  • https://${n}   (publicly-trusted)"; done
  echo
  echo "No browser warning on the LOCAL names needs the CA root trusted ONCE per device:"
  echo "  1. Download:  https://${primary}/orwell-local-ca.crt   (no login needed)"
  echo "  2. Trust it:  macOS → Keychain ▸ System ▸ drag in ▸ Always Trust · Windows → Local Machine ▸"
  echo "                Trusted Root CAs · iOS → install profile, then Settings ▸ General ▸ About ▸"
  echo "                Certificate Trust ▸ enable · Android → Settings ▸ Security ▸ Install certificate."
  [[ -n "$DOMAINS" ]] && echo "  (The public domain above is already trusted everywhere — no install.)"
else
  msg "done — back to plain HTTP. The front-end is on loopback (only reachable via a proxy/tunnel)."
  echo "  To serve plain HTTP on the LAN again (not recommended), set ORWELL_BIND_HOST=0.0.0.0 in ${ENV_FILE}."
fi
