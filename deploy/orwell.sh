#!/usr/bin/env bash
#
# orwell — one-liner Proxmox LXC installer.
#
# On the Proxmox host shell (the repo is PRIVATE — this is the ONE authenticated moment, ever).
# Use a fine-grained PAT (Contents: Read-only on Psychout-Media/orwell) OR a classic PAT (repo scope)
# — A4/ruling #17. Two non-obvious requirements, both baked into the command below:
#   1. EXPORT the token. In `VAR=x bash -c "$(curl …$VAR…)"` the command substitution is expanded
#      by the OUTER shell BEFORE the `VAR=` prefix applies, so curl would get an EMPTY token
#      (→ 404 from raw / 401 from the API). `export` puts it in scope at substitution time.
#   2. Fetch via the GitHub CONTENTS API, not raw.githubusercontent.com (which 404s for fine-grained PATs).
#   export GIT_TOKEN=github_pat_xxx
#   bash -c "$(curl -fsSL -H "Authorization: Bearer $GIT_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/Psychout-Media/orwell/contents/deploy/orwell.sh?ref=main")"
#
# The token is persisted ONCE into the container's data/.env (the file every reset preserves)
# and git reads it through a credential helper at use time — no later command ever re-prompts,
# and the token never lives in a remote URL or .git/config.
#
# Creates a Debian LXC and installs orwell — the TypeScript engine (MCP server) and the orwell
# front-end — as systemd services (engine contract: `npm run build` / `npm start`).
#
# UX: a community-scripts-style config menu (Use Defaults vs Advanced) with every field
# pre-populated, shown when run on a TTY; otherwise it runs non-interactively with defaults.
# Every setting can also be supplied / overridden via env, e.g.:
#   export GIT_TOKEN=github_pat_xxx
#   CTID=104 CORES=6 RAM_MB=12288 DISK_GB=16 STORAGE=local-lvm BRANCH=main \
#     bash -c "$(curl -fsSL -H "Authorization: Bearer $GIT_TOKEN" -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/Psychout-Media/orwell/contents/deploy/orwell.sh?ref=main")"
# Pass --default (or set USE_DEFAULTS=1 / ORWELL_NONINTERACTIVE=1) to skip the menu.
set -euo pipefail

