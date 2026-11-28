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
# check; an unreadable/absent signal means RUN (fail open); and a hard maximum defer proceeds anyway UNLESS a player message is still under the idle threshold old (ORW-1074: a live game is never restarted; the admin is alerted).
#
# Tunables (env wins, then the ROOT-OWNED /etc/orwell/update-defer.conf, then data/.env, then default;
# every value is clamped, so even a tampered data/.env cannot make the wait unbounded):
#   ORWELL_UPDATE_IDLE_MINUTES       idle time that counts as "game over"   (default 15, 1..120)
#   ORWELL_UPDATE_MAX_DEFER_MINUTES  longest the update may wait            (default 240, 1..1440; data/.env may raise it only to 240, the root conf/env to 1440)
#   ORWELL_UPDATE_DEFER_POLL_SECONDS re-check interval                      (default 60, 5..300)
#   ORWELL_UPDATE_FORCE=1            skip the idle check (still waits, bounded, for an in-flight turn: ORW-406)
#   ORWELL_UPDATE_FORCE_NOW=1        emergency only: also skip the in-flight-turn wait (--force-now)
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
# Prints:  run:force | run:unknown | run:idle | run:max-defer | defer:live | defer:max-live
# ORW-1074: the maximum defer never restarts a LIVE game. Past the maximum, a player message younger than the idle
# threshold (idle >= 0) keeps deferring (defer:max-live, and the loop alerts the admin); only a game that is not live
# (a skewed clock, negative idle) is bounded by the maximum. --force and the web force flag still override.
update_defer_decision() {
  local force="$1" idle="$2" thr_min="$3" waited="$4" max_min="$5"
  if [[ "$force" == "1" ]]; then echo "run:force"; return 0; fi
  if [[ ! "$idle" =~ ^-?[0-9]+$ ]]; then echo "run:unknown"; return 0; fi
  if (( 10#${idle#-} >= thr_min * 60 )) && [[ "$idle" != -* ]]; then echo "run:idle"; return 0; fi
  if (( waited >= max_min * 60 )); then
    if [[ "$idle" != -* ]]; then echo "defer:max-live"; else echo "run:max-defer"; fi
    return 0
  fi
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

# ORW-496: an absolute form of a path, resolved against the CURRENT directory (the readers below `cd /` before they open it).
_update_abs_path() {
  local p="$1"
  [[ -n "$p" && "$p" != /* ]] && p="$(pwd)/${p#./}"
  printf '%s' "$p"
}
# ORW-487: the SQLite file the front end really uses. $1 app dir, $2 data/.env, $3 the default file. A DATABASE_URL in the
# environment, else in data/.env, of the form sqlite:///<path> names it (sqlite:////abs = absolute; a relative path is relative to the
# front end's working directory, <app>/frontend, as the systemd unit runs it). Anything else (unset, another database) = the default.
update_fe_db_path() {
  local app="${1%/}" envf="${2:-}" def="$3" url="${DATABASE_URL:-}" p
  if [[ -z "$url" && -n "$envf" && -r "$envf" ]]; then
    url="$(sed -n 's/^DATABASE_URL=[[:space:]]*//p' "$envf" 2>/dev/null | tail -n1 || true)"
    url="${url%"${url##*[![:space:]]}"}"; url="${url#[\"\']}"; url="${url%[\"\']}"
  fi
  if [[ "$url" == sqlite:///* ]]; then
    p="${url#sqlite:///}"; p="${p%%\?*}"
    if [[ -n "$p" && "$p" != :memory:* ]]; then
      [[ "$p" == /* ]] || p="${app}/frontend/${p#./}"
      printf '%s' "$p"; return 0
    fi
  fi
  printf '%s' "$def"
}
# ORW-490: ONE bound helper for every wait: $1 value, $2 default, $3 max (min 1). Non-numeric -> default; leading zeros and
# long digit strings never reach the arithmetic as written.
update_bound() {
  local v="$1" d="$2" mx="$3"
  [[ "$v" =~ ^[0-9]+$ ]] && { v="${v#"${v%%[!0]*}"}"; v="${v:-0}"; }
  [[ "$v" =~ ^[0-9]{1,6}$ ]] || v="$d"
  (( v = 10#$v, v < 1 )) && v=1
  (( v > mx )) && v=$mx
  printf '%s' "$v"
}
# The most seconds the new-turn hold must last: the turn wait + the warm-up wait + a restart allowance (ORW-490).
update_hold_seconds() {
  echo $(( $(update_bound "${ORWELL_UPDATE_TURN_WAIT_SECONDS:-120}" 120 300) + $(update_bound "${ORWELL_UPDATE_WARM_WAIT_SECONDS:-60}" 60 300) + 150 ))
}

# One reader each. $1 db, then the privilege-dropping prefix (empty unless root). Prints <integer> | none | error,
# or "unavailable" when this reader cannot run on this box (the caller then tries the next one).
_live_game_read_python() {
  local db="$1" out rc=0; shift
  command -v python3 >/dev/null 2>&1 || { echo unavailable; return 0; }
  db="$(_update_abs_path "$db")"   # ORW-496: a relative path would be read from / after the cd below
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
  db="$(_update_abs_path "$db")"   # ORW-496
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

# ORW-489: ONE way to get the root-owned run dir ready, used by every writer below. `mkdir -p -m` only applies the mode
# when mkdir CREATES the dir, so a dir another writer already made under a restrictive root umask (077 -> 0700) stayed
# unreadable to the front end (another user), which then read "no hold". Returns 1 for a symlink, a dir root does not own,
# or one that cannot be made; otherwise the dir exists and is 755.
_update_run_dir_ready() {
  local dir="$ORWELL_RUN_DIR"
  [[ -L "$dir" ]] && return 1
  mkdir -p "$dir" 2>/dev/null || return 1
  if [[ "$(id -u)" -eq 0 && ! -O "$dir" ]]; then return 1; fi   # only ever write inside a dir WE own
  [[ -O "$dir" ]] && { chmod 755 "$dir" 2>/dev/null || true; }
  return 0
}

# ORW-485: a web force request is meant for a DEFERRED waiter. A run that is already past the wait never reads it, so it must not
# outlive that run (the next ordinary update inside the hour would honour it and restart a live game without waiting). Called when
# an update run ends. A waiter that is still deferred (its status file exists) keeps the flag: the request may be for it.
# $1 ops dir
update_force_flag_clear() {
  local f="${1%/}/update-force-requested" st="${ORWELL_RUN_DIR}/update-deferred"
  [[ -f "$st" && ! -L "$st" ]] && return 0
  [[ -e "$f" || -L "$f" ]] || return 0
  rm -rf --one-file-system -- "$f" 2>/dev/null || true
  return 0
}

# Write/refresh the visible status in the ROOT-owned run dir (atomic; temp file beside the target in that
# same root-owned dir, O_EXCL via mktemp, chmod 644 so a non-root doctor --status can read it, then mv -fT).
# $1 reason  $2 since(iso)  $3 give-up-by(iso)  $4 give-up-by(epoch)  $5 run token the waiter started under (ownership: only that waiter clears it)
update_defer_write_status() {
  local dir="$ORWELL_RUN_DIR" reason="$1" since="$2" until_="$3" until_epoch="$4" seq="${5:-}" tmp
  _update_run_dir_ready || return 0
  tmp="$(umask 022; mktemp "${dir}/.update-deferred.XXXXXX" 2>/dev/null)" || return 0
  {
    printf 'deferred=true\n'
    printf 'reason=%s\n' "$reason"
    printf 'since=%s\n' "$since"
    printf 'last_check=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'proceeds_by=%s\n' "$until_"
    printf 'proceeds_by_epoch=%s\n' "$until_epoch"
    printf 'run_seq=%s\n' "$seq"
    printf 'override=orwell-update.sh --force  (or ORWELL_UPDATE_FORCE=1)\n'
  } > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  # ORW-486: mktemp makes it 0600; the doctor (--status) is run by non-root operators too and must read the
  # reason and proceeds-by time. The content is Vault-free status text and the dir is root-owned (only root can replace it).
  chmod 644 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  mv -fT "$tmp" "${dir}/update-deferred" 2>/dev/null || rm -f "$tmp"
  return 0
}
update_defer_clear_status() { rm -f "${ORWELL_RUN_DIR}/update-deferred" 2>/dev/null || true; return 0; }
# A superseded waiter removes the status only if it wrote it (its run token is in the file): a waiter that started after the
# run went ahead has a different token and keeps its own status.
update_defer_clear_status_if_mine() {
  local f="${ORWELL_RUN_DIR}/update-deferred"
  [[ -f "$f" && ! -L "$f" ]] || return 0
  grep -qxF "run_seq=$1" "$f" 2>/dev/null && rm -f "$f" 2>/dev/null
  return 0
}

# ORW-398: one token in the ROOT-owned run dir says "the newest update run that went ahead". A deferred run records
# the token when it starts waiting; a run that proceeds (forced, manual, idle) writes a fresh one. A deferred run
# that sees the token change was superseded by a run that already did the work, and exits without restarting.
update_run_seq_read() {
  local f="${ORWELL_RUN_DIR}/update-run-seq"
  [[ -f "$f" && ! -L "$f" ]] || { printf 0; return 0; }
  head -c 80 "$f" 2>/dev/null | tr -d '\r\n' || true
}
# $1 (optional) kind: "rollback" marks the token so a deferred plain update that wakes later knows a rollback ran after it was
# deferred and must not redeploy the tip the rollback rejected (ORW-488). Every run that takes the update lock writes one.
update_run_supersede() {
  local dir="$ORWELL_RUN_DIR" tmp kind="${1:-}"
  [[ "$kind" =~ ^[a-z-]{1,20}$ ]] || kind=''
  [[ -z "$kind" ]] || kind="-${kind}"
  _update_run_dir_ready || return 0
  tmp="$(umask 022; mktemp "${dir}/.update-run-seq.XXXXXX" 2>/dev/null)" || return 0
  printf '%s-%s-%s%s\n' "$$" "$(date +%s%N 2>/dev/null || date +%s)" "$RANDOM" "$kind" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  mv -fT "$tmp" "${dir}/update-run-seq" 2>/dev/null || rm -f "$tmp"
  return 0
}

update_superseded_by_rollback() { [[ "$(update_run_seq_read)" == *-rollback ]]; }

# ORW-1145: the DEPLOY HOLD. A dev live check needs the box to stand still: an auto-deploy that restarts both services mid-run ends the check
# (11-26: two restarts in 90 minutes). The live-check script writes ${APP_DIR}/data/.deploy-hold holding `until=<epoch>` (and `reason=<text>`);
# while that time is in the future an ordinary update run exits 0 without touching anything, and the next deploy after the hold ends picks up
# the tip as usual. NEVER STUCK, by construction: a hold is honoured for at most ORWELL_DEPLOY_HOLD_MAX_MINUTES (default 240, clamped 1..1440)
# counted from the file's own mtime, whatever `until` says, and only a regular, non-symlink file is read. --ignore-hold (or
# ORWELL_UPDATE_IGNORE_HOLD=1), --rollback and --set-token skip it.
# $1 hold file. Prints the effective end of the hold (UTC ISO time) and returns 0 while the hold is active; returns 1 otherwise.
update_deploy_hold_active() {
  local f="$1" until_ mtime max now cap
  [[ -f "$f" && ! -L "$f" && -r "$f" ]] || return 1
  until_="$(_ud_file_value until "$f")"
  [[ "$until_" =~ ^[0-9]{1,12}$ ]] || return 1
  until_=$((10#$until_))
  mtime="$(stat -c %Y "$f" 2>/dev/null)" || return 1
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  max="${ORWELL_DEPLOY_HOLD_MAX_MINUTES:-240}"
  [[ "$max" =~ ^[0-9]{1,4}$ ]] || max=240
  max=$((10#$max)); (( max >= 1 && max <= 1440 )) || max=240
  cap=$((mtime + max * 60))
  (( until_ > cap )) && until_=$cap
  now="$(_update_defer_now)"
  (( now < until_ )) || return 1
  date -u -d "@${until_}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '%s' "$until_"
  return 0
}

# Block until the update may proceed; returns 0 (the update then runs), or 10 when a later run that proceeded
# superseded this deferred one (the caller exits without restarting). A run that proceeds supersedes any deferred run. Seams for tests:
# _update_defer_sleep, _update_defer_now. Optional hook from the updater: update_defer_notify <msg>
# (publishes to the web status page), update_defer_cancelled (cleanup if the wait is interrupted).
# $1 db  $2 ops dir  $3 force  $4 env file
update_wait_for_idle_game() {
  local db="$1" ops="$2" force="${3:-0}" envf="${4:-}"
  local my_seq thr max poll start now waited idle verdict since until_ errs=0 last_log=-1 last_alert=-1 msg
  UPDATE_WAIT_DEFERRED=0; UPDATE_WAIT_OVERDUE=0
  thr="$(update_defer_setting ORWELL_UPDATE_IDLE_MINUTES "$ORWELL_UPDATE_IDLE_MINUTES_DEFAULT" 1 120 "$envf")"
  max="$(update_defer_setting ORWELL_UPDATE_MAX_DEFER_MINUTES "$ORWELL_UPDATE_MAX_DEFER_MINUTES_DEFAULT" 1 1440 "$envf" 240)"
  poll="$(update_defer_setting ORWELL_UPDATE_DEFER_POLL_SECONDS "$ORWELL_UPDATE_DEFER_POLL_SECONDS_DEFAULT" 5 300 "$envf")"
  start="$(_update_defer_now)"
  my_seq="$(update_run_seq_read)"
  since="$(date -u -d "@${start}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  until_="$(date -u -d "@$((start + max * 60))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  # Never leave a stale "deferred" status behind if the wait is interrupted.
  trap '_update_defer_abort 130' INT
  trap '_update_defer_abort 143' TERM
  trap '_update_defer_abort 129' HUP
  trap 'update_defer_clear_status' EXIT
  while :; do
    now="$(_update_defer_now)"; waited=$((now - start))
    if [[ "$(update_run_seq_read)" != "$my_seq" ]]; then
      # The run that went ahead cleared the shared status before publishing its token, but this waiter may have written its status after that clear: remove it if it is ours (a newer waiter's carries another token).
      update_defer_clear_status_if_mine "$my_seq"
      trap - INT TERM HUP EXIT
      echo "==> a later update run already went ahead (forced, manual or idle) — this deferred run is superseded; exiting without restarting"
      return 10
    fi
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
        update_run_supersede
        case "$verdict" in
          run:force)     echo "==> live-game check skipped (--force / web force / ORWELL_UPDATE_FORCE=1)" ;;
          run:max-defer) echo "==> update was deferred ${waited}s for a live game; max defer (${max} min) reached — proceeding anyway" ;;
          run:idle)      [[ $waited -gt 0 ]] && echo "==> game idle for ${idle}s (>= ${thr} min) after deferring ${waited}s — proceeding with the update" ;;
          run:unknown)   echo "==> live-game signal unavailable (no DB / table / player message, or unreadable) — proceeding" ;;
        esac
        return 0 ;;
    esac
    if [[ "$verdict" == defer:max-live ]]; then
      # ORW-1074: past the maximum and a player is still active: keep waiting, never restart a live game, alert the admin.
      msg="ALERT: update OVERDUE: the maximum deferral (${max} min) passed but a game is still live (last player message ${idle}s ago; ${thr} min idle needed). NOT restarting a live game: it runs when the game goes idle, or force it now: bash orwell-update.sh --force."
      UPDATE_WAIT_DEFERRED=1; UPDATE_WAIT_OVERDUE=1
      update_defer_write_status "OVERDUE, live game: last player message ${idle}s ago (< ${thr} min idle needed); the update runs when the game is idle" "$since" "overdue-until-idle" "$((now + 600))" "$my_seq"   # epoch refreshed each poll: the doctor ignores a status whose waiter died
      type update_defer_notify >/dev/null 2>&1 && update_defer_notify "$msg"
      if (( waited / 1800 != last_alert )); then   # the alert goes out at the crossing, then at most every 30 minutes
        last_alert=$((waited / 1800))
        echo "==> ${msg}"
        type update_defer_alert >/dev/null 2>&1 && update_defer_alert "$msg"
      fi
      _update_defer_sleep "$poll"
      continue
    fi
    msg="Update deferred: a game is live (last player message ${idle}s ago; waiting for ${thr} min idle). Runs by ${until_} at the latest, or force it now: bash orwell-update.sh --force."
    UPDATE_WAIT_DEFERRED=1   # this run really waited (the updater re-checks under the lock only for a run that did)
    update_defer_write_status "live game: last player message ${idle}s ago (< ${thr} min idle needed)" "$since" "$until_" "$((start + max * 60))" "$my_seq"
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
  # ORW-1074: a cancelled deferral (stopped before it started) is a clean end, not a failure: exit 0 so orwell-ops-update.service
  # does not stay "failed" and the status says cancelled. The signal that ended it is named in the log.
  echo "==> update deferral cancelled (signal exit ${1}) before it started; nothing was changed"
  exit 0
}
_update_defer_now() { date +%s; }
_update_defer_sleep() { sleep "$1" & wait $!; }   # `wait` so a trapped INT/TERM/HUP fires at once, not after the sleep

# ── ORW-406: restart only what changed, and swap between turns ───────────────────────────────────────────
# update_restart_scope <newline-separated changed paths> -> frontend | both
#   frontend  every changed path is under frontend/ (the engine bundle and its deps are untouched). This includes
#             frontend/static/: constants.py parses static/js/theme.js once per process and the build id is cached,
#             so a static-only change still needs the front end restarted (cheap; the engine is left alone).
#   both      anything else (src/, package*.json, deploy/, units, ...) or an empty/unknown list: the old behaviour
update_restart_scope() {
  local paths="$1" p n=0
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    n=$((n + 1))
    case "$p" in
      frontend/*) ;;
      *) echo both; return 0 ;;
    esac
  done <<<"$paths"
  (( n > 0 )) || { echo both; return 0; }
  echo frontend
}

# The SHA the services were last (re)started on, in the ROOT-owned run dir (the same place as the supersede token;
# data/ belongs to the service user). The restart scope is computed from THIS, not from the previous checkout:
# a run that committed new code and died before the restart must not hide that code from the next run.
update_restarted_sha_read() {
  local f="${ORWELL_RUN_DIR}/restarted-sha" v
  [[ -f "$f" && ! -L "$f" && -r "$f" ]] || return 0
  v="$(head -c 80 "$f" 2>/dev/null | tr -d '\r\n' || true)"
  [[ "$v" =~ ^[0-9a-f]{40}$ ]] && printf '%s' "$v"
  return 0
}
update_restarted_sha_write() {
  local dir="$ORWELL_RUN_DIR" tmp
  _update_run_dir_ready || return 0
  tmp="$(umask 022; mktemp "${dir}/.restarted-sha.XXXXXX" 2>/dev/null)" || return 0
  printf '%s\n' "$1" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  mv -fT "$tmp" "${dir}/restarted-sha" 2>/dev/null || rm -f "$tmp"
  return 0
}
update_restarted_sha_clear() { rm -f "${ORWELL_RUN_DIR}/restarted-sha" 2>/dev/null || true; return 0; }

# update_scope_since_restart <git dir> -> frontend | both: what changed between what the services are running
# (the marker) and HEAD. A missing/unreadable marker, a commit that is not in the checkout, or one that is not an
# ancestor of HEAD (a shallow checkout cannot tell, so there an existing commit is accepted: the tree diff below
# is correct for any two commits) means both.
update_scope_since_restart() {
  local g="$1" m
  m="$(update_restarted_sha_read)"
  [[ -n "$m" ]] || { echo both; return 0; }
  git -C "$g" cat-file -e "${m}^{commit}" 2>/dev/null || { echo both; return 0; }
  if ! git -C "$g" merge-base --is-ancestor "$m" HEAD 2>/dev/null; then
    [[ "$(git -C "$g" rev-parse --is-shallow-repository 2>/dev/null)" == true ]] || { echo both; return 0; }
  fi
  update_restart_scope "$(git -C "$g" diff --name-only --no-renames "$m" HEAD 2>/dev/null || true)"
}

# 0 when the front end's turns-in-flight file says one or more turns are running, else 1. A missing, unreadable,
# symlinked or malformed file means "no turn" (fail open): the wait below is bounded anyway.
update_turn_in_flight() {
  local f="$1" v
  [[ -f "$f" && ! -L "$f" && -r "$f" ]] || return 1
  v="$(timeout 5 head -c 16 "$f" 2>/dev/null | tr -d ' \r\n' || true)"
  [[ "$v" =~ ^[0-9]+$ ]] && (( 10#$v > 0 ))
}

# ORW-461: hold NEW turns while the update waits for the in-flight ones and restarts. The front end (frontend/src/turn_inflight.py) refuses a new turn at admission, with a retryable
# `update-holding`, while ${ORWELL_RUN_DIR}/turns-hold says `until=<epoch>` in the future; the player's page waits ("one moment...") and re-sends the same turn after the restart.
# The file lives in the ROOT-owned run dir, like every other file this updater writes as root: the service user can read it (the front end does) but can never write, swap or
# symlink it, so root never follows a path the service user controls. The hold is bounded by its own `until`, so an updater that dies never leaves the game held for more than that.
# $1 seconds the hold may last (default 240)
update_turn_hold_begin() {
  local secs="${1:-240}" dir="$ORWELL_RUN_DIR" tmp
  [[ "$secs" =~ ^[0-9]{1,5}$ ]] || secs=240
  _update_run_dir_ready || return 0   # 755 whatever the umask or who made the dir first: the front end (another user) must be able to traverse it
  tmp="$(umask 022; mktemp "${dir}/.turns-hold.XXXXXX" 2>/dev/null)" || return 0
  printf 'until=%s\n' "$(( $(_update_defer_now) + 10#$secs ))" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  # mktemp creates 0600 whatever the umask, and the front end reads this as another user: make it world-readable. Safe: the temp file sits in a root-owned dir nobody else can write.
  chmod 644 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  mv -fT "$tmp" "${dir}/turns-hold" 2>/dev/null || { rm -f "$tmp"; return 0; }
  echo "==> holding new turns (the game restarts in a moment; players see 'one moment')"
  # A turn admitted in the same instant as the hold may not be in the in-flight count yet: give it a moment to register before the first count is read.
  local settle="${ORWELL_UPDATE_HOLD_SETTLE_SECONDS:-2}"
  [[ "$settle" =~ ^[0-9]{1,2}$ ]] || settle=2   # ORW-490: validated like the other bounds
  _update_defer_sleep "$settle"
  return 0
}
update_turn_hold_end() {
  rm -f "${ORWELL_RUN_DIR}/turns-hold" 2>/dev/null || true
  return 0
}

# Wait (bounded) until no turn is in flight. $1 = signal file. Bound: ORWELL_UPDATE_TURN_WAIT_SECONDS
# (default 120, clamped 1..300). Always returns 0: after the bound the update proceeds.
# $2 (optional) force_now: "1" skips the wait (emergency --force-now / ORWELL_UPDATE_FORCE_NOW=1 only; may cut a turn).
update_wait_for_no_turn() {
  local f="$1" force_now="${2:-0}" max="${ORWELL_UPDATE_TURN_WAIT_SECONDS:-120}" start now left nap last_say=-1
  max="$(update_bound "$max" 120 300)"   # ORW-490: the one shared clamp (also sizes the hold)
  if [[ "$force_now" == "1" ]]; then
    echo "==> --force-now: not waiting for an in-flight turn (a turn may be cut)."
    return 0
  fi
  start="$(_update_defer_now)"
  while update_turn_in_flight "$f"; do
    now="$(_update_defer_now)"
    if (( now - start >= max )); then
      echo "==> a turn is still in flight after ${max}s — restarting anyway."
      return 0
    fi
    if (( (now - start) / 30 != last_say )); then   # the first pass, then at most every 30 s (not a line per 2 s)
      last_say=$(( (now - start) / 30 ))
      echo "==> a turn is in flight — waiting for it to finish before restarting (up to ${max}s)."
    fi
    left=$(( max - (now - start) )); nap=2; (( left < nap )) && nap=$left; (( nap < 1 )) && nap=1   # never sleep past the bound
    _update_defer_sleep "$nap"
  done
  return 0
}

# ── ORW-406 slice 3: warm before reporting the update complete ───────────────────────────────────────────
# _update_probe <url>: print the body of a loopback GET, or nothing (seam for tests).
# $2 = the most seconds this probe may take (default 3): the warm wait passes what is left of its own bound.
# $3 (optional) is sent as the Host header: a front end with ALLOWED_HOSTS pinned to its public domain rejects Host: 127.0.0.1 (TrustedHostMiddleware).
_update_probe() { local -a h=(); [[ -z "${3:-}" ]] || h=(-H "Host: $3"); curl -fsS --noproxy '*' --max-time "${2:-3}" "${h[@]}" "$1" 2>/dev/null || true; }
# The Host header the front end accepts, from an ALLOWED_HOSTS value (comma list): the first non-wildcard entry; else probe.<domain> for the first "*.<domain>" entry; empty for unset or "*" (any Host is accepted).
update_probe_host() {
  local raw="${1:-}" h wild=""
  raw="$(printf '%s' "$raw" | tr -d '\r"'"'"' ')"
  local -a hs=()
  IFS=, read -ra hs <<<"$raw"   # read, not word splitting: an unquoted "*" would glob
  for h in ${hs[@]+"${hs[@]}"}; do
    [[ "$h" == \[* ]] || h="${h%%:*}"   # ORW-465: a port is not part of the host name (the front end drops it from the allow-list entry too)
    [[ -n "$h" && "$h" != "*" ]] || continue
    # Starlette's "*.example.com" matches only a subdomain (host ends with ".example.com"), never the bare domain.
    if [[ "$h" == \*.* ]]; then [[ -n "$wild" ]] || wild="${h#\*.}"; continue; fi
    printf '%s' "$h"; return 0
  done
  [[ -z "$wild" ]] || printf 'probe.%s' "$wild"
  return 0
}

# update_wait_for_warm <engine /health url or ""> <front-end health url or ""> [<ops log>] [<Host header for the front-end probe>]
# After the restart, poll (bounded by ORWELL_UPDATE_WARM_WAIT_SECONDS, default 60, clamped 1..300) until the
# engine reports `"warmed":true` (an engine predating the field, answering ok, counts as warm) and the front
# end reports `"engine":true`. Logs how long the engine took to warm. ALWAYS returns 0: a timeout is logged
# and the update carries on (the first request just pays the old lazy cost).
# Append to the ops log unless stdout already IS that file (the ops unit redirects stdout there; a second append duplicated every line, review of #2720). `-ef` compares the inode in this shell: a readlink inside $(...) saw the capture pipe and never matched.
_warm_log() { [[ -n "$1" ]] || return 0; [[ /proc/self/fd/1 -ef "$1" ]] && return 0; echo "$2" >>"$1" 2>/dev/null || true; }
update_wait_for_warm() {
  local eng="${1:-}" fe="${2:-}" log="${3:-}" fehost="${4:-}" max="${ORWELL_UPDATE_WARM_WAIT_SECONDS:-60}" start now body msg warm_ms=""
  max="$(update_bound "$max" 60 300)"   # ORW-490: the one shared clamp
  start="$(_update_defer_now)"
  _warm_left() { local l=$(( max - ($(_update_defer_now) - start) )); (( l < 1 )) && l=1; (( l > 3 )) && l=3; echo "$l"; }
  local eng_done=0 fe_done=0
  [[ -z "$eng" ]] && eng_done=1
  [[ -z "$fe" ]] && fe_done=1
  while :; do
    if (( ! eng_done )); then
      body="$(_update_probe "$eng" "$(_warm_left)")"
      if [[ "$body" == *'"ok":true'* ]] && { [[ "$body" == *'"warmed":true'* ]] || [[ "$body" != *'"warmed"'* ]]; }; then
        eng_done=1
        warm_ms="$(sed -n 's/.*"warmMs":\([0-9]*\).*/\1/p' <<<"$body")"
      fi
    fi
    if (( eng_done && ! fe_done )); then
      body="$(_update_probe "$fe" "$(_warm_left)" "$fehost")"
      [[ "$body" == *'"engine":true'* || "$body" == *'"engine": true'* ]] && fe_done=1
    fi
    now="$(_update_defer_now)"
    if (( eng_done && fe_done )); then
      msg="==> warm-up complete after $((now - start))s${warm_ms:+ (engine reported ${warm_ms}ms)}; the new build is ready for traffic."
      echo "$msg"; _warm_log "$log" "$msg"
      return 0
    fi
    if (( now - start >= max )); then
      msg="==> warm-up not confirmed after ${max}s (engine_ready=${eng_done} frontend_ready=${fe_done}) - continuing; the first turn may be slow."
      echo "$msg"; _warm_log "$log" "$msg"
      return 0
    fi
    _update_defer_sleep 2
  done
}
