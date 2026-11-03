#!/usr/bin/env bash
#
# orwell — ops runner: "Connect to the internet" / public deployment (feature 0068, ADR 0007).
#
# Started by orwell-ops-public-deployment.service when the admin "Connect to the internet" wizard
# drops the existence-only flag data/ops/public-deployment-requested. This is the privileged box
# side of the UI-driven public-exposure flow (0067 is the hardening floor it applies). The route
# layer has ALREADY validated the proposed env at request time (assert_public_profile_safe — fail
# closed); this script only APPLIES what the wizard wrote, idempotently.
#
# DELIBERATELY ROOT (the unit's own comments carry the WHY): it must edit data/.env, apt-install +
# `cloudflared service install`, enable a systemd service, and restart the FE — every one of which
# the E85-hardened web tier (User=orwell, empty capability set) structurally cannot do. Containment
# is by DESIGN: only this one fixed script path ever runs; the flag is existence-only (its content
# is never read), and the side inputs the web tier writes are config DATA, never interpolated into
# any command.
#
# Side inputs the route layer wrote under data/ops/ (the contract; names are load-bearing):
#   public-deployment-requested   existence-only flag (removed by the unit's ExecStartPre)
#   public-deployment.json        {action:"apply"|"disconnect", env:{…}, domains:[…], hasToken, ts}
#   cloudflared-token             0600; the raw connector token — CONSUMED + SHREDDED here, never logged
# Outputs:
#   public-deployment-status.json live progress (via orwell-ops-progress.sh) the admin page reads
#   ops-public-deployment.log     the appended run log the status page tails (StandardOutput=append)
#
# THE TOKEN IS A SECRET: it is never echoed to stdout/stderr (this whole script's output is the
# public run log), never written anywhere but its 0600 file, and is SHREDDED the moment cloudflared
# has consumed it. Re-runnable / idempotent: a second run upserts the same keys and no-ops the rest.
set -Eeuo pipefail

# First install dir found: an explicit override, then the current path, then the legacy one. The
# units hard-code /opt/orwell, but honor APP_DIR for a dev checkout / test.
find_app() {
  local d
  for d in "${APP_DIR:-}" /opt/orwell /opt/bbai; do
    [[ -n "$d" && -d "$d/.git" ]] && { printf '%s' "$d"; return 0; }
  done
  return 1
}
APP_DIR="$(find_app || true)"; APP_DIR="${APP_DIR:-/opt/orwell}"
DATA_DIR="${ORWELL_DATA_DIR:-${APP_DIR%/}/data}"
OPS_DIR="${DATA_DIR%/}/ops"
ENV_FILE="${DATA_DIR%/}/.env"
CONFIG_FILE="${OPS_DIR}/public-deployment.json"
TOKEN_FILE="${OPS_DIR}/cloudflared-token"
FLAG_FILE="${OPS_DIR}/public-deployment-requested"

# ── ops-progress lane: step-by-step progress to data/ops/public-deployment-status.json ───────────
# The admin "Public deployment" card reads this back as a live timeline. Best-effort; a missing
# helper ⇒ no-op stubs that never abort the run.
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __pf in "${__here}/orwell-ops-progress.sh" /opt/orwell/deploy/orwell-ops-progress.sh /opt/bbai/deploy/orwell-ops-progress.sh; do
  if [[ -n "${__pf:-}" && -r "$__pf" ]]; then . "$__pf"; break; fi
done
type ops_progress_init >/dev/null 2>&1 || { ops_progress_init() { :; }; ops_progress_step() { :; }; ops_progress_done() { :; }; ops_progress_fail() { :; }; }
export ORWELL_OPS_DIR="${OPS_DIR}"

# SYMLINKS / RACES: this script runs as ROOT but reads, shreds, removes and rewrites files under data/ and
# data/ops/, which the unprivileged service user owns — so nothing there may be followed (shred would
# destroy a symlink's TARGET; a read would publish the target's contents; a write or chown would hit the
# target). A "check, then use" on a path the service user can still swap is racy, so the side files are
# CLAIMED first: renamed (a rename moves a symlink ITSELF, never its target) into a private root-owned temp
# dir, and only then checked, read and shredded there. data/.env is edited only via mktemp + rename.
CLAIM_DIR=""
ORIG_CONFIG_FILE="$CONFIG_FILE"; ORIG_TOKEN_FILE="$TOKEN_FILE"

