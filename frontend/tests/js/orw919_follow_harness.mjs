// ORW-919: drives static/js/chatFollow.js with a fake box. Prints one JSON line.
const dir = process.argv[2];
const { createFollow } = await import(dir + '/chatFollow.js');
const box = { scrollTop: 0, scrollHeight: 1000, clientHeight: 600 };
const out = {};
let f = createFollow();
// pinned at the bottom; a reply lands in one 900px block (no scroll event: content growth never moves scrollTop)
box.scrollTop = 400; f.noteSet(400); f.onScroll(box);
box.scrollHeight += 900;
out.followsABigBlock = f.shouldFollow();
// the player scrolls up past where we put it
box.scrollTop = 120; f.onScroll(box);
out.playerScrolledUpUnpins = !f.shouldFollow();
// more content arrives while they read: still unpinned
box.scrollHeight += 400; out.staysUnpinnedWhileReading = !f.shouldFollow();
// they scroll back to the bottom: pinned again
box.scrollTop = box.scrollHeight - box.clientHeight; f.onScroll(box); out.backAtBottomRepins = f.shouldFollow();
// our own smooth-scroll step mid-way (moving DOWN) never unpins
f = createFollow(); box.scrollTop = 100; box.scrollHeight = 3000; f.noteSet(100); box.scrollTop = 900; f.noteSet(900); f.onScroll(box);
out.ourStepMidwayStaysPinned = f.shouldFollow();
console.log(JSON.stringify(out));
