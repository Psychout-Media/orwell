// static/js/chatRenderer.js
// Extracted from chat.js — message rendering, sources, images, metrics

import uiModule from './ui.js';
import markdownModule, { svgifyEmoji as _svgifyEmoji } from './markdown.js';
import { addAITTSButton } from './tts-ai.js';
import { providerLogo, providerLabel } from './providers.js';
import settingsModule from './settings.js';
import spinnerModule from './spinner.js';
import { bindMenuDismiss } from './escMenuStack.js';
import { matchModelKey } from './model/matchKey.js';
import { isNarrow } from './platform.js';
import { ORWELL_TOOL_BEATS, orwellBeatOutcome, orwellBeatNodeView, isGameBuild, orwellBeatIsSilent, ORWELL_MAX_VISIBLE_BEATS, gameNarrator, orwellCeremonySlate, orwellRenderCeremonySlate } from './orwellToolBeats.js';
import { detectOocAside } from './orwellOocAside.js';

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';
const REPORT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>';
const CHAT_ABOUT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/** Sanitize a URL for use in href — only allow http(s) and protocol-relative. */
function _safeHref(url) {
  if (!url) return '#';
  try {
    var parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return uiModule.esc(url);
  } catch(e) { /* invalid URL */ }
  return '#';
}

export function safeToolScreenshotSrc(raw) {
  const src = String(raw || '').trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) {
    return src;
  }
  return '';
}

export function safeDisplayImageSrc(raw) {
  const src = String(raw || '').trim();
  if (!src) return '';
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) {
    return src;
  }
  try {
    const parsed = new URL(src, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (_) {}
  return '';
}

function _makeActionBtn(className, title, text, handler) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.type = 'button';
  btn.title = title;
  btn.textContent = text;
  btn.addEventListener('click', handler);
  return btn;
}

// Attachment card helpers
function _attachIcon(mimeOrName) {
  const s = (mimeOrName || '').toLowerCase();
  if (s.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(s))
    return '<svg class="attach-card-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
  if (s.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|webm)$/i.test(s))
    return '<svg class="attach-card-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  if (s === 'application/pdf' || /\.pdf$/i.test(s))
    return '<svg class="attach-card-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  // Default: generic document
  return '<svg class="attach-card-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}
function _formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// Build the `.attach-cards` element for a message's attachment list. Shared by
// addMessage and updateMessageAttachments so a live (optimistic) user bubble
// can be re-rendered with real upload ids once the upload resolves.
function buildAttachCards(attachments) {
  const attachWrap = document.createElement('div');
  attachWrap.className = 'attach-cards';
  for (const att of attachments) {
    const isImage = (att.mime || '').startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(att.name || '');
    if (isImage) {
      // Image preview. Shown for both uploaded (att.id present) and still-
      // uploading attachments. A shimmering skeleton + whirlpool fills the
      // space until either the upload resolves (no id yet) or the thumbnail
      // image finishes loading, so the photo doesn't pop in abruptly.
      const imgWrap = document.createElement('div');
      imgWrap.className = 'attach-image-preview';
      imgWrap.style.cursor = att.id ? 'zoom-in' : 'default';
      if (att.id) imgWrap.dataset.fileId = att.id;
      if (att.id) {
        imgWrap.addEventListener('click', (e) => {
          // Tapping the corner OCR button shouldn't also open the lightbox.
          if (e.target.closest('.attach-ocr-btn')) return;
          _openImageLightbox(att);
        });
      }

      let skel = null;
      let sp = null;
      if (!att.previewUrl) {
        // Skeleton placeholder with a centered whirlpool. Self-stops when removed.
        skel = document.createElement('div');
        skel.className = 'attach-image-skeleton';
        // Match the photo's aspect ratio when the backend knew it at upload
        // time, so the skeleton doesn't sit at a 4:3 default and then snap to
        // a portrait shape when the image arrives.
        if (att.width && att.height) {
          skel.style.aspectRatio = att.width + ' / ' + att.height;
          skel.style.width = 'auto';
          skel.style.height = 'auto';
          skel.style.maxWidth = '300px';
          skel.style.maxHeight = '200px';
          skel.style.minWidth = '80px';
        }
        sp = spinnerModule.createWhirlpool(20);
        skel.appendChild(sp.element);
        imgWrap.appendChild(skel);
      }

      if (att.id || att.previewUrl) {
        const img = document.createElement('img');
        // Small cached thumbnail — the preview is tiny, no need to pull the
        // full-resolution photo. Click still opens the full image.
        img.alt = att.name || 'Image';
        img.loading = 'lazy';
        img.style.cssText = 'max-width:300px;max-height:200px;border-radius:6px;display:' + (att.previewUrl ? 'block' : 'none') + ';';
        let _revealed = false;
        let _revealTimer = null;
        const _reveal = () => {
          if (_revealed) return;
          _revealed = true;
          if (_revealTimer) { clearTimeout(_revealTimer); _revealTimer = null; }
          img.style.display = 'block';
          try { sp && sp.stop(); } catch {}
          if (skel) skel.remove();
        };
        img.addEventListener('load', _reveal);
        img.addEventListener('error', _reveal);
        img.src = att.previewUrl || `/api/upload/${att.id}?thumb=1`;
        // Cached images can be complete before the load listener attaches.
        if (img.complete && img.naturalWidth) _reveal();
        // Failsafe: if neither load nor error fires within 8s, reveal anyway.
        // The timer is cleared on reveal AND when updateMessageAttachments
        // replaces the card (which scrubs the img / skel from the DOM), so
        // repeated re-renders don't accumulate stranded timers.
        if (!att.previewUrl) _revealTimer = setTimeout(_reveal, 8000);
        imgWrap.appendChild(img);

        if (att.id) {
          // Small corner button → opens the vision/OCR editor so the user can
          // correct what the vision model extracted. The edit is cached on the
          // server keyed by file id, so any later message referencing this same
          // image picks up the corrected text instead of re-running the model.
          const ocrBtn = document.createElement('button');
          ocrBtn.type = 'button';
          ocrBtn.className = 'attach-ocr-btn';
          ocrBtn.title = 'View / edit OCR text';
          ocrBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg><span class="attach-ocr-label">Caption</span>';
          ocrBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _openVisionEditor(att, ocrBtn.closest('.msg'));
          });
          imgWrap.appendChild(ocrBtn);
        }
      }

      if (att.vision_model) {
        const visionLabel = document.createElement('div');
        visionLabel.className = 'attach-vision-model';
        visionLabel.textContent = 'Vision: ' + String(att.vision_model).split('/').pop();
        imgWrap.appendChild(visionLabel);
      }
      if (att.name) {
        const label = document.createElement('div');
        label.className = 'attach-image-name';
        label.textContent = att.name;
        imgWrap.appendChild(label);
      }
      attachWrap.appendChild(imgWrap);
    } else {
      // Non-image file card
      const card = document.createElement('div');
      card.className = 'attach-card';
      card.dataset.name = att.name;
      if (att.id) {
        card.dataset.fileId = att.id;
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
          // PDFs & text/code/markdown → open in the Documents viewer
          // (others fall back to the raw file).
          if (window.chatModule?.openAttachment) window.chatModule.openAttachment(att, false);
          else window.open(`/api/upload/${att.id}`, '_blank');
        });
      }
      const icon = _attachIcon(att.mime || att.name);
      const nameSpan = document.createElement('span');
      nameSpan.className = 'attach-card-name';
      nameSpan.textContent = att.name;
      card.innerHTML = icon;
      card.appendChild(nameSpan);
      if (att.size) {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'attach-card-size';
        sizeSpan.textContent = _formatSize(att.size);
        card.appendChild(sizeSpan);
      }
      attachWrap.appendChild(card);
    }
  }
  return attachWrap;
}

// #828 — the SINGLE classification point for "is this bubble's WRAP an out-of-character
// producer/OOC aside?", shared by BOTH render paths so they can never drift again:
//   · the RELOAD/settled render (addMessage, below) — always used it.
//   · the LIVE stream (chat.js `_renderStream` / `_renderLiveStream`) — used to classify
//     ONLY on the next reload (chatRenderer.addMessage), so a live producer bubble painted
//     as a normal bubble until the page refreshed. chat.js now calls this on every live
//     delta too, so the wrap picks up `.msg-ooc`/`.msg-ooc-producer` the instant the text
//     resolves to a whole-message `((...))` wrap or a leading `ooc:` — identical to reload,
//     no refresh required.
// Returns `detectOocAside`'s verdict `{ ooc, text }` (`text` has the markers stripped when
// `ooc` is true) so a caller can feed the SAME marker-stripped text into `processWithThinking`
// — that keeps its own internal whole-wrap detection from ALSO firing and double-wrapping the
// body in `.ooc-producer-aside` (the live-only inner-div fallback for a case this can't yet
// classify, e.g. a still-open `((` mid-stream).
export function applyOocClass(wrap, rawText, role) {
  if (!wrap || !((role === 'user' || role === 'assistant')) || !isGameBuild()) {
    return { ooc: false, text: rawText };
  }
  const result = detectOocAside(rawText);
  wrap.classList.toggle('msg-ooc', result.ooc);
  wrap.classList.toggle('msg-ooc-producer', result.ooc && role === 'assistant');
  return result;
}

// OOC retro-styling (metadata half): a message classified OUT-OF-CHARACTER *after the fact* — the
// server marks the persisted row's metadata `ooc: true` — carries NO `((...))`/`ooc:` markers for
// `detectOocAside` to see, so the marker scan above can never style it. This is the SECOND (and
// only other) sanctioned classification input, shared by BOTH render paths so live and reload can
// never drift (the #828 discipline): the settled/reload render (addMessage) reads it off the row's
// metadata, and the reconcile ADOPT pass (chatReconcile.softReloadHistory) retro-applies it to the
// ALREADY-RENDERED bubble the moment the row's metadata is observed — no refresh required.
// DELIBERATELY additive-only: absent/false metadata never REMOVES a class the marker scan applied
// (the two inputs OR together), and classification itself stays server/model-side — this renders a
// server verdict, it never invents an OOC heuristic. Returns whether the class was applied.
export function applyOocClassFromMetadata(wrap, metadata, role) {
  if (!wrap || !((role === 'user' || role === 'assistant')) || !isGameBuild()) return false;
  if (!metadata || metadata.ooc !== true) return false;
  wrap.classList.add('msg-ooc');
  if (role === 'assistant') wrap.classList.add('msg-ooc-producer');
  return true;
}

// Re-render the attachment cards of an already-rendered message. Used to swap
// in real upload ids (and image thumbnails) on the optimistic user bubble once
// uploadPending() resolves — otherwise image previews only appear after a
// refresh, because the bubble is rendered before the upload assigns ids.
export function updateMessageAttachments(msgWrap, attachments) {
  if (!msgWrap || !attachments?.length) return;
  const body = msgWrap.querySelector('.body') || msgWrap;
  const existing = body.querySelector('.attach-cards');
  const fresh = buildAttachCards(attachments);
  if (existing) existing.replaceWith(fresh);
  else body.appendChild(fresh);
}

// Quick full-size preview when the user taps a chat photo thumbnail. Just an
// overlay with the original image centered — no Gallery panel, no editor.
function _openImageLightbox(att) {
  if (!att?.id) return;
  const overlay = document.createElement('div');
  overlay.className = 'attach-lightbox';
  // Show the cached thumb immediately so the overlay doesn't sit blank
  // while a 25MB original streams in. The full image swaps in once loaded;
  // if the full load fails (404 / network), we keep the thumb + show an
  // error label rather than a blank overlay forever.
  const img = document.createElement('img');
  img.alt = att.name || '';
  img.src = `/api/upload/${att.id}?thumb=1`;
  overlay.appendChild(img);
  const full = new Image();
  full.addEventListener('load', () => { img.src = full.src; });
  full.addEventListener('error', () => {
    const err = document.createElement('div');
    err.className = 'attach-lightbox-err';
    err.textContent = 'Failed to load full-resolution image.';
    overlay.appendChild(err);
  });
  full.src = `/api/upload/${att.id}`;

  const _onKey = (e) => { if (e.key === 'Escape') _close(); };
  const _close = () => {
    document.removeEventListener('keydown', _onKey);
    if (_overlayObs) { try { _overlayObs.disconnect(); } catch {} }
    overlay.remove();
  };
  // If the overlay is removed via any path other than our close handler
  // (session switch, parent re-render, external cleanup), still drop the
  // document-level keydown listener so it doesn't leak.
  let _overlayObs = null;
  try {
    _overlayObs = new MutationObserver(() => {
      if (!document.body.contains(overlay)) {
        document.removeEventListener('keydown', _onKey);
        _overlayObs.disconnect();
      }
    });
    _overlayObs.observe(document.body, { childList: true, subtree: false });
  } catch {}
  overlay.addEventListener('click', _close);
  document.addEventListener('keydown', _onKey);
  document.body.appendChild(overlay);
}

