import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInventory } from "../tests/support/flagInventory";

// Regenerates docs/FLAG-INVENTORY.md (B45). Run: npx tsx scripts/gen-flag-inventory.ts
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "FLAG-INVENTORY.md"), renderInventory());
console.log("wrote docs/FLAG-INVENTORY.md");
