# shellcheck shell=bash
#
# deploy/smoke_embeddings.sh — the embeddings warm-up integrity guard for the deploy smoke.
#
# WHY THIS EXISTS (a real prod-breaker, 2026-06-27 → 2026-07-14, issues #1590/#1600).
# fastembed's ESM build does `import tar from "tar"`. A package.json security bump forced
# `tar@7` (pure-ESM, NO default export), so that import threw at MODULE-EVALUATION time —
# BEFORE any network fetch — with:
#     The requested module 'tar' does not provide an export named 'default'
# The engine's boot warm-up caught it and fell back to `DeterministicEmbedding` (a DESIGNED,
# graceful fallback). So every production boot ran semantic recall permanently DEGRADED, and
# NO gate saw it: the smoke booted the engine but never asserted the embedding provider warmed
# up. This file closes that gap.
#
# THE TWO CASES THIS GUARD MUST SEPARATE (getting this wrong makes the gate useless):
#   • INTENTIONAL fallback — `ORWELL_EMBEDDINGS` unset ⇒ the deterministic provider is the
#     DESIGNED default. `degraded:false`, `provider:"deterministic"`. This is NOT a failure and
#     MUST pass.
#   • REAL failure — `ORWELL_EMBEDDINGS=fastembed` requested, but warm-up CRASHED on an
#     import/exception (the #1590 tar-import class). This MUST fail the smoke loudly, because it
#     will never self-heal: every boot degrades forever.
#
# THE DISCRIMINATOR. `node dist/embedWorker.js --prefetch` runs the EXACT import + model-extract
# path the engine warm-up runs (`await import("fastembed")` → `FlagEmbedding.init` → tar-extract
# the model). Its exit code + output classify cleanly, because the #1590 crash happens at IMPORT
# (before any socket) while a genuine model-download failure happens LATER, during the fetch:
#   • exit 0                       → ok           (import + extract + cache all worked)
#   • non-zero, network signature  → network-skip (model CDN unreachable in this sandbox — a
#                                                   BENIGN, offline-CI condition, NOT #1590)
#   • non-zero, anything else      → import-fail  (the #1590 class — FAIL, fail-safe default)
# The default for an UNRECOGNISED non-zero exit is `import-fail`, on purpose: a network-absent CI
# must NEVER silently pass a real import crash (the whole point of the guard).

# classify_prefetch_outcome <exit_code> <combined_output>
#   Pure: no side effects, echoes exactly one of: ok | network-skip | import-fail
classify_prefetch_outcome() {
  local code="$1" out="$2"
  if [ "$code" = "0" ]; then echo "ok"; return 0; fi

  # (1) Explicit IMPORT/MODULE-EVALUATION crash signatures take precedence — these are the #1590
  #     class and MUST fail even if a network-ish word happens to co-occur in the output.
  #     "does not provide an export named" is the literal tar@7 ESM break. These are all SPECIFIC
  #     import-eval signatures — deliberately NOT the bare error-type names `typeerror`/`referenceerror`:
  #     Node's built-in `fetch` reports a benign offline failure as `TypeError: fetch failed`, so a bare
  #     `typeerror` here would swallow the network branch below and misclassify an outage as a #1590 crash
  #     (Greptile P1). A genuine import TypeError still matches its specific token (`is not a function`,
  #     `does not provide an export named`, …); a NOVEL import crash with no signature still fails via the
  #     fail-safe default at (3) — so dropping the bare types loses no real-crash coverage.
  if printf '%s' "$out" | grep -qiE \
      "does not provide an export named|cannot find module|err_module_not_found|err_require_esm|cannot use import statement|unexpected token|is not a function|is not a constructor|syntaxerror|unknown fastembed model|no default export|__filename is not defined|require is not defined"; then
    echo "import-fail"; return 0
  fi

  # (2) Genuine model-DOWNLOAD/network failures — the model can't be fetched in this sandbox.
  #     Benign (the box would retry at boot); tolerated but LOGGED loudly by the caller.
  #     NOTE: `fetch failed` is anchored with a non-letter prefix so it does NOT match the
  #     boilerplate error banner "...preFETCH FAILED:" that opens EVERY prefetch error message
  #     (that substring-collision would misclassify every real crash as benign — a silent #1590).
  if printf '%s' "$out" | grep -qiE \
      "getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout|epipe|(^|[^a-z])fetch failed|network|socket hang up|could not resolve host|request to .* failed|dns|tls|certificate|self-signed|unable to (get|verify)|ssl|timed out|timeout|econnaborted|ehostunreach|enetunreach|status code 4|status code 5|http 4|http 5|(^|[^0-9])429([^0-9]|$)|403 forbidden|proxy|download failed|failed to download|no such host"; then
    echo "network-skip"; return 0
  fi

  # (3) Fail-safe: any OTHER non-zero exit is treated as a real import/warm-up crash. We do NOT
  #     let an unclassified failure pass — a silent import crash slipping through is exactly #1590.
  echo "import-fail"; return 0
}

