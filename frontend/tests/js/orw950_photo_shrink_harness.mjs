// ORW-950: drives static/js/photoShrink.js with a fake browser. Prints one JSON line.
const dir = process.argv[2];
const { shrinkPhoto, targetSize } = await import(dir + '/photoShrink.js');
const out = {};
const log = { drawn: null, closed: 0, opts: null, quality: null };
function fakeEnv({ w, h, decodeFails = false, bitmapFails = false, blobNull = false }) {
  return {
    createImageBitmap: bitmapFails ? async () => { throw new Error('no'); } : async (f, o) => { log.opts = o; return { width: w, height: h, close() { log.closed++; } }; },
    makeCanvas: (cw, ch) => ({ width: cw, height: ch, getContext: () => ({ fillRect() {}, drawImage(s, x, y, dw, dh) { log.drawn = [dw, dh]; } }),
      toBlob(cb, type, q) { log.quality = q; cb(blobNull ? null : new Blob(['x'.repeat(50)], { type })); } }),
    loadImage: async () => { if (decodeFails) throw new Error('heic'); return { source: {}, width: w, height: h, close() { log.closed++; } }; },
  };
}
const orig = new File(['o'.repeat(5000)], 'IMG_1.HEIC', { type: 'image/heic' });
out.sizeLandscape = targetSize(4032, 3024);
out.sizeSmallUnchanged = targetSize(800, 600);
let f = await shrinkPhoto(orig, fakeEnv({ w: 4032, h: 3024 }));
out.big = { type: f.type, name: f.name, drawn: log.drawn, orientation: log.opts.imageOrientation, q: log.quality, closed: log.closed, isOrig: f === orig };
f = await shrinkPhoto(orig, fakeEnv({ w: 3024, h: 4032, bitmapFails: true }));
out.imgFallbackStillShrinks = { type: f.type, drawn: log.drawn };
f = await shrinkPhoto(orig, fakeEnv({ w: 1, h: 1, bitmapFails: true, decodeFails: true }));
out.undecodableKeepsOriginal = f === orig;
f = await shrinkPhoto(orig, fakeEnv({ w: 100, h: 100, blobNull: true }));
out.noBlobKeepsOriginal = f === orig;
console.log(JSON.stringify(out));
