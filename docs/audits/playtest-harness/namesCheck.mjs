// RETIRED (ORW-44 S4b3): this drives POST /api/chat_stream, which the WebSocket-only game build refuses (426 ws-only), and it hard-codes an OpenRouter text endpoint (ORW-287: text is DeepSeek direct). Kept as audit history; drive a turn with frontend/tests/_ws_turn_driver.py instead.
// Clean, single-turn check: force a NAMED scene and read the FULL GM response to
// verify the model uses the engine roster (post NAMES-ARE-FIXED fix) vs inventing.
import { readFileSync } from 'fs';
const BASE = 'http://127.0.0.1:7000';
const sec = Object.fromEntries(readFileSync(new URL('./.secrets.env', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map(l => l.split('=').map(s => s.trim())).map(([k, ...v]) => [k, v.join('=')]));
let COOKIE = '';
async function login() {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: sec.ADMIN_USER, password: sec.ADMIN_PW }) });
  COOKIE = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).filter(Boolean).map(c => c.split(';')[0]).join('; ');
}
const H = (x = {}) => ({ Cookie: COOKIE, ...x });
await login();
const roster = await fetch(BASE + '/api/orwell/state', { headers: H() }).then(r => r.json());
const real = (roster.house || []).map(h => h.name);
const firsts = real.map(n => n.split(' ')[0]);
const sf = new URLSearchParams({ endpoint_id: 'd228e1e2', model: sec.OR_MODEL || 'deepseek/deepseek-v4-flash', skip_validation: 'true' });
const sess = await fetch(BASE + '/api/session', { method: 'POST', headers: H({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: sf }).then(r => r.json());
const sid = sess.session || sess.id || sess.session_id;
if (!sid) { console.log('session create failed:', JSON.stringify(sess)); process.exit(1); }

const body = new URLSearchParams({ mode: 'agent', session: sid,
  message: "I just walked through the front door into the house. Before anything else — walk me around the room and introduce me to the people who are actually standing here, by name. I want to start matching names to faces right now." });
const res = await fetch(BASE + '/api/chat_stream', { method: 'POST', headers: H({ 'Content-Type': 'application/x-www-form-urlencoded' }), body });
let buf = '', text = ''; const dec = new TextDecoder();
for await (const ch of res.body) { buf += dec.decode(ch, { stream: true }); let i;
  while ((i = buf.indexOf('\n\n')) >= 0) { const ln = buf.slice(0, i); buf = buf.slice(i + 2);
    const m = ln.match(/^data: (.*)$/s); if (!m || m[1] === '[DONE]') continue;
    try { const o = JSON.parse(m[1]); if (typeof o.delta === 'string') text += o.delta; } catch {} } }
text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
const realHits = real.filter(n => text.includes(n) || text.includes(n.split(' ')[0]));
const caps = [...new Set((text.match(/\b[A-Z][a-z]{2,}\b/g) || []))];
const common = new Set(['The','You','And','But','Her','His','She','Avery','Quinn','Big','Brother','House','When','That','This','They','Okay','Now','One','For','Your','What','With','Who','Head','Household','Let','Houseguests','Week','Welcome','Production','Kitchen','Living','Backyard','Bedroom','Bathroom','Storage','Room','Here','Their','Three','First','Night']);
const lasts = real.map(n => n.split(' ')[1]);
const invented = caps.filter(c => !firsts.includes(c) && !lasts.includes(c) && !common.has(c));
console.log('ROSTER:', real.join(', '));
console.log('\nREAL names used:', realHits);
console.log('CANDIDATE invented names:', invented);
console.log('\n===== FULL GM RESPONSE =====\n' + text);
