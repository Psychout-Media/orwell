import { it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
type Sess = { live: { aimedAtPlayer?: Array<{ actor: string; hostile: boolean; status: string }> } };
it("scan seeds for a shown hostile approach (mix driver, 1400 messages)", async () => {
  const hits: string[] = [];
  for (let seed = 1; seed <= 16; seed++) {
    let shown = false;
    await playMixGame(seed, 1400, { user: `mixdrv-${seed}`, onStep: (sess) => { if (!shown && ((sess as Sess).live.aimedAtPlayer ?? []).some((r) => r.hostile && r.status === "shown")) shown = true; }, stopWhen: () => shown });
    hits.push(`${seed}:${shown ? "Y" : "n"}`);
    console.log("SCAN " + hits.join(" "));
  }
}, 3_000_000);