# Shred the connector token the moment it has been consumed. shred -u where available; otherwise
# overwrite-then-remove. Called from a trap-safe spot AND idempotent (no-op if already gone).
shred_token() {
  # Only ever the CLAIMED copy (root-private); never a path in the service-writable ops dir.
  [[ -n "$CLAIM_DIR" && -e "$TOKEN_FILE" && ! -L "$TOKEN_FILE" ]] || return 0
  if command -v shred >/dev/null 2>&1; then
    shred -u "$TOKEN_FILE" 2>/dev/null || { dd if=/dev/zero of="$TOKEN_FILE" bs=1024 count=1 conv=notrunc 2>/dev/null || true; rm -f "$TOKEN_FILE"; }
  else
    dd if=/dev/zero of="$TOKEN_FILE" bs=1024 count=1 conv=notrunc 2>/dev/null || true
    rm -f "$TOKEN_FILE"
  fi
}

cleanup_side_files() {
  # Shred the claimed token (a no-op once consumed), drop the private dir, then the originals
  # (re-created mid-run, or never claimed) — never through a symlinked ops dir. `rm -f` of a
  # symlinked FILE unlinks the link only, so a planted symlink is dropped, never followed.
  shred_token
  [[ -z "$CLAIM_DIR" ]] || rm -rf -- "$CLAIM_DIR"
  if [[ ! -L "$OPS_DIR" ]]; then rm -f -- "$ORIG_CONFIG_FILE" "$ORIG_TOKEN_FILE" "$FLAG_FILE" 2>/dev/null || true; fi
}
# Always leave a terminal record + clean up the side files, however we exit. The trap stamps a
# FAILURE if any command tripped pipefail; the success path clears it before ops_progress_done.
trap 'rc=$?; if [[ "$rc" -ne 0 ]]; then ops_progress_fail "public-deployment exited with code $rc — see ops-public-deployment.log"; fi; cleanup_side_files' EXIT

# Service names follow the install: prefer orwell-*, fall back to the legacy bbai-* units.
unit_exists() { systemctl list-unit-files "$1" 2>/dev/null | grep -q "$1"; }
if unit_exists orwell-frontend.service; then
  FRONTEND_SVC="orwell-frontend"
elif unit_exists bbai-frontend.service; then
  FRONTEND_SVC="bbai-frontend"
else
  FRONTEND_SVC="orwell-frontend"
fi

# ── Read the side config (tolerant parse) ────────────────────────────────────────────────────────
# python3 is always present on a real install (the FE is Python). Pull the action + every env key
# the route layer proposed. NEVER the token (that lives only in its 0600 file). A missing/garbage
# config is a hard fail — we will not guess what the admin asked for.
refuse() {   # stamp the failure + exit
  ops_progress_init "public-deployment" 4; ops_progress_fail "refusing to run: $1 is a symlink"
  echo "ERROR: $1 is a symlink — refusing to read, shred or write through it" >&2; exit 1
}
if [[ -L "$OPS_DIR" ]]; then refuse "$OPS_DIR"; fi
[[ ! -L "$FLAG_FILE" ]] || refuse "$FLAG_FILE"
[[ ! -L "$ENV_FILE" ]]  || refuse "$ENV_FILE"
CLAIM_DIR="$(mktemp -d)"
for _f in "$ORIG_CONFIG_FILE" "$ORIG_TOKEN_FILE"; do
  if [[ -e "$_f" || -L "$_f" ]]; then mv -fT -- "$_f" "${CLAIM_DIR}/${_f##*/}"; fi
done
CONFIG_FILE="${CLAIM_DIR}/${ORIG_CONFIG_FILE##*/}"; TOKEN_FILE="${CLAIM_DIR}/${ORIG_TOKEN_FILE##*/}"
for _p in "$CONFIG_FILE" "$TOKEN_FILE"; do
  if [[ -L "$_p" ]]; then refuse "${OPS_DIR}/${_p##*/}"; fi
done

[[ -r "$CONFIG_FILE" ]] || { ops_progress_init "public-deployment" 4; ops_progress_fail "no public-deployment.json side config found"; echo "ERROR: ${ORIG_CONFIG_FILE} missing" >&2; exit 1; }

ACTION="$(python3 - "$CONFIG_FILE" <<'PY' 2>/dev/null || true
import json, os, sys
try:
    with os.fdopen(os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW), encoding="utf-8") as fh:
        cfg = json.load(fh)
    print(str(cfg.get("action", "")).strip())
except Exception:
    print("")
