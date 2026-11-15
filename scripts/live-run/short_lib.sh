# ORW-109: the small pure helpers of run_short.sh (sourced by it; unit-tested in frontend/tests/test_live_run_tooling.py).

# A spend cap must be a finite positive decimal ("0.5", "3"): anything else makes the guard exit or never trip while the driver runs uncapped.
short_valid_cap() { [[ "$1" =~ ^([0-9]+\.?[0-9]*|\.[0-9]+)$ ]] && awk -v c="$1" 'BEGIN { exit !(c + 0 > 0 && c + 0 < 1e9) }'; }

# The report's "- Spend:" line reads spend.json, which the final recount rewrites AFTER the driver wrote report.md: bring the line up to date.
# $1 run dir
short_patch_spend() {
  local run="$1"
  [ -f "$run/report.md" ] && [ -f "$run/spend.json" ] || return 0
  python3 - "$run" <<'P'
import json, re, sys
run = sys.argv[1]
try: usd = json.load(open(f"{run}/spend.json")).get("usd_estimate")
except Exception: sys.exit(0)
if usd is None: sys.exit(0)
rp = f"{run}/report.md"; t = open(rp).read()
t = re.sub(r"^- Spend: \$[^ ]+ of", f"- Spend: ${usd} of", t, count=1, flags=re.M)
open(rp, "w").write(t)
P
}

# The spend guard stops the driver BEFORE it writes its report: leave a report that says so, instead of a path to nothing.
# $1 run dir  $2 sha  $3 cap
short_partial_report() {
  local run="$1" sha="$2" cap="$3"
  [ -f "$run/report.md" ] && return 0
  {
    echo "# Live run (short tier) - CAPPED"; echo
    echo "- Build: \`$sha\`; the spend cap of \$$cap was hit and the guard stopped the run before the driver wrote its report: NO checks were scored."
    echo "- Spend: \$$(python3 -c "import json,sys; print(json.load(open('$run/spend.json')).get('usd_estimate','?'))" 2>/dev/null || echo '?') of a \$$cap cap"; echo
    echo "## Driver output (tail)"; echo; tail -n 30 "$run/live_short.out" 2>/dev/null | sed 's/^/    /'
  } > "$run/report.md"
}
