// ORW-950: shrink a chosen photo on the device before the preview and the upload. A phone camera
// photo is several MB; the server bounds the long edge to 1024 px anyway (orwell_portraits
// _normalize_upload), so anything larger only slows the upload and the page. Any failure (a format
// the browser cannot decode, no canvas) returns the original file unchanged. `env` is injectable for tests.
export const MAX_EDGE_PX = 1024;   // the same bound the server applies on intake
export const JPEG_QUALITY = 0.9;

export function targetSize(w, h, max = MAX_EDGE_PX) {
  const longest = Math.max(w, h);
  if (!(longest > 0)) return null;
  if (longest <= max) return { w, h };
  const k = max / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

function defaultEnv() {
  return {
    createImageBitmap: typeof createImageBitmap === "function" ? createImageBitmap.bind(globalThis) : null,
    makeCanvas: (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; },
    loadImage: (file) => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, close() { URL.revokeObjectURL(url); } });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      img.src = url;   // <img> applies EXIF orientation itself in current browsers
    }),
  };
}

async function decode(file, env) {
  if (env.createImageBitmap) {
    try {
      const bmp = await env.createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close() { try { bmp.close && bmp.close(); } catch (_) {} } };
    } catch (_) { /* fall through to <img> */ }
  }
  return env.loadImage(file);
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try { canvas.toBlob((b) => resolve(b || null), type, quality); } catch (_) { resolve(null); }
  });
}

/** Resolve to a JPEG File no larger than MAX_EDGE_PX on its long side, or the original file when it cannot be decoded. */
export async function shrinkPhoto(file, env) {
  env = env || defaultEnv();
  if (!file) return file;
  let img = null;
  try {
    img = await decode(file, env);
    const size = targetSize(img.width, img.height);
    if (!size) return file;
    const canvas = env.makeCanvas(size.w, size.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size.w, size.h);   // JPEG has no alpha
    ctx.drawImage(img.source, 0, 0, size.w, size.h);
    const blob = await toBlob(canvas, "image/jpeg", JPEG_QUALITY);
    if (!blob || !blob.size) return file;
    const name = String(file.name || "photo").replace(/\.[^.]*$/, "") + ".jpg";
    return typeof File === "function" ? new File([blob], name, { type: "image/jpeg" }) : blob;
  } catch (_) {
    return file;
  } finally {
    try { img && img.close(); } catch (_) {}
  }
}
