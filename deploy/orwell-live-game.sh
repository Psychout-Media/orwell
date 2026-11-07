# shellcheck shell=bash
#
# orwell — live-game guard for the updater (sourced, NOT executed). ORW-206.
#
# WHY: orwell-update.sh restarts the front-end. Doing that in the middle of a live game cuts the reply
# stream, forces browser reloads and wipes in-memory narrator bookkeeping. So the updater first asks
# "is someone playing right now?" and, if so, DEFERS until the game has been idle for a while.
#
# SIGNAL: the age of the newest PLAYER chat message (chat_messages.role='user') in the front-end's
# SQLite DB, read as the service user. No new app endpoint, no new state. It is read with python3's built-in
# sqlite3 module (read-only); the sqlite3 command-line tool is only a fallback, because a production box has
# python3 but not that tool (ORW-233). Nothing is installed for it.
#
# NEVER STUCK, by construction (see update_defer_decision): --force / ORWELL_UPDATE_FORCE=1 skip the
# check; an unreadable/absent signal means RUN (fail open); and a hard maximum defer proceeds anyway.
#
# Tunables (env wins, then the ROOT-OWNED /etc/orwell/update-defer.conf, then data/.env, then default;
# every value is clamped, so even a tampered data/.env cannot make the wait unbounded):
#   ORWELL_UPDATE_IDLE_MINUTES       idle time that counts as "game over"   (default 15, 1..120)
#   ORWELL_UPDATE_MAX_DEFER_MINUTES  longest the update may wait            (default 240, 1..1440; data/.env may raise it only to 240, the root conf/env to 1440)
#   ORWELL_UPDATE_DEFER_POLL_SECONDS re-check interval                      (default 60, 5..300)
#   ORWELL_UPDATE_FORCE=1            skip the check entirely
# Web-side force: the admin tier may drop data/ops/update-force-requested (existence + recent mtime only,
# content never read; a flag whose mtime is older than 60 minutes is ignored as stale); the wait loop consumes it and proceeds.
# Status (for orwell-doctor.sh --status) lives in a ROOT-owned dir, /run/orwell/update-deferred — never in
# the service-user-owned data/ tree, because this code runs as root. The web page gets the same news through
# the ops-progress channel (data/ops/update-status.json) via the update_defer_notify hook.

ORWELL_UPDATE_IDLE_MINUTES_DEFAULT=15
ORWELL_UPDATE_MAX_DEFER_MINUTES_DEFAULT=240
ORWELL_UPDATE_DEFER_POLL_SECONDS_DEFAULT=60
ORWELL_UPDATE_ROOT_CONF="${ORWELL_UPDATE_ROOT_CONF:-/etc/orwell/update-defer.conf}"
ORWELL_RUN_DIR="${ORWELL_RUN_DIR:-/run/orwell}"
ORWELL_DB_ERROR_RETRIES=3

# Value of KEY from a KEY=VALUE file, or nothing. Quotes/space/CR stripped.
_ud_file_value() {
  local key="$1" f="$2"
  # REGULAR file only (a FIFO planted at the path would block sed forever, with the update flock held), and the
  # read is time-boxed anyway in case the path is swapped between this check and the read.
  [[ -f "$f" && ! -L "$f" && -r "$f" ]] || return 0
  { timeout 5 sed -n "s/^${key}=//p" "$f" 2>/dev/null || true; } | tail -1 | tr -d "\"' \r"
}

# A root-owned config file only counts if root owns it and nobody else can write it.
_ud_root_conf_ok() {
  local f="$ORWELL_UPDATE_ROOT_CONF" owner mode
  [[ -f "$f" && ! -L "$f" ]] || return 1
  owner="$(stat -c %u "$f" 2>/dev/null)" && mode="$(stat -c %a "$f" 2>/dev/null)" || return 1
  [[ "$owner" == "0" && "${mode: -2:1}" =~ [0145] && "${mode: -1}" =~ [0145] ]] || return 1
  # ...and its directory must be root-owned and not group/world-writable either (else the file could be swapped).
  local dir; dir="$(dirname "$f")"
  owner="$(stat -c %u "$dir" 2>/dev/null)" && mode="$(stat -c %a "$dir" 2>/dev/null)" || return 1
  [[ "$owner" == "0" && "${mode: -2:1}" =~ [0145] && "${mode: -1}" =~ [0145] ]]
}

