// ORW-919: should the chat keep following the newest reply? The old rule gave up whenever the bottom was more than 300px away, reading that as "the player scrolled up".
// But a reply that lands in a big block (a frozen paragraph, a WebSocket splice, a decision card closing) opens the same gap without the player touching anything, so the
// view stopped following the newest reply (week-1 playtest). Here only the PLAYER can unpin: content growing never moves scrollTop, so it is not a scroll; a scroll event that
// takes scrollTop BELOW where we last put it is the player scrolling up (unpinned); reaching the bottom again pins. Pure (no DOM): `box` is anything with
// scrollTop / scrollHeight / clientHeight.
export const PIN_SLACK_PX = 48;

export function createFollow() {
  let pinned = true;
  let lastSetTop = null;   // the scrollTop we last set ourselves (null: never)
  const gap = (box) => box.scrollHeight - box.clientHeight - box.scrollTop;
  return {
    /** A scroll event on the history box (ours or the player's). */
    onScroll(box) {
      if (gap(box) <= PIN_SLACK_PX) { pinned = true; return; }
      if (lastSetTop !== null && box.scrollTop < lastSetTop - 2) pinned = false;   // moved UP past where we put it: the player
      else if (lastSetTop === null) pinned = false;                                   // a scroll away from the bottom we did not make
    },
    /** We moved the box ourselves. */
    noteSet(top) { lastSetTop = top; },
    /** Follow the newest content now? */
    shouldFollow() { return pinned; },
    /** A fresh start (a new session, history loaded, the player sent a message): follow again. */
    repin() { pinned = true; },
  };
}