// Vision/OCR editor modal — opened from the corner "Aa" button on a chat photo
// thumbnail. Lets the user view and correct the text the vision model fed to
// the LLM (e.g. when OCR misreads a word). Persists to the server's vision
// cache (PUT /api/upload/{id}/vision), so any subsequent message that
// references the same file picks up the corrected text.
// #1638 KM-W9: migrated onto the shared window kit (OrwellWindowKit, modal:true).
// The kit OWNS the scrim + focus-trap + Escape (via the ui.js arbiter) + focus-
// return, so the bespoke `.vision-editor-overlay` scrim and the hand-rolled
// document-level Escape listener are retired here (folded into the kit's trap).
const VISION_WIN_ID = 'vision-editor';
// Eye icon matches the one in Settings → Vision so users recognise where this
// text originates. Rendered by the kit titlebar as the window's mono icon.
const _VISION_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
let _visionWin = null;
function _closeVisionEditor() {
  const w = _visionWin;
  _visionWin = null;
  if (w) { try { w.destroy(); } catch (_) {} }
}
function _openVisionEditor(att, userMsgEl) {
  if (!att?.id) return;
  if (!(window.OrwellWindowKit && window.OrwellWindowKit.create)) return; // kit not ready → fail open
  _closeVisionEditor();

  const panel = document.createElement('div');
  const desc = document.createElement('div');
  desc.style.cssText = 'font-size:12px;opacity:0.6;line-height:1.4;margin-bottom:8px;';
  desc.textContent = 'Edit text and save, new chats will have the new context. Regenerate or continue from there.';
  panel.appendChild(desc);
  const ta = document.createElement('textarea');
  ta.className = 'ow-input';
  ta.rows = 10;
  ta.style.cssText = 'width:100%;resize:vertical;box-sizing:border-box;';
  ta.placeholder = 'Loading…';
  ta.disabled = true;
  panel.appendChild(ta);
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ow-btn ow-btn-secondary';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', _closeVisionEditor);
  const _saveVisionText = async () => {
    const res = await fetch(`/api/upload/${att.id}/vision`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: ta.value }),
    });
    if (!res.ok) throw new Error('save failed');
  };
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'ow-btn ow-btn-prominent';
  saveBtn.textContent = 'Save';
  saveBtn.disabled = true;
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await _saveVisionText();
      if (uiModule?.showToast) uiModule.showToast('Saved');
      _closeVisionEditor();
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      if (uiModule?.showError) uiModule.showError('Failed to save OCR text');
    }
  });
  // Regenerate-message: save the edited text, close, then trigger a resend of
  // the user message so the new AI reply uses the edit immediately.
  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'ow-btn ow-btn-prominent';
  regenBtn.title = 'Save and regenerate the message';
  regenBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>Regenerate message</span>';
  regenBtn.disabled = true;
  regenBtn.addEventListener('click', async () => {
    regenBtn.disabled = true;
    saveBtn.disabled = true;
    try {
      await _saveVisionText();
      _closeVisionEditor();
      if (userMsgEl && window.chatModule?.resendUserMessage) {
        window.chatModule.resendUserMessage(userMsgEl);
      } else if (uiModule?.showToast) {
        uiModule.showToast('Saved');
      }
    } catch (e) {
      regenBtn.disabled = false;
      saveBtn.disabled = false;
      if (uiModule?.showError) uiModule.showError('Failed to save OCR text');
    }
  });
  actions.appendChild(closeBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(regenBtn);
  panel.appendChild(actions);

  _visionWin = window.OrwellWindowKit.create({
    id: VISION_WIN_ID,
    title: 'Vision text',
    icon: _VISION_ICON,
    modal: true,
    minimizable: false,
    resizable: false,
    minWidth: 440,
    content: panel,
    // The kit's × / Escape / scrim-dismiss all tear down through here; just
    // drop the reference (destroy already ran) so there is no double-teardown.
    onClose: () => { _visionWin = null; },
  });
  _visionWin.open();

  fetch(`/api/upload/${att.id}/vision`, { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : Promise.reject(r))
    .then(data => {
      ta.value = data.text || '';
      ta.placeholder = '';
      ta.disabled = false;
      saveBtn.disabled = false;
      regenBtn.disabled = !userMsgEl;
      ta.focus();
    })
    .catch(() => {
      ta.value = '';
      ta.placeholder = 'Could not load OCR text — type your correction and save.';
      ta.disabled = false;
      saveBtn.disabled = false;
      regenBtn.disabled = !userMsgEl;
    });
}

// Tool call syntax patterns to strip from displayed text
const TOOL_CALL_RE = /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi;
// Only strip fenced tool-call blocks that look like structured invocations, not regular code examples
const EXEC_FENCE_RE = /```(?:web_search|read_file|write_file|create_document|edit_document|update_document)\s*\n[\s\S]*?```/gi;
// XML-style tool calls: <minimax:tool_call>, <tool_call>, <function_call>, bare <invoke>
const XML_TOOL_CALL_RE = /<(?:[\w]+:)?(?:tool_call|function_call)>[\s\S]*?<\/(?:[\w]+:)?(?:tool_call|function_call)>/gi;
const XML_INVOKE_RE = /<invoke\s+name=['"][^'"]*['"]>[\s\S]*?<\/invoke>/gi;
// DeepSeek "DSML" tool-call markup (fullwidth-pipe ｜ or ascii | delimited) that
// leaks into content when the model emits a text tool call instead of a native
// one. Strip the whole block; the second pattern catches stray/partial tags
// (e.g. mid-stream before the closing tag arrives).
const DSML_TOOL_RE = /<\s*[｜|]+\s*DSML\s*[｜|]+\s*tool_calls\s*>[\s\S]*?(?:<\s*\/\s*[｜|]+\s*DSML\s*[｜|]+\s*tool_calls\s*>|$)/gi;
const DSML_STRAY_RE = /<\s*\/?\s*[｜|]+\s*DSML\s*[｜|]+[^>]*>/gi;
// Self-narration about tool results (model echoing stdout/exit_code)
const TOOL_NARRATION_RE = /(?:The (?:result|output) shows?:?\s*)?-?\s*(?:stdout|stderr|exit_code):\s*.+/gi;


// Model pricing table — per million tokens
// Model info: pricing (per 1M tokens) + context window length
const MODEL_INFO = {
  // --- Anthropic ---
  'claude-sonnet-4-5':    { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-sonnet-4-6':    { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-sonnet-4':      { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-opus-4':        { input: 15.00, output: 75.00, ctx: 200000 },
  'claude-opus-4-6':      { input: 15.00, output: 75.00, ctx: 200000 },
  'claude-haiku-4':       { input: 0.80,  output: 4.00,  ctx: 200000 },
  'claude-haiku-3-5':     { input: 0.80,  output: 4.00,  ctx: 200000 },
  'claude-3-5-sonnet':    { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-3-5-haiku':     { input: 0.80,  output: 4.00,  ctx: 200000 },
  'claude-3-opus':        { input: 15.00, output: 75.00, ctx: 200000 },
  'claude-3-sonnet':      { input: 3.00,  output: 15.00, ctx: 200000 },
  'claude-3-haiku':       { input: 0.25,  output: 1.25,  ctx: 200000 },
  // --- OpenAI ---
  'gpt-5':                { input: 2.00,  output: 8.00,  ctx: 400000 },
  'gpt-4.1':              { input: 2.00,  output: 8.00,  ctx: 1047576 },
  'gpt-4.1-mini':         { input: 0.40,  output: 1.60,  ctx: 1047576 },
  'gpt-4.1-nano':         { input: 0.10,  output: 0.40,  ctx: 1047576 },
  'gpt-4o':               { input: 2.50,  output: 10.00, ctx: 128000 },
  'gpt-4o-mini':          { input: 0.15,  output: 0.60,  ctx: 128000 },
  'gpt-4-turbo':          { input: 10.00, output: 30.00, ctx: 128000 },
  'o1':                   { input: 15.00, output: 60.00, ctx: 200000 },
  'o1-mini':              { input: 3.00,  output: 12.00, ctx: 128000 },
  'o1-pro':               { input: 150.0, output: 600.0, ctx: 200000 },
  'o3':                   { input: 2.00,  output: 8.00,  ctx: 200000 },
  'o3-mini':              { input: 1.10,  output: 4.40,  ctx: 200000 },
  'o4-mini':              { input: 1.10,  output: 4.40,  ctx: 200000 },
  // --- DeepSeek ---
  'deepseek-chat':        { input: 0.27,  output: 1.10,  ctx: 64000 },
  'deepseek-coder':       { input: 0.27,  output: 1.10,  ctx: 64000 },
  'deepseek-reasoner':    { input: 0.55,  output: 2.19,  ctx: 64000 },
  'deepseek-r1':          { input: 0.55,  output: 2.19,  ctx: 64000 },
  'deepseek-v3':          { input: 0.27,  output: 1.10,  ctx: 64000 },
  'deepseek-v2':          { input: 0.14,  output: 0.28,  ctx: 64000 },
  // --- Google ---
  'gemini-2.5-pro':       { input: 1.25,  output: 10.00, ctx: 1048576 },
  'gemini-2.5-flash':     { input: 0.15,  output: 0.60,  ctx: 1048576 },
  'gemini-2.0-flash':     { input: 0.10,  output: 0.40,  ctx: 1048576 },
  'gemini-1.5-pro':       { input: 1.25,  output: 5.00,  ctx: 1048576 },
  'gemini-1.5-flash':     { input: 0.075, output: 0.30,  ctx: 1048576 },
  'gemma-3':              { input: 0.10,  output: 0.10,  ctx: 128000 },
  // --- Mistral ---
  'mistral-large':        { input: 2.00,  output: 6.00,  ctx: 128000 },
  'mistral-medium':       { input: 2.00,  output: 6.00,  ctx: 32000 },
  'mistral-small':        { input: 0.20,  output: 0.60,  ctx: 32000 },
  'mistral-nemo':         { input: 0.15,  output: 0.15,  ctx: 128000 },
  'mixtral':              { input: 0.24,  output: 0.24,  ctx: 32000 },
  'codestral':            { input: 0.30,  output: 0.90,  ctx: 32000 },
  'pixtral':              { input: 2.00,  output: 6.00,  ctx: 128000 },
  // --- xAI ---
  'grok-4':               { input: 3.00,  output: 15.00, ctx: 131072 },
  'grok-3':               { input: 3.00,  output: 15.00, ctx: 131072 },
  'grok-2':               { input: 2.00,  output: 10.00, ctx: 131072 },
  // --- Meta ---
  'llama-4':              { input: 0.20,  output: 0.20,  ctx: 1048576 },
  'llama-3.3':            { input: 0.20,  output: 0.20,  ctx: 131072 },
  'llama-3.2':            { input: 0.20,  output: 0.20,  ctx: 131072 },
  'llama-3.1':            { input: 0.20,  output: 0.20,  ctx: 131072 },
  'llama-3':              { input: 0.20,  output: 0.20,  ctx: 131072 },
  // --- Qwen ---
  'qwen3':                { input: 0.30,  output: 1.20,  ctx: 131072 },
  'qwen2.5':              { input: 0.30,  output: 1.20,  ctx: 131072 },
  'qwq':                  { input: 0.30,  output: 1.20,  ctx: 32768 },
  // --- Cohere ---
  'command-a':            { input: 2.50,  output: 10.00, ctx: 256000 },
  'command-r-plus':       { input: 2.50,  output: 10.00, ctx: 128000 },
  'command-r':            { input: 0.15,  output: 0.60,  ctx: 128000 },
  // --- Perplexity ---
  'sonar-pro':            { input: 3.00,  output: 15.00, ctx: 200000 },
  'sonar':                { input: 1.00,  output: 1.00,  ctx: 128000 },
  // --- MiniMax ---
  'minimax':              { input: 0.70,  output: 0.70,  ctx: 1000000 },
  // --- Kimi / Moonshot ---
  'moonshot':             { input: 1.00,  output: 1.00,  ctx: 128000 },
  'kimi':                 { input: 1.00,  output: 1.00,  ctx: 128000 },
  // --- Microsoft ---
  'phi-4':                { input: 0.07,  output: 0.14,  ctx: 16000 },
  'phi-3':                { input: 0.07,  output: 0.14,  ctx: 128000 },
  // --- Nvidia ---
  'nemotron':             { input: 0.30,  output: 1.20,  ctx: 131072 },
  // --- Nous ---
  'hermes':               { input: 0.20,  output: 0.20,  ctx: 131072 },
};

// Compat alias
const MODEL_PRICING = MODEL_INFO;

// Image generation cost lookup (per-image, by model × quality × size)
const IMAGE_PRICING = {
  'gpt-image-1.5': { 'low': { '1024x1024': 0.009, '1024x1536': 0.013, '1536x1024': 0.013 }, 'medium': { '1024x1024': 0.034, '1024x1536': 0.05, '1536x1024': 0.05 }, 'high': { '1024x1024': 0.133, '1024x1536': 0.2, '1536x1024': 0.2 } },
  'gpt-image-1':   { 'low': { '1024x1024': 0.011, '1024x1536': 0.016, '1536x1024': 0.016 }, 'medium': { '1024x1024': 0.042, '1024x1536': 0.063, '1536x1024': 0.063 }, 'high': { '1024x1024': 0.167, '1024x1536': 0.25, '1536x1024': 0.25 } },
  'gpt-image-1-mini': { 'low': { '1024x1024': 0.005, '1024x1536': 0.006, '1536x1024': 0.006 }, 'medium': { '1024x1024': 0.011, '1024x1536': 0.015, '1536x1024': 0.015 }, 'high': { '1024x1024': 0.036, '1024x1536': 0.052, '1536x1024': 0.052 } },
};

export function shortModel(name) {
  if (!name) return '...';
  if (typeof name !== 'string') name = String(name);
  let short = name.split('/').pop();
  // Strip .gguf extension
  short = short.replace(/\.gguf$/i, '');
  // Strip quantization suffixes (Q4_K_M, Q8_0, etc.) and shard numbers
  short = short.replace(/-0000\d-of-\d+$/, '');
  short = short.replace(/[-_](Q\d[_A-Z\d]*|F16|F32|BF16|fp16|fp32)$/i, '');
  // Truncate if still too long (keep first meaningful part)
  if (short.length > 25) {
    // Try to find a natural break point (dash after model size like -35B or -7B)
    const sizeMatch = short.match(/^(.+?-\d+[BbMm])/);
    if (sizeMatch) short = sizeMatch[1];
    else short = short.substring(0, 22) + '…';
  }
  return short;
}

function modelValue(name) {
  if (name == null) return '';
  return String(name).trim();
}

export function sameModelName(left, right) {
  const a = modelValue(left);
  const b = modelValue(right);
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase()
    || shortModel(a).toLowerCase() === shortModel(b).toLowerCase();
}

export function modelRouteLabel(requestedModel, actualModel) {
  const requested = modelValue(requestedModel);
  const actual = modelValue(actualModel) || requested;
  if (!requested || sameModelName(requested, actual)) return shortModel(actual || requested);
  return shortModel(requested) + ' -> ' + shortModel(actual);
}

export function replyModelPair(modelName, metadata) {
  const meta = metadata || {};
  const actualFromMeta = modelValue(meta.model || meta.actual_model);
  const requestedFromMeta = modelValue(meta.requested_model || meta.selected_model);
  if (actualFromMeta || requestedFromMeta) {
    const actual = actualFromMeta || requestedFromMeta || modelValue(modelName);
    const requested = requestedFromMeta || actual;
    return { requestedModel: requested, actualModel: actual };
  }
  const fallback = modelValue(modelName);
  return { requestedModel: fallback, actualModel: fallback };
}

/**
 * Generate a consistent HSL color for a model name.
 * Returns an hsl() string. The hue is derived from a string hash,
 * saturation and lightness are fixed for readability on dark/light themes.
 */
export function modelColor(name) {
  if (!name) return null;
  const key = name.toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 65%)`;
}

/** Look up model info (pricing + context) by substring match */
export function getModelInfo(modelName) {
  if (!modelName) return null;
  const key = matchModelKey(modelName, Object.keys(MODEL_INFO));
  return key ? { key, ...MODEL_INFO[key] } : null;
}

function _fmtCtx(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  return Math.round(n / 1000) + 'K';
}

/**
 * Apply model color to a role element (sets color + dot color).
 */
export function applyModelColor(roleEl, modelName) {
  // C14/immersion + glass no-accent-on-text contract (#709): in the game build the assistant
  // role label is "Big Brother", and it must read as NORMAL neutral foreground — never a model
  // BRAND COLOR (which rendered the label yellow/gold). The provider logo + the click-to-info
  // popup are model-identity leaks too, so the whole treatment is suppressed here. The label
  // keeps the theme's default --fg ink (dark-on-light-glass under the frosted theme), exactly
  // like the rest of the chat chrome. Owner: "yellow is not the color I want for 'Big Brother'."
  if (typeof isGameBuild === 'function' && isGameBuild()) return;
  if (!modelName) return;
  const color = modelColor(modelName);
  if (color) {
    roleEl.style.color = color;
    roleEl.style.setProperty('--model-dot', color);
  }
  // Replace generic dot with provider logo if available
  const logo = providerLogo(modelName);
  const existingLogo = roleEl.querySelector('.role-provider-logo');
  if (!logo) {
    if (existingLogo) existingLogo.remove();
    roleEl.classList.remove('has-logo');
  } else if (!existingLogo) {
    const span = document.createElement('span');
    span.className = 'role-provider-logo';
    span.innerHTML = logo;
    roleEl.classList.add('has-logo');
    roleEl.prepend(span);
  }
  // Click to show model info popup
  if (!roleEl._hasInfoClick) {
    roleEl._hasInfoClick = true;
    roleEl.style.cursor = 'pointer';
    roleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      // Toggle: a second click on the role label closes the open popover.
      if (roleEl._owInfoPop && roleEl._owInfoPop.isOpen()) { roleEl._owInfoPop.close('toggle'); roleEl._owInfoPop = null; return; }
      if (!window.OrwellPopoverKit) return;
      const info = getModelInfo(modelName);
      const short = shortModel(modelName);
      const logoHtml = providerLogo(modelName);
      let html = '<div style="font-weight:600;margin-bottom:6px;color:var(--fg);display:flex;align-items:center;gap:6px;">';
      if (logoHtml) html += '<span class="role-provider-logo" style="opacity:0.7">' + logoHtml + '</span>';
      html += uiModule.esc(short) + '</div>';
      html += '<div><span class="ctx-label">Model</span> ' + uiModule.esc(modelName.split('/').pop()) + '</div>';
      // Provider = the serving endpoint, distinct from the model vendor/logo
      // (e.g. the same model via OpenRouter vs Copilot vs Anthropic direct).
      const _epUrl = (window.sessionModule && window.sessionModule.getCurrentEndpointUrl)
        ? window.sessionModule.getCurrentEndpointUrl() : null;
      const _provLabel = providerLabel(_epUrl);
      if (_provLabel) html += '<div><span class="ctx-label">Provider</span> ' + uiModule.esc(_provLabel) + '</div>';
      // Show static context initially, then fetch real from server
      const _realCtx = window._realContextLengths && window._realContextLengths[modelName];
      if (_realCtx) {
        html += '<div><span class="ctx-label">Context</span> ' + _fmtCtx(_realCtx) + ' tokens';
        if (info && info.ctx && info.ctx !== _realCtx) html += ' <span style="opacity:0.35">(spec: ' + _fmtCtx(info.ctx) + ')</span>';
        html += '</div>';
      } else if (info && info.ctx) {
        html += '<div><span class="ctx-label">Context</span> <span id="_ctx-val">' + _fmtCtx(info.ctx) + ' tokens</span></div>';
      }
      // Fetch real context from server async
      if (!_realCtx && window.sessionModule) {
        const _sid = window.sessionModule.getCurrentSessionId();
        if (_sid) {
          fetch('/api/session/' + _sid + '/context_info').then(r => r.ok ? r.json() : null).then(d => {
            if (d && d.context_length) {
              if (!window._realContextLengths) window._realContextLengths = {};
              window._realContextLengths[modelName] = d.context_length;
              const el = document.getElementById('_ctx-val');
              if (el) {
                el.innerHTML = _fmtCtx(d.context_length) + ' tokens';
                if (info && info.ctx && info.ctx !== d.context_length) {
                  el.innerHTML += ' <span style="opacity:0.35">(spec: ' + _fmtCtx(info.ctx) + ')</span>';
                }
              }
            }
          }).catch(() => {});
        }
      }
      // Show configured max tokens if set
      if (window.presetsModule) {
        const _pid = window.presetsModule.getSelectedPreset();
        const _preset = _pid ? window.presetsModule.getPreset(_pid) : null;
        const _mt = _preset?.max_tokens;
        if (_mt && _mt > 0 && _mt <= 8192) {
          html += '<div><span class="ctx-label">Max tokens</span> ' + _mt.toLocaleString() + ' <span style="opacity:0.4">(configured)</span></div>';
        }
      }
      if (info && info.input != null) html += '<div><span class="ctx-label">Input</span> $' + info.input.toFixed(2) + ' / 1M</div>';
      if (info && info.output != null) html += '<div><span class="ctx-label">Output</span> $' + info.output.toFixed(2) + ' / 1M</div>';
      if (!info) html += '<div style="opacity:0.4;font-size:0.85em;margin-top:4px;">No pricing data available</div>';
      // Mount on the shared OrwellPopover kit — the kit owns anchoring (flip/shift) + the
      // dismiss seat (outside-click + Escape). role='dialog' (informational), NOT a menu.
      const content = document.createElement('div');
      content.style.padding = '10px 14px';
      content.style.lineHeight = '1.7';
      content.innerHTML = html;
      roleEl._owInfoPop = window.OrwellPopoverKit.open({
        anchor: roleEl,
        role: 'dialog',
        ariaLabel: 'Model details',
        content,
        placement: 'bottom',
        align: 'start',
        onClose: () => { roleEl._owInfoPop = null; },
      });
    });
  }
}

export function getModelCost(modelName, inputTokens, outputTokens) {
  if (!modelName) return null;
  const key = matchModelKey(modelName, Object.keys(MODEL_PRICING));
  if (!key) return null;
  const price = MODEL_PRICING[key];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Is this endpoint a local / self-hosted model server (vLLM, Ollama, …)?
 * Local models are free, so we must NOT bill them at cloud rates — the
 * pricing table matches on a name substring, so a local `qwen2.5-coder`
 * would otherwise be charged like cloud `qwen2.5`. When the serving host is
 * loopback, a private LAN range, Tailscale CGNAT (100.64–100.127.x), a
 * `.local` name, or the app's own host, the model is local → free.
 * Unknown / missing endpoint also counts as local (bias to not over-bill).
 */
export function isLocalEndpoint(url) {
  if (!url) return true;
  let host;
  try { host = new URL(url).hostname; } catch (_e) { return true; }
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0' || host === 'host.docker.internal' || host.endsWith('.local')) return true;
  if (typeof window !== 'undefined' && window.location && host === window.location.hostname) return true;
  // A single-label hostname (no dot) is an internal/Docker service name
  // (e.g. "nim-nano", "llamaswap", "nemotron-super-49b") or a LAN shortname —
  // never a public API, which always needs an FQDN. Treat as local → free.
  // (Without this, container-name endpoints get billed at cloud rates because
  // the pricing table matches on a name substring, e.g. "nemotron".)
  if (!host.includes('.')) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  const cg = host.match(/^100\.(\d+)\./);            // Tailscale CGNAT
  if (cg && +cg[1] >= 64 && +cg[1] <= 127) return true;
  return false;
}

/** Cost for the current turn, returning null (free) for local endpoints. */
function _billableCost(model, inputTokens, outputTokens) {
  const url = (window.sessionModule && window.sessionModule.getCurrentEndpointUrl)
    ? window.sessionModule.getCurrentEndpointUrl() : null;
  if (isLocalEndpoint(url)) return null;
  return getModelCost(model, inputTokens, outputTokens);
}

export function getImageCost(model, quality, size) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [key, quals] of Object.entries(IMAGE_PRICING)) {
    if (m.includes(key)) {
      const q = quals[(quality || 'medium').toLowerCase()] || quals['medium'];
      return q ? (q[size] || q['1024x1024'] || null) : null;
    }
  }
  return null;
}

/* ── Session cost helpers ─────────────────────────────────────────── */
const _COST_KEY = 'ody-session-cost';

/** Return the accumulated cost for the current (or given) session. */
export function getSessionCost(sessionId) {
  const sid = sessionId || (window.sessionModule && window.sessionModule.getCurrentSessionId());
  if (!sid) return 0;
  try {
    const costs = JSON.parse(localStorage.getItem(_COST_KEY) || '{}');
    return costs[sid] || 0;
  } catch (_e) { return 0; }
}

/** Reset session cost for the given session (defaults to current). */
export function resetSessionCost(sessionId) {
  const sid = sessionId || (window.sessionModule && window.sessionModule.getCurrentSessionId());
  if (!sid) return;
  try {
    const costs = JSON.parse(localStorage.getItem(_COST_KEY) || '{}');
    delete costs[sid];
    localStorage.setItem(_COST_KEY, JSON.stringify(costs));
  } catch (_e) { /* ignore */ }
  updateSessionCostUI();
}

/** Update the persistent session-cost badge in the input bar. */
export function updateSessionCostUI() {
  const el = document.getElementById('session-cost-display');
  if (!el) return;
  // Local model? It's free — hide the badge and clear any stale cost that a
  // previous (buggy) cloud-rate billing left in localStorage for this session.
  const _url = (window.sessionModule && window.sessionModule.getCurrentEndpointUrl)
    ? window.sessionModule.getCurrentEndpointUrl() : null;
  if (isLocalEndpoint(_url)) {
    const sid = window.sessionModule && window.sessionModule.getCurrentSessionId();
    if (sid && getSessionCost(sid) > 0) {
      try {
        const costs = JSON.parse(localStorage.getItem(_COST_KEY) || '{}');
        delete costs[sid];
        localStorage.setItem(_COST_KEY, JSON.stringify(costs));
      } catch (_e) { /* ignore */ }
    }
    el.style.display = 'none';
    return;
  }
  const cost = getSessionCost();
  if (cost > 0) {
    el.textContent = '$' + (cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2));
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

/** Create a timestamp span for role labels.
 * Pass an ISO string / Date / epoch-ms to render the message's own time
 * (used when replaying history). Falls back to "now" when no value is given.
 *
 * M2-6 — in a live game, pass the beat's IN-WORLD `moment` string
 * ("Week 1 · Eviction night · Late night", from `metadata.game_moment`) as the second
 * arg: it becomes the PRIMARY stamp and the real wall clock is demoted to the hover
 * `title` (kept as metadata on `dataset.wallClock`). Absent/blank moment (pre-game /
 * casting) ⇒ the neutral wall-clock stamp (prior behavior). */
export function roleTimestamp(when, moment) {
  const ts = document.createElement('span');
  ts.className = 'role-timestamp';
  let d;
  if (when instanceof Date) d = when;
  else if (typeof when === 'number') d = new Date(when);
  else if (typeof when === 'string' && when) d = new Date(when);
  else d = new Date();
  if (isNaN(d.getTime())) d = new Date();
  const wall = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  if (typeof moment === 'string' && moment.trim()) {
    // In-world moment leads; the wall clock is demoted to hover/metadata.
    ts.textContent = moment.trim();
    ts.classList.add('role-timestamp-moment');
    ts.title = d.toLocaleString();
    ts.dataset.wallClock = wall;
  } else {
    ts.textContent = wall;
    ts.title = d.toLocaleString();
  }
  return ts;
}

/**
 * Strip tool invocation blocks from text before rendering.
 */
export function stripToolBlocks(text) {
  let cleaned = text.replace(TOOL_CALL_RE, '');
  cleaned = cleaned.replace(EXEC_FENCE_RE, '');
  cleaned = cleaned.replace(DSML_TOOL_RE, '');
  cleaned = cleaned.replace(DSML_STRAY_RE, '');
  cleaned = cleaned.replace(XML_TOOL_CALL_RE, '');
  cleaned = cleaned.replace(XML_INVOKE_RE, '');
  cleaned = cleaned.replace(TOOL_NARRATION_RE, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

/**
 * Build a collapsible sources box (used by both research and web search).
 */
export function buildSourcesBox(sources, type, expanded) {
  var esc = uiModule.esc;
  var id = 'sources-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  var count = sources.length;
  var label = type === 'research' ? 'Research sources' : 'Web sources';
  var lines = '';
  for (var i = 0; i < count; i++) {
    var s = sources[i];
    var domain = '';
    try { domain = new URL(s.url).hostname.replace('www.', ''); } catch(e) { domain = s.url; }
    var title = esc(s.title || domain || '');
    var safeUrl = _safeHref(s.url);
    lines += '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" class="source-link">'
      + '<span class="source-num">' + (i + 1) + '</span>'
      + '<span class="source-title">' + title + '</span>'
      + '<span class="source-domain">' + esc(domain) + '</span>'
      + '</a>';
  }
  var arrow = expanded ? 'down' : 'right';
  var expandedClass = expanded ? ' expanded' : '';
  return '<div class="sources-section">'
    + '<div class="sources-header" data-sources-id="' + id + '" onclick="window.toggleSources(\'' + id + '\')">'
    + '<div class="sources-header-left">' + SEARCH_ICON + '<span>' + count + ' ' + label + '</span></div>'
    + '<span class="sources-toggle" id="' + id + '-toggle" data-arrow="' + arrow + '"></span>'
    + '</div>'
    + '<div class="sources-content' + expandedClass + '" id="' + id + '">'
    + '<div class="sources-content-inner">' + lines + '</div>'
    + '</div></div>';
}

/**
 * Build the RAG "Sources (N documents)" box — mirrors the live render in
 * chat.js so persisted rag_sources survive a refresh. Items carry a
 * filename, similarity %, and snippet (not URLs, unlike web sources).
 * @param {Array<{filename, similarity, snippet}>} sources
 */
export function buildRagSourcesBox(sources) {
  if (!sources || !sources.length) return '';
  var esc = uiModule.esc;
  var items = '';
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i] || {};
    var pct = (typeof s.similarity === 'number') ? (s.similarity * 100).toFixed(1) + '%' : '';
    items += '<div class="rag-source-item"><strong>' + esc(s.filename || '') + '</strong>'
      + (pct ? ' <span class="rag-similarity">' + pct + '</span>' : '')
      + '<div class="rag-snippet">' + esc(s.snippet || '') + '</div></div>';
  }
  return '<details class="rag-sources"><summary>Sources (' + sources.length + ' documents)</summary>' + items + '</details>';
}

/**
 * Build a collapsible "Raw collected findings" section, styled like the sources box.
 * @param {Array<{url, title, summary}>} findings
 * @param {boolean} [expanded=false]
 */
export function buildFindingsBox(findings, expanded) {
  if (!findings || !findings.length) return '';
  var esc = uiModule.esc;
  var id = 'findings-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  var count = findings.length;
  var lines = '';
  for (var i = 0; i < count; i++) {
    var f = findings[i];
    var domain = '';
    try { domain = new URL(f.url).hostname.replace('www.', ''); } catch(e) { domain = f.url; }
    var title = esc(f.title || domain || '');
    var summary = esc(f.summary || '');
    var safeUrl = _safeHref(f.url);
    lines += '<div class="finding-item">'
      + '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" class="source-link">'
      + '<span class="source-num">' + (i + 1) + '</span>'
      + '<span class="source-title">' + title + '</span>'
      + '<span class="source-domain">' + esc(domain) + '</span>'
      + '</a>'
      + '<div class="finding-summary">' + summary + '</div>'
      + '</div>';
  }
  var FINDINGS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  var arrow = expanded ? 'down' : 'right';
  var expandedClass = expanded ? ' expanded' : '';
  return '<div class="sources-section">'
    + '<div class="sources-header" data-sources-id="' + id + '" onclick="window.toggleSources(\'' + id + '\')">'
    + '<div class="sources-header-left">' + FINDINGS_ICON + '<span>' + count + ' Raw collected findings</span></div>'
    + '<span class="sources-toggle" id="' + id + '-toggle" data-arrow="' + arrow + '"></span>'
    + '</div>'
    + '<div class="sources-content' + expandedClass + '" id="' + id + '">'
    + '<div class="sources-content-inner">' + lines + '</div>'
    + '</div></div>';
}

/** Append report button + continue research prompt. */
export function appendReportButton(container, sessionId) {
  _appendReportButton(container, sessionId);
  _appendContinuePrompt(container);
}

function _appendContinuePrompt(container) {
  var wrap = document.createElement('div');
  wrap.className = 'continue-research-wrap';
  wrap.innerHTML =
    '<div class="continue-research-hint">'
    + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>'
    + '<span>Dig deeper? Activate Research again and type a follow-up question to continue this research.</span>'
    + '</div>';
  container.appendChild(wrap);
}
function _appendReportButton(container, sessionId) {
  var apiBase = window.API_BASE || '';

  // Wrapper holds report button + chat-about button
  var wrap = document.createElement('div');
  wrap.className = 'report-btn-wrap';

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'view-report-btn';
  btn.innerHTML = REPORT_ICON + ' Open Visual Report';

  var reportUrl = apiBase + '/api/research/report/' + sessionId;
  btn.addEventListener('click', function() {
    window.open(reportUrl, '_blank');
  });
  wrap.appendChild(btn);

  var chatBtn = document.createElement('button');
  chatBtn.type = 'button';
  chatBtn.className = 'view-report-btn chat-about-btn';
  chatBtn.innerHTML = CHAT_ABOUT_ICON + ' Discuss';
  chatBtn.addEventListener('click', async function() {
    if (chatBtn.disabled) return;
    var origLabel = chatBtn.innerHTML;
    chatBtn.disabled = true;
    chatBtn.innerHTML = CHAT_ABOUT_ICON + ' Creating…';
    try {
      var res = await fetch(apiBase + '/api/research/spinoff/' + sessionId, { method: 'POST' });
      if (!res.ok) {
        var detail = '';
        try { detail = (await res.json()).detail || ''; } catch {}
        throw new Error(detail || ('HTTP ' + res.status));
      }
      var payload = await res.json();
      if (window.sessionModule && payload.session_id) {
        await window.sessionModule.loadSessions().catch(() => {});
        await window.sessionModule.selectSession(payload.session_id);
      }
    } catch (e) {
      chatBtn.disabled = false;
      chatBtn.innerHTML = origLabel;
      if (window.uiModule && uiModule.showError) {
        uiModule.showError('Could not start follow-up chat: ' + e.message);
      } else {
        alert('Could not start follow-up chat: ' + e.message);
      }
    }
  });
  wrap.appendChild(chatBtn);

  container.appendChild(wrap);
}

window.toggleSources = function(id) {
  // Debounce to prevent double-fire from both inline onclick and delegation
  var now = Date.now();
  if (window._lastSourcesToggle && now - window._lastSourcesToggle < 100) return;
  window._lastSourcesToggle = now;

  var content = document.getElementById(id);
  var toggle = document.getElementById(id + '-toggle');
  if (content && toggle) {
    var expanded = content.classList.contains('expanded');
    content.classList.toggle('expanded', !expanded);
    toggle.dataset.arrow = expanded ? 'right' : 'down';
  }
};

// Event delegation for sources toggle (capture phase, handles SVG targets)
document.addEventListener('click', function(e) {
  // Walk up from target manually to handle SVG elements that may not support closest()
  var el = e.target;
  while (el && el !== document) {
    if (el.classList && el.classList.contains('sources-header') && el.dataset && el.dataset.sourcesId) {
      e.stopPropagation();
      window.toggleSources(el.dataset.sourcesId);
      return;
    }
    el = el.parentElement || el.parentNode;
  }
}, true);

// Jump-to-entity anchors — the agent emits links like
//   [New Chat](#session-89effa28)
//   [Notes](#document-abc123)
//   [Reminder](#note-42)
// and the chat-history click delegate turns them into navigation
// instead of default in-page anchor jumps. Each prefix routes to the
// matching module via a dynamic import (avoids circular deps —
// sessions.js itself imports chatRenderer.js).
document.addEventListener('click', function(e) {
  // Walk past Text nodes — clicking link text yields a Text node target
  // whose .closest is undefined, so preventDefault never fires and the
  // browser performs a default hash-navigation that resets the session.
  let _t = e.target;
  while (_t && _t.nodeType === Node.TEXT_NODE) _t = _t.parentElement;
  const a = _t && _t.closest && _t.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (!href.startsWith('#')) return;
  // Game build (feature 0032): only session links remain — the workspace
  // content verticals (document/note/image/email/event/task/skill/research)
  // are removed, so their anchor routings are gone with them.
  const m = href.match(/^#(session)-(.+)$/);
  if (!m) return;
  e.preventDefault();
  e.stopPropagation();
  const [, kind, id] = m;
  if (kind === 'session') {
    import('./sessions.js').then(mod => {
      const fn = mod.selectSession || (mod.default && mod.default.selectSession);
      if (fn) fn(id);
    });
  }
});

/**
 * Build a generated-image bubble element.
 */
export function buildImageBubble(imageUrl, prompt, model, size, quality, imageId) {
  var esc = uiModule.esc;
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-ai generated-image-wrap';

  const role = document.createElement('div');
  role.className = 'role';
  // Immersion: image bubbles (in-character portraits) never show the raw image-model name.
  role.textContent = isGameBuild() ? gameNarrator() : (model || 'image').split('/').pop();
  wrap.appendChild(role);

  const body = document.createElement('div');
  body.className = 'body';

  const safeImageUrl = safeDisplayImageSrc(imageUrl);
  if (!safeImageUrl) {
    body.textContent = '[Image unavailable]';
    wrap.appendChild(body);
    return wrap;
  }

  const img = document.createElement('img');
  img.className = 'generated-image';
  img.alt = prompt || 'Generated image';
  img.title = prompt || 'Generated image';
  img.src = safeImageUrl;
  img.addEventListener('click', () => { window.open(safeImageUrl, '_blank', 'noopener,noreferrer'); });
  body.appendChild(img);

  if (prompt) {
    const caption = document.createElement('div');
    caption.className = 'generated-image-caption';
    caption.textContent = prompt;
    body.appendChild(caption);
  }

  wrap.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'msg-footer';

  const actions = document.createElement('span');
  actions.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'footer-copy-btn';
  copyBtn.type = 'button';
  copyBtn.title = 'Copy prompt';
  copyBtn.innerHTML = COPY_ICON;
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    uiModule.copyToClipboard(prompt || '');
    copyBtn.innerHTML = CHECK_ICON;
    setTimeout(() => { copyBtn.innerHTML = COPY_ICON; }, 1500);
  });
  actions.appendChild(copyBtn);

  const dlBtn = document.createElement('button');
  dlBtn.className = 'footer-copy-btn';
  dlBtn.type = 'button';
  dlBtn.title = 'Download image';
  dlBtn.textContent = '\u2913';
  dlBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (prompt || 'image').slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '') + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      dlBtn.textContent = '\u2713';
      setTimeout(() => { dlBtn.textContent = '\u2913'; }, 1500);
    } catch { dlBtn.textContent = '\u2717'; setTimeout(() => { dlBtn.textContent = '\u2913'; }, 1500); }
  });
  actions.appendChild(dlBtn);

  // Game build (feature 0032): the image editor (Gallery) vertical is removed,
  // so no "edit in image editor" action — generated images remain copyable,
  // downloadable, and removable inline.

  const delBtn = document.createElement('button');
  delBtn.className = 'footer-copy-btn footer-delete-btn';
  delBtn.type = 'button';
  delBtn.title = 'Delete image';
  delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await uiModule.styledConfirm('Delete this image?', {
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    // If we have a gallery id, delete server-side; otherwise just remove
    // the bubble from chat (e.g. external DALL-E url that wasn't saved).
    if (imageId) {
      try {
        const res = await fetch(`/api/gallery/${encodeURIComponent(imageId)}`, {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (!res.ok && res.status !== 404) {
          uiModule.showToast?.('Delete failed', 4000);
          return;
        }
        window.dispatchEvent(new CustomEvent('gallery-refresh'));
      } catch (_) {
        uiModule.showToast?.('Delete failed', 4000);
        return;
      }
    }
    wrap.remove();
  });
  actions.appendChild(delBtn);

  footer.appendChild(actions);

  const metrics = document.createElement('span');
  metrics.className = 'response-metrics';
  const parts = [];
  if (model) parts.push(model.split('/').pop());
  if (size) parts.push(size);
  if (quality) parts.push(quality);
  const cost = getImageCost(model, quality, size);
  if (cost !== null) parts.push('$' + (cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)));
  metrics.textContent = parts.join(' \u00B7 ');
  footer.appendChild(metrics);

  wrap.appendChild(footer);
  return wrap;
}

export function hideWelcomeScreen() {
  const ws = document.getElementById('welcome-screen');
  const cc = document.getElementById('chat-container');
  if (ws) ws.classList.add('hidden');
  if (cc) cc.classList.remove('welcome-active');
  // Update send button — switches from muted arrow to + Chat
  if (window._updateSendBtnIcon) setTimeout(window._updateSendBtnIcon, 50);
  const ib = document.getElementById('incognito-btn');
  if (ib) ib.style.display = ib.classList.contains('active') ? '' : 'none';
}

// OWN-1 (2026-07-14 theme audit §9) — the ONE shared "transcript has content" seam.
// hideWelcomeScreen historically fired only from addMessage (history renders) and a few
// explicit call sites, but several live paths mount bubbles DIRECTLY into #chat-history
// without addMessage: the live streaming holder (chat.js handleChatSubmit), the CASTING
// kickoff's hidden-cue stream (the player bubble is deliberately suppressed, so nothing
// routed through addMessage), the WS mirror splice (chatWsSplice.js _wsEnsureRound), and
// the resume/poll fallbacks (sessions.js _checkServerStream). On those paths the welcome
// hero stayed mounted and its wordmark/tagline/tips ghosted through the translucent glass
// bubbles while the conversation streamed (owner screenshot). Rather than patching every
// mount site, this observer watches #chat-history childList: the moment ANY message bubble
// (.msg) exists while the hero is still up, the hero hides. It is hide-only by design — it
// never re-SHOWS welcome; an empty chat gets its welcome only via the explicit
// showWelcomeScreen calls that follow a transcript clear.
let _welcomeSyncBox = null;
export function ensureWelcomeContentSync() {
  const box = document.getElementById('chat-history');
  if (!box || box === _welcomeSyncBox) return;
  _welcomeSyncBox = box;
  const sync = () => {
    try {
      if (!box.querySelector('.msg')) return;
      const ws = document.getElementById('welcome-screen');
      const cc = document.getElementById('chat-container');
      const heroUp = (ws && !ws.classList.contains('hidden')) ||
                     (cc && cc.classList.contains('welcome-active'));
      if (heroUp) hideWelcomeScreen();
    } catch (_) { /* the belt must never break a render */ }
  };
  new MutationObserver(sync).observe(box, { childList: true });
  sync(); // content may already be mounted when the observer arms (resumed transcript)
}
// Arm at module init (DOM-ready-safe; chatRenderer loads as a deferred module so the node
// normally exists already). Guarded so a non-browser evaluation of this file stays inert.
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { try { ensureWelcomeContentSync(); } catch (_) {} }, { once: true });
  } else {
    try { ensureWelcomeContentSync(); } catch (_) {}
  }
}

export function showWelcomeScreen() {
  const ws = document.getElementById('welcome-screen');
  const cc = document.getElementById('chat-container');
  // FE-render #7 + OWN-1 (2026-07-14 theme audit §9): never paint the welcome hero over a
  // non-empty transcript. This guard began scoped to the casting→game cutover
  // (window._orwellCastingTransition — createCharacter fires mid-stream, opening a fresh
  // session while the still-finalizing tool beat / casting card keeps the OLD transcript
  // mounted), but the same ghosting hit the casting STREAM itself: the hero's wordmark/
  // tagline/tips bled through the translucent glass bubbles whenever a show call raced a
  // live render. So the guard is now UNCONDITIONAL — any real bubble (.msg) in
  // #chat-history suppresses the splash. Every legitimate "blank to welcome" caller clears
  // #chat-history BEFORE calling this, so a genuinely empty chat still gets its welcome
  // (pinned by tests/test_own1_welcome_hide.py; the FE-render #7 story is pinned by
  // tests/test_g15_gamechanged.py).
  const _box = document.getElementById('chat-history');
  if (_box && _box.querySelector('.msg')) return;
  if (ws) ws.classList.remove('hidden');
  if (cc) cc.classList.add('welcome-active');
  // Entering the New Chat / welcome state: discard any stale draft left in the
  // composer from the previous session so the input starts empty (issue #1343).
  // Switching between existing sessions loads them directly and does NOT call
  // this, so genuine drafts are not erased. Reset the autosized height and fire
  // an `input` event so the send button + autosize listeners update.
  const _msg = document.getElementById('message');
  if (_msg) {
    _msg.value = '';
    _msg.style.height = '';
    _msg.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // Re-trigger the L→R clip-wipe reveal on the welcome name each time the
  // welcome screen is shown (new session, deleted last session, etc.) — without
  // this, the CSS animation only fires on initial DOM insertion.
  const wn = document.querySelector('.welcome-name');
  if (wn) {
    wn.style.animation = 'none';
    // force reflow so the next assignment registers as a new animation
    void wn.offsetHeight;
    wn.style.animation = '';
  }
  // Update send button — switches from + Chat to muted arrow on empty session
  if (window._updateSendBtnIcon) setTimeout(window._updateSendBtnIcon, 50);
  const ib = document.getElementById('incognito-btn');
  const _researchChk = document.getElementById('research-toggle');
  if (ib && !(_researchChk && _researchChk.checked)) ib.style.display = '';
  if (!isNarrow()) {
    const msg = document.getElementById('message');
    if (msg) msg.focus();
  }
}

// ── Dynamic action buttons (show 3 most recent, rest under ···) ──
const _ACTION_RECENTS_KEY = 'orwell-msg-actions-recent';
const _MAX_VISIBLE = 2;

function _getRecentActions() {
  try { return JSON.parse(localStorage.getItem(_ACTION_RECENTS_KEY) || '[]'); } catch { return []; }
}
function _trackAction(id) {
  let recent = _getRecentActions().filter(x => x !== id);
  recent.unshift(id);
  if (recent.length > 10) recent.length = 10;
  localStorage.setItem(_ACTION_RECENTS_KEY, JSON.stringify(recent));
}

/**
 * Create a footer row for an AI message with timestamp and action buttons.
 */
export function createMsgFooter(msgElement) {
  const footer = document.createElement('div');
  footer.className = 'msg-footer';

  const actions = document.createElement('span');
  actions.className = 'msg-actions';

  // Define all available actions: { id, icon, title, className, handler }
  const allActions = [
    { id: 'copy', icon: COPY_ICON, title: 'Copy message', cls: 'footer-copy-btn', html: true, handler(e) {
      e.stopPropagation();
      const btn = e.currentTarget;
      uiModule.copyToClipboard(msgElement.dataset.raw || msgElement.querySelector('.body')?.textContent || '');
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => { btn.innerHTML = COPY_ICON; }, 1500);
    }},
    { id: 'edit', icon: '\u270E', title: 'Edit', cls: 'msg-action-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.editAIMessage) window.chatModule.editAIMessage(msgElement);
    }},
    { id: 'regen', icon: '\u21BB', title: document.body.hasAttribute('data-game-build') ? 'Re-narrate' : 'Regenerate from here', cls: 'msg-action-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.regenerateFrom) window.chatModule.regenerateFrom(msgElement);
    }},
    { id: 'shorten', icon: '\u2702', title: 'Rewrite shorter', cls: 'msg-action-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.rewriteWith) window.chatModule.rewriteWith(msgElement, 'Rewrite your last response to be shorter and more concise. Keep the key information but cut the fluff.');
    }},
    { id: 'explain', icon: '?', title: 'Explain simpler', cls: 'msg-action-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.rewriteWith) window.chatModule.rewriteWith(msgElement, 'Explain your last response in simpler terms. Use plain language and short sentences.');
    }},
    { id: 'fork', icon: '\u2ADD', title: 'Fork conversation', cls: 'msg-action-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.forkFrom) window.chatModule.forkFrom(msgElement);
    }},
    { id: 'delete', icon: '\u2715', title: 'Delete message', cls: 'msg-action-btn msg-delete-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.deleteMessage) window.chatModule.deleteMessage(msgElement);
    }},
  ];

  // E93 + owner ruling: the chat transcript of a game is the PLAYED RECORD of events the
  // engine has already recorded and folded — editing, deleting, or re-rolling it desyncs the
  // visible story from the EventStore (and edit-then-regenerate is an anti-sycophancy hole).
  // The record-altering + general-assistant utility actions (edit, regenerate, rewrite-shorter,
  // explain-simpler, fork, delete) are chatbot cruft here, NOT in-character play. So in the GAME
  // BUILD, GM/narration messages keep Copy + Re-narrate (the regen action, relabeled — re-rolls
  // the narration prose for the SAME engine beat) plus the Speak/TTS button (added separately by
  // chat.js). Outside the game build (full workspace) the complete set stands.
  const _gameBuild = document.body.hasAttribute('data-game-build');
  const _GAME_KEEP = new Set(['copy', 'regen']);
  const actionPool = _gameBuild ? allActions.filter(a => _GAME_KEEP.has(a.id)) : allActions;

  // Filter out unavailable actions (e.g. TTS when not enabled)
  const availableActions = actionPool.filter(a => !a.available || a.available());

  // Determine which 3 to show: use recent order, fallback to defaults
  const recent = _getRecentActions();
  const defaults = ['copy', 'delete', 'fork'];
  const order = recent.length > 0 ? recent : defaults;
  const sorted = [...availableActions].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return 0;
  });
  const visible = sorted.slice(0, _MAX_VISIBLE);
  const overflow = sorted.slice(_MAX_VISIBLE);

  // Render visible buttons
  function _addBtn(action, container) {
    const btn = _makeActionBtn(action.cls, action.title, action.html ? '' : action.icon, (e) => {
      _trackAction(action.id);
      action.handler(e);
    });
    if (action.html) btn.innerHTML = action.icon;
    btn.dataset.action = action.id;
    container.appendChild(btn);
  }

  visible.forEach(a => _addBtn(a, actions));

  // Overflow "···" button
  if (overflow.length > 0) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'msg-action-btn msg-more-btn';
    moreBtn.type = 'button';
    moreBtn.title = 'More actions';
    moreBtn.textContent = '\u00B7\u00B7\u00B7';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // #1638: anchored OrwellMenuKit menu — the kit owns flip/shift positioning (prefer-up,
      // auto-flip-down when clipped, right-clamp), dismissal through the shared escMenuStack seat
      // (outside-click + the Escape arbiter), and role=menu/menuitem roving-keyboard nav.
      // Toggle: a second click on the same ··· closes its open menu.
      if (moreBtn._owMenu && moreBtn._owMenu.isOpen()) {
        moreBtn._owMenu.close('toggle');
        moreBtn._owMenu = null;
        return;
      }
      if (!window.OrwellMenuKit) return;
      moreBtn._owMenu = window.OrwellMenuKit.open({
        anchor: moreBtn,
        placement: 'top',
        align: 'start',
        ariaLabel: 'Message actions',
        items: overflow.map((a) => ({
          label: a.title,
          icon: a.icon,
          onSelect: (item, ev) => { _trackAction(a.id); a.handler(ev); },
        })),
        onClose: () => { moreBtn._owMenu = null; },
      });
    });
    actions.appendChild(moreBtn);
  }

  // Memory-used indicator pill
  const mems = msgElement._memoriesUsed;
  if (mems && mems.length > 0) {
    const pill = document.createElement('button');
    pill.className = 'memory-used-pill';
    pill.type = 'button';
    const pinnedCount = mems.filter(m => m.type === 'pinned').length;
    const recalledCount = mems.filter(m => m.type === 'recalled').length;
    const parts = [];
    if (pinnedCount) parts.push(`${pinnedCount} pinned`);
    if (recalledCount) parts.push(`${recalledCount} recalled`);
    pill.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.8-3.5 6-.3.2-.5.5-.5.9V18h-6v-2.1c0-.4-.2-.7-.5-.9C6.3 13.8 5 11.5 5 9a7 7 0 0 1 7-7z"/><path d="M9 18h6v1a3 3 0 0 1-6 0v-1z"/><path d="M12 2v7"/><path d="M8.5 6.5L12 9l3.5-2.5"/></svg><span class="memory-used-pill-text">${parts.join(', ')}</span>`;
    pill.title = mems.map(m => `[${m.type}] ${m.text}`).join('\n');

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      let detail = pill._openDetail || document.querySelector('.memory-used-detail');
      if (detail) {
        if (typeof detail._dismiss === 'function') detail._dismiss();
        else { detail.remove(); pill._openDetail = null; }
        return;
      }
      detail = document.createElement('div');
      detail.className = 'memory-used-detail';
      let closeDetail = () => { detail.remove(); pill._openDetail = null; };
      mems.forEach(m => {
        const row = document.createElement('div');
        row.className = 'memory-used-row';
        row.style.cursor = 'pointer';
        row.title = 'Click to open memory manager';
        const badge = document.createElement('span');
        badge.className = 'memory-used-badge ' + (m.type === 'pinned' ? 'pinned' : 'recalled');
        badge.textContent = m.type === 'pinned' ? '\u25CF' : '\u21BB';
        const text = document.createElement('span');
        text.className = 'memory-used-text';
        text.textContent = m.text;
        row.appendChild(badge);
        row.appendChild(text);
        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeDetail();
          const memModal = document.getElementById('memory-modal');
          if (memModal) memModal.classList.remove('hidden');
        });
        detail.appendChild(row);
      });
      detail.style.visibility = 'hidden';
      document.body.appendChild(detail);
      const pillRect = pill.getBoundingClientRect();
      const detailRect = detail.getBoundingClientRect();
      const spaceAbove = pillRect.top;
      const spaceBelow = window.innerHeight - pillRect.bottom;
      if (spaceAbove >= detailRect.height + 8 || spaceAbove > spaceBelow) {
        detail.style.top = (pillRect.top - detailRect.height - 8) + 'px';
      } else {
        detail.style.top = (pillRect.bottom + 8) + 'px';
      }
      detail.style.left = pillRect.left + 'px';
      if (pillRect.left + detailRect.width > window.innerWidth - 8) {
        detail.style.left = (window.innerWidth - detailRect.width - 8) + 'px';
      }
      if (parseFloat(detail.style.left) < 8) detail.style.left = '8px';
      detail.style.visibility = '';
      pill._openDetail = detail;
      // Close on outside click or Escape (pill click toggles, so it's inside).
      closeDetail = bindMenuDismiss(detail, () => { detail.remove(); pill._openDetail = null; }, (ev) => !detail.contains(ev.target) && ev.target !== pill);    });

    footer.appendChild(pill);
  }

  footer.appendChild(actions);
  return footer;
}

