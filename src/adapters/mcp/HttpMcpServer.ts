import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "./McpServer";
import { toolsFor } from "../../surfaces/tools/registry";
import { EngineRefusal, TurnRefusedError, PersistFailureError, StaleBeatError } from "../../domain/errors";
import { HealthMetrics, errorClassOf } from "./healthMetrics";
import { handleRpcPayload, rpcIdOf, RPC } from "./jsonRpc";
import type { ToolGateway } from "./jsonRpc";
import { bootFlagsFromEnv } from "../../featureFlags.js";

/**
 * A minimal HTTP transport over the permissioned `McpServer` routers — the
 * networked seam the orwell front-end calls (feature 0009 allows MCP over
 * stdio or HTTP). It is outward-facing: it depends only on `McpServer`, never on
 * the Vault. Two envelopes ride the SAME router and the SAME guardrails: the
 * REST-ish `/call` shape the front-end uses, and the additive MCP / JSON-RPC 2.0
 * `/rpc` endpoint (`jsonRpc.ts`) for standard MCP clients. This is the runnable
 * entrypoint the deploy scripts (0010) build and start.
 *
 *   GET  /health
 *   GET  /:channel/tools                  -> { tools }
 *   POST /:channel/call { name, args }     -> { result }              (:channel = player | admin)
 *   POST /:channel/rpc  <JSON-RPC 2.0>     -> <JSON-RPC 2.0 response>  (initialize | tools/list | tools/call)
 */
export interface HttpMcpDeps {
  player: McpServer;
  admin: McpServer;
}

/** Per-user routing: resolve the channel's MCP server for the asserted user (0021). */
export interface HttpMcpResolver {
  resolve(channel: "player" | "admin", user: string): McpServer;
}

/**
 * B2 (DEPLOY-12) — the BOOT-TIME state of every opt-in behavioral-fidelity + sleep-economy env flag,
 * so an operator can answer "which living-house layers is this box running?" from `/health` alone.
 * Flag definitions now live in `src/featureFlags.ts` (the single source of truth, #1843).
 * This function delegates to the registry so the /health / flags block stays in sync with the
 * full list of 24 flags — see `FEATURE_FLAGS` in the registry for parsers and ordering.
 */
function bootFlags(): Record<string, boolean> {
  return bootFlagsFromEnv();
}

/**
 * Network-edge guardrails (audit E1 / B34). The in-process Vault Wall + per-user isolation (0021)
 * already hold; these close the *network* edge so the loopback-trusted contract is actually enforced:
 *
 * - `token` — when set, every tool route requires this shared secret (Authorization: Bearer … or
 *   `x-orwell-token`); a mismatch is 401. Lets the engine be safely reachable beyond loopback.
 * - `requireUser` — multi-user mode: a missing/empty `x-orwell-user` header is **rejected (400)**
 *   instead of silently routing to a shared `"default"` sandbox (cross-user bleed).
 * - `knownUser` — a call for a user with no game is refused (404) **without minting a sandbox**,
 *   so an anonymous caller can't spray ids to exhaust memory (DoS) — except the casting tools
 *   (`createCharacter`, `updateCasting`, `getMomentPrompt`), which legitimately run BEFORE a game
 *   exists (0050: the pre-game chat is the casting interview).
 *
 * All three default OFF, so the single-tenant trusted-loopback deploy (and existing tests) are
 * unchanged; production turns them on via env (`main.ts`).
 */
