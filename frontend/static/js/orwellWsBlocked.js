// static/js/orwellWsBlocked.js
//
// ORW-44 slice 3 (Ryne: WebSocket only, no fallback transport): when the live connection cannot be established for a PERMANENT reason (a proxy or network that blocks WebSockets, a refused handshake, exhausted
// reconnects), the player is told so plainly and persistently instead of the game silently limping on another transport. orwellWs.js emits `orwell:ws-blocked` (game build only; the two recoverable
// pre-game causes never do) and `orwell:ws-active` when a socket comes up. A distinct window event pair, so the g15 single-dispatcher rule is untouched.

const ID = 'orwell-ws-blocked';

export function showBlockedBanner() {
  if (typeof document === 'undefined' || document.getElementById(ID)) return;
  const box = document.getElementById('chat-history');
  if (!box || !box.parentNode) return;
  const el = document.createElement('div');
  el.id = ID;
  el.className = 'ow-ws-blocked';
  el.setAttribute('role', 'alert');
  el.textContent = 'This network blocks the live connection Orwell needs to play. Switch to another network (or turn off a VPN or proxy), then reload.';
  box.parentNode.insertBefore(el, box);
}

export function hideBlockedBanner() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(ID);
  if (el) el.remove();
}

if (typeof window !== 'undefined' && !window.__orwellWsBlockedListeners) {
  window.__orwellWsBlockedListeners = true;
  window.addEventListener('orwell:ws-blocked', showBlockedBanner);
  window.addEventListener('orwell:ws-active', hideBlockedBanner);
}
