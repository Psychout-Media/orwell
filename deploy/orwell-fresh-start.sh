#!/usr/bin/env bash
#
# orwell-fresh-start.sh (ORW-331) - the tested "master wipe + update" for a returning player.
#
#   backup    take a backup, verify it, record it, and (with --offbox) copy it off the box
#   wipe      stop the app, clear every game, session and chat; KEEP accounts, the encrypted endpoint rows (+ their key), settings
#   update    update to a PINNED sha (never the branch tip)
#   postcheck doctor, ready, the text-routing line, zero keyed session rows (count only), the first narrator turn to api.deepseek.com
#   rollback  put back the backup and the previous build, then run the post-checks
#   preflight read-only: what would happen and whether it can
#   all       preflight, backup, wipe, update, postcheck (stops at the first failure and prints the rollback command)
#
# Run as root ON THE BOX (the app and its units live there). It composes the box's own scripts (orwell-backup, orwell-game-reset, orwell-update,
# orwell-doctor, orwell-ready, orwell-restore); only the front-end store wipe is new (frontend/scripts/fresh_start_wipe.py, stdlib only, so it can
# be pushed alongside this file before the update lands). It prints counts and paths, never a key or a row value.
#
#   orwell-fresh-start.sh all --ref <sha> [--offbox user@host:/dir] [--yes] [--first-turn-wait 300]
#   orwell-fresh-start.sh rollback
#
# Env: APP_DIR (default /opt/orwell) - FRESH_WIPE_PY (path to fresh_start_wipe.py when it is not beside this file / in the checkout).
# DRY RUN: --dry-run on preflight/backup/wipe/update only reports. Prod is touched only when the owner says go; this script cannot tell the
# difference between boxes, so the runbook (vault: "Orwell Fresh Start Runbook") names the box every time.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/orwell}"
CMD="${1:-}"; [[ $# -gt 0 ]] && shift
REF=""; OFFBOX=""; YES=0; DRY=0; FIRST_TURN_WAIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)             REF="${2:-}"; shift ;;
    --offbox)          OFFBOX="${2:-}"; shift ;;
    --yes|-y)          YES=1 ;;
    --dry-run|-n)      DRY=1 ;;
    --first-turn-wait) FIRST_TURN_WAIT="${2:-0}"; shift ;;
    -h|--help)         sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                 echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
FE_DATA="${ORWELL_FE_DATA_DIR:-${APP_DIR}/frontend/data}"
OPS_DIR="${APP_DIR}/data/ops"
STATE="${OPS_DIR}/fresh-start.state"
BACKUP_DIR="${FRESH_BACKUP_DIR:-${APP_DIR}/backups}"
DEPLOY="${APP_DIR}/deploy"
ENGINE_SVC="orwell-engine"; FRONTEND_SVC="orwell-frontend"

