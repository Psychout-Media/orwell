#!/usr/bin/env bash
#
# orwell — ops runner: "Local HTTPS" apply/disable (feature 0074, ADR 0014).
#
# Started by orwell-ops-tls.service when the admin "Local HTTPS" card drops the existence-only flag
# data/ops/tls-requested. This is the privileged box side of the UI-driven local-TLS flow. The route
# layer has ALREADY validated the proposed config at request time (sanitised host names, fail closed);
# this script only translates what the wizard wrote into deploy/orwell-https.sh flags and runs it.
#
# DELIBERATELY ROOT (see the unit's comments): orwell-https.sh edits data/.env, apt-installs caddy,
# writes /etc/caddy/Caddyfile, enables a systemd service, and restarts the FE — none of which the
# E85-hardened web tier (User=orwell, empty capability set) can do. Containment is by DESIGN: only this
# one fixed script path runs; the flag is existence-only (its content is never read), and the side
# inputs the web tier writes are config DATA, never interpolated into any command.
#
# Side inputs the route layer wrote under data/ops/ (the contract; names are load-bearing):
#   tls-requested      existence-only flag (removed by the unit's ExecStartPre)
#   tls.json           {action:"apply"|"disable", mode, localNames:[…], domains:[…], dnsProvider, hasToken, ts}
#   tls-dns-token      0600; the DNS provider API token — CONSUMED + SHREDDED here, never logged
# Outputs:
#   tls-status.json    live progress (via orwell-ops-progress.sh) the admin page reads
#   ops-tls.log        the appended run log the status page tails (StandardOutput=append)
#
# THE DNS TOKEN IS A SECRET: it is never echoed to stdout/stderr (this whole script's output is the
# public run log), never written anywhere but its 0600 file, and is handed to orwell-https.sh via an
# ENV var (not argv) then SHREDDED. Re-runnable / idempotent.
set -Eeuo pipefail

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
CONFIG_FILE="${OPS_DIR}/tls.json"
TOKEN_FILE="${OPS_DIR}/tls-dns-token"
FLAG_FILE="${OPS_DIR}/tls-requested"
HTTPS_SH="${APP_DIR%/}/deploy/orwell-https.sh"

# ── ops-progress lane (best-effort; missing helper ⇒ no-op stubs) ─────────────────────────────────
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __pf in "${__here}/orwell-ops-progress.sh" /opt/orwell/deploy/orwell-ops-progress.sh /opt/bbai/deploy/orwell-ops-progress.sh; do
  if [[ -n "${__pf:-}" && -r "$__pf" ]]; then . "$__pf"; break; fi
done
type ops_progress_init >/dev/null 2>&1 || { ops_progress_init() { :; }; ops_progress_step() { :; }; ops_progress_done() { :; }; ops_progress_fail() { :; }; }
export ORWELL_OPS_DIR="${OPS_DIR}"

# SYMLINKS / RACES: this script runs as ROOT but reads, shreds and removes files under data/ops/, which
# the unprivileged service user owns — so nothing there may be followed (shred would destroy a symlink's
# TARGET; a read would publish the target's contents). A "check, then use" on a path the service user can
# still swap is racy, so the side files are CLAIMED first: renamed (a rename moves a symlink ITSELF, never
# its target) into a private root-owned temp dir, and only then checked, read and shredded there.
CLAIM_DIR=""
ORIG_CONFIG_FILE="$CONFIG_FILE"; ORIG_TOKEN_FILE="$TOKEN_FILE"

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
  shred_token
  [[ -z "$CLAIM_DIR" ]] || rm -rf -- "$CLAIM_DIR"
  # The originals (re-created mid-run, or never claimed): never through a symlinked ops dir; `rm -f` of a
  # symlinked FILE unlinks the link only.
  if [[ ! -L "$OPS_DIR" ]]; then rm -f -- "$ORIG_CONFIG_FILE" "$ORIG_TOKEN_FILE" "$FLAG_FILE" 2>/dev/null || true; fi
}
trap 'rc=$?; if [[ "$rc" -ne 0 ]]; then ops_progress_fail "local-HTTPS apply exited with code $rc — see ops-tls.log"; fi; cleanup_side_files' EXIT

