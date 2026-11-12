import { it } from "vitest";
import { execFileSync } from "node:child_process";
const prof = execFileSync("bash", ["-c", 'source "$1" && orwell_optin_env_defaults "$2"', "_", "deploy/orwell-env-defaults.sh", "/x"], { encoding: "utf8" })
  .split("\n").map((l) => l.trim()).filter((l) => /^ORWELL_/.test(l)).filter((l) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)=/.test(l));
const off = (process.env.JURY_OFF ?? "").split(",").filter(Boolean);
for (const line of prof) { const i = line.indexOf("="); const k = line.slice(0, i); process.env[k] = off.includes(k) ? "0" : line.slice(i + 1); }
const { composeRuntime } = await import("../../src/composition/runtime");
const { runJurySequesterScenario } = await import("../support/jurySequesterScenario");
it("prof", async () => {
  const t: Record<string, { n: number; ms: number }> = {};
  const wrapped = ((o: any) => {
    const rt = composeRuntime(o);
    const orig = rt.registry.resolver();
    (rt.registry as any).resolver = () => (ch: string, u: string) => {
      const m = orig(ch as any, u);
      const c = m.callTool.bind(m);
      (m as any).callTool = async (name: string, a: any) => { const s = performance.now(); try { return await c(name, a); } finally { const e = t[name] ??= { n: 0, ms: 0 }; e.n++; e.ms += performance.now() - s; } };
      return m;
    };
    return rt;
  }) as typeof composeRuntime;
  const s0 = performance.now();
  await runJurySequesterScenario(wrapped);
  console.log("TOTAL", Math.round(performance.now() - s0), JSON.stringify(Object.entries(t).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([k, v]) => [k, v.n, Math.round(v.ms)])));
}, 900_000);