PY
)"
[[ "$ACTION" == "apply" || "$ACTION" == "disconnect" ]] || { ops_progress_init "public-deployment" 4; ops_progress_fail "unknown or missing action in public-deployment.json"; echo "ERROR: action must be apply|disconnect (got '${ACTION}')" >&2; exit 1; }

# Emit the env map as KEY=VALUE lines (only for action=apply). The side file is written by the
# unprivileged web tier (or by anything running as its user), so it is NOT trusted to be what the route
# layer validated: only the four keys the wizard owns are accepted, and a value with a control character
# (a newline would start a new KEY=VALUE line in data/.env) is skipped and reported, never written.
read_env_pairs() {
  python3 - "$CONFIG_FILE" <<'PY' || true
import json, os, re, sys
ALLOWED = {"ORWELL_PUBLIC", "ALLOWED_HOSTS", "ALLOWED_ORIGINS", "SECURE_COOKIES"}
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
try:
    with os.fdopen(os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW), encoding="utf-8") as fh:
        cfg = json.load(fh)
    env = cfg.get("env") or {}
    if isinstance(env, dict):
        for k, v in env.items():
            k, v = str(k).strip(), str(v)
            if k not in ALLOWED:
                print(f"WARN: ignoring unexpected key '{k}' in the public-deployment config", file=sys.stderr)
            elif CONTROL.search(v):
                print(f"WARN: ignoring {k}: its value contains a control character", file=sys.stderr)
            else:
                print(f"{k}={v}")
except Exception:
    pass
PY
}

# ── .env upsert (idempotent; mirrors orwell-update.sh's --set-token rotate-in-place) ─────────────
# Replace an existing `KEY=` line in place, else append. data/.env stays mode 600. A tmp + mv keeps
# the file intact if something trips mid-write; every OTHER line is preserved untouched.
upsert_env() {
  local key="$1" value="$2"
  mkdir -p "$DATA_DIR"
  # No touch/chmod on $ENV_FILE itself (both dereference a symlink): the mktemp copy below is created
  # 0600 and renamed over it, which creates the file when absent and replaces — never follows — a link.
  local tmp; tmp="$(mktemp "${DATA_DIR}/.env.XXXXXX")"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  mv -fT "$tmp" "$ENV_FILE"
}

# Remove a key entirely from data/.env (used by disconnect; also tmp + mv, mode preserved).
remove_env_key() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  local tmp; tmp="$(mktemp "${DATA_DIR}/.env.XXXXXX")"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  chmod 600 "$tmp"
  mv -fT "$tmp" "$ENV_FILE"
}

# ── cloudflared install (idempotent) — apt via the Cloudflare repo, .deb fallback ────────────────
# Already present ⇒ no-op. apt path first (the Cloudflare pkg repo); if the repo can't be reached we
# fall back to the published .deb for the host arch. NEVER touches the token.
install_cloudflared() {
  command -v cloudflared >/dev/null 2>&1 && { echo "==> cloudflared already installed"; return 0; }
  echo "==> installing cloudflared"
  export DEBIAN_FRONTEND=noninteractive
  local keyring="/usr/share/keyrings/cloudflare-main.gpg"
  local listfile="/etc/apt/sources.list.d/cloudflared.list"
  if mkdir -p --mode=0755 /usr/share/keyrings 2>/dev/null \
     && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg 2>/dev/null | tee "$keyring" >/dev/null \
     && echo "deb [signed-by=${keyring}] https://pkg.cloudflare.com/cloudflared any main" > "$listfile" \
     && apt-get update -y >/dev/null 2>&1 \
     && apt-get install -y cloudflared >/dev/null 2>&1; then
    echo "==> cloudflared installed from the Cloudflare apt repo"
    return 0
  fi
  echo "WARN: apt repo path unavailable — falling back to the .deb release"
  local arch deb
  arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
  deb="$(mktemp /tmp/cloudflared-XXXXXX.deb)"
  if curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb" -o "$deb" \
     && apt-get install -y "$deb" >/dev/null 2>&1; then
    rm -f "$deb"
    echo "==> cloudflared installed from the .deb release"
    return 0
  fi
  rm -f "$deb"
  echo "ERROR: could not install cloudflared (apt repo and .deb both failed)" >&2
  return 1
}