refuse() {   # stamp the failure + exit
  ops_progress_init "tls" 3; ops_progress_fail "refusing to run: $1 is a symlink"
  echo "ERROR: $1 is a symlink — refusing to read, shred or write through it" >&2; exit 1
}
if [[ -L "$OPS_DIR" ]]; then refuse "$OPS_DIR"; fi
[[ ! -L "$FLAG_FILE" ]] || refuse "$FLAG_FILE"
CLAIM_DIR="$(mktemp -d)"
# Move the side files out of the service-writable ops dir into a root-private claim dir. Done through a
# dirfd opened O_NOFOLLOW|O_DIRECTORY, so swapping the dir for a symlink after the earlier -L check cannot
# redirect the rename; the files are renamed/copied by name relative to that fd and a symlink is moved as
# a link (never followed). Exit 3 = the ops dir itself is a symlink.
claim_side_files() {   # names…  (relative to $OPS_DIR)
  python3 - "$OPS_DIR" "$CLAIM_DIR" "$@" <<'PY'
import os, stat, sys
ops, claim, *names = sys.argv[1:]
try:
    dfd = os.open(ops, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
except FileNotFoundError:
    sys.exit(0)
except OSError:
    sys.exit(3)
cfd = os.open(claim, os.O_RDONLY | os.O_DIRECTORY)
for name in names:
    try:
        st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
    except FileNotFoundError:
        continue
    try:
        os.rename(name, name, src_dir_fd=dfd, dst_dir_fd=cfd)
        continue
    except OSError:
        pass                       # e.g. EXDEV: copy by fd instead
    if stat.S_ISLNK(st.st_mode):
        os.symlink(os.readlink(name, dir_fd=dfd), name, dir_fd=cfd)
    elif stat.S_ISREG(st.st_mode):
        src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
        try:
            data = b""
            while True:
                chunk = os.read(src, 65536)
                if not chunk:
                    break
                data += chunk
        finally:
            os.close(src)
        out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=cfd)
        try:
            os.write(out, data)
        finally:
            os.close(out)
    os.unlink(name, dir_fd=dfd)
PY
}
claim_side_files "${ORIG_CONFIG_FILE##*/}" "${ORIG_TOKEN_FILE##*/}" || refuse "$OPS_DIR"
CONFIG_FILE="${CLAIM_DIR}/${ORIG_CONFIG_FILE##*/}"; TOKEN_FILE="${CLAIM_DIR}/${ORIG_TOKEN_FILE##*/}"
for _p in "$CONFIG_FILE" "$TOKEN_FILE"; do
  if [[ -L "$_p" ]]; then refuse "${ORIG_CONFIG_FILE%/*}/${_p##*/}"; fi
done

[[ -r "$CONFIG_FILE" ]] || { ops_progress_init "tls" 3; ops_progress_fail "no tls.json side config found"; echo "ERROR: ${ORIG_CONFIG_FILE} missing" >&2; exit 1; }
[[ -x "$HTTPS_SH" || -r "$HTTPS_SH" ]] || { ops_progress_init "tls" 3; ops_progress_fail "deploy/orwell-https.sh not found"; echo "ERROR: ${HTTPS_SH} missing" >&2; exit 1; }

# Parse the non-secret config (tolerant). NEVER reads the token (that lives only in its 0600 file).
read_cfg() {
  python3 - "$CONFIG_FILE" "$1" <<'PY' 2>/dev/null || true
import json, os, sys
try:
    with os.fdopen(os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW), encoding="utf-8") as fh:
        cfg = json.load(fh)
except Exception:
    sys.exit(0)
key = sys.argv[2]
val = cfg.get(key)
if isinstance(val, list):
    print(",".join(str(x).strip() for x in val if str(x).strip()))
elif val is not None:
    print(str(val).strip())
PY
}

ACTION="$(read_cfg action)"
[[ "$ACTION" == "apply" || "$ACTION" == "disable" ]] || { ops_progress_init "tls" 3; ops_progress_fail "unknown or missing action in tls.json"; echo "ERROR: action must be apply|disable (got '${ACTION}')" >&2; exit 1; }

if [[ "$ACTION" == "disable" ]]; then
  ops_progress_init "tls" 2
  ops_progress_step 1 "disabling the local HTTPS terminator"
  echo "==> local HTTPS: disabling (back to plain HTTP)"
  bash "$HTTPS_SH" --disable --yes
  trap 'cleanup_side_files' EXIT
  ops_progress_done "local HTTPS disabled"
  exit 0
fi

# action=apply
ops_progress_init "tls" 3
LOCAL_NAMES="$(read_cfg localNames)"
DOMAINS="$(read_cfg domains)"
DNS_PROVIDER="$(read_cfg dnsProvider)"

ARGS=(--mode local --yes)
[[ -n "$LOCAL_NAMES"  ]] && ARGS+=(--local-names "$LOCAL_NAMES")
[[ -n "$DOMAINS"      ]] && ARGS+=(--domains "$DOMAINS")
[[ -n "$DNS_PROVIDER" ]] && ARGS+=(--dns-provider "$DNS_PROVIDER")

ops_progress_step 1 "applying local HTTPS profile"
echo "==> local HTTPS: applying (names: ${LOCAL_NAMES:-none}${DOMAINS:+, domain: ${DOMAINS}})"

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

# The DNS token (if the wizard pasted one) is passed via the ENV (never argv → never in `ps`), then
# shredded. orwell-https.sh reads ORWELL_TLS_DNS_API_TOKEN from the environment.
if [[ -f "$TOKEN_FILE" ]]; then
  ops_progress_step 2 "configuring the publicly-trusted (DNS-01) upgrade"
  DNS_TOKEN_VALUE="$(read_token)" || { echo "ERROR: could not read the DNS token file safely" >&2; exit 1; }
  ORWELL_TLS_DNS_API_TOKEN="$DNS_TOKEN_VALUE" bash "$HTTPS_SH" "${ARGS[@]}"
  shred_token
  echo "==> DNS API token consumed and shredded"
else
  ops_progress_step 2 "local names only (no DNS token supplied)"
  bash "$HTTPS_SH" "${ARGS[@]}"
fi

trap 'cleanup_side_files' EXIT
ops_progress_done "local HTTPS applied — front-end restarting"
echo "==> local HTTPS applied."
