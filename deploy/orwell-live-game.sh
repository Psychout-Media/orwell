# shellcheck shell=bash
#
# orwell — live-game guard for the updater (sourced, NOT executed). ORW-206.
#
# WHY: orwell-update.sh restarts the front-end. Doing that in the middle of a live game cuts the reply
# stream, forces browser reloads and wipes in-memory narrator bookkeeping. So the updater first asks
# "is someone playing right now?" and, if so, DEFERS until the game has been idle for a while.
#
# SIGNAL: the age of the newest PLAYER chat message (chat_messages.role='user') in the front-end's
# SQLite DB, read as the service user. No new app endpoint, no new state.
#
# NEVER STUCK, by construction (see update_defer_decision): --force / ORWELL_UPDATE_FORCE=1 skip the
# check; an unreadable/absent signal means RUN (fail open); and a hard maximum defer proceeds anyway.
#
# Tunables (env wins, then data/.env, then default):
#   ORWELL_UPDATE_IDLE_MINUTES       idle time that counts as "game over"          (default 15)
#   ORWELL_UPDATE_MAX_DEFER_MINUTES  longest the update may wait, then it proceeds (default 240)
#   ORWELL_UPDATE_DEFER_POLL_SECONDS re-check interval                              (default 60)
#   ORWELL_UPDATE_FORCE=1            skip the check entirely
# Status file (for humans / orwell-doctor.sh --status): data/ops/update-deferred, removed when the
# update proceeds.

ORWELL_UPDATE_IDLE_MINUTES_DEFAULT=15
ORWELL_UPDATE_MAX_DEFER_MINUTES_DEFAULT=240
ORWELL_UPDATE_DEFER_POLL_SECONDS_DEFAULT=60

# A positive integer from env, else data/.env, else the default. Never trusts a malformed value.
# $1 key  $2 default  $3 env file (optional)
update_defer_setting() {
  local key="$1" def="$2" envf="${3:-}" v="${!1:-}"
  if [[ -z "$v" && -n "$envf" && -r "$envf" ]]; then
    v="$(sed -n "s/^${key}=//p" "$envf" 2>/dev/null | tail -1 | tr -d "\"' \r")"
  fi
  if [[ "$v" =~ ^[0-9]+$ && "$v" -gt 0 ]]; then printf '%s' "$v"; else printf '%s' "$def"; fi
}

