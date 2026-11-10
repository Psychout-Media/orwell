// Compare the classic page (/) with the new page (/play) under 4x CPU throttle:
//   - bytes + requests to load,
//   - script / task time and long tasks while one reply streams,
//   - requests per minute while idle.
// Usage: PLAY_BASE_URL=http://127.0.0.1:7000 node scripts/perf-compare.mjs [out.json] [--idle-seconds=60]
// Needs a stack with a started game bound to a chat session and the deterministic fake model
// (docs/audits/playtest-harness/fake_model_server.mjs, ideally with FAKE_REPLY_REPEAT>1).
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = process.env.PLAY_BASE_URL ?? 'http://127.0.0.1:7000';
const USER = process.env.PLAY_USER ?? 'admin';
const PASSWORD = process.env.PLAY_PASSWORD ?? 'play-test-pw';
const THROTTLE = Number(process.env.CPU_THROTTLE ?? 4);
const idleArg = process.argv.find((a) => a.startsWith('--idle-seconds='));
const IDLE_S = idleArg ? Number(idleArg.split('=')[1]) : 60;
const outFile = process.argv.find((a) => a.endsWith('.json'));

const TARGETS = {
  classic: {
    path: '/',
    ready: (page) => page.waitForSelector('#message', { timeout: 60_000 }),
    send: async (page, text) => {
      await page.fill('#message', text);
      await page.keyboard.press('Enter');
    },
    aiCount: (page) => page.locator('#chat-history .msg-ai').count(),
  },
  play: {
    path: '/play',
    ready: (page) => page.getByTestId('transcript').waitFor({ timeout: 60_000 }),
    send: async (page, text) => {
      await page.getByLabel('Say or do something').fill(text);
      await page.getByTestId('send').click();
    },
    aiCount: (page) => page.getByTestId('msg-ai').count(),
  },
};

async function run(name, browser) {
  const t = TARGETS[name];
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const login = await page.request.post('/api/auth/login', { data: { username: USER, password: PASSWORD } });
  if (!login.ok()) throw new Error('login failed');
  await page.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ type: 'longtask', buffered: true });
    } catch {}
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  const reqs = [];
  const sizes = new Map();
  cdp.on('Network.requestWillBeSent', (e) => reqs.push({ t: Date.now(), url: e.request.url, type: e.type }));
  cdp.on('Network.loadingFinished', (e) => sizes.set(e.requestId, e.encodedDataLength));
  const idToUrl = new Map();
  cdp.on('Network.responseReceived', (e) => idToUrl.set(e.requestId, { url: e.response.url, type: e.type }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  const log = (m) => console.error(`[${name}] ${m}`);
  const t0 = Date.now();
  await page.goto(t.path, { waitUntil: 'load' });
  await t.ready(page);
  await page.waitForTimeout(4000); // let boot-time fetches settle
  const loadReqs = reqs.length;
  let bytes = 0, js = 0, css = 0;
  for (const [id, n] of sizes) {
    bytes += n;
    const m = idToUrl.get(id);
    if (m?.type === 'Script') js += n;
    if (m?.type === 'Stylesheet') css += n;
  }
  const loadMs = Date.now() - t0 - 4000;

  log(`loaded: ${loadReqs} requests`);
  // Idle: no interaction at all.
  const idleStart = reqs.length;
  await page.waitForTimeout(IDLE_S * 1000);
  const idleReqs = reqs.length - idleStart;
  const idlePerMin = Math.round((idleReqs * 60) / IDLE_S);

  log(`idle done: ${idleReqs} requests in ${IDLE_S}s`);
  // One streamed reply.
  const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const lt0 = await page.evaluate(() => window.__lt.length);
  const ai0 = await t.aiCount(page);
  const sendStart = Date.now();
  // The stream is done when its request finishes OR is cancelled by the client (the new app cancels the
  // reader on [DONE]); CDP reports both.
  const done = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('stream did not finish in 120s')), 120_000);
    let id = null;
    cdp.on('Network.requestWillBeSent', (e) => { if (e.request.url.includes('/api/chat_stream')) id = e.requestId; });
    const end = (e) => { if (id && e.requestId === id) { clearTimeout(to); resolve(); } };
    cdp.on('Network.loadingFinished', end);
    cdp.on('Network.loadingFailed', end);
  });
  await t.send(page, `Perf turn ${name} ${Date.now()}`);
  await done;
  log('stream finished');
  await page.waitForTimeout(1500);
  const streamMs = Date.now() - sendStart;
  const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const lts = await page.evaluate((from) => window.__lt.slice(from), lt0);
  const ai1 = await t.aiCount(page);
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/${name}.png` });
  await ctx.close();
  const ms = (k) => Math.round((m1[k] - m0[k]) * 1000);
  return {
    target: name,
    cpuThrottle: THROTTLE,
    load: { requests: loadReqs, bytesOnWire: bytes, jsBytes: js, cssBytes: css, loadMs },
    idle: { seconds: IDLE_S, requests: idleReqs, requestsPerMinute: idlePerMin },
    stream: {
      windowMs: streamMs,
      scriptMs: ms('ScriptDuration'),
      taskMs: ms('TaskDuration'),
      layoutMs: ms('LayoutDuration'),
      styleMs: ms('RecalcStyleDuration'),
      longTasks: lts.length,
      longTaskTotalMs: Math.round(lts.reduce((a, b) => a + b, 0)),
      longestTaskMs: Math.round(Math.max(0, ...lts)),
      newAiBubbles: ai1 - ai0,
    },
  };
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const results = [];
for (const name of ['classic', 'play']) results.push(await run(name, browser));
await browser.close();
console.log(JSON.stringify(results, null, 2));
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