/**
 * Create a footer row for a user message with action buttons (same system as AI footer).
 */
const _USER_ACTION_RECENTS_KEY = 'orwell-user-actions-recent';

function _getUserRecentActions() {
  try { return JSON.parse(localStorage.getItem(_USER_ACTION_RECENTS_KEY) || '[]'); } catch { return []; }
}
function _trackUserAction(id) {
  let recent = _getUserRecentActions().filter(x => x !== id);
  recent.unshift(id);
  if (recent.length > 10) recent.length = 10;
  localStorage.setItem(_USER_ACTION_RECENTS_KEY, JSON.stringify(recent));
}

export function createUserMsgFooter(msgElement) {
  const footer = document.createElement('div');
  footer.className = 'msg-footer';

  const actions = document.createElement('span');
  actions.className = 'msg-actions';

  const allActions = [
    { id: 'edit', icon: '\u270E', title: 'Edit message', cls: 'msg-action-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.editUserMessage) window.chatModule.editUserMessage(msgElement);
    }},
    { id: 'delete', icon: '\u2715', title: 'Delete message', cls: 'msg-action-btn msg-delete-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.deleteMessage) window.chatModule.deleteMessage(msgElement);
    }},
    { id: 'copy', icon: COPY_ICON, title: 'Copy message', cls: 'footer-copy-btn', html: true, handler(e) {
      e.stopPropagation();
      const btn = e.currentTarget;
      uiModule.copyToClipboard(msgElement.querySelector('.body')?.textContent || '');
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => { btn.innerHTML = COPY_ICON; }, 1500);
    }},
    { id: 'resend', icon: '\u21BB', title: 'Resend message', cls: 'msg-action-btn', handler(e) {
      e.stopPropagation();
      if (window.chatModule?.resendUserMessage) window.chatModule.resendUserMessage(msgElement);
    }},
  ];

  // OWNER RULING (liquid-glass follow-up): NIX the per-message action icons on SENT (player)
  // bubbles entirely. Under the glass theme the lone "Copy" glyph rendered gray/illegible on the
  // blue fill, and the played-record model (E93) already strips the record-altering actions
  // (edit/delete/resend) — so the sent side carries NO action buttons in the game build. RECEIVED
  // / GM messages keep their actions (createMsgFooter, unchanged). Outside the game build (full
  // workspace) the complete set still stands.
  const userPool = document.body.hasAttribute('data-game-build') ? [] : allActions;

  const recent = _getUserRecentActions();
  const defaults = ['edit', 'delete', 'copy'];
  const order = recent.length > 0 ? recent : defaults;
  const sorted = [...userPool].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return 0;
  });
  const visible = sorted.slice(0, _MAX_VISIBLE);
  const overflow = sorted.slice(_MAX_VISIBLE);

  visible.forEach(a => {
    const btn = _makeActionBtn(a.cls, a.title, a.html ? '' : a.icon, (ev) => {
      _trackUserAction(a.id);
      a.handler(ev);
    });
    if (a.html) btn.innerHTML = a.icon;
    btn.dataset.action = a.id;
    actions.appendChild(btn);
  });

  if (overflow.length > 0) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'msg-action-btn msg-more-btn';
    moreBtn.type = 'button';
    moreBtn.title = 'More actions';
    moreBtn.textContent = '\u00B7\u00B7\u00B7';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // #1638: anchored OrwellMenuKit menu (see the received-message twin above) — the kit owns
      // flip/shift positioning, escMenuStack dismissal, and role=menu roving-keyboard nav.
      // Toggle: a second click on the same ··· closes its open menu.
      if (moreBtn._owMenu && moreBtn._owMenu.isOpen()) {
        moreBtn._owMenu.close('toggle');
        moreBtn._owMenu = null;
        return;
      }
      if (!window.OrwellMenuKit) return;
      moreBtn._owMenu = window.OrwellMenuKit.open({
        anchor: moreBtn,
        placement: 'top',
        align: 'start',
        ariaLabel: 'Message actions',
        items: overflow.map((a) => ({
          label: a.title,
          icon: a.icon,
          onSelect: (item, ev) => { _trackUserAction(a.id); a.handler(ev); },
        })),
        onClose: () => { moreBtn._owMenu = null; },
      });
    });
    actions.appendChild(moreBtn);
  }

  footer.appendChild(actions);
  return footer;
}