# THE decision, pure (no I/O) so it is unit-testable.
#   $1 force (1|0)  $2 idle_seconds ("" = unknown)  $3 idle_threshold_minutes
#   $4 deferred_seconds (how long we have already waited)  $5 max_defer_minutes
# Prints one line:  run:force | run:unknown | run:idle | run:max-defer | defer:live
update_defer_decision() {
  local force="$1" idle="$2" thr_min="$3" waited="$4" max_min="$5"
  if [[ "$force" == "1" ]]; then echo "run:force"; return 0; fi
  if [[ ! "$idle" =~ ^[0-9]+$ ]]; then echo "run:unknown"; return 0; fi
  if (( idle >= thr_min * 60 )); then echo "run:idle"; return 0; fi
  if (( waited >= max_min * 60 )); then echo "run:max-defer"; return 0; fi
  echo "defer:live"
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

# Seconds since the newest player message in the FE DB; prints nothing when unknown (no sqlite3, no
# DB, no table, no player message ever, unreadable). Uses _svc_sqlite3 when the updater defined it
# (drops privileges to the service user), else the service-user runuser, else plain sqlite3.
# $1 db path
live_game_idle_seconds() {
  local db="$1" out sql svcu
  svcu="$(_live_game_svc_user)"
  [[ -f "$db" ]] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  sql="SELECT CAST(strftime('%s','now') - strftime('%s', max(timestamp)) AS INTEGER) FROM chat_messages WHERE role='user';"
  if type _svc_sqlite3 >/dev/null 2>&1; then
    out="$(_svc_sqlite3 -readonly -cmd '.timeout 2000' "$db" "$sql" 2>/dev/null)" || return 0
  elif [[ "$(id -u)" -eq 0 ]] && command -v runuser >/dev/null 2>&1 && id "$svcu" >/dev/null 2>&1; then
    out="$(runuser -u "$svcu" -- sqlite3 -readonly -cmd '.timeout 2000' "$db" "$sql" 2>/dev/null)" || return 0
  else
    out="$(sqlite3 -readonly -cmd '.timeout 2000' "$db" "$sql" 2>/dev/null)" || return 0
  fi
  out="${out//[$'\r\n ']/}"
  [[ "$out" =~ ^[0-9]+$ ]] && printf '%s' "$out"
  return 0
}

# Write/refresh the visible status (atomic, never through a symlinked dir, best-effort).
# $1 ops dir  $2 reason  $3 since(iso)  $4 give-up-by(iso)
update_defer_write_status() {
  local dir="$1" reason="$2" since="$3" until_="$4" tmp
  [[ -L "$dir" ]] && return 0
  mkdir -p "$dir" 2>/dev/null || return 0
  tmp="$(mktemp "${dir}/.update-deferred.XXXXXX" 2>/dev/null)" || return 0
  {
    printf 'deferred=true\n'
    printf 'reason=%s\n' "$reason"
    printf 'since=%s\n' "$since"
    printf 'last_check=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'proceeds_by=%s\n' "$until_"
    printf 'override=orwell-update.sh --force  (or ORWELL_UPDATE_FORCE=1)\n'
  } > "$tmp" 2>/dev/null
  chmod 0644 "$tmp" 2>/dev/null
  mv -f "$tmp" "${dir}/update-deferred" 2>/dev/null || rm -f "$tmp"
  return 0
}
update_defer_clear_status() { rm -f "${1}/update-deferred" 2>/dev/null || true; return 0; }

# Block until the update may proceed. Returns 0 always (the update then runs); the outcome label is
# echoed to the log. Overridable seams for tests: _update_defer_sleep, _update_defer_now.
# $1 db  $2 ops dir  $3 force  $4 env file
update_wait_for_idle_game() {
  local db="$1" ops="$2" force="${3:-0}" envf="${4:-}"
  local thr max poll start now waited idle verdict since until_ last_log=-1
  thr="$(update_defer_setting ORWELL_UPDATE_IDLE_MINUTES "$ORWELL_UPDATE_IDLE_MINUTES_DEFAULT" "$envf")"
  max="$(update_defer_setting ORWELL_UPDATE_MAX_DEFER_MINUTES "$ORWELL_UPDATE_MAX_DEFER_MINUTES_DEFAULT" "$envf")"
  poll="$(update_defer_setting ORWELL_UPDATE_DEFER_POLL_SECONDS "$ORWELL_UPDATE_DEFER_POLL_SECONDS_DEFAULT" "$envf")"
  start="$(_update_defer_now)"
  since="$(date -u -d "@${start}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  until_="$(date -u -d "@$((start + max * 60))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  while :; do
    now="$(_update_defer_now)"; waited=$((now - start))
    idle="$(live_game_idle_seconds "$db")"
    verdict="$(update_defer_decision "$force" "$idle" "$thr" "$waited" "$max")"
    case "$verdict" in
      run:*)
        update_defer_clear_status "$ops"
        case "$verdict" in
          run:force)     echo "==> live-game check skipped (--force / ORWELL_UPDATE_FORCE=1)" ;;
          run:max-defer) echo "==> update was deferred ${waited}s for a live game; max defer (${max} min) reached — proceeding anyway" ;;
          run:idle)      [[ $waited -gt 0 ]] && echo "==> game idle for ${idle}s (>= ${thr} min) after deferring ${waited}s — proceeding with the update" ;;
          run:unknown)   echo "==> live-game signal unavailable (no DB / table / player message) — proceeding" ;;
        esac
        return 0 ;;
    esac
    update_defer_write_status "$ops" "live game: last player message ${idle}s ago (< ${thr} min idle needed)" "$since" "$until_"
    if (( waited / 300 != last_log )); then   # first pass, then at most every 5 minutes
      last_log=$((waited / 300))
      echo "==> update DEFERRED: a game is live (last player message ${idle}s ago; waiting for ${thr} min idle). Re-checking every ${poll}s; proceeds by ${until_} at the latest. Skip the wait: orwell-update.sh --force"
    fi
    _update_defer_sleep "$poll"
  done
}
_update_defer_now() { date +%s; }
_update_defer_sleep() { sleep "$1"; }
