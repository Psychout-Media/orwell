#!/usr/bin/env bash
#
# orwell — factory reset.
#
# "Factory reset" returns the app to first-run onboarding (OOBE) while PRESERVING the operator's
# LLM credentials — the API keys + the provider endpoint(s) — so you never have to re-enter your
# provider config. The SELECTED MODELS are RESET to the OOB defaults (issue #860) — whatever
# frontend/src/settings.py DEFAULT_SETTINGS says (today: default + utility model `deepseek-flash`,
# image model google/gemini-3.1-flash-image) — so a stale/placeholder pick can never ride across a reset.
# EVERYTHING ELSE is wiped: every per-user game sandbox (saves,
# souls, the hidden Vault layer) and the ENTIRE front-end store — all accounts, chats/sessions,
# memory, MCP configs, uploads, EVERY cast portrait / avatar / headshot, presets, and every other
# user setting. (The engine config data/.env is preserved, as in every reset.)
#
# This is intentionally IDENTICAL to the in-app admin "Factory Reset (OOBE)" button and to
# `orwell reset-oobe`: a reset must never throw away the operator's LLM credentials. The real
# work — preserve the model_endpoints (API keys), RESET the model selections to defaults, wipe the
# rest, rebuild — lives in orwell-oobe-reset.sh + frontend/scripts/oobe_reset.py. This script delegates to it so the two
# can NEVER drift. (Historically this script wiped the API keys too; that behavior was removed per
# the product decision that a factory reset keeps your LLM config — to also drop the keys, remove
# frontend/data/.app_key, .key, api_keys.json and app.db by hand.)
#
# Run on the Proxmox HOST or inside the container as root — same flags as the other resets:
#   bash /path/to/orwell-factory-reset.sh             # prompts to confirm (type RESET)
#   bash /path/to/orwell-factory-reset.sh --yes       # no prompt (automation)
#   bash /path/to/orwell-factory-reset.sh --dry-run   # show what WOULD be removed
#   bash /path/to/orwell-factory-reset.sh --no-restart # scrub but leave services down
#
# Paths/services are overridable via the same env vars orwell-oobe-reset.sh honors (APP_DIR,
# ORWELL_DATA_DIR, ORWELL_FE_DIR, ORWELL_FE_DATA_DIR, ORWELL_CONFIG_DIR, ORWELL_ENGINE_SVC, …).
set -euo pipefail

msg() { echo -e "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# Print this script's OWN purpose for --help, instead of forwarding to the implementation's help.
case "${1:-}" in
  -h|--help) sed -n '3,21p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# Locate the OOBE-reset implementation this script delegates to: alongside this file first (the
# local checkout — never a GitHub fetch of a branch tip, A4/ruling #17), then the install dirs.
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
OOBE=""
for cand in "${__here:+${__here}/orwell-oobe-reset.sh}" \
            /opt/orwell/deploy/orwell-oobe-reset.sh \
            /opt/bbai/deploy/orwell-oobe-reset.sh; do
  if [[ -n "$cand" && -r "$cand" ]]; then OOBE="$cand"; break; fi
done
[[ -n "$OOBE" ]] || die "cannot find orwell-oobe-reset.sh (the factory-reset implementation) next to this script or under /opt/orwell/deploy."

msg "factory reset → ${OOBE} (keeps API keys + endpoint; RESETS selected models to defaults; wipes everything else)"
# Hand off entirely (forwarding every flag), so the host→container bridge, confirmation, keys-safe
# preservation, scrub, ownership restore, ops-progress and restart all run from the one source.
exec bash "$OOBE" "$@"