/**
 * Display performance metrics for a message.
 */
export function displayMetrics(messageElement, metrics) {
  const existingMetrics = messageElement.querySelector('.response-metrics');
  if (existingMetrics) existingMetrics.remove();
  // J1-22 / Issue 1: the tok/s + context-% strip is an OUT-OF-CHARACTER dev artifact — a raw model
  // metric ("38.57 tok/s · 12% context") breaks the Big Brother fiction, and the context reading
  // confuses players (esp. right after a factory reset). Never render it in the game build; the full
  // workspace still shows it.
  if (document.body && document.body.hasAttribute('data-game-build')) return;

  const metricsContainer = document.createElement('span');
  metricsContainer.className = 'response-metrics';

  const responseTime = metrics.response_time;
  const inputTokens = metrics.input_tokens || 0;
  const outputTokens = metrics.output_tokens || 0;
  const tps = metrics.tokens_per_second;
  const isReal = metrics.usage_source === 'real';
  const ctxPct = metrics.context_percent;
  const model = metrics.model || 'Unknown';
  const cost = _billableCost(model, inputTokens, outputTokens);

  // Nothing useful to show — bail out (only if ALL metrics are missing)
  if (!responseTime && !outputTokens && tps == null && !ctxPct) return;

  // Accumulate session cost (only on fresh metrics, not history reload)
  if (!metrics._fromHistory) {
    const _sid = window.sessionModule && window.sessionModule.getCurrentSessionId();
    if (_sid && cost !== null) {
      try {
        const _costs = JSON.parse(localStorage.getItem(_COST_KEY) || '{}');
        _costs[_sid] = (_costs[_sid] || 0) + cost;
        localStorage.setItem(_COST_KEY, JSON.stringify(_costs));
      } catch (_e) { /* ignore */ }
      updateSessionCostUI();
    }
  }

  // Default: show tok/s if available, else fall back to other stats
  const costStr0 = cost !== null ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}` : null;
  const metricsLabel = tps != null && tps !== 'undefined'
    ? `${tps} tok/s`
    : costStr0
      ? `${outputTokens} tok · ${costStr0}`
      : outputTokens
        ? `${outputTokens} tok · ${responseTime != null ? responseTime + 's' : ''}`
        : responseTime != null
          ? `${responseTime}s`
          : '';
  if (!metricsLabel) return;
  metricsContainer.textContent = metricsLabel;
  metricsContainer.style.cursor = 'pointer';
  metricsContainer.title = 'Click for details';
  const metricsDivider = document.createElement('span');
  metricsDivider.textContent = ' | ';
  metricsDivider.style.color = 'var(--color-muted-alt)';
  metricsDivider.style.pointerEvents = 'none';
  metricsContainer.addEventListener('click', (e) => {
    e.stopPropagation();
    // Toggle: a second click on the metrics text closes the open popover.
    if (metricsContainer._owStatsPop && metricsContainer._owStatsPop.isOpen()) { metricsContainer._owStatsPop.close('toggle'); metricsContainer._owStatsPop = null; return; }
    if (!window.OrwellPopoverKit) return;

    const costStr = cost !== null ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}` : 'n/a';
    const speedStr = tps != null && tps !== 'undefined' ? `${tps} tok/s` : 'n/a';
    const totalTok = inputTokens + outputTokens;
    const ctxColor = ctxPct >= 85 ? 'var(--red, #e06c75)' : ctxPct >= 70 ? '#ff9900' : 'var(--color-muted-alt, #6b7280)';
    const prepTime = metrics.agent_prep_time;
    const modelWaitTime = metrics.agent_model_wait_time;
    const prepBreakdown = metrics.agent_prep_breakdown || null;
    const prepDetails = prepBreakdown
      ? Object.entries(prepBreakdown).map(([k, v]) => `${k}: ${v}s`).join('<br>')
      : '';

    // Session total cost
    let sessionCostStr = '';
    const sc = getSessionCost();
    if (sc > 0) {
      sessionCostStr = `<div><span class="ctx-label">Session</span> $${sc < 0.01 ? sc.toFixed(4) : sc.toFixed(3)}</div>`;
    }

    const popup = document.createElement('div');
    popup.style.padding = '10px 14px';
    popup.style.lineHeight = '1.7';
    popup.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;color:var(--fg);">Message Stats</div>
      <div><span class="ctx-label">Model</span> ${uiModule.esc(model.split('/').pop())}</div>
      <div><span class="ctx-label">Input</span> ${inputTokens.toLocaleString()} tokens${isReal ? '' : '~'}</div>
      <div><span class="ctx-label">Output</span> ${outputTokens.toLocaleString()} tokens${isReal ? '' : '~'}</div>
      <div><span class="ctx-label">Total</span> ${totalTok.toLocaleString()} tokens</div>
      <div><span class="ctx-label">Speed</span> ${speedStr}</div>
      <div><span class="ctx-label">Time</span> ${responseTime}s</div>
      ${prepTime != null ? `<div><span class="ctx-label">Prep</span> ${prepTime}s</div>` : ''}
      ${modelWaitTime != null ? `<div><span class="ctx-label">Model wait</span> ${modelWaitTime}s</div>` : ''}
      <div><span class="ctx-label">Cost</span> ${costStr}</div>
      ${sessionCostStr}
      ${prepDetails ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);font-size:0.85em;opacity:0.8;">
        <div style="font-weight:600;margin-bottom:4px;color:var(--fg);">Agent prep</div>
        ${prepDetails}
      </div>` : ''}
      ${ctxPct !== undefined && ctxPct > 0 ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);">
        <span class="ctx-label">Context</span> <span style="color:${ctxColor};font-weight:600;">${ctxPct}%</span> used
      </div>` : ''}
      ${isReal ? '' : '<div style="margin-top:4px;font-size:0.8em;opacity:0.4;">~ estimated token count</div>'}
    `;

    // Mount on the shared OrwellPopover kit — it owns anchoring (prefer above, flip on
    // overflow) + the dismiss seat. role='dialog' (informational stats), NOT a menu.
    metricsContainer._owStatsPop = window.OrwellPopoverKit.open({
      anchor: metricsContainer,
      role: 'dialog',
      ariaLabel: 'Message stats',
      content: popup,
      placement: 'top',
      align: 'start',
      onClose: () => { metricsContainer._owStatsPop = null; },
    });
  });

  // Store real context length for model info popup
  if (metrics.context_length && metrics.model) {
    if (!window._realContextLengths) window._realContextLengths = {};
    window._realContextLengths[metrics.model] = metrics.context_length;
  }

  // Context usage ring
  let ctxRing = null;
  const ctxLen = metrics.context_length || 0;
  if (ctxPct !== undefined && ctxPct > 0) {
    const r = 6, stroke = 1.5;
    const circ = 2 * Math.PI * r;
    const fill = circ * (ctxPct / 100);
    const ctxColor = ctxPct >= 85 ? 'var(--red, #e06c75)' : ctxPct >= 70 ? '#ff9900' : 'var(--green, #98c379)';
    ctxRing = document.createElement('span');
    ctxRing.className = 'ctx-ring';
    ctxRing.title = `${ctxPct}% context used — click for details`;
    ctxRing.style.cursor = 'pointer';
    ctxRing.style.setProperty('--ctx-color', ctxColor);
    ctxRing.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="${r}" fill="none" stroke="var(--border, #333)" stroke-width="${stroke}" opacity="0.3"/>
      <circle cx="7" cy="7" r="${r}" fill="none" stroke="var(--ctx-stroke)" stroke-width="${stroke}"
        stroke-dasharray="${fill} ${circ - fill}" stroke-dashoffset="${circ * 0.25}"
        stroke-linecap="round" transform="rotate(-90 7 7)"/>
    </svg><span class="ctx-ring-pct">${Math.round(ctxPct)}%</span>`;

    ctxRing.addEventListener('click', (e) => {
      e.stopPropagation();
      // Toggle: a second click on the ring closes the open popover.
      if (ctxRing._owCtxPop && ctxRing._owCtxPop.isOpen()) { ctxRing._owCtxPop.close('toggle'); ctxRing._owCtxPop = null; return; }
      if (!window.OrwellPopoverKit) return;

      const usedTokens = inputTokens || 0;
      const totalCtx = ctxLen || 0;
      const modelShort = uiModule.esc(model.split('/').pop());
      const fmtNum = n => n ? n.toLocaleString() : '?';

      const popup = document.createElement('div');
      popup.style.padding = '12px 14px';
      popup.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px;color:var(--fg);">Context Window</div>
        <div class="ctx-bar-wrap">
          <div class="ctx-bar-fill" style="width:${Math.min(ctxPct, 100)}%;background:${ctxColor};"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-top:4px;opacity:0.6;">
          <span>${fmtNum(usedTokens)} used</span>
          <span>${fmtNum(totalCtx)} total</span>
        </div>
        <div style="margin-top:8px;font-size:0.8rem;">
          <div><span class="ctx-label">Model</span> ${modelShort}</div>
          <div><span class="ctx-label">Usage</span> <span style="color:${ctxColor};font-weight:600;">${ctxPct}%</span></div>
          <div><span class="ctx-label">Window</span> ${fmtNum(totalCtx)} tokens</div>
        </div>
        ${ctxPct >= 70 && !isGameBuild() ? `<button class="ctx-compact-btn" title="Summarize older messages to free up context">Compact context</button>` : ''}
      `;

      const compactBtn = popup.querySelector('.ctx-compact-btn');
      if (compactBtn) {
        compactBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const sid = window.sessionModule && window.sessionModule.getCurrentSessionId();
          if (!sid) return;
          if (ctxRing._owCtxPop) ctxRing._owCtxPop.close('compact'); else popup.remove();

          // Add a spinner bubble at the bottom of chat
          const chatBox = document.getElementById('chat-history');
          if (!chatBox) return;
          const compactMsg = document.createElement('div');
          compactMsg.className = 'msg msg-ai';
          const compactRole = document.createElement('div');
          compactRole.className = 'role';
          compactRole.textContent = 'Orwell';
          const compactBody = document.createElement('div');
          compactBody.className = 'body';
          compactBody.innerHTML = 'Compacting context <span class="compact-wave">▁▂▃▅▂▁</span>';
          compactMsg.appendChild(compactRole);
          compactMsg.appendChild(compactBody);
          chatBox.appendChild(compactMsg);
          chatBox.scrollTop = chatBox.scrollHeight;

          // Animate the wave
          const waveFrames = ['▁▂▃▅▂▁', '▂▃▅▃▂▁', '▃▅▃▂▁▂', '▅▃▂▁▂▃', '▃▂▁▂▃▅', '▂▁▂▃▅▃'];
          let frame = 0;
          const waveEl = compactBody.querySelector('.compact-wave');
          const waveInterval = setInterval(() => {
            frame = (frame + 1) % waveFrames.length;
            if (waveEl) waveEl.textContent = waveFrames[frame];
          }, 150);

          try {
            const res = await fetch(window.location.origin + '/api/session/' + sid + '/compact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            });
            clearInterval(waveInterval);
            if (res.ok) {
              const data = await res.json();
              // Reload session — the compacted history will show
              if (window.sessionModule) await window.sessionModule.selectSession(sid);
              // Scroll to the compacted message (first msg with compacted metadata)
              setTimeout(() => {
                const msgs = document.querySelectorAll('#chat-history .msg');
                for (const m of msgs) {
                  if (m.querySelector('.body')?.textContent.includes('Conversation compacted')) {
                    m.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    break;
                  }
                }
              }, 200);
            } else {
              let detail = 'Compaction failed. Try again later.';
              try {
                const err = await res.json();
                if (err.detail) detail = err.detail;
              } catch {}
              compactBody.textContent = detail;
              compactBody.style.color = 'var(--red)';
            }
          } catch (err) {
            clearInterval(waveInterval);
            console.warn('compact failed:', err);
            compactBody.innerHTML = '<span style="color:var(--red);">Compaction failed: ' + err.message + '</span>';
          }
        });
      }

      // Mount on the shared OrwellPopover kit — above the ring, right-aligned (align:'end'),
      // flip on overflow. role='dialog'; the kit owns anchoring + the dismiss seat.
      ctxRing._owCtxPop = window.OrwellPopoverKit.open({
        anchor: ctxRing,
        role: 'dialog',
        ariaLabel: 'Context window',
        content: popup,
        placement: 'top',
        align: 'end',
        minWidth: 220,
        maxWidth: 280,
        onClose: () => { ctxRing._owCtxPop = null; },
      });
    });
  }

  let footer = messageElement.querySelector('.msg-footer');
  if (footer) {
    const actions = footer.querySelector('.msg-actions');
    if (actions) {
      footer.insertBefore(metricsDivider, actions);
      footer.insertBefore(metricsContainer, metricsDivider);
    } else {
      footer.appendChild(metricsContainer);
      footer.appendChild(metricsDivider);
    }
    if (ctxRing) {
      const ctxDiv = document.createElement('span');
      ctxDiv.textContent = ' | ';
      ctxDiv.style.color = 'var(--color-muted-alt)';
      ctxDiv.style.pointerEvents = 'none';
      ctxDiv.className = 'ctx-divider';
      footer.appendChild(ctxDiv);
      footer.appendChild(ctxRing);
    }
  } else {
    messageElement.appendChild(metricsContainer);
    if (ctxRing) messageElement.appendChild(ctxRing);
  }

  if (uiModule) uiModule.scrollHistory();
}

// ─────────────────────────────────────────────────────────────────────────────
// #1413-RENDER-MODEL-START  (feature #1413 / R2 · ADR-0015 — collapse the duplicated
// live-vs-reload chat SETTLE render into one seam)
//
// `toRenderModel(input)` normalizes a SETTLED assistant turn — from EITHER the reload path
// (`source: 'history'`, the persisted `{role, content, modelName, metadata}` that `addMessage`
// receives) OR the live-finalize path (`source: 'live'`, the stream state chat.js holds at settle) —
// onto ONE normalized "settled message" model. Both adapters normalize to the SAME canonical
// `{role, content, modelName, metadata}` and DERIVE the structural fields (rounds / reasoning /
// sources / …) from it, so the derived model is EQUAL by construction whenever the canonical
// matches: "live == reload by construction" (ADR-0015). `renderAssistantMessage` then funnels the
// model's canonical fields to the ONE canonical builder (`addMessage`), so a live finalize and a
// history reload of the SAME turn paint identical DOM.
//
// These functions are DELIBERATELY pure — no DOM, no markdown, no ui — so they are Node-sliceable
// and unit-tested (frontend/tests/test_1413_render_model.py asserts the history and live adapters
// produce an EQUAL model for the same turn). The live adapter is defined + proven equal here; wiring
// the chat.js sender finalize through `renderAssistantMessage(toRenderModel({source:'live', …}))` is
// S3 — DEFERRED (that reroute is where the F5 mirror-parity risk lives; see the PR notes).
// ─────────────────────────────────────────────────────────────────────────────

// Reconstruct the per-round structure from the canonical turn. Mirrors addMessage's multi-bubble
// grouping (round default 1; a text round is "last" when no later round carries text). A turn with
// no tool events is a single round carrying the whole content.
function _rm_deriveRounds(content, metadata) {
  const toolEvents = (metadata && metadata.tool_events) || [];
  if (toolEvents.length > 0) {
    const roundTexts = (metadata && metadata.round_texts) || [];
    const toolsByRound = {};
    for (const ev of toolEvents) {
      const r = ev.round || 1;
      (toolsByRound[r] = toolsByRound[r] || []).push(ev);
    }
    let maxRound = roundTexts.length;
    for (const k of Object.keys(toolsByRound)) maxRound = Math.max(maxRound, Number(k));
    const rounds = [];
    for (let r = 0; r < maxRound; r++) {
      const txt = (roundTexts[r] || '').trim();
      let isLastTextRound = true;
      for (let rr = r + 1; rr < maxRound; rr++) {
        if ((roundTexts[rr] || '').trim()) { isLastTextRound = false; break; }
      }
      rounds.push({ text: txt, tools: toolsByRound[r + 1] || [], isLastTextRound: isLastTextRound });
    }
    return rounds;
  }
  return [{ text: String(content == null ? '' : content), tools: [], isLastTextRound: true }];
}

function _rm_deriveReasoning(metadata) {
  if (metadata && metadata.thinking) {
    return { text: metadata.thinking, timeMs: metadata.thinking_time != null ? metadata.thinking_time : null };
  }
  return null;
}

function _rm_deriveSources(metadata) {
  if (!metadata) return null;
  if (metadata.research_sources && metadata.research_sources.length) {
    return { kind: 'research', items: metadata.research_sources };
  }
  if (metadata.web_sources && metadata.web_sources.length) {
    return { kind: 'web', items: metadata.web_sources };
  }
  return null;
}

// Build the canonical {role, content, modelName, metadata} for a live-finalized assistant turn,
// matching exactly what /api/history persists + reloads for the same turn (so the reload adapter,
// fed that persisted shape, derives the identical model). Pure.
function _rm_liveToCanonical(live) {
  const rnds = live.rounds || [];
  const round_texts = rnds.map(function (r) { return r.replyText != null ? r.replyText : ''; });
  const tool_events = [];
  rnds.forEach(function (r, i) {
    (r.tools || []).forEach(function (ev) {
      const withRound = { round: i + 1 };
      for (const k in ev) { if (Object.prototype.hasOwnProperty.call(ev, k)) withRound[k] = ev[k]; }
      tool_events.push(withRound);
    });
  });
  const content = live.content != null ? live.content
    : round_texts.filter(function (t) { return t && t.trim(); }).join('\n\n');
  const reasoningText = live.reasoningText != null ? live.reasoningText
    : rnds.map(function (r) { return r.reasoningText || ''; }).filter(Boolean).join('\n\n');
  const metadata = {};
  if (tool_events.length) { metadata.tool_events = tool_events; metadata.round_texts = round_texts; }
  if (reasoningText) {
    metadata.thinking = reasoningText;
    if (live.thinkingTimeMs != null) metadata.thinking_time = live.thinkingTimeMs;
  }
  if (live.sources) {
    if (live.sources.kind === 'research') metadata.research_sources = live.sources.items;
    else metadata.web_sources = live.sources.items;
  }
  if (live.findings) metadata.research_findings = live.findings;
  if (live.ragSources) metadata.rag_sources = live.ragSources;
  if (live.timestamp != null) metadata.timestamp = live.timestamp;
  if (live.dbId != null) metadata._db_id = live.dbId;
  if (live.seq != null) metadata._seq = live.seq;
  if (live.clientMsgId != null) metadata.client_msg_id = live.clientMsgId;
  if (live.stopped) metadata.stopped = true;
  if (live.cancelled) metadata.cancelled = true;
  if (live.memoriesUsed) metadata.memories_used = live.memoriesUsed;
  return {
    role: 'assistant',
    content: content,
    modelName: live.actualModel != null ? live.actualModel : null,
    metadata: metadata,
    rawForPersistence: live.rawForPersistence != null ? live.rawForPersistence : content,
    ooc: !!live.ooc,
  };
}

export function toRenderModel(input) {
  input = input || {};
  let role, content, modelName, metadata, rawForPersistence, ooc;
  if (input.source === 'live') {
    const norm = _rm_liveToCanonical(input);
    role = norm.role; content = norm.content; modelName = norm.modelName;
    metadata = norm.metadata; rawForPersistence = norm.rawForPersistence; ooc = norm.ooc;
  } else {
    role = input.role != null ? input.role : 'assistant';
    content = input.content;
    modelName = input.modelName != null ? input.modelName : null;
    metadata = input.metadata || {};
    rawForPersistence = input.rawForPersistence != null ? input.rawForPersistence
      : (typeof content === 'string' ? content : '');
    ooc = !!input.ooc;
  }
  metadata = metadata || {};
  return {
    role: role,
    // Canonical passthrough — the ONLY thing renderAssistantMessage feeds to addMessage, so the
    // render stays byte-identical to a direct reload.
    raw: {
      role: role, content: content, modelName: modelName, metadata: metadata,
      rawForPersistence: rawForPersistence, ooc: ooc,
    },
    // Derived structural model — the contract the equality test pins; source-agnostic.
    rounds: _rm_deriveRounds(content, metadata),
    reasoning: _rm_deriveReasoning(metadata),
    sources: _rm_deriveSources(metadata),
    findings: (metadata.research_findings && metadata.research_findings.length) ? metadata.research_findings : null,
    ragSources: (metadata.rag_sources && metadata.rag_sources.length) ? metadata.rag_sources : null,
    model: {
      requested: metadata.requested_model != null ? metadata.requested_model : (modelName != null ? modelName : null),
      actual: metadata.model != null ? metadata.model : (modelName != null ? modelName : null),
    },
    timestamp: metadata.timestamp != null ? metadata.timestamp : null,
    dbId: metadata._db_id != null ? metadata._db_id : null,
    seq: metadata._seq != null ? metadata._seq : null,
    clientMsgId: metadata.client_msg_id != null ? metadata.client_msg_id : null,
    stopped: !!metadata.stopped,
    cancelled: !!metadata.cancelled,
    edited: !!metadata.edited,
    variants: (metadata.variants && metadata.variants.length) ? metadata.variants : null,
    variantIndex: metadata.variantIndex != null ? metadata.variantIndex : null,
    memoriesUsed: (metadata.memories_used && metadata.memories_used.length) ? metadata.memories_used : null,
  };
}
// #1413-RENDER-MODEL-END

/**
 * Render a settled ASSISTANT turn from a normalized render model (#1413 / R2 · ADR-0015).
 *
 * The model-typed front door BOTH the reload path and (S3, deferred) the live-finalize path funnel
 * through: it hands the model's canonical `{role, content, modelName, metadata}` to the ONE canonical
 * builder, `addMessage`, so a live finalize and a history reload of the same turn paint IDENTICAL
 * DOM ("live == reload by construction"). Pure DOM: no session/subscribe/selectSession/resumeStream
 * side-effects — it only builds bubbles. (S3 will additionally carry the model's `rawForPersistence`
 * onto the settled bubble's `dataset.raw`; the reload path derives that from the persisted text.)
 */
export function renderAssistantMessage(model) {
  const raw = (model && model.raw) || {};
  return addMessage(raw.role != null ? raw.role : 'assistant', raw.content, raw.modelName, raw.metadata);
}

/**
 * Chyron persistence: the announcements a stored turn carries — the engine's Vault-free `BeatAnnouncementView`s that
 * reached the client OWED (pre-resolve / stateDelta; stored as `metadata.announcements`) first, then the ones riding
 * a persisted advanceGame/submitDecision tool result (re-derived from its stored output), in order, deduped by id.
 * Repainted after the turn's bubble by `OrwellChyron.renderAfter` so a reload shows the same cards in the same place.
 */
function storedAnnouncements(metadata) {
  const out = [];
  const seen = new Set();
  const take = (list) => {
    if (!Array.isArray(list)) return;
    for (const a of list) {
      if (a && typeof a === 'object' && a.id && !seen.has(a.id)) { seen.add(a.id); out.push(a); }
    }
  };
  if (!metadata) return out;
  take(metadata.announcements);
  const evs = Array.isArray(metadata.tool_events) ? metadata.tool_events : [];
  for (const ev of evs) {
    if (!ev || (ev.tool !== 'advanceGame' && ev.tool !== 'submitDecision') || typeof ev.output !== 'string') continue;
    try { take((JSON.parse(ev.output) || {}).announcements); } catch (_) { /* a truncated/non-JSON output carries none */ }
  }
  return out;
}

function repaintStoredChyrons(metadata, anchor) {
  try {
    const list = storedAnnouncements(metadata);
    if (list.length && window.OrwellChyron && window.OrwellChyron.renderAfter) window.OrwellChyron.renderAfter(list, anchor);
  } catch (_) { /* fail open — the cards are an augmentation of the chat, never a reload blocker */ }
}

/**
 * Add a message to the chat history.
 */
export function addMessage(role, content, modelName, metadata) {
  try {
    hideWelcomeScreen();
    const box = document.getElementById('chat-history');
    if (!box) { console.error('Chat history element not found'); return; }

    var esc = uiModule.esc;
    const textRaw = Array.isArray(content) ? markdownModule.renderContent(content) : content;

    // --- Agent multi-bubble reconstruction from saved metadata ---
    if (role === 'assistant' && metadata && metadata.tool_events && metadata.tool_events.length > 0) {
      const roundTexts = metadata.round_texts || [];
      const toolEvents = metadata.tool_events;
      let lastWrap = null;
      let firstMsgAi = null;
      let lastMsgAi = null;
      // #834: role + timestamp attach to the FIRST VISIBLE bubble of the turn, NOT strictly
      // round 0. When round 0 is a hidden tool-call (e.g. getGameState — empty txt, no bubble),
      // the first rendered bubble is a later round; it must still carry the role+timestamp header
      // (and NOT read as a continuation), or the received message shows no timestamp.
      let renderedFirstVisible = false;

      const toolsByRound = {};
      for (const ev of toolEvents) {
        const r = ev.round || 1;
        if (!toolsByRound[r]) toolsByRound[r] = [];
        toolsByRound[r].push(ev);
      }

      const maxRound = Math.max(...Object.keys(toolsByRound).map(Number), roundTexts.length);

      for (let r = 0; r < maxRound; r++) {
        const roundNum = r + 1;
        const txt = (roundTexts[r] || '').trim();

        // Check if this is the last text round — sources go on top of final response.
        // (Hoisted: L6b also gates the whole bubble on it in the game build.)
        var isLastTextRound = true;
        for (let rr = r + 1; rr < maxRound; rr++) {
          if ((roundTexts[rr] || '').trim()) { isLastTextRound = false; break; }
        }

        // L6c (supersedes L6b): every NON-EMPTY text round renders on reload — a multi-line
        // interview / scene accumulates, matching the live path. The old rule kept only the
        // FINAL narration round, which lost a multi-line casting interview on reload ("4 answers
        // go away"). Empty tool-only rounds carry no `txt` and are skipped by the guard below;
        // their tools still render as production beats. `isLastTextRound` is retained for
        // source/findings placement (web_sources/research/rag) further down. Non-game UNCHANGED.
        const _gbSkipIntermediateText = false;

        if (txt && !_gbSkipIntermediateText) {
          // #834: the FIRST visible bubble of the turn owns the role+timestamp header and is
          // NOT a continuation, even when earlier rounds were hidden tool-calls.
          const isFirstVisible = !renderedFirstVisible;
          const wrap = document.createElement('div');
          wrap.className = 'msg msg-ai' + (isFirstVisible ? '' : ' msg-continuation');
          const roleEl = document.createElement('div');
          roleEl.className = 'role';
          const pair = replyModelPair(modelName, metadata);
          const contModel = pair.actualModel || pair.requestedModel;
          // C14/immersion: never render the raw LLM model name as the sender in the game
          // build — the narrator is the show (matches the live path's _setRoleModelLabel).
          roleEl.textContent = isGameBuild() ? gameNarrator() : modelRouteLabel(pair.requestedModel, contModel);
          // C14/immersion: the "alias -> dated-version" tooltip is a model-name leak too —
          // suppressed in the game build (mirrors the live path's _setRoleModelLabel).
          if (!isGameBuild() && pair.requestedModel && contModel && !sameModelName(pair.requestedModel, contModel)) {
            roleEl.title = pair.requestedModel + ' -> ' + contModel;
          }
          applyModelColor(roleEl, contModel);
          if (isFirstVisible) roleEl.appendChild(roleTimestamp(metadata?.timestamp, metadata?.game_moment));
          wrap.appendChild(roleEl);
          const body = document.createElement('div');
          body.className = 'body';
          // Sources go on top of the final response.
          var agentSourcesPrefix = '';
          var agentFindingsSuffix = '';
          if (isLastTextRound && metadata?.web_sources?.length) {
            agentSourcesPrefix = buildSourcesBox(metadata.web_sources, 'web');
          } else if (isLastTextRound && metadata?.research_sources?.length) {
            agentSourcesPrefix = buildSourcesBox(metadata.research_sources, 'research');
          }
          if (isLastTextRound && metadata?.research_findings?.length) {
            agentFindingsSuffix = buildFindingsBox(metadata.research_findings);
          }
          // RAG document sources — restored on the final text round.
          if (isLastTextRound && metadata?.rag_sources?.length) {
            agentFindingsSuffix += buildRagSourcesBox(metadata.rag_sources);
          }
          body.innerHTML = agentSourcesPrefix + markdownModule.processWithThinking(markdownModule.squashOutsideCode(txt)) + agentFindingsSuffix;
          wrap.appendChild(body);
          wrap.dataset.raw = txt;
          if (metadata?._db_id) wrap.dataset.dbId = metadata._db_id;
          if (metadata?._seq != null) wrap.dataset.seq = String(metadata._seq);          // ADR 0008
          if (metadata?.client_msg_id) wrap.dataset.clientMsgId = metadata.client_msg_id; // ADR 0008
          if (metadata?._fromHistory) wrap.dataset.fromHistory = '1';                     // F5: STATIC reconcile render (resumeStream's dup-check distinguishes this from an own-echo live bubble)
          box.appendChild(wrap);
          lastWrap = wrap;
          if (!firstMsgAi) firstMsgAi = wrap;
          lastMsgAi = wrap;
          renderedFirstVisible = true;  // #834: subsequent bubbles are continuations
        }

        // Whether a TEXT bubble was actually rendered above this round's tools.
        // In the game build an intermediate text round is skipped, so the thread
        // must merge/connect as if there were no text bubble (no dangling has-top).
        const _renderedTxt = txt && !_gbSkipIntermediateText;
        const roundTools = toolsByRound[roundNum] || [];
        // ADR 0011 — pure context-read beats render no chip in the game build (mirror of the live
        // path): a re-opened transcript must not re-paint a wall of identical "Production notes" rows.
        const _visibleTools = isGameBuild() ? roundTools.filter(ev => !orwellBeatIsSilent(ev.tool)) : roundTools;
        if (_visibleTools.length > 0) {
          // Reuse previous thread if no text separated us (merge consecutive tool rounds)
          let threadWrap = null;
          if (!_renderedTxt && lastWrap && lastWrap.classList.contains('agent-thread')) {
            threadWrap = lastWrap;
          } else {
            threadWrap = document.createElement('div');
            threadWrap.className = 'agent-thread';
            // Extend line up if there's a chat bubble above
            if (_renderedTxt) threadWrap.classList.add('has-top');
            box.appendChild(threadWrap);
          }
          const _gbBeat = isGameBuild();
          // M4-6: ceremony slates queued while walking this round's tools, inserted as full-width
          // cards right after the thread once it's fully built (mirrors the live path's per-event
          // insertion — see chat.js — since appending more chips INTO threadWrap never moves its
          // position relative to a sibling already inserted after it).
          const _pendingSlates = [];
          for (const ev of _visibleTools) {
            const ok = (ev.exit_code === 0 || ev.exit_code == null);
            // C14/C19 immersion: in the game build a recognised engine/agent tool
            // renders as a quiet production beat — label + status only, never its raw
            // name, args, output JSON, screenshots, or diffs. The live path (chat.js)
            // already did this; the reload path was leaking all of it on every session
            // re-open. Single-sourced via ORWELL_TOOL_BEATS.
            const _beat = _gbBeat ? ORWELL_TOOL_BEATS[ev.tool] : null;
            let outHtml = '';
            if (!_beat && ev.output && ev.output.trim()) {
              outHtml = `<details class="agent-tool-output"><summary>Output</summary><pre>${esc(ev.output)}</pre></details>`;
            }
            const screenshotSrc = _beat ? null : safeToolScreenshotSrc(ev.screenshot);
            if (screenshotSrc) {
              outHtml += `<details class="agent-tool-output"><summary>Screenshot</summary><img src="${esc(screenshotSrc)}" style="max-width:100%;border-radius:6px;margin-top:6px;border:1px solid var(--border)" /></details>`;
            }
            // File-write/edit diff (persisted in the tool event) \u2014 re-render it
            // so it survives reload, matching the live stream.
            let evDiffHtml = '';
            if (!_beat && ev.diff && ev.diff.text) {
              const d = ev.diff;
              const stat = [
                d.new_file ? '<span class="diff-stat-new">new</span>' : '',
                d.added ? `<span class="diff-stat-add">+${d.added}</span>` : '',
                d.removed ? `<span class="diff-stat-del">\u2212${d.removed}</span>` : '',
              ].filter(Boolean).join(' ');
              const rows = d.text.split('\n').map(line => {
                let cls = 'diff-ctx', text = line;
                if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta';
                else if (line.startsWith('@@')) cls = 'diff-hunk';
                // Drop the leading diff marker (+/-/space) — colour encodes add/del.
                else if (line.startsWith('+')) { cls = 'diff-add'; text = line.slice(1); }
                else if (line.startsWith('-')) { cls = 'diff-del'; text = line.slice(1); }
                else if (line.startsWith(' ')) { text = line.slice(1); }
                return `<span class="${cls}">${esc(text) || '&nbsp;'}</span>`;
              }).join('');  // spans are display:block \u2014 a literal \n would double-space
              evDiffHtml = `<details class="agent-tool-output agent-tool-diff"><summary><span class="diff-file">${esc(d.file || 'diff')}</span> <span class="diff-summary-stats">${stat}</span></summary><pre class="diff-pre">${rows}</pre></details>`;
            }
            const node = document.createElement('div');
            // Hide the raw JSON command when a diff says it better (same as live);
            // production beats never show raw args at all.
            const evCmdHtml = (!_beat && ev.command && !(ev.diff && ev.diff.text)) ? `<pre class="agent-thread-cmd">${esc(ev.command)}</pre>` : '';
            // L7 (mirror of the live path): render the chevron + collapsible content
            // ONLY when there's real content to expand (command, output, or diff).
            // A production beat / empty tool result is a flat label, not an
            // expand/collapse affordance with nothing behind it.
            const _evExpandHtml = `${evCmdHtml}${outHtml}${evDiffHtml}`;
            // ORW-264: the finished chip is built by the ONE shared pure builder the live path uses
            // (orwellBeatNodeView) - outcome line, no "done" tail in the game build, flat/expand shape.
            const _nv = orwellBeatNodeView({ tool: ev.tool, beat: _beat, ok, output: ev.output, expandHtml: _evExpandHtml, esc });
            node.className = _nv.className;
            node.innerHTML = _nv.innerHTML;
            // Click handling is delegated globally \u2014 see chat.js init.
            threadWrap.appendChild(node);
            // M4-6: the SAME pure descriptor + shared DOM builder the live path uses (chat.js) \u2014
            // identical (tool, output) always yields identical markup, so a re-opened transcript
            // paints the exact card the player saw live.
            if (ok && _gbBeat) {
              const _slate = orwellCeremonySlate(ev.tool, ev.output);
              if (_slate) _pendingSlates.push(_slate);
            }
          }
          { // M4-6: insert the queued ceremony-slate card(s) right after the built thread — a
            // sibling of threadWrap, in order, so appending more chips INTO threadWrap (a later
            // tool in the same round) never moves it relative to a slate already placed after it.
            // When consecutive rounds MERGE into the same reused threadWrap, walk the anchor past
            // slates a prior round already placed — resetting to threadWrap reversed cross-round
            // order vs the live path's walk, breaking .ow-cslate mirror parity (review P1).
            let _slateAnchor = threadWrap;
            while (_slateAnchor.nextElementSibling && _slateAnchor.nextElementSibling.classList.contains('ow-cslate')) {
              _slateAnchor = _slateAnchor.nextElementSibling;
            }
            for (const _slate of _pendingSlates) {
              const _card = orwellRenderCeremonySlate(_slate);
              _slateAnchor.insertAdjacentElement('afterend', _card);
              _slateAnchor = _card;
            }
          }
          // ADR 0011 — cap the reload rail (mirror of the live backstop): keep the most recent
          // ORWELL_MAX_VISIBLE_BEATS chips, drop older overflow (no live timers on reload nodes).
          { const _rn = threadWrap.querySelectorAll('.agent-thread-node');
            for (let _ri = 0; _ri < _rn.length - ORWELL_MAX_VISIBLE_BEATS; _ri++) _rn[_ri].remove(); }
          // Check if next round has text — extend line down to connect. In the
          // game build, an intermediate next-round text bubble is skipped (L6b),
          // so only connect down when that next text bubble will actually render
          // (i.e. it is the final text round).
          let nextTxt = (roundTexts[r + 1] || '').trim();
          if (nextTxt && isGameBuild()) {
            let nextIsLastText = true;
            for (let rr = r + 2; rr < maxRound; rr++) {
              if ((roundTexts[rr] || '').trim()) { nextIsLastText = false; break; }
            }
            if (!nextIsLastText) nextTxt = '';
          }
          if (nextTxt) threadWrap.classList.add('has-bottom');
          lastWrap = threadWrap;

          for (const ev of roundTools) {
            if (ev.image_url) {
              box.appendChild(buildImageBubble(ev.image_url, ev.image_prompt, ev.image_model, ev.image_size, ev.image_quality, ev.image_id));
            }
          }
        }
      }

      const firstWrap = lastMsgAi || lastWrap;
      if (firstWrap && firstWrap.classList.contains('msg-ai')) {
        if (metadata?.memories_used?.length) firstWrap._memoriesUsed = metadata.memories_used;
        firstWrap.appendChild(createMsgFooter(firstWrap));
        if (metadata) displayMetrics(firstWrap, metadata);
      }

      if (window.hljs) {
        box.querySelectorAll('pre code:not(.hljs)').forEach(b => window.hljs.highlightElement(b));
      }
      if (markdownModule.renderMermaid) markdownModule.renderMermaid(box);
      repaintStoredChyrons(metadata, box.lastElementChild || lastWrap);
      return lastWrap;
    }

    // --- Standard single-bubble message ---
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-ai');

    const r = document.createElement('div');
    r.className = 'role';
    const isSlash = metadata?.source === 'slash';
    const isCompacted = metadata?.compacted;
    const replyModels = replyModelPair(modelName, metadata);
    const resolvedModel = replyModels.actualModel || replyModels.requestedModel;
    // C14/immersion: in the game build the assistant byline is the show's production voice
    // (gameNarrator() — the season's producer, "Production" until resolved), never the model name.
    // Slash/compacted meta-bubbles keep the product name "Orwell" (product chrome, M2-5).
    var _roleText = role === 'user' ? 'You' : (isSlash || isCompacted) ? 'Orwell'
      : (isGameBuild() && role === 'assistant') ? gameNarrator()
      : modelRouteLabel(replyModels.requestedModel, resolvedModel);
    if (role === 'assistant' && (metadata?.research || metadata?.research_clarification)) {
      _roleText += ' (Research)';
    }
    if (metadata?.group_model && role !== 'user') {
      _roleText = metadata.group_model;
    } else if (metadata?.character_name && role !== 'user' && !isSlash && !isCompacted) {
      _roleText = metadata.character_name;
    }
    r.textContent = _roleText;
    if (role !== 'user') {
      // C14/immersion: suppress the "alias -> dated-version" tooltip in the game build —
      // the raw model name must never reach the player, not even on hover.
      if (!isGameBuild() && !isSlash && !isCompacted && replyModels.requestedModel && resolvedModel && !sameModelName(replyModels.requestedModel, resolvedModel)) {
        r.title = replyModels.requestedModel + ' -> ' + resolvedModel;
      }
      if (!isSlash && !isCompacted) applyModelColor(r, resolvedModel);
      r.appendChild(roleTimestamp(metadata?.timestamp, metadata?.game_moment));
    }

    const b = document.createElement('div');
    b.className = 'body';

    let text = markdownModule.squashOutsideCode(stripToolBlocks(textRaw || ''));

    // For user messages, pull out vision-model image descriptions ([Image: name]\n
    // <multi-line desc>) into a collapsible "image description" section. Done for
    // ALL user messages (not just ones with attachment metadata) so it rebuilds
    // from the stored text even after a browser restart drops the cached attachments.
    const attachments = metadata?.attachments;
    const _visionBlocks = [];
    if (role === 'user') {
      text = text.replace(
        /\n*\[Image: ([^\]]+)\]\n([\s\S]*?)(?=\n*\[Image: |\n*\[Image attached: |\n*=== File: |\n*\[PDF content\]:|$)/g,
        (_m, name, desc) => { const d = desc.trim(); if (d) _visionBlocks.push({ name: name, desc: d }); return ''; }
      );
    }
    // With attachments present, also strip the embedded file/PDF/image-marker text.
    if (role === 'user' && attachments?.length) {
      // Strip === File: ... === blocks, [PDF content]: blocks, and [Image attached: ...] lines
      text = text
        .replace(/\n*=== File: .+? ===\n\[Type: .+?\]\n+```[\s\S]*?```/g, '')
        .replace(/\n*=== File: .+? ===\n\[Type: .+?\]\n+[\s\S]*?(?=\n*=== File:|$)/g, '')
        .replace(/\n*\[PDF content\]:[\s\S]*?(?=\n*\[PDF content\]|\n*=== File:|$)/g, '')
        .replace(/\n*\[Image attached: [^\]]+\]/g, '')
        .replace(/\n*\[Attached (?:document|non-text) file\]/g, '')
        .trim();
    }

    // L36 (game build): an OUT-OF-CHARACTER aside is a quiet word to/from production,
    // NOT a line the room hears. Style the bubble distinctly and strip the markers so it
    // reads cleanly. PLAYER side: a message the player wrapped in `((...))` or prefixed
    // `ooc:`. MODEL side (L36 follow-on): the GM marks its OWN OOC answers by wrapping the
    // ENTIRE reply in `((...))` (the engine prompt contract — not a heuristic guess), so a
    // fully-wrapped assistant message renders as a producer/HUD aside, never a spoken line.
    // Full build is UNCHANGED.
    if ((role === 'user' || role === 'assistant') && isGameBuild()) {
      const _ooc = detectOocAside(text);
      if (_ooc.ooc) {
        wrap.classList.add('msg-ooc');
        if (role === 'assistant') wrap.classList.add('msg-ooc-producer');
        text = _ooc.text;
      } else {
        // OOC retro-styling: a marker-LESS message the server classified OOC after the fact
        // (metadata `ooc: true`) styles identically — same classes, text untouched (no markers
        // to strip). See applyOocClassFromMetadata (the shared metadata half of the seam).
        applyOocClassFromMetadata(wrap, metadata, role);
      }
    }

    wrap.dataset.raw = text;
    if (metadata?._db_id) wrap.dataset.dbId = metadata._db_id;
    if (metadata?._seq != null) wrap.dataset.seq = String(metadata._seq);          // ADR 0008
    if (metadata?.client_msg_id) wrap.dataset.clientMsgId = metadata.client_msg_id; // ADR 0008
    if (metadata?._fromHistory) wrap.dataset.fromHistory = '1';                     // F5: STATIC reconcile render (resumeStream's dup-check distinguishes this from an own-echo live bubble)
    // Prepend sources box if saved in metadata
    var sourcesPrefix = '';
    var findingsSuffix = '';
    if (role === 'assistant' && metadata?.research_sources?.length) {
      sourcesPrefix = buildSourcesBox(metadata.research_sources, 'research');
    } else if (role === 'assistant' && metadata?.web_sources?.length) {
      sourcesPrefix = buildSourcesBox(metadata.web_sources, 'web');
    }
    if (role === 'assistant' && metadata?.research_findings?.length) {
      findingsSuffix = buildFindingsBox(metadata.research_findings);
    }
    // RAG document sources — restored from metadata so they survive refresh.
    if (role === 'assistant' && metadata?.rag_sources?.length) {
      findingsSuffix += buildRagSourcesBox(metadata.rag_sources);
    }
    // If thinking is stored in metadata (not in text), reconstruct the full display
    // so processWithThinking can render the reasoning in its (default-collapsed)
    // "Thinking" accordion. GAME BUILD (2026-06-20 owner ruling): the accordion is
    // shown by default but COLLAPSED, separate from the clean public bubble — so we
    // reconstruct here in every build and let processWithThinking decide (it renders
    // the collapsed accordion in the game build, or drops it when an operator set
    // `body.hide-thinking`; either way the reply text is scrubbed clean).
    if (role === 'assistant' && metadata?.thinking) {
      const thinkTime = metadata.thinking_time || null;
      const thinkHtml = markdownModule.processWithThinking(
        markdownModule.composeThinkSource(metadata.thinking, text, thinkTime, true)
      );
      b.innerHTML = sourcesPrefix + thinkHtml + findingsSuffix;
    } else if (role === 'user') {
      // USER-AUTHORED TEXT: render with the base markdown renderer, NOT
      // processWithThinking. In the game build, processWithThinking runs the
      // MODEL-reasoning leak scrubbers (scrubReasoningPreamble / redactRawIds)
      // regardless of role, and those drop whole leading lines that match the
      // reasoning-preamble pattern ("I'll …", "Let me …", "I need …", "So I …").
      // A player message is verbatim by the owner's hard rule — what they typed
      // goes in the bubble, every time — and never contains <think> blocks,
      // operator asides, or raw npc:<id> leaks, so the scrub pipeline is both
      // unnecessary and harmful here. mdToHtml still performs the same-origin
      // inline image upgrade (uploaded casting photo / generated image) and all
      // normal markdown; svgifyEmoji mirrors processWithThinking's emoji pass.
      b.innerHTML = sourcesPrefix
        + _svgifyEmoji(markdownModule.mdToHtml(text))
        + findingsSuffix;
    } else {
      b.innerHTML = sourcesPrefix + markdownModule.processWithThinking(text) + findingsSuffix;
    }

    // The vision/OCR caption is stripped from the displayed text above (so the
    // bubble doesn't show the raw model output) but no longer rendered as an
    // inline collapsible — the user can still view/edit it via the "Caption"
    // button on the photo thumbnail. _visionBlocks is intentionally left unused
    // so the parsing-and-strip side-effect on `text` still happens.
    void _visionBlocks;

    // Add "Open Visual Report" button for persisted research messages
    if (role === 'assistant' && metadata?.research) {
      var _sid = window.sessionModule?.getCurrentSessionId?.();
      if (_sid) _appendReportButton(b, _sid);
    }

    // Style [Doc edit: ...] prefix in user messages
    if (role === 'user') {
      // Match compact format: [Doc edit: line X] instruction
      b.innerHTML = b.innerHTML.replace(
        /\[Doc edit: (lines? [\d–\-]+)\]\s*/,
        '<span class="doc-edit-tag">Doc edit: $1</span> '
      );
      // Match raw format: "In the document, edit this specific text (line X):\n```\n...\n```\n\nInstruction: ..."
      // After markdown processing this becomes a <p> + <pre><code> block + <p>Instruction: text</p>
      const rawDocMatch = b.innerHTML.match(/In the document, edit this specific text \((lines? [\d–\-]+)\)/);
      if (rawDocMatch) {
        const lineRef = rawDocMatch[1];
        // Extract instruction text (after "Instruction: ")
        const instrMatch = b.textContent.match(/Instruction:\s*([\s\S]*)$/);
        const instrText = instrMatch ? instrMatch[1].trim() : '';
        // User-authored instruction text — base markdown renderer, NOT the
        // reasoning-scrub pipeline (see the role === 'user' note above): an
        // instruction like "Let me rephrase line 3" must render verbatim.
        b.innerHTML = '<span class="doc-edit-tag">Doc edit: ' + lineRef + '</span> '
          + _svgifyEmoji(markdownModule.mdToHtml(instrText));
      }

      // Render attachment cards
      if (attachments?.length) {
        b.appendChild(buildAttachCards(attachments));
      }
    }

    wrap.appendChild(r);
    wrap.appendChild(b);

    // Add stopped indicator + continue button for messages that were stopped by user
    if (role === 'assistant' && metadata?.stopped) {
      const stoppedIndicator = document.createElement('div');
      stoppedIndicator.className = 'stopped-indicator';
      const stoppedLabel = document.createElement('span');
      // Differentiate between "stopped mid-stream" (had content, can continue)
      // and "cancelled before any content" — the latter has no Continue affordance.
      stoppedLabel.textContent = metadata.cancelled
        ? '[Cancelled by user]'
        : '[Message interrupted]';
      stoppedIndicator.appendChild(stoppedLabel);
      // Continue button only makes sense when there's partial content to
      // resume from \u2014 skip it for fully-cancelled (empty) turns.
      if (!metadata.cancelled) {
        const continueBtn = document.createElement('button');
        continueBtn.className = 'continue-btn';
        continueBtn.title = 'Continue';
        continueBtn.textContent = '\u25B8';
        continueBtn.addEventListener('click', () => {
          stoppedIndicator.remove();
          if (window.chatModule && window.chatModule.handleChatSubmit) {
            const cutoff = wrap.dataset.raw || wrap.querySelector('.body')?.textContent || '';
            // Headless send (no composer puppeteering); the continuation merges into the same bubble.
            window.chatModule.handleChatSubmit(null,
              'Your previous response was interrupted. It ended with:\n\n' + cutoff.slice(-500) + '\n\nDo NOT repeat what you already said. Continue exactly from where you were cut off.',
              { hideUserBubble: true, pendingContinue: wrap });
          }
        });
        stoppedIndicator.appendChild(continueBtn);
      }
      b.appendChild(stoppedIndicator);
    }

    if (metadata?.edited) {
      const editedIndicator = document.createElement('div');
      editedIndicator.className = 'edited-indicator';
      editedIndicator.textContent = '[Message edited]';
      b.appendChild(editedIndicator);
    }

    // Restore variant navigation from saved metadata
    if (role === 'assistant' && metadata?.variants && metadata.variants.length > 1) {
      wrap.dataset.variants = JSON.stringify(metadata.variants);
      const idx = metadata.variantIndex ?? metadata.variants.length - 1;
      wrap.dataset.variantIndex = String(idx);

      // Re-render from `raw` markdown rather than trusting cached `v.html`.
      // Variants ride through localStorage / chat export-import; cached HTML
      // would let an attacker-controlled session JSON inject markup.
      const _renderVariant = (v) => (v && v.raw)
        ? markdownModule.processWithThinking(markdownModule.squashOutsideCode(v.raw))
        : (v && v.html) || '';

      // Show the selected variant's content
      const v = metadata.variants[idx];
      if (v) {
        b.innerHTML = _renderVariant(v);
        wrap.dataset.raw = v.raw;
      }

      // Render nav
      const nav = document.createElement('span');
      nav.className = 'variant-nav';
      nav.addEventListener('click', (e) => e.stopPropagation());

      const divider = document.createElement('span');
      divider.className = 'variant-divider';
      divider.textContent = '|';
      nav.appendChild(divider);

      const tagLabel = document.createElement('span');
      const _icons = { regen: '\u21BB', shorter: '\u2702', simpler: '?', original: '\u25CB' };
      const _tl0 = metadata.variants[idx]?.label;
      tagLabel.className = 'variant-tag' + (_tl0 === 'shorter' ? ' variant-tag-scissors' : '');
      tagLabel.textContent = _icons[_tl0] || '';
      nav.appendChild(tagLabel);

      const prevBtn = document.createElement('button');
      prevBtn.className = 'variant-btn';
      prevBtn.textContent = '<';
      prevBtn.disabled = idx === 0;
      nav.appendChild(prevBtn);

      const numLeft = document.createElement('button');
      numLeft.className = 'variant-num';
      numLeft.textContent = String(idx + 1);
      numLeft.disabled = idx === 0;
      nav.appendChild(numLeft);

      const slash = document.createElement('span');
      slash.className = 'variant-slash';
      slash.textContent = '/';
      nav.appendChild(slash);

      const numRight = document.createElement('button');
      numRight.className = 'variant-num';
      numRight.textContent = String(metadata.variants.length);
      numRight.disabled = idx === metadata.variants.length - 1;
      nav.appendChild(numRight);

      const nextBtn = document.createElement('button');
      nextBtn.className = 'variant-btn';
      nextBtn.textContent = '>';
      nextBtn.disabled = idx === metadata.variants.length - 1;
      nav.appendChild(nextBtn);

      const switchFn = (newIdx) => {
        const vars = metadata.variants;
        if (newIdx < 0 || newIdx >= vars.length) return;
        const sv = vars[newIdx];
        b.innerHTML = _renderVariant(sv);
        wrap.dataset.raw = sv.raw;
        wrap.dataset.variantIndex = String(newIdx);
        if (window.hljs) wrap.querySelectorAll('pre code').forEach(bl => window.hljs.highlightElement(bl));
        tagLabel.textContent = _icons[sv.label] || '';
        tagLabel.className = 'variant-tag' + (sv.label === 'shorter' ? ' variant-tag-scissors' : '');
        numLeft.textContent = String(newIdx + 1);
        numLeft.disabled = newIdx === 0;
        numRight.disabled = newIdx === vars.length - 1;
        prevBtn.disabled = newIdx === 0;
        nextBtn.disabled = newIdx === vars.length - 1;
      };
      prevBtn.addEventListener('click', (e) => { e.stopPropagation(); switchFn(parseInt(wrap.dataset.variantIndex) - 1); });
      numLeft.addEventListener('click', (e) => { e.stopPropagation(); switchFn(parseInt(wrap.dataset.variantIndex) - 1); });
      numRight.addEventListener('click', (e) => { e.stopPropagation(); switchFn(parseInt(wrap.dataset.variantIndex) + 1); });
      nextBtn.addEventListener('click', (e) => { e.stopPropagation(); switchFn(parseInt(wrap.dataset.variantIndex) + 1); });

      r.appendChild(nav);
    }

    if (role === 'assistant') {
      // The "N pinned" / "N recalled" pill in the footer reads from
      // wrap._memoriesUsed — propagate it from saved metadata so the pill
      // survives a page refresh (live-stream path sets it via SSE, but
      // history reloads need this assignment).
      if (metadata?.memories_used?.length) wrap._memoriesUsed = metadata.memories_used;
      wrap.appendChild(createMsgFooter(wrap));
      if (metadata) displayMetrics(wrap, metadata);
    } else {
      // Add timestamp to user header (like AI messages). M2-6: user turns carry no
      // server-stamped game_moment today, so this stays a neutral wall-clock stamp; the
      // arg is passed for forward-compat and render-contract symmetry with the AI header.
      r.appendChild(roleTimestamp(metadata?.timestamp, metadata?.game_moment));

      wrap.appendChild(createUserMsgFooter(wrap));
    }

    box.appendChild(wrap);

    // TTS is now part of the msg-actions system
    if (role === 'assistant' && markdownModule.renderMermaid) {
      markdownModule.renderMermaid(wrap);
    }
    if (role === 'assistant') repaintStoredChyrons(metadata, wrap);
    return wrap;
  } catch (error) {
    console.error('Error in addMessage:', error);
    if (uiModule) uiModule.showError('Failed to add message: ' + error.message);
  }
}

const chatRenderer = {
  shortModel,
  sameModelName,
  modelRouteLabel,
  replyModelPair,
  modelColor,
  applyModelColor,
  getModelCost,
  getImageCost,
  getSessionCost,
  resetSessionCost,
  updateSessionCostUI,
  roleTimestamp,
  stripToolBlocks,
  safeToolScreenshotSrc,
  safeDisplayImageSrc,
  buildSourcesBox,
  buildFindingsBox,
  appendReportButton,
  buildImageBubble,
  hideWelcomeScreen,
  showWelcomeScreen,
  ensureWelcomeContentSync,
  createMsgFooter,
  displayMetrics,
  addMessage,
  toRenderModel,
  renderAssistantMessage,
  updateMessageAttachments,
  applyOocClass,
  applyOocClassFromMetadata,
};

export default chatRenderer;