# A clamped positive integer: env, else root conf, else data/.env, else default. Never trusts a malformed
# value; leading zeros are decimal (10#), never octal. data/.env is service-user-writable, so a value taken
# from it is held to the tighter $6 (default: $4); only env and the root conf may use the full range.
# $1 key $2 default $3 min $4 max $5 env file $6 max when the value comes from data/.env
update_defer_setting() {
  local key="$1" def="$2" min="$3" max="$4" envf="${5:-}" envmax="${6:-$4}" v="${!1:-}" from=env
  if [[ ! "$v" =~ ^[0-9]+$ ]] && _ud_root_conf_ok; then v="$(_ud_file_value "$key" "$ORWELL_UPDATE_ROOT_CONF")"; from=conf; fi
  if [[ ! "$v" =~ ^[0-9]+$ && -n "$envf" ]]; then v="$(_ud_file_value "$key" "$envf")"; from=dotenv; fi
  if [[ "$v" =~ ^[0-9]{1,6}$ ]] && (( 10#$v > 0 )); then v=$((10#$v)); else v="$def"; fi
  if [[ "$from" == dotenv ]] && (( v > envmax )); then v="$envmax"; fi
  (( v < min )) && v="$min"
  (( v > max )) && v="$max"
  printf '%s' "$v"
}

# THE decision, pure (no I/O) so it is unit-testable.
#   $1 force (1|0)  $2 idle_seconds ("" = unknown; negative = clock skew, treated as LIVE)
#   $3 idle_threshold_minutes  $4 deferred_seconds  $5 max_defer_minutes
# Prints:  run:force | run:unknown | run:idle | run:max-defer | defer:live
update_defer_decision() {
  local force="$1" idle="$2" thr_min="$3" waited="$4" max_min="$5"
  if [[ "$force" == "1" ]]; then echo "run:force"; return 0; fi
  if [[ ! "$idle" =~ ^-?[0-9]+$ ]]; then echo "run:unknown"; return 0; fi
  if (( 10#${idle#-} >= thr_min * 60 )) && [[ "$idle" != -* ]]; then echo "run:idle"; return 0; fi
  if (( waited >= max_min * 60 )); then echo "run:max-defer"; return 0; fi
  echo "defer:live"
}

# The question both readers ask: the age, in seconds, of the newest PLAYER message.
_LG_SQL="SELECT CAST(strftime('%s','now') - strftime('%s', max(timestamp)) AS INTEGER) FROM chat_messages WHERE role='user';"

# ORW-233: the reader is python3's built-in sqlite3 module. The production box has python3 (the front end needs it)
# but NO sqlite3 command-line tool, so the CLI-only reader always answered "none" there and no update ever waited.
# Read-only URI, a 2 s busy timeout, and an isolated interpreter (-I: no PYTHON* env, no user site-packages, no cwd
# on sys.path — a module planted where it runs is never imported). Exit codes: 0 = printed the age (or nothing: no
# player message yet) · 4 = no such table · 5 = no sqlite3 module · anything else = the read failed.
_LG_PY='
import sys
try:
    import sqlite3
    from urllib.parse import quote
except ImportError:
    sys.exit(5)
try:
    con = sqlite3.connect("file:" + quote(sys.argv[1]) + "?mode=ro", uri=True, timeout=2)
    try:
        row = con.execute(sys.argv[2]).fetchone()
    finally:
        con.close()
except sqlite3.Error as e:
    sys.stderr.write("%s\n" % e)
    sys.exit(4 if "no such table" in str(e) else 3)
if row and row[0] is not None:
    print(int(row[0]))
'

# One reader each. $1 db, then the privilege-dropping prefix (empty unless root). Prints <integer> | none | error,
# or "unavailable" when this reader cannot run on this box (the caller then tries the next one).
_live_game_read_python() {
  local db="$1" out rc=0; shift
  command -v python3 >/dev/null 2>&1 || { echo unavailable; return 0; }
  # `|| rc=$?`: a failing read must not trip the caller's `set -e`. `cd /`: the service user may not be able to
  # enter the directory the updater was started in.
  out="$(cd / && timeout 10 "$@" python3 -I -c "$_LG_PY" "$db" "$_LG_SQL" 2>/dev/null)" || rc=$?
  case "$rc" in
    0) out="${out//[$'\r\n ']/}"
       if [[ "$out" =~ ^-?[0-9]+$ ]]; then printf '%s' "$out"; else echo none; fi ;;
    4) echo none ;;
    5) echo unavailable ;;
    *) echo error ;;
  esac
  return 0
}
# The fallback for a box without python3: the sqlite3 command-line tool (the ORW-206 reader).
_live_game_read_cli() {
  local db="$1" out err rc=0; shift
  command -v sqlite3 >/dev/null 2>&1 || { echo unavailable; return 0; }
  err="$(mktemp 2>/dev/null)" || { echo none; return 0; }
  out="$(cd / && timeout 10 "$@" sqlite3 -readonly -cmd '.timeout 2000' "$db" "$_LG_SQL" 2>"$err")" || rc=$?
  if (( rc != 0 )); then
    if grep -qi 'no such table' "$err" 2>/dev/null; then rm -f "$err"; echo none; return 0; fi
    rm -f "$err"; echo error; return 0
  fi
  rm -f "$err"
  out="${out//[$'\r\n ']/}"
  if [[ "$out" =~ ^-?[0-9]+$ ]]; then printf '%s' "$out"; else echo none; fi
  return 0
}

