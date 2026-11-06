// Fails when the built bundle exceeds the budget: JS <= 200 KB gzip, CSS <= 40 KB gzip.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, extname } from 'node:path';

const BUDGET = { '.js': 200 * 1024, '.css': 40 * 1024 };
const dir = new URL('../dist/assets/', import.meta.url).pathname;
const total = { '.js': 0, '.css': 0 };
for (const f of readdirSync(dir)) {
  const ext = extname(f);
  if (!(ext in total)) continue;
  total[ext] += gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
}
let bad = false;
for (const [ext, n] of Object.entries(total)) {
  const ok = n <= BUDGET[ext];
  console.log(`${ext.slice(1).toUpperCase()}: ${(n / 1024).toFixed(1)} KB gzip (budget ${(BUDGET[ext] / 1024).toFixed(0)} KB) ${ok ? 'OK' : 'OVER'}`);
  if (!ok) bad = true;
}
process.exit(bad ? 1 : 0);