export interface HttpMcpOptions {
  token?: string;
  /**
   * Audit E27: a SEPARATE secret for the admin/God-Mode channel. With only the shared `token`,
   * one bearer granted any-user impersonation AND God Mode. When `adminToken` is set, `/admin/*`
   * requires it specifically — the player token is refused there (401). Player routes accept
   * either (admin is strictly more privileged).
   *
   * SEC-5 (fail-closed): when `token` IS configured but `adminToken` is NOT, the admin channel is
   * DISABLED (503) rather than silently falling back to accepting the player token — that fallback
   * was the exact collapse the admin/player split exists to prevent (the player token is inherently
   * more exposed; it transits every ordinary game request). Neither token set (fully open dev/test)
   * is unaffected — there is no secret asymmetry to collapse.
   */
  adminToken?: string;
  requireUser?: boolean;
  knownUser?: (user: string) => boolean;
  /**
   * Lane G1: the embeddings-provider status for `/health` — provider name plus whether the
   * fastembed runtime has DEGRADED to the deterministic fallback (boot warm-up failure or a
   * mid-process worker death). Wired by `main.ts`, which owns the provider choice; the
   * transport stays free of any engine-root dependency. Unset ⇒ deterministic, not degraded.
   */
  embeddingsStatus?: () => { provider: string; degraded: boolean };
  /**
   * The LIVE in-game clock state (ADR 0006). The FE flips the clock at runtime (`setTimeOfDay`), so the
   * boot env alone mis-reports it; when wired, `/health` `flags.timeOfDay` reports what the engine is
   * actually running.
   */
  timeOfDayStatus?: () => boolean;
  /**
   * #1713 — the per-request RESPONSE BUDGET (ms): the hard bound on how long a queued tool call may
   * go unanswered before the transport answers a typed 503 (`code: "engine-busy"`) instead of holding
   * the socket silently. Node's `server.requestTimeout` only bounds RECEIVING the request — nothing
   * bounded the time to RESPOND, so a call parked behind the per-user serialization queue (a slow
   * drain under CI/host contention, or a job that never settles) held its socket until the CALLER's
   * own timeout — observed as the casting-finalize turn blocking the FE for the full
   * `ORWELL_ENGINE_TIMEOUT` (300s) with zero feedback. Engine tool work is milliseconds; a request
   * that cannot even be dispatched inside this budget is refused loudly and retriably. Overridable
   * via `ORWELL_ENGINE_RESPONSE_BUDGET_MS`; this option (tests) wins over the env.
   */
  responseBudgetMs?: number;
}

/** #1713 — default per-request response budget (see `HttpMcpOptions.responseBudgetMs`). */
const DEFAULT_RESPONSE_BUDGET_MS = 60_000;

