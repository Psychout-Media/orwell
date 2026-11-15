// frameBatch.js - ORW-157: keep body/transcript-wide MutationObservers off the per-token path.
//
// A streamed reply mutates the DOM on every token. A MutationObserver on `document.body` (subtree) or `#chat-history`
// otherwise runs its callback after EVERY such batch, and several of them do a `querySelectorAll` per added node or
// force layout. `frameBatched(cb)` returns a MutationObserver callback that ACCUMULATES the records and calls `cb`
// once per animation frame with all of them (a 120 ms timer backs the frame up so a hidden tab still progresses).
// `liveAddedElements(records)` then reduces a batch to the element nodes worth scanning: still connected (the
// streaming tail is replaced several times per frame; the replaced nodes are already gone) and not nested inside
// another added node (one scan of the ancestor covers the descendants).
//
// Use: new MutationObserver(frameBatched((records, observer) => { ... }))

export function frameBatched(cb) {
  let queue = [];
  let pending = false;
  let timer = 0;
  let raf = 0;
  let observer = null;
  const flush = () => {
    if (!pending) return;
    pending = false;
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = 0;
    const records = queue;
    queue = [];
    if (records.length) cb(records, observer);
  };
  return function batched(records, obs) {
    observer = obs || observer;
    for (let i = 0; i < records.length; i++) queue.push(records[i]);
    if (pending) return;
    pending = true;
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(flush);
    timer = setTimeout(flush, 120);
  };
}

export function liveAddedElements(records) {
  const added = [];
  for (const r of records) {
    if (!r.addedNodes) continue;
    for (const n of r.addedNodes) if (n.nodeType === 1 && n.isConnected) added.push(n);
  }
  if (added.length < 2) return added;
  const set = new Set(added);
  return added.filter((n) => {
    for (let p = n.parentNode; p; p = p.parentNode) if (set.has(p)) return false;
    return true;
  });
}
