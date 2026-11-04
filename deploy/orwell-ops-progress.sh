# shellcheck shell=bash
#
# orwell — ops progress helper (sourced, NOT executed). One line per phase lets a privileged
# ops script (orwell-update.sh, orwell-oobe-reset.sh, and any future orwell-update-reset.sh)
# publish step-by-step progress that the admin health page reads back live.
#
# WHY THIS FILE: the admin "Update" / "Factory Reset (OOBE)" buttons used to log "triggered" and
# then go quiet — the operator could not tell whether the box was stopping services, scrubbing,
# rebuilding, or had silently no-op'd. This helper writes a tiny status JSON the web tier serves
# at GET /api/admin/ops-status and the status page renders as a live timeline, so every phase is
# visible and a FAILURE is surfaced (never a silent success).
#
# CONTRACT (kept deliberately tiny and dependency-free — pure bash + printf, no jq):
#   ops_progress_init  <action> <total>           # begin: running=true, step=0
#   ops_progress_step  <step> <message>           # advance: running=true, ok=false, error=""
#   ops_progress_done  [message]                  # finish OK: running=false, ok=true
#   ops_progress_fail  <reason>                   # finish FAIL: running=false, ok=false, error=reason
#
# The status file is data/ops/<action>-status.json, OVERWRITE-safe (a fresh run replaces it) and
# written atomically (tmp + mv) so a concurrent reader never sees a half-written file. It is made
# world-READABLE (0644) so the non-root web tier can read what this (root) script writes. Every
# helper is best-effort: a status-write failure must NEVER abort the ops run itself (the run is the
# point; the breadcrumb is a courtesy), so each call is guarded and returns success regardless.
#
# Sourcing: each ops script sources this beside itself (and the installed/legacy paths), exactly
# like orwell-tui.sh. If it is missing the no-op stubs at the bottom keep the ops script working.

# Resolve the data/ops dir the web tier reads. ORWELL_OPS_DIR wins (tests/dev); otherwise derive
# it from APP_DIR (set by the ops script before sourcing) or fall back to the known install path.
_ops_progress_dir() {
  if [[ -n "${ORWELL_OPS_DIR:-}" ]]; then printf '%s' "${ORWELL_OPS_DIR%/}"; return 0; fi
  local base="${APP_DIR:-/opt/orwell}"
  printf '%s' "${base%/}/data/ops"
}

# JSON-escape a string for embedding as a value (backslash + quote escaped; control chars flattened).
_ops_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"   # backslash first
  s="${s//\"/\\\"}"   # quote
  s="${s//$'\n'/ }"   # newlines → spaces (one-line message)
  s="${s//$'\r'/}"    # strip CR
  s="${s//$'\t'/ }"   # tabs → spaces
  printf '%s' "$s"
}

# Current ISO-8601 UTC timestamp (date is always present; fall back to epoch if not).
_ops_progress_ts() { date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '%s' "$(date +%s 2>/dev/null || echo 0)"; }

# Atomically write the status JSON for ACTION. All fields are passed in by the callers above.
#   $1 action  $2 step  $3 total  $4 message  $5 running(true|false)  $6 ok(true|false)  $7 error
_ops_progress_write() {
  local action="$1" step="$2" total="$3" message="$4" running="$5" ok="$6" error="$7"
  local dir; dir="$(_ops_progress_dir)"
  # This runs as ROOT but writes into data/ops/, which the unprivileged service user owns: never
  # write through a symlinked dir (it could point anywhere), and never use a predictable temp name
  # (a pre-planted symlink at that name would be followed). mktemp creates the temp file O_EXCL.
  if [[ -L "$dir" ]]; then echo "WARN: ops status dir ${dir} is a symlink — refusing to write status" >&2; return 0; fi
  # Best-effort: create the dir; if we cannot, give up quietly (never fail the run).
  mkdir -p "$dir" 2>/dev/null || return 0
  local out="${dir}/${action}-status.json"
  # The temp file lives in root's own temp dir (sticky /tmp, or $TMPDIR), NOT in $dir: $dir is writable by
  # the service user, which could swap a temp file there for a symlink between mktemp and the write below.
  local tmp; tmp="$(mktemp "${TMPDIR:-/tmp}/orwell-ops-${action}.XXXXXX" 2>/dev/null)" || return 0
  local ts; ts="$(_ops_progress_ts)"
  message="$(_ops_json_escape "$message")"
  error="$(_ops_json_escape "$error")"
  {
    printf '{'
    printf '"action":"%s",'  "$(_ops_json_escape "$action")"
    printf '"step":%s,'      "${step:-0}"
    printf '"total":%s,'     "${total:-0}"
    printf '"message":"%s",' "$message"
    printf '"running":%s,'   "${running:-false}"
    printf '"ok":%s,'        "${ok:-false}"
    printf '"error":"%s",'   "$error"
    printf '"ts":"%s"'       "$ts"
    printf '}\n'
  } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 0; }
  chmod 644 "$tmp" 2>/dev/null || true
  # -T: $out is the destination FILE, never "a directory to move into" (a symlink planted there is
  # replaced by the rename, not followed).
  mv -fT "$tmp" "$out" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 0; }
  return 0
}

# ── Public API ─────────────────────────────────────────────────────────────────────────────────
# Each tracks the action + total in module-level vars so step/done/fail callers stay one-liners.
ops_progress_init() {
  ORWELL_OPS_ACTION="${1:-ops}"
  ORWELL_OPS_TOTAL="${2:-0}"
  ORWELL_OPS_STEP=0
  _ops_progress_write "$ORWELL_OPS_ACTION" 0 "$ORWELL_OPS_TOTAL" "starting…" true false ""
}
ops_progress_step() {
  local step="${1:-0}" message="${2:-}"
  ORWELL_OPS_STEP="$step"
  _ops_progress_write "${ORWELL_OPS_ACTION:-ops}" "$step" "${ORWELL_OPS_TOTAL:-0}" "$message" true false ""
}
ops_progress_done() {
  local message="${1:-done}"
  _ops_progress_write "${ORWELL_OPS_ACTION:-ops}" "${ORWELL_OPS_TOTAL:-0}" "${ORWELL_OPS_TOTAL:-0}" "$message" false true ""
}
ops_progress_fail() {
  local reason="${1:-failed}"
  _ops_progress_write "${ORWELL_OPS_ACTION:-ops}" "${ORWELL_OPS_STEP:-0}" "${ORWELL_OPS_TOTAL:-0}" "FAILED: ${reason}" false false "$reason"
}