# _self_test_classify — synthetic-case unit test for classify_prefetch_outcome. Invoked by
# `bash deploy/smoke_embeddings.sh --self-test` (which the deploy-smoke CI job runs), so the
# assertion helper is itself gated in the SAME lane that path-triggers on deploy/** changes.
_self_test_classify() {
  local n_fail=0
  _expect() { # want  code  output
    local got; got="$(classify_prefetch_outcome "$2" "$3")"
    if [ "$got" = "$1" ]; then
      echo "  ok  — classify[$2]: got '$got' ($(printf '%s' "$3" | head -c 48))"
    else
      echo "  FAIL — classify: wanted '$1' got '$got' for code=$2 out='$3'"; n_fail=$((n_fail + 1))
    fi
  }
  # Success.
  _expect ok           0 '[orwell] fastembed model "fast-bge-small-en-v1.5" cached at /x/models'
  # The #1590 tar-import crash — the case this whole guard exists to catch.
  _expect import-fail  1 "[orwell] fastembed prefetch failed: The requested module 'tar' does not provide an export named 'default'"
  _expect import-fail  1 '[orwell] fastembed prefetch failed: Cannot find module '\''fastembed'\'''
  _expect import-fail  1 '[orwell] fastembed prefetch failed: TypeError: tar.x is not a function'
  _expect import-fail  1 '[orwell] fastembed prefetch failed: SyntaxError: Unexpected token'
  _expect import-fail  1 '[orwell] fastembed prefetch failed: unknown fastembed model "bad-pin"'
  # Benign, offline-CI: the model CDN can't be reached. NOT a crash — tolerated.
  _expect network-skip 1 '[orwell] fastembed prefetch failed: getaddrinfo ENOTFOUND huggingface.co'
  _expect network-skip 1 '[orwell] fastembed prefetch failed: fetch failed'
  # Node's built-in fetch reports a benign OFFLINE failure as `TypeError: fetch failed` — a network
  # skip, NOT the #1590 import class. A bare `typeerror` in branch (1) used to swallow this (Greptile P1).
  _expect network-skip 1 '[orwell] fastembed prefetch failed: TypeError: fetch failed'
  _expect network-skip 1 '[orwell] fastembed prefetch failed: connect ETIMEDOUT 1.2.3.4:443'
  # The pinned-mirror fetch (fastembedWorker.ensureModelFiles): an HTTP error or a checksum mismatch is a
  # DOWNLOAD failure, never misreported as a fastembed import crash.
  _expect network-skip 1 '[orwell] fastembed prefetch failed: model download failed: https://huggingface.co/x/config.json → HTTP 403'
  _expect network-skip 1 '[orwell] fastembed prefetch failed: model download failed: model_optimized.onnx sha256 mismatch (got 00ff)'
  _expect network-skip 1 '[orwell] fastembed prefetch failed: request to https://huggingface.co/... failed'
  # Fail-safe: an unrecognised non-zero exit must NOT silently pass — default to import-fail.
  _expect import-fail  1 '[orwell] fastembed prefetch failed: something totally unexpected'
  _expect import-fail  7 ''
  # An import crash that also mentions a network-ish word must still fail (precedence rule).
  _expect import-fail  1 'TypeError while opening network socket module: does not provide an export named default'
  if [ "$n_fail" -eq 0 ]; then echo "classify self-test: PASS"; return 0; fi
  echo "classify self-test: FAIL ($n_fail)"; return 1
}

# Run the self-test ONLY when this file is EXECUTED directly with --self-test. When SOURCED (the
# common case — smoke.sh / install.sh / update.sh pull in `classify_prefetch_outcome`), this block
# is skipped regardless of the sourcing script's positional args, so sourcing is side-effect-free.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    --self-test) _self_test_classify ;;
    *) : ;;
  esac
fi