msg()  { echo "==> $*"; }
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }
warn() { echo "  WARN  $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }
FAILS=0
phase_start() { PHASE_T0=$SECONDS; msg "$1"; }
phase_end()   { echo "    [$1 took $((SECONDS - PHASE_T0))s]"; }

state_get() { [[ -f "$STATE" ]] && grep -E "^$1=" "$STATE" | tail -1 | cut -d= -f2- || true; }
state_set() { mkdir -p "$OPS_DIR"; { grep -vE "^$1=" "$STATE" 2>/dev/null || true; echo "$1=$2"; } > "${STATE}.tmp" && mv "${STATE}.tmp" "$STATE"; }

need_root() { [[ "$(id -u)" -eq 0 || "${FRESH_TEST_NONROOT:-0}" == "1" ]] || die "run as root on the box (it stops services and writes under ${APP_DIR})."; }
need_app()  { [[ -d "$APP_DIR/.git" ]] || die "no orwell checkout at ${APP_DIR} (set APP_DIR)."; }
wipe_py() {
  local c
  for c in "${FRESH_WIPE_PY:-}" "${HERE}/../frontend/scripts/fresh_start_wipe.py" "${HERE}/fresh_start_wipe.py" "${APP_DIR}/frontend/scripts/fresh_start_wipe.py"; do
    [[ -n "$c" && -r "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
valid_ref() { [[ "$1" =~ ^[0-9a-fA-F]{7,40}$ ]]; }
svc_exists() { systemctl list-unit-files "${1}.service" --no-legend 2>/dev/null | grep -q .; }
fe_db_count() {  # count only - never a value
  python3 - "$FE_DATA/app.db" "$1" <<'PY' 2>/dev/null || echo "?"
import sqlite3, sys
db, q = sys.argv[1], sys.argv[2]
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10)
print(c.execute(q).fetchone()[0])
PY
}

# ── preflight ───────────────────────────────────────────────────────────────────────────────────────────────
do_preflight() {
  phase_start "preflight (read-only)"
  need_app
  [[ "$(id -u)" -eq 0 ]] || warn "not root: the real run needs root"
  local head; head="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "  box: $(hostname)  app: ${APP_DIR}  running: ${head}"
  if [[ -n "$REF" ]]; then
    valid_ref "$REF" || die "--ref must be a 7-40 hex sha (a pinned commit), got '${REF}'."
    git -C "$APP_DIR" fetch -q origin 2>/dev/null || warn "git fetch failed (the update step will fetch again)"
    git -C "$APP_DIR" cat-file -e "${REF}^{commit}" 2>/dev/null && pass "target ${REF} is a known commit" || fail "target ${REF} is not a commit this checkout knows (fetch first)"
  else
    echo "  (no --ref given: needed for update/all)"
  fi
  local free_kb need_kb
  free_kb="$(df -Pk "$APP_DIR" | awk 'NR==2{print $4}')"
  need_kb="$(( $(du -sk "$APP_DIR/data" "$FE_DATA" 2>/dev/null | awk '{s+=$1} END{print s+0}') * 3 ))"
  [[ "${free_kb:-0}" -gt "$need_kb" ]] && pass "disk: ${free_kb} KB free, ~${need_kb} KB needed (3x the data)" || fail "disk: ${free_kb} KB free < ~${need_kb} KB needed"
  local py; py="$(wipe_py)" || { fail "fresh_start_wipe.py not found (set FRESH_WIPE_PY)"; py=""; }
  if [[ -n "$py" ]]; then echo "  what the wipe would clear:"; python3 "$py" --data-dir "$FE_DATA" --dry-run | sed 's/^/  /'; fi
  [[ -x "$DEPLOY/orwell-backup.sh" || -r "$DEPLOY/orwell-backup.sh" ]] && pass "box scripts present (backup, game-reset, update, doctor, ready, restore)" || fail "box deploy scripts missing in ${DEPLOY}"
  phase_end preflight
  [[ $FAILS -eq 0 ]]
}

# ── backup ──────────────────────────────────────────────────────────────────────────────────────────────────
do_backup() {
  need_root; need_app
  phase_start "backup"
  if [[ $DRY -eq 1 ]]; then echo "  would run orwell-backup.sh into ${BACKUP_DIR}${OFFBOX:+ and copy to ${OFFBOX}}"; phase_end backup; return 0; fi
  mkdir -p "$BACKUP_DIR"
  local out tar
  out="$(bash "$DEPLOY/orwell-backup.sh" "$BACKUP_DIR" 2>&1)" || { echo "$out" | tail -5; die "backup failed - nothing was changed."; }
  tar="$(ls -t "$BACKUP_DIR"/orwell-backup-*.tar.gz 2>/dev/null | head -1)"
  [[ -n "$tar" && -s "$tar" ]] || die "no backup archive produced in ${BACKUP_DIR} - nothing was changed."
  local n; n="$(tar tzf "$tar" 2>/dev/null | wc -l)"
  [[ "$n" -gt 5 ]] || die "backup ${tar} lists only ${n} entries - refusing to treat it as a backup."
  tar tzf "$tar" | grep -q 'frontend/data/app.db' || die "backup ${tar} has no frontend/data/app.db."
  local sum; sum="$(sha256sum "$tar" | cut -d' ' -f1)"
  pass "archive ${tar} ($(du -h "$tar" | cut -f1), ${n} entries, sha256 ${sum:0:16}...)"
  state_set BACKUP "$tar"; state_set BACKUP_SHA256 "$sum"; state_set PREV_SHA "$(git -C "$APP_DIR" rev-parse HEAD)"; state_set BACKUP_AT "$(date -u +%FT%TZ)"
  if [[ -n "$OFFBOX" ]]; then
    scp -q -o BatchMode=yes "$tar" "$OFFBOX" && pass "copied off the box to ${OFFBOX}" || die "off-box copy to ${OFFBOX} FAILED - do not wipe."
    state_set OFFBOX "$OFFBOX"
  else
    warn "NOT copied off the box (pass --offbox user@host:/dir). The wipe step refuses without a recorded off-box copy unless FRESH_ALLOW_ONBOX=1 is set."
  fi
  phase_end backup
}

# ── wipe ────────────────────────────────────────────────────────────────────────────────────────────────────
do_wipe() {
  need_root; need_app
  phase_start "wipe games, sessions and chats (keeps accounts, endpoints, settings)"
  local tar; tar="$(state_get BACKUP)"
  if [[ $DRY -eq 0 ]]; then
    [[ -n "$tar" && -s "$tar" ]] || die "no recorded backup - run 'backup' first. Nothing was changed."
    local age=$(( $(date +%s) - $(stat -c %Y "$tar") ))
    [[ $age -lt 21600 ]] || die "the recorded backup is $((age / 3600))h old (limit 6h) - take a fresh one."
    [[ -n "$(state_get OFFBOX)" || "${FRESH_ALLOW_ONBOX:-0}" == "1" ]] || die "the backup has not been copied off the box (use backup --offbox, or FRESH_ALLOW_ONBOX=1)."
    if [[ $YES -ne 1 ]]; then
      read -r -p "Type FRESH to wipe every game, session and chat on $(hostname): " ans
      [[ "$ans" == "FRESH" ]] || die "aborted - nothing was changed."
    fi
  fi
  local py; py="$(wipe_py)" || die "fresh_start_wipe.py not found (set FRESH_WIPE_PY)."
  if [[ $DRY -eq 1 ]]; then
    echo "  would stop ${FRONTEND_SVC}/${ENGINE_SVC}, run orwell-game-reset.sh --yes --no-restart, then:"
    python3 "$py" --data-dir "$FE_DATA" --dry-run | sed 's/^/    /'; echo "  then restart both."; phase_end wipe; return 0
  fi
  for s in "$FRONTEND_SVC" "$ENGINE_SVC"; do svc_exists "$s" && systemctl stop "$s"; done
  for s in "$FRONTEND_SVC" "$ENGINE_SVC"; do
    if svc_exists "$s" && systemctl is-active --quiet "$s"; then die "$s is still running - refusing to wipe under a live service. Nothing was changed."; fi
  done
  bash "$DEPLOY/orwell-game-reset.sh" --yes --no-restart 2>&1 | sed 's/^/  /' || die "engine game reset failed - the services are stopped; run rollback or restart them."
  # run AS the database's owner so SQLite never leaves a root-owned -wal/-shm next to the service's database
  local owner; owner="$(stat -c %U "$FE_DATA/app.db" 2>/dev/null || echo root)"
  local runas=(); [[ "$(id -u)" -eq 0 && "$owner" != "root" ]] && command -v runuser >/dev/null 2>&1 && runas=(runuser -u "$owner" --)
  "${runas[@]}" python3 "$py" --data-dir "$FE_DATA" | sed 's/^/  /'
  [[ ${PIPESTATUS[0]} -eq 0 ]] || die "front-end wipe failed - the services are stopped; run rollback or restart them."
  for s in "$ENGINE_SVC" "$FRONTEND_SVC"; do svc_exists "$s" && systemctl start "$s"; done
  state_set WIPED_AT "$(date -u +%FT%TZ)"
  phase_end wipe
}

# ── update (pinned) ─────────────────────────────────────────────────────────────────────────────────────────
do_update() {
  need_root; need_app
  phase_start "update to the pinned sha ${REF:-?}"
  [[ -n "$REF" ]] || die "--ref <sha> is required (a pinned, CI-green commit; never the branch tip)."
  valid_ref "$REF" || die "--ref must be a 7-40 hex sha."
  if [[ $DRY -eq 1 ]]; then echo "  would run: REF=${REF} orwell-update.sh --force (previous build ${PREV_SHA:-$(git -C "$APP_DIR" rev-parse --short HEAD)} stays one --rollback away)"; phase_end update; return 0; fi
  state_set UPDATE_AT "$(date -u +%FT%TZ)"
  REF="$REF" bash "$DEPLOY/orwell-update.sh" --force 2>&1 | tail -25 | sed 's/^/  /'
  local rc=${PIPESTATUS[0]}
  [[ $rc -eq 0 ]] || die "update exited ${rc} (1 = failed with the previous build restored, 3 = the revert failed too). Run: $0 rollback"
  local now; now="$(git -C "$APP_DIR" rev-parse HEAD)"
  [[ "$now" == "$REF"* ]] || die "after the update HEAD is ${now:0:10}, not ${REF}. Run: $0 rollback"
  pass "running ${now:0:10}"
  state_set NEW_SHA "$now"
  phase_end update
}

# ── postcheck ───────────────────────────────────────────────────────────────────────────────────────────────
do_postcheck() {
  need_app
  phase_start "post-checks"
  local since; since="$(state_get UPDATE_AT)"; since="${since:-$(date -u -d '-30 minutes' +%FT%TZ)}"
  local verdict; verdict="$(bash "$DEPLOY/orwell-doctor.sh" --status 2>&1 | grep -E '^VERDICT' | tail -1)"
  [[ "$verdict" == *healthy* ]] && pass "doctor: ${verdict}" || fail "doctor: ${verdict:-no verdict line}"
  if bash "$DEPLOY/orwell-ready.sh" >/tmp/orwell-fresh-ready.txt 2>&1; then pass "ready: READY"; else fail "ready: $(grep -E 'NOT READY' /tmp/orwell-fresh-ready.txt | head -2 | tr '\n' ' ')"; fi
  # the one-time migration line appears only on the boot that migrates; otherwise the routing is already direct (host only, never the key)
  if journalctl -u "$FRONTEND_SVC" --since "$since" --no-pager 2>/dev/null | grep -q '\[text-routing\] migrated saved text selections'; then
    pass "text routing: the migration line was logged this boot"
  else
    local host; host="$(python3 - "$FE_DATA/settings.json" "$FE_DATA/app.db" <<'PY' 2>/dev/null
import json, sqlite3, sys, urllib.parse
try: s = json.load(open(sys.argv[1]))
except Exception: s = {}
eid = s.get("default_endpoint_id")
if not eid: print("none"); raise SystemExit
c = sqlite3.connect(f"file:{sys.argv[2]}?mode=ro", uri=True, timeout=10)
r = c.execute("select base_url from model_endpoints where id=?", (eid,)).fetchone()
print(urllib.parse.urlparse(r[0]).hostname if r else "none")
PY
)"
    [[ "$host" == "api.deepseek.com" ]] && pass "text routing: the default endpoint is already ${host} (no migration needed)" || fail "text routing: no migration line and the default endpoint host is '${host:-?}' (want api.deepseek.com)"
  fi
  local keyed; keyed="$(fe_db_count "select count(*) from sessions where lower(cast(headers as text)) like '%authorization%' or lower(cast(headers as text)) like '%x-api-key%'")"
  [[ "$keyed" == "0" ]] && pass "session rows holding an auth header: 0" || fail "session rows holding an auth header: ${keyed} (count only)"
  local deadline=$(( SECONDS + FIRST_TURN_WAIT )) seen=0
  while :; do
    if journalctl -u "$FRONTEND_SVC" --since "$since" --no-pager 2>/dev/null | grep -q 'LLM stream to https://api.deepseek.com'; then seen=1; break; fi
    [[ $SECONDS -ge $deadline ]] && break
    sleep 5
  done
  if [[ $seen -eq 1 ]]; then pass "first narrator turn: streamed to api.deepseek.com"
  elif [[ $FIRST_TURN_WAIT -gt 0 ]]; then fail "first narrator turn: nothing streamed to api.deepseek.com within ${FIRST_TURN_WAIT}s (send one player message and re-run postcheck)"
  else warn "first narrator turn: not seen yet - send one player message, then re-run 'postcheck --first-turn-wait 120' (not counted as a failure without --first-turn-wait)"; fi
  phase_end postcheck
  [[ $FAILS -eq 0 ]]
}

# ── rollback ────────────────────────────────────────────────────────────────────────────────────────────────
do_rollback() {
  need_root; need_app
  phase_start "rollback (previous build + the backup)"
  local tar prev; tar="$(state_get BACKUP)"; prev="$(state_get PREV_SHA)"
  [[ -n "$tar" && -s "$tar" ]] || die "no recorded backup in ${STATE} - restore by hand with orwell-restore.sh <archive>."
  if [[ $DRY -eq 1 ]]; then echo "  would: orwell-update.sh --rollback, then orwell-restore.sh ${tar} (build back to ${prev:0:10})"; phase_end rollback; return 0; fi
  if [[ "$(git -C "$APP_DIR" rev-parse HEAD)" != "$prev" ]]; then
    bash "$DEPLOY/orwell-update.sh" --rollback 2>&1 | tail -12 | sed 's/^/  /' || warn "update --rollback returned non-zero; falling back to a pinned update to ${prev:0:10}"
    if [[ "$(git -C "$APP_DIR" rev-parse HEAD)" != "$prev" ]]; then
      REF="$prev" bash "$DEPLOY/orwell-update.sh" --force 2>&1 | tail -12 | sed 's/^/  /' || die "could not return to ${prev:0:10}; the app may not start."
    fi
  fi
  [[ "$(git -C "$APP_DIR" rev-parse HEAD)" == "$prev" ]] && pass "build is back at ${prev:0:10}" || die "build is not at ${prev:0:10}"
  bash "$DEPLOY/orwell-restore.sh" "$tar" 2>&1 | tail -12 | sed 's/^/  /'
  pass "data restored from ${tar}"
  phase_end rollback
  do_postcheck
}

case "$CMD" in
  preflight) do_preflight ;;
  backup)    do_backup ;;
  wipe)      do_wipe ;;
  update)    do_update ;;
  postcheck) do_postcheck ;;
  rollback)  do_rollback ;;
  all)
    TOTAL0=$SECONDS
    do_preflight || die "preflight failed - nothing was changed."
    do_backup
    do_wipe
    do_update
    if ! do_postcheck; then echo; echo "POST-CHECKS FAILED. To go back: $0 rollback"; exit 2; fi
    echo; msg "fresh start complete in $((SECONDS - TOTAL0))s. Backup: $(state_get BACKUP)"
    ;;
  ""|-h|--help) sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) echo "unknown command '${CMD}' (preflight|backup|wipe|update|postcheck|rollback|all)" >&2; exit 64 ;;
esac
