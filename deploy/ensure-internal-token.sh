#!/usr/bin/env bash
# ORW-1173: make sure ORWELL_INTERNAL_TOKEN exists in data/.env. Standalone and idempotent; the value is never printed.
#
# Unset, the front end mints a random per-process token and no ops script can authenticate to /api/admin/ops/*.
#
#   ensure-internal-token.sh [ENV_FILE]            mint one once when the key is absent or empty; never overwrite an existing value
#   ensure-internal-token.sh --check [ENV_FILE]    the doctor's check: prints one "ok"/"warn" line, exit 0 when set, 1 when not
#
# ENV_FILE defaults to ${ORWELL_HOME:-/opt/orwell}/data/.env. orwell-install.sh writes the token on a first install; orwell-update.sh
# and orwell-doctor.sh call this script (one line each).
set -euo pipefail
MODE=ensure
if [[ "${1:-}" == "--check" ]]; then MODE=check; shift; fi
ENV_FILE="${1:-${ORWELL_HOME:-/opt/orwell}/data/.env}"
KEY=ORWELL_INTERNAL_TOKEN

is_set() { grep -Eqs "^${KEY}=." "$ENV_FILE"; }

if [[ "$MODE" == check ]]; then
  [[ -f "$ENV_FILE" ]] || exit 0
  if is_set; then echo "  ok   — ${KEY} is set (ops scripts can authenticate)"; exit 0; fi
  echo "  warn — ${KEY} is not set in ${ENV_FILE}: the front end uses a random per-process token, so no ops script can call /api/admin/ops/*; run: bash $(dirname "${BASH_SOURCE[0]}")/ensure-internal-token.sh"
  exit 1
fi

[[ -f "$ENV_FILE" ]] || { echo "ensure-internal-token: ${ENV_FILE} not found; nothing done" >&2; exit 0; }
if is_set; then exit 0; fi
secret="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
[[ ${#secret} -eq 64 ]] || { echo "ensure-internal-token: could not make a secret" >&2; exit 1; }
tmp="$(mktemp "${ENV_FILE}.tok.XXXXXX")"
cat "$ENV_FILE" > "$tmp"
printf '%s=%s\n' "$KEY" "$secret" >> "$tmp"
chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
chown --reference="$ENV_FILE" "$tmp" 2>/dev/null || true
mv "$tmp" "$ENV_FILE"
echo "==> ${KEY} minted into ${ENV_FILE} (value not shown)"