TITLE="orwell installer"
# Inline presentation (this file is the curl-bootstrapped one-liner — it must stay standalone, so
# no sourcing the TUI lib). Colour auto-disables off a TTY / under NO_COLOR / TERM=dumb. Pure echo.
if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
  C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'; C_GRN=$'\e[32m'; C_CYN=$'\e[36m'; C_OFF=$'\e[0m'
else
  C_BOLD=""; C_DIM=""; C_GRN=""; C_CYN=""; C_OFF=""
fi
msg()  { echo -e "${C_CYN}▸${C_OFF} $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
banner() {
  printf '%s\n' \
"${C_CYN} _____ _____ _ _ _ _____ __    __    ${C_OFF}" \
"${C_CYN}|     |  _  | | | |   __|  |  |  |   ${C_OFF}" \
"${C_CYN}|  |  |    -| | | |   __|  |__|  |__ ${C_OFF}" \
"${C_CYN}|_____|__|__|_____|_____|_____|_____|${C_OFF}" \
"${C_BOLD}            O R W E L L${C_OFF}" \
"   ${C_DIM}${1:-}${C_OFF}"
  printf '\n'
}

case "${1:-}" in
  -h|--help)
    sed -n '3,21p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//'
    exit 0 ;;
  -d|--default|--defaults) USE_DEFAULTS=1 ;;
esac

[[ "$(id -u)" -eq 0 ]] || die "run this on the Proxmox host as root."
command -v pct   >/dev/null 2>&1 || die "this must run on a Proxmox VE host (pct not found)."
command -v pveam >/dev/null 2>&1 || die "this must run on a Proxmox VE host (pveam not found)."
banner "Proxmox LXC installer"

# ── Helpers ──────────────────────────────────────────────────────────────────────────────────
# First active storage that supports a content type (rootdir for the CT rootfs, vztmpl for the
# template). Empty if none — callers fall back to a sensible literal.
storage_for() { pvesm status --content "$1" 2>/dev/null | awk 'NR>1 && $3=="active"{print $1; exit}' || true; }

# Newest debian-12-standard template names available in the appliance catalog (oldest→newest).
available_debian12() {
  pveam available --section system 2>/dev/null | awk '{print $2}' \
    | grep -E '^debian-12-standard' | sort -V || true
}

interactive() {
  [[ -t 0 && -t 1 ]] && command -v whiptail >/dev/null 2>&1 \
    && [[ -z "${ORWELL_NONINTERACTIVE:-}" && -z "${USE_DEFAULTS:-}" ]]
}

wt_input() {  # var "prompt" default
  local __var="$1" __val
  __val="$(whiptail --title "$TITLE" --inputbox "$2" 10 72 "$3" 3>&1 1>&2 2>&3)" || die "cancelled."
  printf -v "$__var" '%s' "${__val:-$3}"
}

wt_password() {  # var "prompt" — empty answer = skip; Linux requires >=5 chars (pct contract)
  local __var="$1" __val
  while :; do
    __val="$(whiptail --title "$TITLE" --passwordbox "$2" 11 72 3>&1 1>&2 2>&3)" || die "cancelled."
    [[ -z "$__val" || ${#__val} -ge 5 ]] && break
    whiptail --title "$TITLE" --msgbox "Password must be at least 5 characters (or empty to skip)." 8 64
  done
  printf -v "$__var" '%s' "$__val"
}

wt_pick_storage() {  # var content default
  local __var="$1" content="$2" def="$3" rows args=() s sel
  mapfile -t rows < <(pvesm status --content "$content" 2>/dev/null | awk 'NR>1{print $1}')
  if [[ ${#rows[@]} -le 1 ]]; then printf -v "$__var" '%s' "${rows[0]:-$def}"; return; fi
  for s in "${rows[@]}"; do args+=("$s" "$content"); done
  sel="$(whiptail --title "$TITLE" --default-item "$def" --menu \
        "Select storage for: $content" 18 60 8 "${args[@]}" 3>&1 1>&2 2>&3)" || die "cancelled."
  printf -v "$__var" '%s' "$sel"
}

wt_pick_template() {  # advanced-mode OS template chooser (newest highlighted)
  msg "refreshing template catalog"; pveam update >/dev/null 2>&1 || true
  local rows args=() t sel
  mapfile -t rows < <(available_debian12)
  [[ ${#rows[@]} -gt 0 ]] || return 0
  for t in "${rows[@]}"; do args+=("$t" ""); done
  sel="$(whiptail --title "$TITLE" --default-item "${TEMPLATE_NAME:-${rows[-1]}}" --menu \
        "OS template" 20 78 10 "${args[@]}" 3>&1 1>&2 2>&3)" || die "cancelled."
  TEMPLATE_NAME="$sel"
}

wt_pick_llm() {  # writes the LLM provider into the container's data/.env (never committed)
  # DEPLOY-6 (2026-07-05 ops-hygiene close-out): this menu used to also offer "Anthropic API
  # key", but `orwell-install.sh`'s write_config() never consumed ANTHROPIC_API_KEY — the value
  # was captured here, exposed on the pct-exec command line (the DEPLOY-5 bug), and then silently
  # discarded, so the operator's install stayed unconfigured with no signal why. Anthropic-native
  # endpoints ARE supported by the front-end (`frontend/src/llm_core.py` `_detect_provider`), just
  # not via this env-var bootstrap path — configure one after first boot via the admin Settings ->
  # Services/AI panel (`POST /api/model-endpoints`) instead. Only offer providers this installer
  # can actually wire end-to-end.
  local choice
  choice="$(whiptail --title "$TITLE" --default-item none --menu \
    "LLM provider (stored only in the container's data/.env)" 13 72 2 \
    none   "Configure later (incl. Anthropic, via Settings -> Services/AI)" \
    ollama "Ollama host URL" 3>&1 1>&2 2>&3)" || die "cancelled."
  case "$choice" in
    ollama) wt_input OLLAMA_HOST "Ollama host URL" "${OLLAMA_HOST:-http://127.0.0.1:11434}" ;;
  esac
}

# ── Defaults (env overrides everything; auto-detected where it matters) ────────────────────────
CTID="${CTID:-$(pvesh get /cluster/nextid 2>/dev/null || echo 900)}"
CT_HOSTNAME="${CT_HOSTNAME:-orwell}"
# Recommended baseline (approved 2026-06-19): 4 vCPU / 8 GB RAM. The LLM is REMOTE, so CPU is for
# the front-end + engine + local embeddings (fastembed/ONNX); allow more RAM if also running image
# generation. Every value is overridable via env (CORES=… RAM_MB=… DISK_GB=…).
CORES="${CORES:-4}"
RAM_MB="${RAM_MB:-8192}"
DISK_GB="${DISK_GB:-12}"
BRIDGE="${BRIDGE:-vmbr0}"
NET="${NET:-dhcp}"                 # "dhcp" or a static CIDR, e.g. 192.168.1.50/24
GATEWAY="${GATEWAY:-}"             # required only for a static NET
STORAGE="${STORAGE:-$(storage_for rootdir)}";          STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$(storage_for vztmpl)}"; TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
REPO="${REPO:-https://github.com/Psychout-Media/orwell.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/orwell}"
# The private-repo deploy credential (A4/ruling #17): a fine-grained PAT, Contents: Read-only.
# Captured HERE, once — persisted into the container's data/.env; git reads it via a credential
# helper from then on (updates/resets never re-prompt).
GIT_TOKEN="${GIT_TOKEN:-}"
ORWELL_PORT="${ORWELL_PORT:-${BBAI_PORT:-8080}}"   # ORWELL_* primary; BBAI_* deprecated fallback
# Trusted-LAN exposure (feature 0067 / ADR 0007). The systemd unit's BUILT-IN default is loopback
# (127.0.0.1), which is correct ONLY behind a reverse proxy / HTTPS / tunnel — a plain LAN browser
# then gets "connection refused". This self-hosted app is reached DIRECTLY on the LAN in the common
# case, so the installer DEFAULTS to binding all interfaces (0.0.0.0) and PERSISTS that choice into
# data/.env (so a rebuild stays reachable). Set ORWELL_BIND_HOST=127.0.0.1 (or answer "no" to the
# prompt) to keep loopback for the proxy/HTTPS case. If local HTTPS is later enabled,
# orwell-https.sh re-pins this to 127.0.0.1 (the terminator becomes the only LAN entrypoint).
ORWELL_BIND_HOST="${ORWELL_BIND_HOST:-0.0.0.0}"
# Optional container root password (console login). pct enter from the host never needs one;
# without it the LXC console rejects every login (pct create sets no password by default).
CT_ROOT_PASSWORD="${CT_ROOT_PASSWORD:-}"
OLLAMA_HOST="${OLLAMA_HOST:-}"

# An explicit TEMPLATE=storage:vztmpl/name override splits into storage + name; otherwise the
# newest debian-12-standard is resolved (and downloaded) below.
TEMPLATE_NAME="${TEMPLATE_NAME:-}"
if [[ -n "${TEMPLATE:-}" ]]; then
  TEMPLATE_STORAGE="${TEMPLATE%%:*}"
  TEMPLATE_NAME="${TEMPLATE##*/}"
fi

# ── Config menu (community-scripts style: Defaults vs Advanced, fields pre-populated) ───────────
if interactive; then
  if whiptail --title "$TITLE" --yes-button "Use Defaults" --no-button "Advanced" --yesno \
      "Create a Debian LXC and install orwell.\n\nDefaults:\n  CTID ${CTID}  ·  ${CORES} cores  ·  ${RAM_MB} MB  ·  ${DISK_GB} GB\n  rootfs storage ${STORAGE}  ·  bridge ${BRIDGE}  ·  net ${NET}\n  UI port ${ORWELL_PORT}  ·  branch ${BRANCH}\n\nUse these defaults, or configure advanced settings?" 20 72; then
    : # keep defaults
  else
    wt_input CTID        "Container ID (CTID)"                        "$CTID"
    wt_input CT_HOSTNAME "Hostname"                                   "$CT_HOSTNAME"
    wt_input CORES       "CPU cores"                                  "$CORES"
    wt_input RAM_MB      "RAM (MB)"                                   "$RAM_MB"
    wt_input DISK_GB     "Disk (GB)"                                  "$DISK_GB"
    wt_pick_storage  STORAGE          rootdir "$STORAGE"
    wt_pick_storage  TEMPLATE_STORAGE vztmpl  "$TEMPLATE_STORAGE"
    wt_input BRIDGE      "Network bridge"                             "$BRIDGE"
    wt_input NET         "IP — 'dhcp' or CIDR (e.g. 192.168.1.50/24)" "$NET"
    [[ "$NET" != "dhcp" ]] && wt_input GATEWAY "Gateway (for the static IP)" "${GATEWAY:-}"
    wt_input ORWELL_PORT   "orwell UI port"                               "$ORWELL_PORT"
    # Trusted-LAN exposure decision (default = yes ⇒ bind 0.0.0.0). "No" pins loopback for the
    # reverse-proxy / HTTPS / tunnel case. Persisted into data/.env by the in-container installer.
    if whiptail --title "$TITLE" --yes-button "LAN (direct)" --no-button "Behind proxy" --yesno \
        "Expose the UI on your LAN (a trusted network)?\n\nChoose ${C_BOLD}LAN (direct)${C_OFF} if you'll reach it straight at http://<ip>:${ORWELL_PORT} — the common case for this self-hosted app.\n\nChoose ${C_BOLD}Behind proxy${C_OFF} only if it sits behind a reverse proxy / HTTPS / tunnel (then it stays on loopback, 127.0.0.1)." 16 72; then
      ORWELL_BIND_HOST="0.0.0.0"
    else
      ORWELL_BIND_HOST="127.0.0.1"
    fi
    wt_password CT_ROOT_PASSWORD "Container root password (console login)\nEmpty = none: 'pct enter ${CTID}' from this host always works without one."
    wt_input BRANCH      "Git branch"                                 "$BRANCH"
    wt_pick_template
    wt_pick_llm
  fi
fi

# Linux rejects short passwords at the chpasswd layer too — fail fast, not mid-install.
[[ -z "$CT_ROOT_PASSWORD" || ${#CT_ROOT_PASSWORD} -ge 5 ]] \
  || die "CT_ROOT_PASSWORD must be at least 5 characters (or unset for no console password)."

# ── Resolve + download the OS template (the fix for the original failure) ───────────────────────
ensure_template() {
  if [[ -z "$TEMPLATE_NAME" ]]; then
    msg "resolving newest debian-12-standard template"
    pveam update >/dev/null 2>&1 || true
    TEMPLATE_NAME="$(available_debian12 | tail -n1)"
  fi
  # Offline fallback: newest debian-12-standard already present on the template storage.
  if [[ -z "$TEMPLATE_NAME" ]]; then
    TEMPLATE_NAME="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $1}' \
      | sed 's#.*/##' | grep -E '^debian-12-standard' | sort -V | tail -n1 || true)"
  fi
  [[ -n "$TEMPLATE_NAME" ]] || die "no debian-12-standard template available or downloaded — check internet / 'pveam available'."
  if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -qF "$TEMPLATE_NAME"; then
    msg "downloading template ${TEMPLATE_NAME} → ${TEMPLATE_STORAGE} (first run only)"
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_NAME"
  fi
  TEMPLATE="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_NAME}"
}
ensure_template

# ── Create + start the container ───────────────────────────────────────────────────────────────
# NET0 may be passed as a raw pct net0 string (e.g. "name=eth0,bridge=vmbr0,ip=dhcp") to
# bypass the helpers; otherwise it's constructed from NET ("dhcp" or CIDR), BRIDGE, GATEWAY.
if [[ -n "${NET0:-}" ]]; then
  : # raw passthrough — use as-is
elif [[ "${NET:-dhcp}" =~ ^name= ]] || [[ "${NET:-dhcp}" =~ bridge= ]]; then
  NET0="${NET}"  # caller already supplied a full net0 option string via NET=
elif [[ "${NET:-dhcp}" == "dhcp" ]]; then
  NET0="name=eth0,bridge=${BRIDGE},ip=dhcp"
else
  NET0="name=eth0,bridge=${BRIDGE},ip=${NET}${GATEWAY:+,gw=${GATEWAY}}"
fi

msg "config: CTID=${CTID} CORES=${CORES} RAM_MB=${RAM_MB} DISK_GB=${DISK_GB} STORAGE=${STORAGE} TEMPLATE=${TEMPLATE} NET=${NET0} PORT=${ORWELL_PORT} BRANCH=${BRANCH}"
msg "creating LXC ${CTID} (${CT_HOSTNAME})"
pct create "$CTID" "$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" --memory "$RAM_MB" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "$NET0" \
  --features nesting=1 \
  --unprivileged 1 \
  --onboot 1
pct start "$CTID"

# Console password (optional). Fed via stdin — the same no-secrets-on-a-command-line rule as the
# GIT_TOKEN handling below: it must never appear in host `ps` or the shell history of a pct exec.
if [[ -n "$CT_ROOT_PASSWORD" ]]; then
  msg "setting the container root password (console login)"
  printf 'root:%s\n' "$CT_ROOT_PASSWORD" | pct exec "$CTID" -- chpasswd
fi

# Wait for a network address (DHCP lease) before running the in-container install.
msg "waiting for the container network"
IP=""
for _ in $(seq 1 30); do
  IP="$(pct exec "$CTID" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
  [[ -n "$IP" ]] && break
  sleep 2
done
[[ -n "$IP" ]] || IP="<container-ip>"

# ── Bootstrap the git checkout inside the container (A4/ruling #17 — closes audit E84) ──────────
# No raw-curl of branch tips: the ONLY GitHub fetch is `git` itself, authenticated (when the repo
# is private) by a credential helper reading GIT_TOKEN from data/.env — the one file every reset
# preserves. The installer that runs is the CHECKED-OUT copy, integrity-anchored to the git ref.
msg "bootstrapping the git checkout inside the container"
pct exec "$CTID" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git ca-certificates"
pct exec "$CTID" -- bash -c "mkdir -p '${APP_DIR}/data'; touch '${APP_DIR}/data/.env'; chmod 600 '${APP_DIR}/data/.env'"
if [[ -n "$GIT_TOKEN" ]]; then
  # Persist the token via a pushed file (never on a pct exec command line / host ps).
  TMP_TOKEN="$(mktemp /tmp/orwell-token-XXXXXX)"
  # The PAT file must not outlive this run on ANY exit (failed push, Ctrl-C) — on the host OR, once pushed, in the LXC.
  trap 'rm -f "$TMP_TOKEN"; pct exec "$CTID" -- rm -f /tmp/orwell-token >/dev/null 2>&1 || true' EXIT
  trap 'exit 130' INT TERM
  chmod 600 "$TMP_TOKEN"
  printf 'GIT_TOKEN=%s\n' "$GIT_TOKEN" > "$TMP_TOKEN"
  pct push "$CTID" "$TMP_TOKEN" /tmp/orwell-token --perms 0600
  rm -f "$TMP_TOKEN"
  pct exec "$CTID" -- bash -c "grep -q '^GIT_TOKEN=' '${APP_DIR}/data/.env' || cat /tmp/orwell-token >> '${APP_DIR}/data/.env'; rm -f /tmp/orwell-token"
fi
# The credential helper reads the token at use time — it never lands in a URL or .git/config.
pct exec "$CTID" -- bash -c "git config --system credential.helper '!f(){ echo username=x-access-token; echo \"password=\$(sed -n s/^GIT_TOKEN=//p ${APP_DIR}/data/.env)\"; };f'"
# init+fetch+reset (not clone): the data/.env we just seeded makes ${APP_DIR} non-empty.
pct exec "$CTID" -- bash -c "set -e; mkdir -p '${APP_DIR}'; cd '${APP_DIR}'; \
  [ -d .git ] || git init -q; \
  git remote get-url origin >/dev/null 2>&1 && git remote set-url origin '${REPO}' || git remote add origin '${REPO}'; \
  git fetch --depth 1 origin '${BRANCH}'; \
  git reset --hard \"origin/${BRANCH}\" --quiet"

# ── In-container install (LLM config, if any, is passed through and lands in data/.env) ─────────
msg "running in-container install (the checked-out deploy/orwell-install.sh)"
# DEPLOY-5 (2026-07-05 ops-hygiene close-out): don't interpolate the install env into a `pct exec
# … bash -c "…"` argv — it's visible in host/container `ps auxww` / `/proc/<pid>/cmdline` for the
# life of the process (and possibly longer under process accounting / an EDR agent). Same fix
# already applied to GIT_TOKEN above: push a temp file instead and `source` it in-container.
# (OLLAMA_HOST is not itself a secret, but is included here too for consistency — one mechanism,
# no argv passthrough at all.)
TMP_INSTALL_ENV="$(mktemp /tmp/orwell-install-env-XXXXXX)"
chmod 600 "$TMP_INSTALL_ENV"
{
  printf 'REPO=%q\n' "$REPO"
  printf 'BRANCH=%q\n' "$BRANCH"
  printf 'APP_DIR=%q\n' "$APP_DIR"
  printf 'ORWELL_PORT=%q\n' "$ORWELL_PORT"
  printf 'ORWELL_BIND_HOST=%q\n' "$ORWELL_BIND_HOST"
  [[ -n "$OLLAMA_HOST" ]] && printf 'OLLAMA_HOST=%q\n' "$OLLAMA_HOST"
} > "$TMP_INSTALL_ENV"
pct push "$CTID" "$TMP_INSTALL_ENV" /tmp/orwell-install-env --perms 0600
rm -f "$TMP_INSTALL_ENV"
pct exec "$CTID" -- bash -c \
  "set -a; source /tmp/orwell-install-env; set +a; rm -f /tmp/orwell-install-env; \
   bash '${APP_DIR}/deploy/orwell-install.sh'"

echo
echo "${C_GRN}╶───────────────────────────────────────────────────────────╴${C_OFF}"
echo "  ${C_BOLD}${C_GRN}orwell is deployed in LXC ${CTID}.${C_OFF}"
if [[ "$ORWELL_BIND_HOST" == "127.0.0.1" ]]; then
  # Loopback bind: the LAN IP is NOT reachable directly — it sits behind a proxy/HTTPS/tunnel.
  echo "  ${C_BOLD}play:${C_OFF}    http://127.0.0.1:${ORWELL_PORT}   ${C_DIM}(loopback — reach it via your reverse proxy / HTTPS / tunnel)${C_OFF}"
else
  echo "  ${C_BOLD}play:${C_OFF}    http://${IP}:${ORWELL_PORT}"
fi
echo "  ${C_DIM}enter:${C_OFF}   pct enter ${CTID}    ${C_DIM}then:${C_OFF} ${C_BOLD}orwell${C_OFF} ${C_DIM}(control panel)${C_OFF}"
if [[ -n "$CT_ROOT_PASSWORD" ]]; then
  echo "  ${C_DIM}console:${C_OFF} root + the password you set (or 'pct enter ${CTID}' from this host)"
else
  echo "  ${C_DIM}console:${C_OFF} disabled (no root password). Use 'pct enter ${CTID}', or set one:"
  echo "           pct exec ${CTID} -- passwd"
fi
echo "${C_GRN}╶───────────────────────────────────────────────────────────╴${C_OFF}"