# Seconds since the newest player message in the FE DB. Prints exactly one of:
#   <integer>  the age (may be negative on clock skew)
#   none       nothing to wait on: no DB, no table, no player message, no reader on this box (neither python3 nor
#              the sqlite3 CLI), or we cannot read it safely (as root with no way to drop privileges) -> the update runs
#   error      the read failed in a way that may be transient (locked, timeout) -> caller retries
# The DB is NEVER opened as root (root-owned -wal/-shm sidecars break the FE): as root, the read runs as the service user.
live_game_idle_seconds() {
  local db="$1" svcu got
  [[ -f "$db" ]] || { echo none; return 0; }
  local -a runner=()
  if [[ "$(id -u)" -eq 0 ]]; then
    svcu="$(_live_game_svc_user)"
    if command -v runuser >/dev/null 2>&1 && id "$svcu" >/dev/null 2>&1 && [[ "$svcu" != "root" ]]; then
      runner=(runuser -u "$svcu" --)
    else
      echo none; return 0
    fi
  fi
  got="$(_live_game_read_python "$db" "${runner[@]}")"
  if [[ "$got" == unavailable ]]; then got="$(_live_game_read_cli "$db" "${runner[@]}")"; fi
  if [[ "$got" == unavailable ]]; then got=none; fi
  printf '%s' "$got"
  return 0
}

# The user that owns the DB: explicit override, else the front-end unit's User=, else `orwell`.
_live_game_svc_user() {
  local u="${ORWELL_SERVICE_USER:-}" svc
  if [[ -z "$u" ]] && command -v systemctl >/dev/null 2>&1; then
    for svc in orwell-frontend bbai-frontend; do
      u="$(systemctl show -p User --value "$svc" 2>/dev/null || true)"
      [[ -n "$u" ]] && break
    done
  fi
  printf '%s' "${u:-orwell}"
}

# Web-side force request: a regular, non-symlink file under the ops dir modified within the last hour.
# Consumed (removed) when honoured. Existence only: the content is never read.
update_force_flag_present() {
  local f="${1%/}/update-force-requested"
  [[ -f "$f" && ! -L "$f" ]] || return 1
  [[ -n "$(find "$f" -maxdepth 0 -mmin -60 2>/dev/null)" ]]
}

# Write/refresh the visible status in the ROOT-owned run dir (atomic; temp file beside the target in that
# same root-owned dir, O_EXCL via mktemp, then mv -fT; no chmod after creation).
# $1 reason  $2 since(iso)  $3 give-up-by(iso)  $4 give-up-by(epoch)
update_defer_write_status() {
  local dir="$ORWELL_RUN_DIR" reason="$1" since="$2" until_="$3" until_epoch="$4" tmp
  [[ -L "$dir" ]] && return 0
  mkdir -p "$dir" 2>/dev/null || return 0
  if [[ "$(id -u)" -eq 0 && ! -O "$dir" ]]; then return 0; fi   # only ever write inside a dir WE own
  tmp="$(umask 022; mktemp "${dir}/.update-deferred.XXXXXX" 2>/dev/null)" || return 0
  {
    printf 'deferred=true\n'
    printf 'reason=%s\n' "$reason"
    printf 'since=%s\n' "$since"
    printf 'last_check=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'proceeds_by=%s\n' "$until_"
    printf 'proceeds_by_epoch=%s\n' "$until_epoch"
    printf 'override=orwell-update.sh --force  (or ORWELL_UPDATE_FORCE=1)\n'
  } > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  mv -fT "$tmp" "${dir}/update-deferred" 2>/dev/null || rm -f "$tmp"
  return 0
}
update_defer_clear_status() { rm -f "${ORWELL_RUN_DIR}/update-deferred" 2>/dev/null || true; return 0; }