# read_token: print the token file's contents; fails on a symlink, anything but a regular file, or a token
# carrying a control character (O_NOFOLLOW, so it cannot be raced). Output goes only into a variable — never to the run log.
read_token() {
  python3 - "$TOKEN_FILE" <<'PY'
import os, re, stat, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
if not stat.S_ISREG(os.fstat(fd).st_mode):
    sys.exit(1)
token = os.read(fd, 65536).decode("utf-8", "replace").rstrip("\r\n")
if re.search(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", token):   # a token never contains control characters
    sys.exit(2)
sys.stdout.write(token)
PY
}

# ── apply ────────────────────────────────────────────────────────────────────────────────────────
do_apply() {
  ops_progress_init "public-deployment" 4
  echo "==> public deployment: applying the public profile"

  ops_progress_step 1 "writing public-profile env"
  # Upsert each proposed key (ORWELL_PUBLIC, ALLOWED_HOSTS, ALLOWED_ORIGINS, SECURE_COOKIES).
  local pairs; pairs="$(read_env_pairs)"
  if [[ -n "$pairs" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      local k="${line%%=*}" v="${line#*=}"
      upsert_env "$k" "$v"
    done <<< "$pairs"
  fi
  # The 0067 floor is non-negotiable on the public profile: force auth ON, the localhost bypass
  # OFF, and the bind host to loopback — regardless of what the config carried. A public box must
  # never run open, with the dev bypass live, or listening in the clear on a public/wildcard
  # interface (DEPLOY-2 — the route-layer validator now checks the box's real current
  # ORWELL_BIND_HOST too, but this is the belt-and-suspenders floor that can't drift out of sync
  # with it). Idempotent upserts.
  upsert_env "AUTH_ENABLED" "true"
  upsert_env "LOCALHOST_BYPASS" "false"
  upsert_env "ORWELL_BIND_HOST" "127.0.0.1"

  # The connector token (if the wizard pasted one): install + run cloudflared, then SHRED it.
  if [[ -f "$TOKEN_FILE" ]]; then
    ops_progress_step 2 "installing the tunnel connector"
    install_cloudflared
    echo "==> registering the cloudflared connector service"
    # The token is passed via the TUNNEL_TOKEN env var (never argv → never in `ps`/`/proc/<pid>/cmdline`),
    # matching the DNS-token sibling (orwell-ops-tls.sh). The command's own stdout can include the token
    # on some versions, so it is silenced. cloudflared reads TUNNEL_TOKEN when no token arg is given.
    local tunnel_token
    tunnel_token="$(read_token)" || { echo "ERROR: could not read the connector token file safely" >&2; exit 1; }
    if TUNNEL_TOKEN="$tunnel_token" cloudflared service install >/dev/null 2>&1; then
      echo "==> cloudflared service installed"
    else
      echo "WARN: 'cloudflared service install' returned non-zero (it may already be installed)"
    fi
    shred_token
    echo "==> connector token consumed and shredded"
    systemctl enable --now cloudflared >/dev/null 2>&1 || echo "WARN: could not enable --now cloudflared"
  else
    ops_progress_step 2 "no connector token supplied — env applied only"
    echo "==> no connector token present; applied the public env without (re)installing the tunnel"
  fi

  ops_progress_step 3 "restarting the front-end to apply"
  echo "==> restart ${FRONTEND_SVC} (the new env is boot-read)"
  systemctl restart "$FRONTEND_SVC"

  trap 'cleanup_side_files' EXIT
  ops_progress_done "public deployment applied — front-end restarting"
  echo "==> public deployment applied."
}

# ── disconnect ───────────────────────────────────────────────────────────────────────────────────
do_disconnect() {
  ops_progress_init "public-deployment" 3
  echo "==> public deployment: disconnecting (back to LAN-only)"

  ops_progress_step 1 "disabling public mode in .env"
  # Flip ORWELL_PUBLIC off by removing the line (absent ⇒ the non-public default).
  remove_env_key "ORWELL_PUBLIC"

  ops_progress_step 2 "stopping the tunnel connector"
  # Stop + disable the connector but LEAVE it installed (a later reconnect needs no reinstall).
  systemctl disable --now cloudflared >/dev/null 2>&1 || echo "==> cloudflared not active (nothing to stop)"

  ops_progress_step 3 "restarting the front-end to apply"
  echo "==> restart ${FRONTEND_SVC}"
  systemctl restart "$FRONTEND_SVC"

  trap 'cleanup_side_files' EXIT
  ops_progress_done "disconnected — LAN-only restored"
  echo "==> disconnected."
}

case "$ACTION" in
  apply)      do_apply ;;
  disconnect) do_disconnect ;;
esac