function resolveResponseBudgetMs(option: number | undefined): number {
  if (option !== undefined && Number.isFinite(option) && option > 0) return option;
  const env = parseInt((process.env.ORWELL_ENGINE_RESPONSE_BUDGET_MS ?? "").trim(), 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_RESPONSE_BUDGET_MS;
}

/**
 * Constant-time secret comparison (audits E27 + E32): `===` short-circuits on the first differing
 * byte — a timing oracle that lets a network attacker recover the shared secret byte-by-byte.
 * Comparing fixed-length SHA-256 digests makes the time independent of both content and length.
 */
function secretsMatch(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The front-end (trusted loopback auth tier, 0021) asserts the user via this header. */
const USER_HEADER = "x-orwell-user";
/** Request body cap (B60/audit E9): no tool call legitimately needs more than this. */
const MAX_BODY_BYTES = 256 * 1024;
/** Per-request timeout (B60/E9): a wedged request must release its socket. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Tools that may run for a user with no existing game (i.e. may mint a fresh sandbox). */
// 0050: the casting interview happens BEFORE a game exists, so its tools must be able to mint the
// user's sandbox — updateCasting records the first answers; getMomentPrompt serves the interview
// manual to a brand-new user (the front-end frames the pre-game chat with it).
const SANDBOX_CREATING_TOOLS: ReadonlySet<string> = new Set(["createCharacter", "updateCasting", "getMomentPrompt",
  // 0065: pre-warming the cast happens pre-game (it mints + persists the season seed into a fresh
  // sandbox during casting), so it legitimately runs BEFORE a game exists — like updateCasting.
  "preSeedCast",
  // 0116: the model-authored cast-genesis skeleton write-back runs pre-game (DURING the casting interview,
  // onto the preSeedCast warm), so it is exempt from the known-user gate like the other pre-game tools. It
  // refuses cleanly with no warmed cast, so an early call before preSeedCast is a harmless no-op.
  "recordCastGenesis",
  // #1626 (increment 3): the producer-DEEPENING write-back runs pre-game (DURING the casting interview, to
  // enrich the off-camera casting producer the player is talking to), so it is exempt from the known-user
  // gate like the other pre-game tools. It establishes the producer seed lazily, so an early call is safe.
  "recordProducerProfile"]);

function isResolver(d: HttpMcpDeps | HttpMcpResolver): d is HttpMcpResolver {
  return typeof (d as HttpMcpResolver).resolve === "function";
}

function headerValue(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

/** The shared secret a request presents, via `Authorization: Bearer <token>` or `x-orwell-token`. */
function presentedToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headerValue(headers["authorization"]);
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return headerValue(headers["x-orwell-token"]);
}

/**
 * Asserted-user-id cap (audit E8): `FileSaveStore` hex-doubles the id into a directory name, so a
 * >127-byte header becomes `ENAMETOOLONG` 500s deep in the save path. Refuse absurd ids at the
 * edge with a deliberate 400 instead.
 */
const MAX_USER_ID_CHARS = 64;

export function createHttpMcpServer(deps: HttpMcpDeps | HttpMcpResolver, options: HttpMcpOptions = {}): Server {
  // A request's MCP server is resolved per (channel, asserted user). Single-tenant deps ignore the
  // user; the registry-backed resolver routes each call into that user's isolated sandbox.
  const pick = (channel: "player" | "admin", user: string): McpServer =>
    isResolver(deps) ? deps.resolve(channel, user) : (channel === "player" ? deps.player : deps.admin);

  // SEC-5 — computed once: true exactly when the player-channel secret is configured but no
  // DISTINCT admin secret is. This is the collapse the admin/player token split (audit E27)
  // exists to prevent: the player token is inherently more exposed (it transits every ordinary
  // game request), so silently accepting it for /admin/* hands out producerVault + every
  // God-Mode lever to anyone who holds it. Fully open (neither token set — dev/test) is
  // unaffected: there is no secret asymmetry to collapse.
  const adminTokenCollapseRisk = Boolean(options.token) && !options.adminToken;

  // Lane G1: per-process health metrics — uptime, call counters, and the capped ring of
  // recent tool FAILURES (tool name + sanitized error class + duration ONLY — the Vault
  // rule; see healthMetrics.ts). Surfaced on /health for the admin Health & Logs card.
  const metrics = new HealthMetrics();

  // Per-user serialization (B60/audit E10): two in-flight calls for the SAME user run in order —
  // closing the sandbox-swap race (a reset racing a player action) and future-proofing an async
  // narrator. Different users still run fully concurrently (isolation, 0021).
  const queues = new Map<string, Promise<void>>();
  const enqueue = (user: string, job: () => Promise<void>): void => {
    // Audit E30: a rejecting job on a drained queue (e.g. `send` racing a timeout-destroyed
    // socket) had no `.catch` — an unhandled rejection exits the process on modern Node. Every
    // job body is wrapped so the chain can NEVER reject; the request's own structured error
    // handling already answered (or the socket is gone and there is no one to answer).
    const run = async (): Promise<void> => {
      try {
        await job();
      } catch {
        /* swallowed by design — the per-request handlers own error responses */
      }
    };
    const tail = (queues.get(user) ?? Promise.resolve()).then(run, run);
    queues.set(user, tail);
    void tail.finally(() => {
      if (queues.get(user) === tail) queues.delete(user); // drop drained queues (no unbounded map)
    });
  };

  // #1713 — the per-request RESPONSE-BUDGET watchdog (see `HttpMcpOptions.responseBudgetMs`): every
  // queued tool call must be ANSWERED within the budget. If the deadline fires first (the per-user
  // queue is saturated under contention, or a prior job wedged and never settles), the request gets a
  // typed, retriable 503 — and its job, when it eventually reaches the queue head, is SKIPPED
  // (`refused()` is checked before dispatch), so a call the caller was already told failed can never
  // ghost-mutate the sandbox afterward. The E10 per-user serialization is untouched — jobs still run
  // strictly in order, one at a time; the watchdog only converts "wait silently forever" into "fail
  // typed within the budget". A job already mid-dispatch when its deadline fires still completes (the
  // late 200 is dropped by `send`'s dead-socket guard) — the same abandonment semantics as a caller-
  // side timeout today, and the 0065 idempotency keys keep progression at-most-once across it.
  const responseBudgetMs = resolveResponseBudgetMs(options.responseBudgetMs);
  const armResponseDeadline = (
    send: (code: number, body: unknown) => void,
    label: string,
  ): { refused: () => boolean; clear: () => void } => {
    let refused = false;
    const timer = setTimeout(() => {
      refused = true;
      metrics.recordFailure(label, "ResponseBudgetExceeded", responseBudgetMs);
      send(503, {
        error:
          `engine busy: no response within the ${responseBudgetMs}ms response budget — a call still ` +
          "queued was refused outright (no state changed); a call already dispatched may yet apply, " +
          "so re-ground from getGameState before retrying",
        code: "engine-busy",
      });
    }, responseBudgetMs);
    timer.unref?.();
    return { refused: () => refused, clear: () => clearTimeout(timer) };
  };

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      // E30: the socket may be gone (request timeout, client abort) by the time a queued job
      // answers — writing then throws and used to surface as an unhandled rejection. A dead
      // response is simply dropped.
      if (res.writableEnded || res.destroyed) return;
      try {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      } catch {
        /* socket torn down mid-write — nothing to answer */
      }
    };
    // Guard the whole request (audit E2): an unexpected throw — e.g. resolving a sandbox whose save
    // is unreadable — becomes a 500 for THIS request, never an uncaughtException that exits the
    // process and crash-loops every user. The async tool-call path adds its own structured catches.
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Health is an unauthenticated liveness probe — it carries no game data (deploy smoke /
      // systemd). G1 widens it with OPERATIONAL data only: uptime, call counters, the capped
      // recent-failure ring (tool name + error class + timing — never args/payloads/users),
      // and the embeddings-provider status (fastembed vs. the deterministic fallback).
      if (req.method === "GET" && url.pathname === "/health") {
        let embeddings = { provider: "deterministic", degraded: false };
        try {
          embeddings = options.embeddingsStatus?.() ?? embeddings;
        } catch {
          /* a broken status probe must never fail the liveness answer */
        }
        return send(200, {
          ok: true,
          ...metrics.snapshot(),
          embeddings,
          flags: (() => {
            const f = bootFlags();
            try {
              if (options.timeOfDayStatus) f.timeOfDay = options.timeOfDayStatus();
            } catch {
              /* a broken status probe must never fail the liveness answer */
            }
            return f;
          })(),
          // SEC-5: lets a doctor script / monitoring catch this misconfiguration on a live box
          // without shelling in — never a secret, just a boolean.
          security: { adminTokenMissing: adminTokenCollapseRisk },
        });
      }

      const match = url.pathname.match(/^\/(player|admin)\/(tools|call|rpc)$/);
      if (!match) return send(404, { error: "not found" });
      const channel = match[1] as "player" | "admin";

      // (1.5) SEC-5 fail-closed: refuse the ENTIRE admin channel while the collapse risk stands,
      // before any secret comparison — a 503 (service disabled), never a 401 that could read as
      // "just present the right secret" when no secret can ever satisfy this route.
      if (channel === "admin" && adminTokenCollapseRisk) {
        return send(503, {
          error:
            "admin channel disabled: ORWELL_ENGINE_ADMIN_TOKEN is not set (refusing to accept the " +
            "player token for admin/God-Mode access — set a distinct ORWELL_ENGINE_ADMIN_TOKEN)",
        });
      }

      // (2) Secret auth on every tool route, when configured — constant-time compares (E27).
      // The admin channel demands its OWN secret when one is set: the player token must not
      // grant God Mode. Player routes accept either secret (admin ⊇ player privilege).
      const presented = presentedToken(req.headers);
      if (channel === "admin" && options.adminToken) {
        if (!secretsMatch(presented, options.adminToken)) return send(401, { error: "unauthorized" });
      } else if (options.token || options.adminToken) {
        const playerOk =
          (options.token !== undefined && secretsMatch(presented, options.token)) ||
          (options.adminToken !== undefined && secretsMatch(presented, options.adminToken));
        if (!playerOk) return send(401, { error: "unauthorized" });
      }

      // (3) Identity: in multi-user mode a missing/empty user header is refused, never routed to "default".
      const rawUser = headerValue(req.headers[USER_HEADER]);
      if (options.requireUser && !rawUser) return send(400, { error: "missing user identity" });
      // E8: an oversize id would ENAMETOOLONG deep in the save path — refuse it deliberately here.
      if (rawUser && rawUser.length > MAX_USER_ID_CHARS) {
        return send(400, { error: `user identity too long (max ${MAX_USER_ID_CHARS} chars)` });
      }
      const user = rawUser ?? "default";

      if (req.method === "GET" && match[2] === "tools") {
        // Audit E28: the tool list is the STATIC per-channel allowlist — serving it must never
        // resolve (and so never mint) a sandbox for an asserted user. Previously a GET for any
        // sprayed id created the sandbox, making the id "known" for later POSTs and defeating
        // the B34 anti-spray gate.
        return send(200, { tools: toolsFor(channel === "player" ? "player" : "admin/God Mode") });
      }

      if (req.method === "POST" && match[2] === "call") {
        let body = "";
        let oversize = false;
        req.on("data", (chunk) => {
          body += chunk;
          // E9: cap the request body — no tool call legitimately needs more; drop the rest.
          if (!oversize && body.length > MAX_BODY_BYTES) {
            oversize = true;
            send(413, { error: "request body too large" });
            req.destroy();
          }
        });
        req.on("end", () => {
          if (oversize) return;
          // #1713: the response-budget watchdog — a queued call is ANSWERED (503, typed) within the
          // budget even when the per-user queue cannot dispatch it; a refused job never dispatches.
          const deadline = armResponseDeadline(send, "call");
          // E10: serialize per user — a player action can never race a sandbox swap/reset.
          enqueue(user, async () => {
            if (deadline.refused()) return; // #1713: already answered 503 — never ghost-dispatch
            // #1713: clear the deadline once this job is actually dispatching — whatever this job
            // does next may take a while (or fail), but the caller either already has its answer
            // (`send`'s dead-socket guard drops a duplicate) or is about to get a real one; either
            // way the watchdog timer's job is done and it must never fire a stray late 503 for a
            // completed request.
            try {
              let name: unknown, args: unknown;
              try {
                ({ name, args } = JSON.parse(body || "{}") as { name?: unknown; args?: unknown });
              } catch {
                return send(400, { error: "invalid JSON body" });
              }
              // E9: basic arg validation before anything touches the engine.
              if (typeof name !== "string" || name.length === 0) return send(400, { error: "a tool name is required" });
              if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
                return send(400, { error: "args must be an object" });
              }
              // (4) Don't mint a sandbox for an unknown user unless they are starting a game.
              if (options.knownUser && !SANDBOX_CREATING_TOOLS.has(name) && !options.knownUser(user)) {
                return send(404, { error: "no active game for this user" });
              }
              // G1: per-call duration tracking starts here — the dispatch path proper (resolve +
              // callTool). Failures land in the /health ring as {ts, tool, errorClass, durationMs}.
              const dispatchStart = Date.now();
              // E10: the sandbox is resolved HERE, inside the serialized job — never at request start.
              // Resolving can fail (e.g. an unreadable save) — a server error (500), distinct from a
              // bad tool/args (400). Either way the process stays up.
              let server: McpServer;
              try {
                server = pick(channel, user);
              } catch {
                metrics.recordFailure(name, "SandboxResolveError", Date.now() - dispatchStart);
                return send(500, { error: "internal error" });
              }
              try {
                const result = await server.callTool(name, (args as Record<string, unknown>) ?? {});
                metrics.recordSuccess(name, Date.now() - dispatchStart);
                send(200, { result });
              } catch (e) {
                // G1: the ring records the sanitized class only — never e.message (it can quote
                // caller content), never args. Recorded BEFORE the status mapping so every
                // failure mode (409/400/500) is visible to the admin card.
                metrics.recordFailure(name, errorClassOf(e), Date.now() - dispatchStart);
                // Typed engine errors first (audit E3/E7): a commit refused by the fail-closed
                // integrity checkpoint FAILS THE REQUEST — 409, state unchanged, never a 200 whose
                // view narrates a rolled-back beat. A durable-save failure is a 500 with a sanitized
                // message (its own class — never misread as the caller's fault, no data-dir path).
                // 0065 Part A — a stale compare-and-swap write is ALSO a 409, but with a stable machine
                // `code: "stale-beat"`, the CURRENT beatSeq, and the Vault-free board so the caller can
                // re-ground immediately (no state changed — nothing was applied to roll back).
                if (e instanceof StaleBeatError) {
                  return send(409, { error: e.message, code: e.code, beatSeq: e.beatSeq, board: e.board });
                }
                if (e instanceof TurnRefusedError) return send(409, { error: e.message, code: "turn-refused", kinds: e.kinds, ...(e.invariants.length ? { invariant: e.invariants.join(",") } : {}) });
                if (e instanceof PersistFailureError) return send(500, { error: e.message });
                // E9/E7: a DELIBERATE refusal — `EngineRefusal`, or (back-compat) a plain Error
                // thrown by the engine's validation (illegal nominee, unknown tool) — is the
                // caller's fault (400). Anything else (TypeError, RangeError, a subclass) is an
                // engine bug and must read as 500, not masquerade as a client error.
                const deliberate = e instanceof EngineRefusal || (e instanceof Error && e.constructor === Error);
                if (deliberate) send(400, { error: (e as Error).message });
                else send(500, { error: "internal error" });
              }
            } finally {
              deadline.clear();
            }
          });
        });
        return;
      }

      // The additive MCP / JSON-RPC 2.0 envelope (the deferral noted at the top of this file).
      // It rides the SAME auth (above), per-user routing, body cap, serialization, and metrics as
      // /call — it is just another envelope over the same permissioned router, so the Vault Wall
      // and isolation hold identically. `initialize` / `tools/list` answer statically (never mint
      // a sandbox); `tools/call` routes to the per-user McpServer behind the same anti-spray gate.
      if (req.method === "POST" && match[2] === "rpc") {
        let body = "";
        let oversize = false;
        req.on("data", (chunk) => {
          body += chunk;
          if (!oversize && body.length > MAX_BODY_BYTES) {
            oversize = true;
            send(413, { error: "request body too large" });
            req.destroy();
          }
        });
        req.on("end", () => {
          if (oversize) return;
          enqueue(user, async () => {
            let payload: unknown;
            try {
              payload = JSON.parse(body || "{}");
            } catch {
              // JSON-RPC parse error: the id is unknowable ⇒ null (spec).
              return send(200, { jsonrpc: "2.0", id: null, error: { code: RPC.PARSE_ERROR, message: "parse error" } });
            }
            const dispatchStart = Date.now();
            const gateway: ToolGateway = {
              // Static allowlist — `initialize`/`tools/list` never resolve (and so never mint) a
              // sandbox, closing the same spray vector the REST GET /tools route closes (E28).
              listTools: () => toolsFor(channel === "player" ? "player" : "admin/God Mode"),
              callTool: async (name, args) => {
                // E28: an unknown user may mint a sandbox only via a sandbox-creating tool.
                if (options.knownUser && !SANDBOX_CREATING_TOOLS.has(name) && !options.knownUser(user)) {
                  throw new EngineRefusal("no active game for this user");
                }
                let srv: McpServer;
                try {
                  srv = pick(channel, user);
                } catch {
                  // E7: a resolve failure must not leak the data-dir path into isError content.
                  metrics.recordFailure(name, "SandboxResolveError", Date.now() - dispatchStart);
                  throw new Error("internal error");
                }
                return srv.callTool(name, args);
              },
            };
            try {
              const out = await handleRpcPayload(gateway, payload);
              metrics.recordSuccess("rpc", Date.now() - dispatchStart);
              if (out === null) {
                // A lone/all-notification payload gets NO response body (MCP Streamable HTTP: 202).
                if (!res.writableEnded && !res.destroyed) {
                  try { res.writeHead(202); res.end(); } catch { /* socket torn down */ }
                }
                return;
              }
              return send(200, out);
            } catch (e) {
              // dispatch swallows tool failures into isError content; here is an unexpected
              // transport fault ⇒ a JSON-RPC internal error, never a leak.
              metrics.recordFailure("rpc", errorClassOf(e), Date.now() - dispatchStart);
              return send(200, { jsonrpc: "2.0", id: rpcIdOf(payload), error: { code: RPC.INTERNAL_ERROR, message: "internal error" } });
            }
          });
        });
        return;
      }
      return send(405, { error: "method not allowed" });
    } catch {
      return send(500, { error: "internal error" });
    }
  });
  // E9: a wedged request must release its socket (the default Node timeout is far too generous).
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  // SEC-5: loud + REPEATED startup warning for the token-collapse misconfiguration (see above) —
  // a live-deployment misconfiguration, not a one-off boot note, so it must not scroll off the top
  // of a long-running log. Unref'd so it never keeps the process alive on its own; cleared on
  // server close so a test creating many short-lived servers in one process never leaves a stray
  // timer firing after its server is gone.
  if (adminTokenCollapseRisk) {
    const warnAdminTokenCollapse = (): void => {
      // eslint-disable-next-line no-console
      console.warn(
        "[orwell-engine] SECURITY (SEC-5): ORWELL_ENGINE_TOKEN is set but ORWELL_ENGINE_ADMIN_TOKEN " +
          "is NOT — the admin/God-Mode channel is DISABLED (refusing to fall back to the player " +
          "token). Set a distinct ORWELL_ENGINE_ADMIN_TOKEN to restore admin access.",
      );
    };
    warnAdminTokenCollapse();
    const collapseWarnTimer = setInterval(warnAdminTokenCollapse, 5 * 60_000).unref();
    server.on("close", () => clearInterval(collapseWarnTimer));
  }

  return server;
}

/**
 * Start the HTTP transport. Binds **loopback (`127.0.0.1`) by default** (audit E1): the deploy
 * contract is a trusted local front-end, so the engine must not be reachable cross-host unless the
 * operator opts in via `host` (and should pair that with `options.token`).
 */
export function startHttpMcp(
  deps: HttpMcpDeps | HttpMcpResolver,
  port: number,
  options: HttpMcpOptions = {},
  host = "127.0.0.1",
): Server {
  return createHttpMcpServer(deps, options).listen(port, host);
}