# Block until the update may proceed; always returns 0 (the update then runs). Seams for tests:
# _update_defer_sleep, _update_defer_now. Optional hook from the updater: update_defer_notify <msg>
# (publishes to the web status page), update_defer_cancelled (cleanup if the wait is interrupted).
# $1 db  $2 ops dir  $3 force  $4 env file
update_wait_for_idle_game() {
  local db="$1" ops="$2" force="${3:-0}" envf="${4:-}"
  local thr max poll start now waited idle verdict since until_ errs=0 last_log=-1 msg
  thr="$(update_defer_setting ORWELL_UPDATE_IDLE_MINUTES "$ORWELL_UPDATE_IDLE_MINUTES_DEFAULT" 1 120 "$envf")"
  max="$(update_defer_setting ORWELL_UPDATE_MAX_DEFER_MINUTES "$ORWELL_UPDATE_MAX_DEFER_MINUTES_DEFAULT" 1 1440 "$envf" 240)"
  poll="$(update_defer_setting ORWELL_UPDATE_DEFER_POLL_SECONDS "$ORWELL_UPDATE_DEFER_POLL_SECONDS_DEFAULT" 5 300 "$envf")"
  start="$(_update_defer_now)"
  since="$(date -u -d "@${start}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  until_="$(date -u -d "@$((start + max * 60))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  # Never leave a stale "deferred" status behind if the wait is interrupted.
  trap '_update_defer_abort 130' INT
  trap '_update_defer_abort 143' TERM
  trap '_update_defer_abort 129' HUP
  trap 'update_defer_clear_status' EXIT
  while :; do
    now="$(_update_defer_now)"; waited=$((now - start))
    if [[ "$force" != "1" ]] && update_force_flag_present "$ops"; then
      rm -rf --one-file-system -- "${ops%/}/update-force-requested" 2>/dev/null || true
      force=1; echo "==> web force request received"
    fi
    idle="$(live_game_idle_seconds "$db")"
    case "$idle" in
      none) idle="" ; errs=0 ;;
      error)
        errs=$((errs + 1))
        if (( errs <= ORWELL_DB_ERROR_RETRIES )); then
          echo "==> live-game read failed (attempt ${errs}/${ORWELL_DB_ERROR_RETRIES}); retrying before running"
          [[ "$force" == "1" ]] || { _update_defer_sleep 5; continue; }
        fi
        idle="" ;;
      *) errs=0 ;;
    esac
    verdict="$(update_defer_decision "$force" "$idle" "$thr" "$waited" "$max")"
    case "$verdict" in
      run:*)
        update_defer_clear_status
        trap - INT TERM HUP EXIT
        case "$verdict" in
          run:force)     echo "==> live-game check skipped (--force / web force / ORWELL_UPDATE_FORCE=1)" ;;
          run:max-defer) echo "==> update was deferred ${waited}s for a live game; max defer (${max} min) reached — proceeding anyway" ;;
          run:idle)      [[ $waited -gt 0 ]] && echo "==> game idle for ${idle}s (>= ${thr} min) after deferring ${waited}s — proceeding with the update" ;;
          run:unknown)   echo "==> live-game signal unavailable (no DB / table / player message, or unreadable) — proceeding" ;;
        esac
        return 0 ;;
    esac
    msg="Update deferred: a game is live (last player message ${idle}s ago; waiting for ${thr} min idle). Runs by ${until_} at the latest, or force it from the admin page."
    update_defer_write_status "live game: last player message ${idle}s ago (< ${thr} min idle needed)" "$since" "$until_" "$((start + max * 60))"
    type update_defer_notify >/dev/null 2>&1 && update_defer_notify "$msg"
    if (( waited / 300 != last_log )); then   # first pass, then at most every 5 minutes
      last_log=$((waited / 300))
      echo "==> ${msg} Re-checking every ${poll}s. Skip the wait: orwell-update.sh --force"
    fi
    _update_defer_sleep "$poll"
  done
}
_update_defer_abort() {
  update_defer_clear_status
  type update_defer_cancelled >/dev/null 2>&1 && update_defer_cancelled
  trap - INT TERM HUP EXIT
  exit "$1"
}
_update_defer_now() { date +%s; }
_update_defer_sleep() { sleep "$1" & wait $!; }   # `wait` so a trapped INT/TERM/HUP fires at once, not after the sleep
