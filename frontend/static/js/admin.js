// static/js/admin.js — Admin panel module (ES6)
// Admin-only: users, endpoints, MCP, RAG, embeddings, tokens, webhooks, features

import uiModule from './ui.js';
import settingsModule from './settings.js';
import { providerLogo } from './providers.js';
import { sortModelObjects } from './modelSort.js';

let initialized = false;
let modalEl = null;
// When the user adds an endpoint, store its id so the next render of
// the endpoints list can flash a glow on that row. Cleared once the
// animation fires.
let _recentlyAddedEpId = null;

function el(id) { return document.getElementById(id); }
function esc(s) { return uiModule.esc(s); }
// #1644: shared admin status-badge — opaque pastel fill + dark ink, theme-independent (the pastel/dark
// pairs are contrast-critical; one shared source stops the three init* copies from drifting apart).
function _adminStatusBadge(ok, text, failBg = '#f5c2c2', failFg = '#842029') {
  return `<span class="admin-badge" style="background:${ok ? '#bfe8cf' : failBg};color:${ok ? '#0f5132' : failFg};">${esc(text)}</span>`;
}

/* ═══════════════════════════════════════════
   USERS TAB
   ═══════════════════════════════════════════ */
const PRIV_LABELS = {
  can_use_agent: 'Agent mode',
  can_use_browser: 'Browser automation',
  can_use_bash: 'Shell / Python / Files',
  can_use_documents: 'Document editor',
  can_use_research: 'Deep research',
  can_generate_images: 'Image generation',
  can_manage_memory: 'Memory & skills',
};

async function loadUsers() {
  const list = el('adm-userList');
  try {
    // Resolve who we are so the UI can hide the self-delete control (guard a).
    // Best-effort: the server re-checks every guard, so a failed lookup just
    // means the button shows and the server refuses.
    let me = '';
    try {
      const sres = await fetch('/api/auth/status', { credentials: 'same-origin' });
      const sd = await sres.json();
      me = (sd && sd.username ? String(sd.username) : '').trim().toLowerCase();
    } catch (_) {}
    const res = await fetch('/api/auth/users', { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) { list.innerHTML = '<div class="admin-empty">Access denied</div>'; return; }
    const data = await res.json();
    if (!data.users || data.users.length === 0) { list.innerHTML = '<div class="admin-empty">No users found</div>'; return; }
    // Admin count drives the last-admin UI guard (guard b): the Remove button is
    // withheld from the final administrator (the server also refuses it).
    const adminCount = data.users.filter(x => x.is_admin).length;
    list.innerHTML = '';
    data.users.forEach(u => {
      const uname = String(u.username).trim().toLowerCase();
      const isSelf = !!me && uname === me;
      const isLastAdmin = u.is_admin && adminCount <= 1;
      // Guards (a) + (b) reflected in the UI: never offer to delete yourself or
      // the last admin. Every other user (admin or not) gets a Remove button.
      const canDelete = !isSelf && !isLastAdmin;
      const row = document.createElement('div');
      row.className = 'admin-user-row';

      // Header: name + badges + delete
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 0;';
      const initial = u.username.charAt(0).toUpperCase();
      header.innerHTML = `
        <div class="admin-user-info">
          <div style="width:28px;height:28px;border-radius:50%;background:color-mix(in srgb, var(--accent) 20%, var(--panel));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0;color:var(--accent);">${esc(initial)}</div>
          <div>
            <span class="admin-user-name">${esc(u.username)}</span>
            ${u.is_admin ? '<span class="admin-badge" style="margin-left:6px;">ADMIN</span>' : '<span style="font-size:10px;opacity:0.4;display:block;">Click to manage privileges</span>'}
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="ow-btn ow-btn-compact" data-adm-role-user="${esc(u.username)}" data-adm-is-admin="${u.is_admin ? '1' : '0'}">${u.is_admin ? 'Revoke admin' : 'Make admin'}</button>
          <button class="ow-btn ow-btn-compact" data-adm-resetpw-user="${esc(u.username)}">Reset password</button>
          <button class="ow-btn ow-btn-compact" data-adm-rename-user="${esc(u.username)}">Rename</button>
          ${canDelete ? `<button class="ow-btn ow-btn-compact ow-btn-destructive" data-adm-del-user="${esc(u.username)}">Remove</button>` : ''}
          ${u.is_admin ? '' : '<svg class="admin-user-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;transition:transform 0.2s,opacity 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>'}
        </div>
      `;
      row.appendChild(header);

      // Privileges panel (hidden by default, not for admins)
      if (!u.is_admin) {
        const privPanel = document.createElement('div');
        privPanel.className = 'admin-priv-panel hidden';
        privPanel.style.cssText = 'padding:8px 0 4px;border-top:1px solid var(--border);margin-top:8px;';

        // Boolean toggles
        let html = '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.35;font-weight:600;margin-bottom:4px;">Features</div>';
        for (const [key, label] of Object.entries(PRIV_LABELS)) {
          const checked = u.privileges && u.privileges[key] ? 'checked' : '';
          html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
            <span style="font-size:12px;">${label}</span>
            <label class="ow-switch" style="transform:scale(0.85);"><input type="checkbox" data-priv="${key}" data-user="${esc(u.username)}" ${checked}><span class="ow-switch-track"></span></label>
          </div>`;
        }
        // Rate limit
        html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.35;font-weight:600;margin:10px 0 4px;">Limits</div>';
        const maxMsg = (u.privileges && u.privileges.max_messages_per_day) || 0;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
          <div>
            <span style="font-size:12px;">Daily message limit</span>
            <div style="font-size:10px;opacity:0.4;">0 = no limit</div>
          </div>
          <input type="number" min="0" value="${maxMsg}" data-priv="max_messages_per_day" data-user="${esc(u.username)}" style="width:70px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px;text-align:center;">
        </div>`;
        // Allowed models — checkbox list
        const allowedModels = Array.isArray(u.privileges && u.privileges.allowed_models)
          ? u.privileges.allowed_models
          : [];
        const allowedSet = new Set(allowedModels);
        const modelsRestricted = !!(u.privileges && u.privileges.allowed_models_restricted);
        html += `<div style="padding:4px 0;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;">Allowed models</span>
            <div style="display:flex;gap:8px;">
              <a href="#" class="priv-models-all" data-user="${esc(u.username)}" style="font-size:10px;opacity:0.5;">All</a>
              <a href="#" class="priv-models-none" data-user="${esc(u.username)}" style="font-size:10px;opacity:0.5;">None</a>
            </div>
          </div>
          <div style="font-size:10px;opacity:0.4;margin-bottom:4px;">${!modelsRestricted ? 'All models allowed (no restrictions)' : (allowedSet.size === 0 ? 'No models allowed' : allowedSet.size + ' model(s) allowed')}</div>
          <div class="priv-models-list" data-user="${esc(u.username)}">
            <span style="opacity:0.4;font-size:11px;">Loading models...</span>
          </div>
        </div>`;
        privPanel.innerHTML = html;
        row.appendChild(privPanel);

        // Toggle panel visibility + rotate chevron + load models
        let _modelsLoaded = false;
        header.addEventListener('click', (e) => {
          if (e.target.closest('.ow-btn, [data-adm-rename-user], [data-adm-role-user], [data-adm-resetpw-user]')) return;
          privPanel.classList.toggle('hidden');
          const chevron = header.querySelector('.admin-user-chevron');
          if (chevron) {
            const isOpen = !privPanel.classList.contains('hidden');
            chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
            chevron.style.opacity = isOpen ? '0.7' : '0.3';
          }
          // Load models list on first expand
          if (!_modelsLoaded && !privPanel.classList.contains('hidden')) {
            _modelsLoaded = true;
            _loadModelsForUser(u.username, allowedSet, modelsRestricted, privPanel);
          }
        });

        // Wire privilege changes (boolean + number inputs, not model checkboxes)
        privPanel.querySelectorAll('[data-priv]').forEach(input => {
          const handler = async () => {
            const username = input.dataset.user;
            const key = input.dataset.priv;
            let value;
            if (input.type === 'checkbox') value = input.checked;
            else if (input.type === 'number') value = parseInt(input.value) || 0;
            else value = input.value;
            try {
              await fetch(`/api/auth/users/${encodeURIComponent(username)}/privileges`, {
                method: 'PUT', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value }),
              });
            } catch (e) { uiModule.showError('Failed to update privilege'); }
          };
          if (input.type === 'checkbox') input.addEventListener('change', handler);
          else input.addEventListener('change', handler);
        });
      }

      // Rename button
      const renameBtn = row.querySelector('[data-adm-rename-user]');
      if (renameBtn) {
        renameBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const oldUsername = renameBtn.dataset.admRenameUser;
          const next = await uiModule.styledPrompt(`Rename "${oldUsername}"`, {
            defaultValue: oldUsername,
            placeholder: 'New username',
            confirmText: 'Rename',
          });
          const username = (next || '').trim();
          if (!username || username === oldUsername) return;
          try {
            const res = await fetch(`/api/auth/users/${encodeURIComponent(oldUsername)}/rename`, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              uiModule.showError(data.detail || 'Failed to rename user');
              return;
            }
            if (data.renamed_self) {
              window.location.reload();
              return;
            }
            loadUsers();
          } catch (err) {
            uiModule.showError('Failed to rename user');
          }
        });
      }

      // Delete button. Guard (c): require the admin to TYPE the exact username.
      // The typed value must match before we even call the API, and the server
      // re-checks the match (confirm_username) so the typed step can't be skipped.
      const delBtn = row.querySelector('[data-adm-del-user]');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const username = delBtn.dataset.admDelUser;
          const typed = await uiModule.styledPrompt(
            `This permanently deletes "${username}" and wipes their game. Type the username to confirm.`,
            { title: 'Delete user', placeholder: username, confirmText: 'Delete', cancelText: 'Cancel' });
          // Cancelled, or the typed name doesn't exactly match — do nothing.
          if (typed === null) return;
          if (typed.trim().toLowerCase() !== String(username).trim().toLowerCase()) {
            uiModule.showError('Username did not match — deletion cancelled');
            return;
          }
          const res = await fetch('/api/auth/users', {
            method: 'DELETE', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, confirm_username: typed }),
          });
          if (res.ok) loadUsers();
          else {
            const d = await res.json().catch(() => ({}));
            uiModule.showError(d.detail || 'Failed to delete user');
          }
        });
      }

      // Promote / demote (0029). The last-admin guard is enforced server-side.
      const roleBtn = row.querySelector('[data-adm-role-user]');
      if (roleBtn) {
        roleBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const username = roleBtn.dataset.admRoleUser;
          const makeAdmin = roleBtn.dataset.admIsAdmin !== '1';
          const verb = makeAdmin ? 'Make' : 'Revoke';
          if (!await uiModule.styledConfirm(`${verb} admin for "${username}"?`, { confirmText: `${verb} admin`, danger: !makeAdmin })) return;
          try {
            const res = await fetch(`/api/auth/users/${encodeURIComponent(username)}/role`, {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ is_admin: makeAdmin }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { uiModule.showError(data.detail || 'Failed to change role'); return; }
            loadUsers();
          } catch (err) { uiModule.showError('Failed to change role'); }
        });
      }

      // Admin password reset (0029): set a new password without the current one;
      // the server revokes that user's sessions on reset.
      const resetBtn = row.querySelector('[data-adm-resetpw-user]');
      if (resetBtn) {
        resetBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const username = resetBtn.dataset.admResetpwUser;
          const entered = await uiModule.styledPrompt(`Set a new password for "${username}"`, {
            title: 'Reset password', placeholder: 'New password (min 8 characters)', confirmText: 'Reset',
          });
          const newPassword = (entered || '').trim();
          if (!newPassword) return;
          if (newPassword.length < 8) { uiModule.showError('Password must be at least 8 characters'); return; }
          try {
            const res = await fetch(`/api/auth/users/${encodeURIComponent(username)}/password`, {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ new_password: newPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { uiModule.showError(data.detail || 'Failed to reset password'); return; }
            uiModule.showToast('Password reset');
          } catch (err) { uiModule.showError('Failed to reset password'); }
        });
      }

      list.appendChild(row);
    });
  } catch (e) { list.innerHTML = '<div class="admin-error">Failed to load users</div>'; }
}

async function _loadModelsForUser(username, allowedSet, modelsRestricted, privPanel) {
  const listEl = privPanel.querySelector(`.priv-models-list[data-user="${username}"]`);
  if (!listEl) return;
  try {
    const res = await fetch('/api/models', { credentials: 'same-origin' });
    const data = await res.json();
    const allModels = [];
    (data.items || []).forEach(item => {
      if (item.offline) return;
      (item.models || []).forEach(mid => {
        allModels.push({ mid, epName: item.endpoint_name || '', display: mid.split('/').pop() });
      });
    });
    if (!allModels.length) {
      listEl.innerHTML = '<span style="opacity:0.4;font-size:11px;">No models available</span>';
      return;
    }
    let restricted = modelsRestricted;
    listEl.innerHTML = sortModelObjects(allModels).map(m => {
      const checked = !restricted || allowedSet.has(m.mid) ? 'checked' : '';
      return `<label>
        <input type="checkbox" class="priv-model-cb" data-mid="${esc(m.mid)}" ${checked}>
        <span>${esc(m.display)}</span>
        <span style="opacity:0.3;font-size:10px;margin-left:auto;">${esc(m.epName)}</span>
      </label>`;
    }).join('');

    // Save on change
    function _saveModels() {
      const checked = [];
      listEl.querySelectorAll('.priv-model-cb').forEach(cb => {
        if (cb.checked) checked.push(cb.dataset.mid);
      });
      // All checked means unrestricted; zero checked means explicitly no models.
      restricted = checked.length !== allModels.length;
      const value = restricted ? checked : [];
      const hint = privPanel.querySelector('.priv-models-list[data-user]')?.previousElementSibling?.querySelector('div[style*="opacity"]');
      if (hint) hint.textContent = !restricted ? 'All models allowed (no restrictions)' : (value.length === 0 ? 'No models allowed' : value.length + ' model(s) allowed');
      fetch(`/api/auth/users/${encodeURIComponent(username)}/privileges`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowed_models: value, allowed_models_restricted: restricted }),
      }).catch(() => {});
    }
    listEl.querySelectorAll('.priv-model-cb').forEach(cb => cb.addEventListener('change', _saveModels));

    // All / None buttons
    privPanel.querySelector(`.priv-models-all[data-user="${username}"]`)?.addEventListener('click', (e) => {
      e.preventDefault();
      listEl.querySelectorAll('.priv-model-cb').forEach(cb => cb.checked = true);
      _saveModels();
    });
    privPanel.querySelector(`.priv-models-none[data-user="${username}"]`)?.addEventListener('click', (e) => {
      e.preventDefault();
      listEl.querySelectorAll('.priv-model-cb').forEach(cb => cb.checked = false);
      _saveModels();
    });
  } catch (e) {
    listEl.innerHTML = '<span style="opacity:0.4;font-size:11px;">Failed to load models</span>';
  }
}

function initSignupToggle() {
  const toggle = el('adm-signupToggle');
  fetch('/api/auth/status', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => { toggle.checked = !!d.signup_enabled; })
    .catch(e => console.warn('Auth status fetch failed:', e));
  toggle.addEventListener('change', async () => {
    try {
      const res = await fetch('/api/auth/signup-toggle', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      toggle.checked = data.signup_enabled;
    } catch (e) { toggle.checked = !toggle.checked; }
  });
}

function initAddUser() {
  el('adm-addBtn').addEventListener('click', async () => {
    const msg = el('adm-addMsg');
    msg.textContent = ''; msg.className = '';
    const username = el('adm-newUsername').value.trim();
    const password = el('adm-newPassword').value;
    const is_admin = el('adm-newIsAdmin').checked;
    if (!username) { msg.textContent = 'Username required'; msg.className = 'admin-error'; return; }
    if (password.length < 8) { msg.textContent = 'Password must be at least 8 characters'; msg.className = 'admin-error'; return; }
    el('adm-addBtn').disabled = true;
    try {
      const res = await fetch('/api/auth/users', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, is_admin }) });
      const data = await res.json();
      if (res.ok) { msg.textContent = 'User created'; msg.className = 'admin-success'; el('adm-newUsername').value = ''; el('adm-newPassword').value = ''; el('adm-newIsAdmin').checked = false; loadUsers(); }
      else { msg.textContent = data.detail || 'Failed'; msg.className = 'admin-error'; }
    } catch (e) { msg.textContent = 'Request failed'; msg.className = 'admin-error'; }
    el('adm-addBtn').disabled = false;
  });
}

/* ═══════════════════════════════════════════
   SERVICES TAB — Endpoints
   ═══════════════════════════════════════════ */
function _isLocalEndpoint(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return true;
    if (h.endsWith('.local')) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
    // Tailscale CGNAT range (100.64.0.0/10 → 100.64.x–100.127.x). Servers
    // found via "Scan for Servers" come back as tailnet IPs, which are still
    // your own machines, so group them under Local rather than API.
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
    // Single-label hostnames are LAN by convention.
    if (!h.includes('.')) return true;
    return false;
  } catch { return false; }
}

async function _refreshAfterEndpointChange(deletedEndpointId) {
  try {
    const sm = window.sessionModule;
    const pending = sm && sm.getPendingChat ? sm.getPendingChat() : null;
    if (deletedEndpointId && pending && String(pending.endpointId || '') === String(deletedEndpointId)) {
      if (sm.setPendingChat) sm.setPendingChat(null);
    }
  } catch (_) {}
  try {
    if (window.modelsModule && window.modelsModule.refreshModels) {
      await window.modelsModule.refreshModels(true);
    }
  } catch (_) {}
  try {
    window.dispatchEvent(new CustomEvent('ge:model-endpoints-updated', {
      detail: { deletedEndpointId: deletedEndpointId || null }
    }));
  } catch (_) {}
  try {
    if (window.sessionModule && window.sessionModule.updateModelPicker) {
      window.sessionModule.updateModelPicker();
    }
  } catch (_) {}
}

async function _selectAddedModelInChat(endpoint) {
  const models = (endpoint && Array.isArray(endpoint.models)) ? endpoint.models : [];
  let modelId = models[0] || '';
  // 2026-07-13 (the arbitrary-default class): the just-added endpoint used to auto-select its
  // FIRST listed model into the chat picker — on a fresh OpenRouter add that was whatever the
  // catalog led with (e.g. openai/gpt-5.6-luna-pro), not the shipped narrator. Prefer the
  // CONFIGURED default chat model whenever the new endpoint serves it; the first-listed id
  // stays only as the floor for endpoints that don't serve the configured default.
  try {
    const r = await fetch('/api/default-chat', { credentials: 'same-origin' });
    if (r.ok) {
      const dc = await r.json();
      if (dc && dc.model && models.includes(dc.model)) modelId = dc.model;
    }
  } catch (_) {}
  if (!modelId) return;
  try {
    if (window.modelsModule && window.modelsModule.refreshModels) {
      await window.modelsModule.refreshModels(true);
    }
  } catch (_) {}
  try {
    document.dispatchEvent(new CustomEvent('orwell:auto-select-model', {
      detail: {
        endpointId: endpoint.id || '',
        endpointName: endpoint.name || '',
        modelId,
        url: endpoint.base_url || '',
      }
    }));
  } catch (_) {}
}

async function loadEndpoints() {
  const listLocal = el('adm-epList-local');
  const listApi = el('adm-epList-api');
  // Fallback to the legacy single list if the split containers don't exist
  // (older HTML or third-party embedding).
  const listLegacy = el('adm-epList');
  // Refresh model picker so new endpoints show up in chat
  if (window.modelsModule && window.modelsModule.refreshModels) {
    window.modelsModule.refreshModels();
    setTimeout(() => {
      if (window.sessionModule && window.sessionModule.updateModelPicker) {
        window.sessionModule.updateModelPicker();
      }
    }, 1500);
  }
  if (settingsModule && typeof settingsModule.refreshAiModelEndpoints === 'function') {
    settingsModule.refreshAiModelEndpoints();
  }
  try {
    const res = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
    // Treat a non-OK response (e.g. 401/403 for non-admins, or backend
    // returning an error envelope) the same as "no endpoints yet": show the
    // empty state, not "Failed to load". The user just installed the app —
    // there's literally nothing to load, so the error read as broken UI.
    let data = [];
    if (res.ok) {
      try { data = await res.json(); } catch { data = []; }
    }
    if (!Array.isArray(data) || data.length === 0) {
      const empty = '<div class="admin-empty">None</div>';
      if (listLocal) listLocal.innerHTML = empty;
      if (listApi) listApi.innerHTML = '<div class="admin-empty">None</div>';
      if (listLegacy) listLegacy.innerHTML = empty;
      return;
    }
    const rowHtml = data.map(ep => {
      const visibleCount = ep.models.length;
      const totalCount = visibleCount + (ep.hidden_count || 0);
      // `ep.models` is the *visible* set — when every model is hidden it's
      // empty, but we still need to render the expand panel so the user can
      // un-hide them. Gate on the total instead.
      const hasModels = ep.online && totalCount > 0;
      const statusBadge = ep.status === 'empty'
        ? '<span class="admin-badge">no models</span>'
        : ep.online
          ? `<span class="admin-badge adm-ep-model-count">${visibleCount}/${totalCount} models enabled</span>`
          : '<span class="admin-badge admin-badge-off">offline</span>';
      const justAddedClass = (_recentlyAddedEpId && String(ep.id) === _recentlyAddedEpId) ? ' adm-ep-just-added' : '';
      const category = ep.category || (_isLocalEndpoint(ep.base_url) ? 'local' : 'api');
      const kindLabel = ep.endpoint_kind && ep.endpoint_kind !== 'auto' ? ep.endpoint_kind.toUpperCase() : '';
      const keyLabel = ep.has_key
        ? (ep.api_key_fingerprint ? ` (key ${esc(ep.api_key_fingerprint)})` : ' (key set)')
        : '';
      return `
        <div class="admin-user-row${ep.is_enabled ? '' : ' admin-ep-disabled'}${justAddedClass}" data-adm-ep-id="${ep.id}">
          <div style="display:flex;align-items:center;justify-content:space-between;${hasModels ? 'cursor:pointer;' : ''}padding:4px 0;" data-adm-ep-header="${ep.id}">
            <div class="admin-user-info" style="flex:1;flex-wrap:wrap;gap:0.3rem;">
              <span class="admin-user-name">${esc(ep.name)}</span>
              ${ep.model_type === 'image' ? '<span class="admin-badge" style="background:color-mix(in srgb, var(--accent) 20%, transparent);color:var(--accent);">Image</span>' : ''}
              ${kindLabel ? `<span class="admin-badge">${esc(kindLabel)}</span>` : ''}
              ${statusBadge}
              ${ep.is_enabled ? '' : '<span class="admin-badge admin-badge-off">disabled</span>'}
              ${hasModels ? '<span style="font-size:10px;opacity:0.4;">Click to manage models</span>' : ''}
            </div>
            <div class="admin-ep-actions">
              ${_isLocalEndpoint(ep.base_url) ? '<select class="admin-tools-select" data-adm-tools-select="' + ep.id + '" title="Native tool calling mode. Auto = use heuristic (fenced blocks for Ollama /v1). On = always use native function calling. Off = always use fenced blocks."><option value="auto"' + (ep.supports_tools !== true && ep.supports_tools !== false ? ' selected' : '') + '>Tools: Auto</option><option value="true"' + (ep.supports_tools === true ? ' selected' : '') + '>Tools: On</option><option value="false"' + (ep.supports_tools === false ? ' selected' : '') + '>Tools: Off</option></select>' : ''}
              <button class="ow-btn ow-btn-compact" data-adm-toggle-ep="${ep.id}">${ep.is_enabled ? 'Disable' : 'Enable'}</button>
              <button class="ow-btn ow-btn-compact ow-btn-destructive" data-adm-del-ep="${ep.id}" data-adm-ep-online="${ep.online ? '1' : '0'}">Delete</button>
              ${hasModels ? '<svg class="admin-user-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;transition:transform 0.2s,opacity 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>' : ''}
            </div>
          </div>
          <div class="admin-ep-detail">${esc(ep.base_url)}${category === 'local' ? `<button type="button" class="admin-ep-copy-btn" data-adm-copy-url="${esc(ep.base_url)}" title="Copy URL" aria-label="Copy URL" style="background:none;border:none;padding:0 2px;margin-left:6px;cursor:pointer;color:inherit;opacity:0.45;vertical-align:-2px;line-height:1;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` : ''}${keyLabel}</div>
          ${hasModels ? `<div class="mcp-tools-panel hidden" data-adm-ep-models-panel="${ep.id}"></div>` : ''}
        </div>`;
    });
    // Partition rows into Local vs API for the split sections.
    // Subsections without any rows are hidden entirely (heading + all)
    // so empty groups don't take up vertical real estate.
    const _renderInto = (container, indices) => {
      if (!container) return;
      const section = container.closest('.adm-ep-section');
      if (!indices.length) {
        if (section) section.style.display = 'none';
        container.innerHTML = '';
        return;
      }
      if (section) section.style.display = '';
      container.innerHTML = indices.map(i => rowHtml[i]).join('');
    };
    const localIdx = [], apiIdx = [];
    data.forEach((ep, i) => ((ep.category || (_isLocalEndpoint(ep.base_url) ? 'local' : 'api')) === 'local' ? localIdx : apiIdx).push(i));
    // Sort each section: enabled endpoints first, disabled at the bottom.
    // Preserve original order within each group via stable sort.
    const _sortByEnabled = (a, b) => Number(!!data[b].is_enabled) - Number(!!data[a].is_enabled);
    localIdx.sort(_sortByEnabled);
    apiIdx.sort(_sortByEnabled);
    _renderInto(listLocal, localIdx);
    _renderInto(listApi, apiIdx);
    if (listLegacy) listLegacy.innerHTML = rowHtml.join('');
    // Iterate matching nodes across both containers.
    const queryAll = (sel) => {
      const out = [];
      [listLocal, listApi, listLegacy].forEach(c => {
        if (c) c.querySelectorAll(sel).forEach(n => out.push(n));
      });
      return out;
    };
    queryAll('[data-adm-toggle-ep]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/model-endpoints/${btn.dataset.admToggleEp}`, { method: 'PATCH' });
        // #967 belt (a): ENABLING an endpoint is the "enable API access" action that unblocks the
        // casting cold-start. loadEndpoints()'s own refreshModels() call is UNFORCED, so when the
        // models were already scanned (cached) while the endpoint was disabled, refreshModels sees a
        // fresh cache, SKIPS the fetch, and never observes the none→some transition that fires
        // orwell:models-changed — so the onboarding wizard never re-routes and the producers' opener
        // never fires. Force a refresh here so the transition IS observed. (refreshModels only fires
        // the event on a genuine none→some edge, so disabling — some→none — never spuriously fires it.)
        try {
          if (window.modelsModule && window.modelsModule.refreshModels) {
            await window.modelsModule.refreshModels(true);
          }
        } catch (_) {}
        loadEndpoints();
      });
    });
    queryAll('[data-adm-tools-select]').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        e.stopPropagation();
        const epId = sel.dataset.admToolsSelect;
        const val = sel.value;
        const body = {};
        if (val === 'auto') body.supports_tools = null;
        else body.supports_tools = val === 'true';
        await fetch(`/api/model-endpoints/${epId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        loadEndpoints();
      });
    });
    queryAll('[data-adm-copy-url]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = btn.dataset.admCopyUrl || '';
        if (!url) return;
        uiModule.copyToClipboard(url).then(() => {
          // Brief icon swap to a checkmark so the user gets feedback that
          // the copy actually happened. Reverts after ~1.4s.
          const prev = btn.innerHTML;
          btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          btn.style.opacity = '1';
          setTimeout(() => { btn.innerHTML = prev; btn.style.opacity = ''; }, 1400);
        }).catch(() => {});
      });
    });
    queryAll('[data-adm-del-ep]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        var epId = btn.dataset.admDelEp;
        var isOffline = btn.dataset.admEpOnline === '0';
        // Offline endpoints are already broken — skip the confirm dialog
        // entirely and delete immediately. The optimistic UI removal makes
        // the action feel instant.
        if (!isOffline) {
          var deps = [];
          try {
            var depRes = await fetch('/api/model-endpoints/' + epId + '/dependents', { credentials: 'same-origin' });
            var depData = await depRes.json();
            deps = depData.dependents || [];
          } catch (e) { /* proceed without warning */ }
          var msg = 'Delete this endpoint?';
          if (deps.length) {
            msg += '\n\nThe following settings use this endpoint and will be reset:\n— ' + deps.join('\n— ');
          }
          if (!await uiModule.styledConfirm(msg, { confirmText: 'Delete', danger: true })) return;
        }
        // Optimistic: remove from UI immediately
        const row = btn.closest('[data-adm-ep-id]');
        if (row) row.remove();
        fetch('/api/model-endpoints/' + epId, { method: 'DELETE' })
          .then(() => _refreshAfterEndpointChange(epId))
          .then(() => loadEndpoints())
          .catch(() => loadEndpoints());
      });
    });
    // Clear the just-added marker now that the row has been rendered
    // with the animation class — keeps the glow from re-firing on every
    // subsequent loadEndpoints() call (e.g. when toggling a model).
    if (_recentlyAddedEpId) _recentlyAddedEpId = null;
    // Models expand/collapse (click anywhere on card)
    queryAll('[data-adm-ep-id]').forEach(row => {
      const header = row.querySelector('[data-adm-ep-header]');
      if (!header) return;
      let _modelsLoaded = false;
      row.style.cursor = 'pointer';
      row.addEventListener('click', async (e) => {
        // Don't let interactions inside the expanded panel re-fire the
        // expand/collapse handler — the search box was getting closed
        // because clicking it bubbled up to here.
        if (e.target.closest('.ow-btn, .mcp-tools-list, .mcp-tools-header, .mcp-tools-search, input, label')) return;
        const epId = header.dataset.admEpHeader;
        const panel = row.querySelector(`[data-adm-ep-models-panel="${epId}"]`);
        if (!panel) return;
        panel.classList.toggle('hidden');
        const chevron = row.querySelector('.admin-user-chevron');
        const isOpen = !panel.classList.contains('hidden');
        if (chevron) {
          chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
          chevron.style.opacity = isOpen ? '0.7' : '0.3';
        }
        if (!_modelsLoaded && isOpen) {
          _modelsLoaded = true;
          // Our shared whirlpool spinner (consistent with the rest of the app).
          panel.innerHTML = '';
          let _modelsSpin = null;
          const _ld = document.createElement('span');
          _ld.style.cssText = 'opacity:0.55;font-size:11px;display:inline-flex;align-items:center;gap:8px;';
          _ld.appendChild(document.createTextNode('Loading models…'));
          try {
            const _sp = (await import('./spinner.js')).default;
            _modelsSpin = _sp.createWhirlpool(14);
            _modelsSpin.element.style.cssText = 'width:14px;height:14px;margin:0;display:inline-block;';
            _ld.appendChild(_modelsSpin.element);
          } catch (_) {}
          panel.appendChild(_ld);
          const _stopSpin = () => { try { _modelsSpin && _modelsSpin.stop(); } catch (_) {} };
          const _loadingHtml = (label) => `<span style="opacity:0.55;font-size:11px;display:inline-flex;align-items:center;gap:8px;">${esc(label)}</span>`;
          const renderModels = (models, warning = '') => {
            const sortedModels = sortModelObjects(models);
            const warningHtml = warning ? `<div class="admin-error" style="font-size:11px;margin:6px 0;">${esc(warning)}</div>` : '';
            const attachRefresh = () => {
              panel.querySelector(`[data-ep-refresh-models="${epId}"]`)?.addEventListener('click', async (e) => {
                e.preventDefault();
                panel.innerHTML = _loadingHtml('Refreshing models...');
                try {
                  const res = await fetch(`/api/model-endpoints/${epId}/models?refresh=true&refresh_timeout=60`, { credentials: 'same-origin' });
                  const refreshWarning = res.headers.get('X-Model-Refresh-Warning') || '';
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                  const refreshedModels = await res.json();
                  renderModels(refreshedModels, refreshWarning);
                  if (refreshWarning && uiModule?.showToast) uiModule.showToast(refreshWarning, 6000);
                } catch (_) {
                  renderModels(sortedModels, 'Model refresh failed; kept cached models.');
                }
              });
            };
            if (!sortedModels.length) {
              panel.innerHTML = `<div class="mcp-tools-header">
                <span>Models</span>
                <span style="display:flex;gap:8px;align-items:center;">
                  <span class="mcp-tools-count">0/0 enabled</span>
                  <a href="#" data-ep-refresh-models="${epId}">Refresh</a>
                </span>
              </div>${warningHtml}<span style="opacity:0.5;font-size:11px;">No models</span>`;
              attachRefresh();
              return;
            }
            const hiddenSet = new Set(sortedModels.filter(m => m.is_hidden).map(m => m.id));
            const showSearch = sortedModels.length >= 8;
            panel.innerHTML = `<div class="mcp-tools-header">
              <span>Models</span>
              <span style="display:flex;gap:8px;align-items:center;">
                <span class="mcp-tools-count">${sortedModels.length - hiddenSet.size}/${sortedModels.length} enabled</span>
                <a href="#" data-ep-refresh-models="${epId}">Refresh</a>
                <a href="#" data-ep-select-all="${epId}">All</a>
                <a href="#" data-ep-select-none="${epId}">None</a>
              </span>
            </div>${warningHtml}${showSearch ? `<input type="search" class="mcp-tools-search" placeholder="Search ${sortedModels.length} models..." data-ep-search="${epId}">` : ''}<div class="mcp-tools-list">` + sortedModels.map(m =>
              `<label title="${esc(m.id)}" data-ep-model-row data-search="${esc((m.display + ' ' + m.id).toLowerCase())}" class="adm-model-row">
                <input type="checkbox" class="adm-cb-hidden" data-ep-model-id="${esc(m.id)}" ${!m.is_hidden ? 'checked' : ''}>
                <span class="adm-check-dot" aria-hidden="true"></span>
                <span>${esc(m.display)}</span>
              </label>`
            ).join('') + '</div>';
            const filterRows = (q) => {
              const needle = q.trim().toLowerCase();
              panel.querySelectorAll('[data-ep-model-row]').forEach(row => {
                row.style.display = (!needle || row.dataset.search.includes(needle)) ? '' : 'none';
              });
            };
            attachRefresh();
            panel.querySelector(`[data-ep-search="${epId}"]`)?.addEventListener('input', (e) => filterRows(e.target.value));
            panel.querySelector(`[data-ep-select-all="${epId}"]`)?.addEventListener('click', (e) => {
              e.preventDefault();
              panel.querySelectorAll('[data-ep-model-row]').forEach(row => {
                if (row.style.display !== 'none') row.querySelector('input[type=checkbox]').checked = true;
              });
              _saveEpModelState(epId, panel);
            });
            panel.querySelector(`[data-ep-select-none="${epId}"]`)?.addEventListener('click', (e) => {
              e.preventDefault();
              panel.querySelectorAll('[data-ep-model-row]').forEach(row => {
                if (row.style.display !== 'none') row.querySelector('input[type=checkbox]').checked = false;
              });
              _saveEpModelState(epId, panel);
            });
            panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
              cb.addEventListener('change', () => _saveEpModelState(epId, panel));
            });
          };
          try {
            const res = await fetch(`/api/model-endpoints/${epId}/models`, { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const models = await res.json();
            _stopSpin();
            renderModels(models);
          } catch (e) { _stopSpin(); panel.innerHTML = '<span class="admin-error" style="font-size:11px;">Failed to load models</span>'; }
        }
      });
    });
  } catch (e) {
    const err = '<div class="admin-error">Failed to load</div>';
    [listLocal, listApi, listLegacy].forEach(c => { if (c) c.innerHTML = err; });
  }
}

async function _saveEpModelState(epId, panel) {
  const hidden = [];
  panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
    if (!cb.checked) hidden.push(cb.dataset.epModelId);
  });
  const total = panel.querySelectorAll('input[type=checkbox]').length;
  try {
    await fetch(`/api/model-endpoints/${epId}/models`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ hidden }),
    });
    const enabled = total - hidden.length;
    const countLabel = panel.querySelector('.mcp-tools-count');
    if (countLabel) countLabel.textContent = `${enabled}/${total} enabled`;
    const row = panel.closest('[data-adm-ep-id]');
    if (row) {
      // Target the COUNT badge specifically. A row can carry several
      // `.admin-badge` spans (Image / endpoint-kind / status); the first one
      // is not necessarily the count, so querying `.admin-badge` left the
      // header count stale while the panel updated — two disagreeing counters.
      const badge = row.querySelector('.adm-ep-model-count');
      if (badge) badge.textContent = `${enabled}/${total} models enabled`;
    }
    if (settingsModule && typeof settingsModule.refreshAiModelEndpoints === 'function') {
      settingsModule.refreshAiModelEndpoints();
    }
  } catch (e) { /* silent */ }
}

function initEndpointForm() {
  const provider = el('adm-epProvider');
  const urlInput = el('adm-epUrl');
  const kindSel = el('adm-epKind');

  // Custom provider picker — mirrors the (now hidden) <select id="adm-epProvider">
  // so the rest of this function (which reads provider.value and dispatches
  // change events) keeps working unchanged.
  //
  // #1638 (consumer #9b): migrated onto the shared OrwellMenuKit (the twin of the search
  // provider picker in settings.js). The button stays the trigger; the kit owns the anchored
  // role=menu surface, the click-toggle, aria-haspopup/aria-expanded on the trigger, and the
  // outside-click + Escape dismissal — so there is NO ad-hoc document click listener and NO
  // bespoke .adm-provider-menu container here anymore. The caret rotates off aria-expanded.
  //
  // CRITICAL — the bidirectional URL<->provider sync is preserved verbatim:
  //   • picking a provider writes provider.value AND dispatches 'change' (whose handler below
  //     sets #adm-epUrl + kind), then re-syncs the picker's current display; and
  //   • typing a URL that no longer matches the picked provider resets provider.value to
  //     "Custom URL" and re-syncs the current display.
  // Dropping the 'change' dispatch would silently desync the endpoint form.
  const picker = el('adm-provider-picker');
  const pickerBtn = el('adm-provider-btn');
  const pickerCurrent = picker ? picker.querySelector('.adm-provider-current') : null;
  function _buildAdminProviderItems() {
    // Re-evaluated on every open, so `checked` always tracks the live selection.
    return Array.from(provider.options).map(o => {
      const value = o.value;
      const logo = o.dataset.logo ? (providerLogo(o.dataset.logo) || '') : '';
      return {
        icon: logo,
        label: o.textContent,
        checked: value === provider.value,
        onSelect: () => {
          provider.value = value;
          provider.dispatchEvent(new Event('change', { bubbles: true }));
          _syncPickerCurrent();
        },
      };
    });
  }
  function _syncPickerCurrent() {
    if (!pickerCurrent) return;
    const opt = provider.selectedOptions[0] || provider.options[0];
    const logo = opt.dataset.logo ? (providerLogo(opt.dataset.logo) || '') : '';
    pickerCurrent.querySelector('.adm-provider-logo').innerHTML = logo;
    pickerCurrent.querySelector('.adm-provider-name').textContent = opt.textContent;
  }
  if (picker && pickerBtn && pickerCurrent && window.OrwellMenuKit) {
    _syncPickerCurrent();
    if (provider.value && !urlInput.value) urlInput.value = provider.value;
    window.OrwellMenuKit.attach(pickerBtn, _buildAdminProviderItems, {
      matchAnchorWidth: true,
      ariaLabel: 'Provider',
    });
  }

  provider.addEventListener('change', () => {
    if (provider.value) urlInput.value = provider.value;
    else urlInput.value = '';
    if (kindSel) kindSel.value = provider.value ? 'api' : 'proxy';
  });
  urlInput.addEventListener('input', () => {
    if (provider.value && urlInput.value.trim() !== provider.value) {
      provider.value = '';
      if (kindSel) kindSel.value = 'api';
      _syncPickerCurrent();
    }
  });
  if (kindSel) kindSel.value = kindSel.value || 'api';
  function _apiEndpointKind() {
    return (kindSel && kindSel.value) ? kindSel.value : 'api';
  }
  function _normalizeBaseUrl(raw) {
    let u = raw.trim();
    // Fix common protocol typos
    u = u.replace(/^https?:\/(?!\/)/, m => m + '/');  // https:/ → https://
    u = u.replace(/^htp:/, 'http:').replace(/^htps:/, 'https:');
    u = u.replace(/^http:\/\/\//, 'http://');  // http:/// → http://
    u = u.replace(/^https:\/\/\//, 'https://');
    // Add http:// if no protocol
    if (!/^https?:\/\//.test(u)) u = 'http://' + u;
    // Strip trailing slashes
    u = u.replace(/\/+$/, '');
    // Strip trailing paths that shouldn't be in a base URL
    u = u.replace(/\/v1\/(models|chat\/completions|completions|messages)\/?$/i, '/v1');
    u = u.replace(/\/(models|chat\/completions|completions|v1\/messages)\/?$/i, '');
    u = u.replace(/\/api\/(chat|tags|generate)\/?$/i, '/api');
    // Fix double /v1/v1
    u = u.replace(/\/v1\/v1$/, '/v1');
    // Strip query params and fragments
    u = u.split('?')[0].split('#')[0];
    try {
      const parsed = new URL(u);
      if (parsed.hostname.endsWith('ollama.com')) {
        u = 'https://ollama.com/api';
      }
    } catch(e) {}
    // Ensure /v1 suffix for bare host:port URLs (not cloud providers)
    if (!u.includes('api.') && !u.includes('openrouter') && !u.includes('opencode.ai') && !u.includes('ollama.com') && !u.endsWith('/v1')) {
      try {
        const parsed = new URL(u);
        if (!parsed.pathname || parsed.pathname === '/') {
          u += '/v1';
        }
      } catch(e) {}
    }
    return u;
  }

  async function _defaultOllamaUrl() {
    try {
      const res = await fetch('/api/runtime', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ollama_base_url) return data.ollama_base_url;
      }
    } catch (_) {}
    return 'http://127.0.0.1:11434/v1';
  }

  function _renderEndpointTestResult(msg, res, d) {
    if (res.ok && d.status === 'empty') {
      msg.textContent = 'Online — no models found';
      msg.className = 'admin-success';
      return;
    }
    if (res.ok && d.online) {
      const models = d.models || [];
      const preview = models.slice(0, 3).map(m => esc(String(m).split('/').pop())).join(', ');
      msg.innerHTML = `Online — found ${models.length} model${models.length !== 1 ? 's' : ''}${preview ? `: ${preview}${models.length > 3 ? ', …' : ''}` : ''}`;
      msg.className = 'admin-success';
      return;
    }
    msg.textContent = (d && d.detail) || (d && d.ping_error ? `Offline — ${d.ping_error}` : 'Offline');
    msg.className = 'admin-error';
  }

  function _endpointMsg(kind) {
    return el(kind === 'local' ? 'adm-epLocalMsg' : 'adm-epApiMsg') || el('adm-epMsg');
  }

  let apiTestController = null;
  const apiTestBtn = el('adm-epApiTestBtn');
  const apiCancelTestBtn = el('adm-epApiCancelTestBtn');
  if (apiTestBtn) {
    apiTestBtn.addEventListener('click', async () => {
      const msg = _endpointMsg('api');
      msg.textContent = ''; msg.className = '';
      const rawUrl = (urlInput.value || provider.value).trim();
      const apiKey = el('adm-epApiKey').value.trim();
      if (!rawUrl) { msg.textContent = 'Select a provider or enter a base URL'; msg.className = 'admin-error'; return; }
      if (provider.value && !apiKey) { msg.textContent = 'API key is required for cloud providers'; msg.className = 'admin-error'; return; }
      const url = provider.value && rawUrl === provider.value ? rawUrl : _normalizeBaseUrl(rawUrl);
      apiTestController = new AbortController();
      apiTestBtn.disabled = true;
      apiTestBtn.textContent = 'Testing...';
      if (apiCancelTestBtn) apiCancelTestBtn.classList.remove('hidden');
      try {
        const fd = new FormData();
        fd.append('base_url', url);
        fd.append('endpoint_kind', _apiEndpointKind());
        fd.append('model_refresh_timeout', '30');
        if (apiKey) fd.append('api_key', apiKey);
        const res = await fetch('/api/model-endpoints/test', {
          method: 'POST',
          body: fd,
          credentials: 'same-origin',
          signal: apiTestController.signal,
        });
        const d = await res.json();
        _renderEndpointTestResult(msg, res, d);
      } catch (e) {
        if (e && e.name === 'AbortError') {
          msg.textContent = 'Test canceled';
          msg.className = '';
        } else {
          msg.textContent = 'Test failed: ' + (e && e.message ? e.message : 'request failed');
          msg.className = 'admin-error';
        }
      }
      apiTestController = null;
      apiTestBtn.disabled = false;
      apiTestBtn.textContent = 'Test';
      if (apiCancelTestBtn) apiCancelTestBtn.classList.add('hidden');
    });
  }
  if (apiCancelTestBtn) {
    apiCancelTestBtn.addEventListener('click', () => {
      if (apiTestController) apiTestController.abort();
    });
  }

  el('adm-epAddBtn').addEventListener('click', async () => {
    const msg = _endpointMsg('api');
    msg.textContent = ''; msg.className = '';
    const rawUrl = (urlInput.value || provider.value).trim();
    const apiKey = el('adm-epApiKey').value.trim();
    if (!rawUrl) { msg.textContent = 'Select a provider or enter a base URL'; msg.className = 'admin-error'; return; }
    if (provider.value && !apiKey) { msg.textContent = 'API key is required for cloud providers'; msg.className = 'admin-error'; return; }
    // Normalize URL (fix typos, add /v1, strip wrong paths)
    const url = provider.value && rawUrl === provider.value ? rawUrl : _normalizeBaseUrl(rawUrl);
    const btn = el('adm-epAddBtn');
    btn.disabled = true; btn.textContent = 'Adding...';
    try {
      const fd = new FormData();
      fd.append('base_url', url);
      const endpointKind = _apiEndpointKind();
      fd.append('endpoint_kind', endpointKind);
      fd.append('model_refresh_mode', endpointKind === 'proxy' ? 'manual' : 'auto');
      fd.append('model_refresh_timeout', '30');
      if (apiKey) fd.append('api_key', apiKey);
      if (provider.value && provider.selectedOptions && provider.selectedOptions[0]) {
        fd.append('name', provider.selectedOptions[0].textContent.trim());
      }
      const epType = el('adm-epType');
      if (epType) fd.append('model_type', epType.value);
      if (provider.value && /openrouter\.ai|ollama\.com/i.test(provider.value)) fd.append('require_models', 'true');
      else fd.append('skip_probe', 'false');
      const res = await fetch('/api/model-endpoints', { method: 'POST', body: fd, credentials: 'same-origin' });
      const d = await res.json();
      if (res.ok) {
        const count = d.models ? d.models.length : 0;
        urlInput.value = ''; urlInput.style.display = '';
        el('adm-epApiKey').value = ''; provider.value = '';
        if (kindSel) kindSel.value = 'proxy';
        if (epType) epType.value = 'llm';
        if (d.id) _recentlyAddedEpId = String(d.id);
        await loadEndpoints();
        await _selectAddedModelInChat(d);
        if (!d.online) {
          msg.textContent = 'Added (endpoint offline — will retry on next load)';
          msg.className = 'admin-error';
        } else if (d.status === 'empty') {
          msg.textContent = 'Added — endpoint reachable, no models found';
          msg.className = 'admin-success';
        } else {
          msg.textContent = `Added — found ${count} model${count !== 1 ? 's' : ''}`;
          msg.className = 'admin-success';
        }
      } else { msg.textContent = d.detail || 'Failed'; msg.className = 'admin-error'; }
    } catch (e) { msg.textContent = 'Request failed'; msg.className = 'admin-error'; }
    btn.disabled = false; btn.textContent = 'Add';
  });

  // GitHub Copilot — device-flow login. Starts the flow, shows the user a
  // code + verification link, and polls until they authorise (or it expires).
  const copilotBtn = el('adm-copilotConnectBtn');
  if (copilotBtn) {
    let copilotPolling = false;
    copilotBtn.addEventListener('click', async () => {
      if (copilotPolling) return;
      const status = el('adm-copilotStatus');
      const reset = () => { copilotBtn.disabled = false; copilotBtn.textContent = 'Connect GitHub Copilot'; copilotPolling = false; };
      status.textContent = ''; status.className = 'adm-ep-inline-msg';
      copilotBtn.disabled = true; copilotBtn.textContent = 'Starting...';
      copilotPolling = true;
      let start;
      try {
        const res = await fetch('/api/copilot/device/start', { method: 'POST', body: new FormData(), credentials: 'same-origin' });
        start = await res.json();
        if (!res.ok) { status.textContent = start.detail || 'Failed to start login'; status.className = 'admin-error'; reset(); return; }
      } catch (e) { status.textContent = 'Request failed'; status.className = 'admin-error'; reset(); return; }

      const { poll_id, user_code, verification_uri, verification_uri_complete, interval, expires_in } = start;
      // Prefer the "complete" URL — it embeds the code so the user only has to
      // click "Authorize" (no manual code entry).
      const authUrl = verification_uri_complete || verification_uri || '';
      const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
      copilotBtn.textContent = 'Waiting…';

      // Cohesive waiting panel: spinner + status line, the device code as a
      // copyable chip, and a primary "Authorize on GitHub" action.
      status.className = '';
      status.innerHTML =
        '<div class="adm-copilot-panel">' +
          '<div class="adm-copilot-wait"><span class="admin-spinner"></span>' +
            '<span>Waiting for GitHub authorization…</span></div>' +
          '<div class="adm-copilot-coderow">' +
            '<span class="adm-copilot-code-label">Code</span>' +
            '<code class="adm-copilot-code">' + esc(user_code) + '</code>' +
            '<button type="button" class="ow-btn ow-btn-compact adm-copilot-copy">Copy</button>' +
          '</div>' +
          '<a class="ow-btn ow-btn-prominent adm-copilot-auth" href="' + encodeURI(authUrl) + '" target="_blank" rel="noopener">Authorize on GitHub ↗</a>' +
          '<div class="adm-copilot-hint">A new tab opened on GitHub — approve there to finish. Didn\'t open? Use the button above.</div>' +
        '</div>';
      const copyBtn = status.querySelector('.adm-copilot-copy');
      if (copyBtn) copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(user_code || ''); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); } catch (e) {}
      });
      try { if (authUrl) window.open(authUrl, '_blank', 'noopener'); } catch (e) {}

      const deadline = Date.now() + (expires_in || 900) * 1000;
      const stepMs = Math.max((interval || 5), 2) * 1000;
      const done = (cls, text) => { status.className = cls; status.textContent = text; reset(); };
      const poll = async () => {
        if (Date.now() > deadline) { done('admin-error', 'Authorization expired — try again.'); return; }
        try {
          const fd = new FormData(); fd.append('poll_id', poll_id);
          const r = await fetch('/api/copilot/device/poll', { method: 'POST', body: fd, credentials: 'same-origin' });
          const d = await r.json();
          if (d.status === 'authorized') {
            const n = ((d.endpoint && d.endpoint.models) || []).length;
            done('admin-success', '✓ Connected — ' + n + ' Copilot model' + (n !== 1 ? 's' : '') + ' available.');
            if (d.endpoint && d.endpoint.id) _recentlyAddedEpId = String(d.endpoint.id);
            await loadEndpoints();
            await _selectAddedModelInChat(d.endpoint || {});
            return;
          }
          if (d.status === 'failed') { done('admin-error', 'Authorization failed (' + (d.error || 'denied') + ').'); return; }
        } catch (e) { /* transient — keep polling */ }
        setTimeout(poll, stepMs);
      };
      setTimeout(poll, stepMs);
    });
  }

  // Local "Add" button — sibling form for self-hosted base URLs.
  const localAddBtn = el('adm-epLocalAddBtn');
  const localTestBtn = el('adm-epLocalTestBtn');
  if (localTestBtn) {
    localTestBtn.addEventListener('click', async () => {
      const msg = _endpointMsg('local');
      msg.textContent = ''; msg.className = '';
      const raw = (el('adm-epLocalUrl').value || '').trim();
      if (!raw) { msg.textContent = 'Enter a base URL to test'; msg.className = 'admin-error'; return; }
      const url = _normalizeBaseUrl(raw);
      const keyEl = el('adm-epLocalApiKey');
      const apiKey = keyEl ? keyEl.value.trim() : '';
      localTestBtn.disabled = true;
      localTestBtn.textContent = 'Testing...';
      try {
        const fd = new FormData();
        fd.append('base_url', url);
        if (apiKey) fd.append('api_key', apiKey);
        const res = await fetch('/api/model-endpoints/test', { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        _renderEndpointTestResult(msg, res, d);
      } catch (e) {
        msg.textContent = 'Test failed: ' + (e && e.message ? e.message : 'request failed');
        msg.className = 'admin-error';
      }
      localTestBtn.disabled = false;
      localTestBtn.textContent = 'Test';
    });
  }
  if (localAddBtn) {
    localAddBtn.addEventListener('click', async () => {
      const msg = _endpointMsg('local');
      msg.textContent = ''; msg.className = '';
      const raw = (el('adm-epLocalUrl').value || '').trim();
      if (!raw) { msg.textContent = 'Enter a base URL (e.g. http://localhost:8002/v1)'; msg.className = 'admin-error'; return; }
      const url = _normalizeBaseUrl(raw);
      const keyEl = el('adm-epLocalApiKey');
      const apiKey = keyEl ? keyEl.value.trim() : '';
      localAddBtn.disabled = true; localAddBtn.textContent = 'Adding...';
      try {
        const fd = new FormData();
        fd.append('base_url', url);
        if (apiKey) fd.append('api_key', apiKey);
        fd.append('endpoint_kind', 'local');
        fd.append('model_refresh_mode', 'auto');
        const lt = el('adm-epLocalType');
        if (lt) fd.append('model_type', lt.value);
        fd.append('skip_probe', 'false');
        const res = await fetch('/api/model-endpoints', { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (res.ok) {
          el('adm-epLocalUrl').value = '';
          if (keyEl) keyEl.value = '';
          if (lt) lt.value = 'llm';
          if (d.id) _recentlyAddedEpId = String(d.id);
          await loadEndpoints();
          await _selectAddedModelInChat(d);
          const count = (d.models || []).length;
          msg.textContent = d.status === 'empty'
            ? 'Added — Ollama is running, no models pulled yet'
            : d.online
            ? `Added — found ${count} model${count !== 1 ? 's' : ''}`
            : 'Added (offline — will retry on next load)';
          msg.className = d.online ? 'admin-success' : 'admin-error';
        } else { msg.textContent = d.detail || 'Failed'; msg.className = 'admin-error'; }
      } catch (e) { msg.textContent = 'Request failed'; msg.className = 'admin-error'; }
      localAddBtn.disabled = false; localAddBtn.textContent = 'Add';
    });
  }

  const ollamaBtn = el('adm-epOllamaBtn');
  if (ollamaBtn) {
    ollamaBtn.addEventListener('click', async () => {
      const input = el('adm-epLocalUrl');
      if (input) {
        input.value = await _defaultOllamaUrl();
        input.focus();
      }
      const msg = _endpointMsg('local');
      if (msg) {
        msg.innerHTML = '<span style="font-size:11px;opacity:0.55;">Ollama ready to test.</span>';
        msg.className = '';
      }
    });
  }

  // Discover local models button
  const discoverBtn = el('adm-epDiscoverBtn');
  if (discoverBtn) {
    discoverBtn.addEventListener('click', async () => {
      const msg = _endpointMsg('local');
      discoverBtn.disabled = true;
      // Keep the button's icon as-is while scanning; the whirlpool +
      // status text below is enough feedback. (Two spinning indicators
      // at once looks busy.)
      msg.className = '';
      msg.innerHTML = '';
      try {
        const sp = window.spinnerModule || (await import('./spinner.js')).default;
        const wp = sp.createWhirlpool(20);
        wp.element.style.cssText = 'display:inline-block;vertical-align:middle;margin:0 8px 0 0;';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;padding:8px 0;';
        wrap.appendChild(wp.element);
        const txt = document.createElement('span');
        txt.textContent = 'Scanning ports 8000-8020 and 11434 for model servers...';
        txt.style.cssText = 'font-size:12px;opacity:0.7;';
        wrap.appendChild(txt);
        msg.appendChild(wrap);
        discoverBtn._wp = wp;
      } catch(e) { msg.textContent = 'Scanning...'; }
      try {
        const res = await fetch('/api/discover');
        const data = await res.json();
        const items = data.items || [];
        if (!items.length) {
          msg.textContent = 'No model servers found. Make sure vLLM, llama.cpp, SGLang, or Ollama is running. Docker users may need Ollama bound to a trusted reachable interface.';
          msg.className = 'admin-error';
        } else {
          // Auto-add each discovered endpoint. Server dedupes on base_url
          // and returns `existing: true` for already-registered ones.
          let added = 0;
          let skipped = 0;
          for (const item of items) {
            const base = item.url.replace('/chat/completions', '').replace(/\/$/, '');
            const fd = new FormData();
            fd.append('base_url', base);
            fd.append('endpoint_kind', 'local');
            fd.append('model_refresh_mode', 'auto');
            fd.append('skip_probe', 'false');
            const r = await fetch('/api/model-endpoints', { method: 'POST', body: fd });
            if (r.ok) {
              try {
                const dd = await r.json();
                if (dd && dd.existing) { skipped++; }
                else { added++; if (dd && dd.id) _recentlyAddedEpId = String(dd.id); }
              } catch (_) { added++; }
            }
          }
          const totalModels = items.reduce((n, i) => n + (i.models ? i.models.length : 0), 0);
          const parts = [`Found ${items.length} server${items.length !== 1 ? 's' : ''} with ${totalModels} model${totalModels !== 1 ? 's' : ''}`];
          if (added) parts.push(`added ${added} new`);
          if (skipped) parts.push(`${skipped} already added`);
          msg.innerHTML = parts.join(' — ');
          msg.className = 'admin-success';
          loadEndpoints();
        }
      } catch (e) {
        msg.textContent = 'Scan failed: ' + e.message;
        msg.className = 'admin-error';
      }
      if (discoverBtn._wp) { discoverBtn._wp.destroy(); discoverBtn._wp = null; }
      discoverBtn.disabled = false;
      discoverBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-1px;margin-right:4px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Scan for Servers';
    });
  }

  // Collapsible Add-Models subsections (API / Local). Both start collapsed
  // so the card is compact; the last-used state is remembered per section
  // in localStorage so a frequent API-adder doesn't re-expand every time.
  document.querySelectorAll('#adm-add-api, #adm-add-local').forEach((sec) => {
    const head = sec.querySelector('.adm-section-toggle');
    if (!head) return;
    const key = 'orwell.addModels.' + sec.id + '.open';
    let open = false;
    try { open = localStorage.getItem(key) === '1'; } catch {}
    const apply = () => {
      sec.classList.toggle('collapsed', !open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    apply();
    const toggle = () => {
      open = !open;
      try { localStorage.setItem(key, open ? '1' : '0'); } catch {}
      apply();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
  document.querySelectorAll('.adm-quickstart-section').forEach((sec) => {
    const head = sec.querySelector('.adm-quickstart-toggle');
    if (!head) return;
    const key = 'orwell.addModels.' + sec.id + '.open';
    let open = false;
    try { open = localStorage.getItem(key) === '1'; } catch {}
    const apply = () => {
      sec.classList.toggle('collapsed', !open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    apply();
    const toggle = () => {
      open = !open;
      try { localStorage.setItem(key, open ? '1' : '0'); } catch {}
      apply();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

/* ═══════════════════════════════════════════
   TOOLS TAB — MCP
   ═══════════════════════════════════════════ */

const _GOOGLE_OAUTH_HELP = `To get Google OAuth credentials:
1. Go to console.cloud.google.com
2. Click the project dropdown (top left) > New Project > name it > Create
3. APIs & Services > Library > enable the API you need (Gmail, Calendar, Drive, etc.)
4. APIs & Services > OAuth consent screen > configure (External, app name + email)
5. Under Audience, click Add Users > add your Google email as a test user
6. APIs & Services > Credentials > + Create Credentials > OAuth Client ID > Desktop App
7. Copy the Client ID and Client Secret into the fields above
8. After adding the server, click Authorize to sign in with Google
9. If accessing remotely: sign in, then copy the URL from the error page and paste it back`;

const MCP_PRESETS = [
  { name: "Gmail",           command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],      env: { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" },
    oauthFile: { dir: "gmail", filename: "gcp-oauth.keys.json" },
    oauth: {
      provider: "google",
      keys_file: "gmail/gcp-oauth.keys.json",
      token_file: "gmail/credentials.json",
      scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.settings.basic"],
    },
    help: `Setup:
1. Go to console.cloud.google.com > create or select a project
2. APIs & Services > Library > search "Gmail API" > Enable
3. APIs & Services > OAuth consent screen > set up (External is fine)
4. Under Audience, add your Gmail address as a test user
5. APIs & Services > Credentials > + Create Credentials > OAuth Client ID
6. Application type: Desktop App > Create
7. Copy the Client ID and Client Secret into the fields above
8. Click Add Server, then click the Authorize button
9. Sign in with Google, copy the URL from the error page, paste it back` },
  { name: "Email (IMAP/SMTP)", command: "npx", args: ["-y", "@codefuturist/email-mcp", "stdio"],        env: { MCP_EMAIL_ADDRESS: "", MCP_EMAIL_PASSWORD: "", MCP_EMAIL_IMAP_HOST: "", MCP_EMAIL_SMTP_HOST: "" },
    providerDropdown: {
      label: "Provider",
      targets: { MCP_EMAIL_IMAP_HOST: "imap", MCP_EMAIL_SMTP_HOST: "smtp" },
      options: [
        { name: "Migadu",        imap: "imap.migadu.com",     smtp: "smtp.migadu.com" },
        { name: "Fastmail",      imap: "imap.fastmail.com",   smtp: "smtp.fastmail.com" },
        { name: "Proton Bridge", imap: "127.0.0.1",           smtp: "127.0.0.1" },
        { name: "Outlook/Hotmail", imap: "outlook.office365.com", smtp: "smtp.office365.com" },
        { name: "Yahoo",         imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
        { name: "iCloud",        imap: "imap.mail.me.com",    smtp: "smtp.mail.me.com" },
        { name: "Zoho",          imap: "imap.zoho.com",       smtp: "smtp.zoho.com" },
        { name: "Custom",        imap: "",                    smtp: "" },
      ],
    },
    help: "Works with any IMAP/SMTP email provider.\n1. Pick your provider from the dropdown (or choose Custom)\n2. Enter your email address and password (or app password)\n3. Click Add Server" },
  { name: "CalDAV (Radicale/Nextcloud)", command: "npx", args: ["-y", "caldav-mcp"],                     env: { CALDAV_BASE_URL: "http://localhost:5232", CALDAV_USERNAME: "", CALDAV_PASSWORD: "" },
    help: "Works with any CalDAV server (Radicale, Nextcloud, etc.).\n1. Enter your CalDAV server URL (e.g. http://localhost:5232)\n2. Enter your username and password\n3. Click Add Server" },
  { name: "Google Calendar", command: "npx", args: ["-y", "@cocal/google-calendar-mcp"],                 env: { GOOGLE_OAUTH_CREDENTIALS: "" },
    help: `Setup:
1. Go to console.cloud.google.com > create/select a project
2. APIs & Services > Library > enable Google Calendar API
3. APIs & Services > Credentials > + Create Credentials > OAuth Client ID
4. Application type: Desktop App > Create
5. Click "Download JSON" on the credential you just created
6. Set Google Oauth Credentials to the full path of the downloaded JSON file` },
  { name: "Google Drive",    command: "npx", args: ["-y", "@modelcontextprotocol/server-gdrive"],        env: {},
    help: "Google Drive uses browser-based OAuth on first run. No env vars needed — just click Add and authorize when prompted." },
  { name: "GitHub",          command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    help: "1. Go to github.com > Settings > Developer Settings > Personal Access Tokens > Fine-grained tokens\n2. Generate a new token with the repo permissions you need\n3. Paste it as Github Personal Access Token" },
  { name: "Slack",           command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"],         env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    help: "1. Go to api.slack.com/apps > Create New App > From Scratch\n2. Add Bot Token Scopes (channels:read, chat:write, etc.)\n3. Install to workspace, copy the Bot User OAuth Token (xoxb-...)\n4. Team ID is in your workspace URL or Slack admin settings" },
  { name: "Notion",          command: "npx", args: ["-y", "@notionhq/notion-mcp-server"],               env: { OPENAPI_MCP_HEADERS: "" },
    help: "1. Go to notion.so/my-integrations\n2. Create a new integration\n3. Copy the Internal Integration Secret\n4. Share the Notion pages/databases you want accessible with the integration\n5. For Openapi Mcp Headers enter:\n   {\"Authorization\": \"Bearer YOUR_SECRET\", \"Notion-Version\": \"2022-06-28\"}" },
  { name: "Linear",          command: "npx", args: ["-y", "mcp-linear"],                                env: { LINEAR_API_KEY: "" },
    help: "1. Go to linear.app > Settings > API\n2. Create a Personal API Key\n3. Paste it as Linear Api Key" },
  { name: "Brave Search",    command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "" },
    help: "1. Go to brave.com/search/api\n2. Sign up for a free plan (2000 queries/month)\n3. Copy your API key" },
  { name: "Browser (Playwright)", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"],  env: {},
    help: "Browser automation via Playwright. The AI can navigate pages, click, fill forms, and read content.\nRuns headless by default. Remove --headless from Args to see the browser window.\nFirst run installs Chromium automatically." },
  { name: "Filesystem",      command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home"], env: {},
    help: "Edit the Args field to change which directory the server has access to." },
  { name: "Memory",          command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],        env: {} },
  { name: "Postgres",        command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost/db"], env: {},
    help: "Replace the connection string in the Args field with your actual Postgres connection URL." },
  { name: "Todoist",         command: "npx", args: ["-y", "todoist-mcp-server"],                         env: { TODOIST_API_TOKEN: "" },
    help: "1. Go to todoist.com > Settings > Integrations > Developer\n2. Copy your API token" },
];
// ── Built-in tools management ──
const TOOL_META = {
  bash:              { name: 'Shell',            desc: 'Execute bash commands',           cat: 'Code',       ctx: '~200' },
  python:            { name: 'Python',           desc: 'Run Python scripts',              cat: 'Code',       ctx: '~200' },
  read_file:         { name: 'Read File',        desc: 'Read files from disk',            cat: 'Code',       ctx: '~150' },
  write_file:        { name: 'Write File',       desc: 'Write/create files',              cat: 'Code',       ctx: '~150' },
  web_search:        { name: 'Web Search',       desc: 'Search the web via SearXNG',      cat: 'Search',     ctx: '~300' },
  search_chats:      { name: 'Search Chats',     desc: 'Search conversation history',     cat: 'Search',     ctx: '~150' },
  // Workspace verticals (create_document/update_document/edit_document/suggest_document/
  // manage_documents, manage_memory/manage_skills, ask_teacher, manage_tasks, manage_webhooks)
  // are dropped under the game build — these entries only render in the full workspace
  // (ORWELL_GAME_BUILD=0), where /api/tools lists every tool.
  create_document:   { name: 'Create Document',  desc: 'Create new documents',            cat: 'Documents',  ctx: '~200' },
  update_document:   { name: 'Update Document',  desc: 'Modify existing documents',       cat: 'Documents',  ctx: '~200' },
  edit_document:     { name: 'Edit Document',    desc: 'Find & replace in documents',     cat: 'Documents',  ctx: '~200' },
  suggest_document:  { name: 'Suggest Changes',  desc: 'Propose document edits',          cat: 'Documents',  ctx: '~200' },
  manage_documents:  { name: 'Manage Documents', desc: 'List, delete, organize docs',     cat: 'Documents',  ctx: '~150' },
  generate_image:    { name: 'Generate Image',   desc: 'Create images via AI',            cat: 'Media',      ctx: '~150' },
  manage_memory:     { name: 'Memory',           desc: 'Save and recall memories',        cat: 'Knowledge',  ctx: '~200' },
  manage_skills:     { name: 'Skills',           desc: 'Learn and use procedures',        cat: 'Knowledge',  ctx: '~200' },
  chat_with_model:   { name: 'Chat with Model',  desc: 'Talk to another AI model',        cat: 'Multi-Agent', ctx: '~200' },
  pipeline:          { name: 'Pipeline',         desc: 'Multi-step AI workflows',         cat: 'Multi-Agent', ctx: '~200' },
  ask_teacher:       { name: 'Ask Teacher',      desc: 'Query a more capable model',      cat: 'Multi-Agent', ctx: '~150' },
  send_to_session:   { name: 'Send to Session',  desc: 'Send message to another chat',    cat: 'Sessions',   ctx: '~100' },
  create_session:    { name: 'Create Session',   desc: 'Start a new chat session',        cat: 'Sessions',   ctx: '~100' },
  list_sessions:     { name: 'List Sessions',    desc: 'Browse existing sessions',        cat: 'Sessions',   ctx: '~100' },
  manage_session:    { name: 'Manage Session',   desc: 'Rename, archive, configure',      cat: 'Sessions',   ctx: '~100' },
  list_models:       { name: 'List Models',      desc: 'Show available models',           cat: 'System',     ctx: '~100' },
  ui_control:        { name: 'UI Control',       desc: 'Change theme, layout, settings',  cat: 'System',     ctx: '~150' },
  manage_tasks:      { name: 'Tasks',            desc: 'Schedule automated tasks',        cat: 'System',     ctx: '~150' },
  api_call:          { name: 'API Call',         desc: 'Make HTTP requests',              cat: 'System',     ctx: '~200' },
  manage_webhooks:   { name: 'Webhooks',         desc: 'Configure webhook events',        cat: 'System',     ctx: '~100' },
  manage_tokens:     { name: 'API Tokens',       desc: 'Manage API access tokens',        cat: 'Core',       ctx: '~100' },
  manage_settings:   { name: 'Settings',         desc: 'Change app settings',             cat: 'Core',       ctx: '~100' },
  manage_endpoints:  { name: 'Endpoints',        desc: 'Add/remove model endpoints',      cat: 'Core',       ctx: '~100' },
  manage_mcp:        { name: 'MCP Servers',      desc: 'Manage MCP connections',          cat: 'Core',       ctx: '~100' },
  // ── Big Brother game engine + God Mode (always available under the game build) ──
  getGameState:        { name: 'Get Game State',     desc: 'Read the visible game state',      cat: 'Game', ctx: '~200' },
  runCompetition:      { name: 'Run Competition',    desc: 'Resolve a comp by stats + temperature', cat: 'Game', ctx: '~150' },
  recordInteraction:   { name: 'Record Interaction', desc: 'Log an event + its hidden impact', cat: 'Game', ctx: '~150' },
  surfaceInformationTo:{ name: 'Surface Information', desc: 'Reveal a fact via an in-game pathway', cat: 'Game', ctx: '~150' },
  gameStatus:          { name: 'Game Status',        desc: 'Current week / phase summary',     cat: 'Game', ctx: '~100' },
  getVisibleStateFor:  { name: 'Visible State For',  desc: 'What an entity can see',           cat: 'Game', ctx: '~150' },
  socialRead:          { name: 'Social Read',        desc: 'Observable houseguest behavior',   cat: 'Game', ctx: '~150' },
  askProducers:        { name: 'Ask Producers',      desc: 'Out-of-character producer query',  cat: 'Game', ctx: '~100' },
  renderScene:         { name: 'Render Scene',       desc: 'Narrate an in-game scene',         cat: 'Game', ctx: '~200' },
  endOfSessionSummary: { name: 'Session Summary',    desc: 'Wrap up a play session',          cat: 'Game', ctx: '~150' },
  createCharacter:     { name: 'Create Character',   desc: 'Generate / author a houseguest',   cat: 'Game', ctx: '~200' },
  updateCasting:       { name: 'Update Casting',     desc: 'Record casting-interview answers', cat: 'Game', ctx: '~150' },
  advanceGame:         { name: 'Advance Game',       desc: 'Advance the weekly loop a beat',   cat: 'Game', ctx: '~150' },
  submitDecision:      { name: 'Submit Decision',    desc: 'Resolve a player decision point',  cat: 'Game', ctx: '~100' },
  premiereIntros:      { name: 'Premiere Intros',    desc: 'Premiere meet-everyone progress',  cat: 'Game', ctx: '~150' },
  markHouseguestMet:   { name: 'Mark Met',           desc: 'Mark a houseguest introduced',     cat: 'Game', ctx: '~100' },
  whereabouts:         { name: 'Whereabouts',        desc: 'Room, presence and sightlines',    cat: 'Game', ctx: '~150' },
  moveTo:              { name: 'Move To',            desc: 'Walk the player to a room',        cat: 'Game', ctx: '~100' },
  socialInitiatives:   { name: 'Social Initiatives', desc: 'Who wants to approach the player', cat: 'Game', ctx: '~150' },
  npcVoice:            { name: 'NPC Voice',          desc: 'A houseguest\'s bounded voicing view', cat: 'Game', ctx: '~200' },
  confide:             { name: 'Confide',            desc: 'Press an ally to open up',         cat: 'Game', ctx: '~150' },
  askJuror:            { name: 'Ask Juror',          desc: 'Ask a fellow juror what they know', cat: 'Game', ctx: '~150' },
  makeDeal:            { name: 'Make Deal',          desc: 'Record a deal with a houseguest',  cat: 'Game', ctx: '~150' },
  formAlliance:        { name: 'Form Alliance',      desc: 'Found a named alliance',           cat: 'Game', ctx: '~150' },
  joinAlliance:        { name: 'Join Alliance',      desc: 'Accept an alliance pitch',         cat: 'Game', ctx: '~100' },
  exposeSecret:        { name: 'Expose Secret',      desc: 'Out a learned secret publicly',    cat: 'Game', ctx: '~150' },
  tradeSecret:         { name: 'Trade Secret',       desc: 'Trade a secret for a favor',       cat: 'Game', ctx: '~150' },
  confront:            { name: 'Confront',           desc: 'Confront over a learned fact',     cat: 'Game', ctx: '~150' },
  accuseTie:           { name: 'Accuse Tie',         desc: 'Accuse a pre-show connection',     cat: 'Game', ctx: '~100' },
  callInFavor:         { name: 'Call In Favor',      desc: 'Call in a favor a houseguest owes', cat: 'Game', ctx: '~100' },
  diaryRoom:           { name: 'Diary Room',         desc: 'Record a private player confessional', cat: 'Game', ctx: '~100' },
  turnIn:              { name: 'Turn In',            desc: 'End the player\'s night',          cat: 'Game', ctx: '~150' },
  dailyRecap:          { name: 'Daily Recap',        desc: 'Re-fetch the closed day\'s digest', cat: 'Game', ctx: '~150' },
  worldSnapshotView:  { name: 'World Snapshot',     desc: 'The move-in zeitgeist snapshot',    cat: 'Game', ctx: '~150' },
  seasonRecap:         { name: 'Season Recap',       desc: 'The season\'s public arc',         cat: 'Game', ctx: '~200' },
  playerReceipts:      { name: 'Player Receipts',    desc: 'Contradictions in the player\'s own record', cat: 'Game', ctx: '~200' },
  playerDossier:       { name: 'Player Dossier',     desc: 'The player\'s own diary reads per houseguest', cat: 'Game', ctx: '~300' },
  seasonRetrospective: { name: 'Season Retrospective', desc: 'Post-season Vault unsealing',    cat: 'Game', ctx: '~200' },
  requestSelfEviction: { name: 'Self-Eviction',      desc: 'Raise the self-eviction confirm',  cat: 'Game', ctx: '~100' },
  inspectNonVaultState:{ name: 'Inspect State',      desc: 'God Mode: read non-Vault state',   cat: 'Game', ctx: '~200' },
  overrideMechanic:    { name: 'Override Mechanic',  desc: 'God Mode: override a mechanic',    cat: 'Game', ctx: '~150' },
  configureGame:       { name: 'Configure Game',     desc: 'God Mode: configure the sandbox',  cat: 'Game', ctx: '~150' },
  manageSandbox:       { name: 'Manage Sandbox',     desc: 'God Mode: manage the game sandbox', cat: 'Game', ctx: '~150' },
  sandboxHealth:       { name: 'Sandbox Health',     desc: 'God Mode: sandbox integrity health', cat: 'Game', ctx: '~150' },
  // ── Core UI / account tools (kept) ──
  ask_user:          { name: 'Ask User',          desc: 'Ask the player a question',       cat: 'Core',   ctx: '~100' },
  update_plan:       { name: 'Update Plan',       desc: 'Maintain a running plan',         cat: 'Core',   ctx: '~150' },
  // ── System (opt-in) — general "power" tools, off by default for security ──
  edit_file:         { name: 'Edit File',         desc: 'Find & replace in a file',        cat: 'System (opt-in)', ctx: '~150' },
  grep:              { name: 'Grep',              desc: 'Search file contents',            cat: 'System (opt-in)', ctx: '~100' },
  glob:              { name: 'Glob',              desc: 'Match files by pattern',          cat: 'System (opt-in)', ctx: '~100' },
  ls:                { name: 'List Dir',          desc: 'List directory contents',         cat: 'System (opt-in)', ctx: '~100' },
  app_api:           { name: 'App API',           desc: 'Call a UI-button endpoint (game build: dropped verticals answer 404 by design)', cat: 'System (opt-in)', ctx: '~200' },
};

// A2 (gate 4): per-owner security blocks every power tool for non-admin accounts regardless
// of these toggles — say so, or a multi-account install reads the opt-in as random breakage.
const OPTIONAL_TOOLS_NOTE =
  'Opt-ins apply to admin accounts only — non-admin players never receive these tools. ' +
  'Under the game build, App API calls into removed features return 404 by design.';

async function loadBuiltinTools() {
  const list = el('adm-builtin-tools-list');
  if (!list) return;
  try {
    const res = await fetch('/api/tools', { credentials: 'same-origin' });
    const data = await res.json();
    const tools = data.tools || [];
    if (!tools.length) { list.innerHTML = '<div class="admin-empty">No tools found</div>'; return; }

    // Group by category
    const groups = {};
    for (const t of tools) {
      const meta = TOOL_META[t.id] || { name: t.id, desc: '', cat: 'Other', ctx: '?' };
      const cat = meta.cat;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ ...t, ...meta });
    }

    // Category order ('Game' + 'Core' lead under the game build; 'System (opt-in)'
    // groups the off-by-default power tools; legacy categories trail for the
    // full-workspace (game-build-off) listing).
    const catOrder = ['Game', 'Core', 'System (opt-in)', 'Code', 'Search', 'Documents', 'Media', 'Knowledge', 'Multi-Agent', 'Sessions', 'System', 'Other'];
    let html = '';
    for (const cat of catOrder) {
      const items = groups[cat];
      if (!items) continue;
      const enabledCount = items.filter(i => i.enabled).length;
      const totalCount = items.length;
      const catId = 'tool-cat-' + cat.replace(/[^a-zA-Z]/g, '');
      const allEnabled = enabledCount === totalCount;
      html += `<div class="admin-tool-category">
        <div class="admin-tool-cat-header" data-tool-cat="${catId}" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span>${esc(cat)}</span>
          <span style="display:flex;align-items:center;gap:6px;" class="admin-tool-cat-right">
            <span class="admin-tool-cat-count" style="font-size:10px;opacity:0.5;">${enabledCount}/${totalCount}</span>
            <label class="ow-switch" style="flex-shrink:0;">
              <input type="checkbox" data-tool-cat-toggle="${catId}" ${allEnabled ? 'checked' : ''}>
              <span class="ow-switch-track"></span>
            </label>
            <svg class="admin-tool-cat-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;transition:transform 0.2s,opacity 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
        </div>
        <div class="admin-tool-cat-body hidden" id="${catId}">`;
      if (cat === 'System (opt-in)') {
        html += `<div class="admin-tool-desc" style="display:block;padding:6px 10px 2px;opacity:0.65;">${esc(OPTIONAL_TOOLS_NOTE)}</div>`;
      }
      for (const t of items) {
        const optHint = t.optional
          ? '<span class="admin-tool-desc" style="opacity:0.6;font-style:italic;">off by default · security</span>'
          : '';
        html += `
        <div class="admin-tool-row">
          <div class="admin-tool-info">
            <span class="admin-tool-name">${esc(t.name)}</span>
            <span class="admin-tool-desc">${esc(t.desc)}</span>
            ${optHint}
          </div>
          <span class="admin-tool-ctx" title="Approximate context tokens used">${esc(t.ctx)}</span>
          <label class="ow-switch" style="flex-shrink:0;">
            <input type="checkbox" data-tool-id="${esc(t.id)}" data-tool-optional="${t.optional ? '1' : '0'}" ${t.enabled ? 'checked' : ''}>
            <span class="ow-switch-track"></span>
          </label>
        </div>`;
      }
      html += '</div></div>';
    }
    list.innerHTML = html;

    // Prevent toggle clicks from expanding/collapsing
    list.querySelectorAll('.admin-tool-cat-right').forEach(span => {
      span.addEventListener('click', e => e.stopPropagation());
    });

    // Wire category expand/collapse
    list.querySelectorAll('[data-tool-cat]').forEach(header => {
      header.addEventListener('click', () => {
        const body = el(header.dataset.toolCat);
        if (!body) return;
        body.classList.toggle('hidden');
        const chevron = header.querySelector('.admin-tool-cat-chevron');
        const isOpen = !body.classList.contains('hidden');
        if (chevron) {
          chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
          chevron.style.opacity = isOpen ? '0.7' : '0.3';
        }
      });
    });

    // Helper: save tool state + update counters.
    //   disabled         = KEEP / non-optional tools that are unchecked.
    //   enabled_optional = optional ("power") tools that are checked.
    // When the GET response carried no `optional` field (game build off), every
    // row is data-tool-optional="0", so all unchecked tools fall into `disabled`
    // and enabled_optional stays empty — today's behavior, unchanged.
    async function _saveToolState() {
      const allChecks = list.querySelectorAll('input[data-tool-id]');
      const disabled = [];
      const enabledOptional = [];
      allChecks.forEach(c => {
        const isOptional = c.dataset.toolOptional === '1';
        if (isOptional) {
          if (c.checked) enabledOptional.push(c.dataset.toolId);
        } else if (!c.checked) {
          disabled.push(c.dataset.toolId);
        }
      });
      await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled, enabled_optional: enabledOptional }),
        credentials: 'same-origin',
      });
    }
    function _updateCatCounter(catEl) {
      if (!catEl) return;
      const catChecks = catEl.querySelectorAll('input[data-tool-id]');
      const catEnabled = Array.from(catChecks).filter(c => c.checked).length;
      const counter = catEl.querySelector('.admin-tool-cat-count');
      if (counter) counter.textContent = catEnabled + '/' + catChecks.length;
      const catToggle = catEl.querySelector('input[data-tool-cat-toggle]');
      if (catToggle) catToggle.checked = (catEnabled === catChecks.length);
    }

    // Wire individual tool toggles
    list.querySelectorAll('input[data-tool-id]').forEach(chk => {
      chk.addEventListener('change', async () => {
        await _saveToolState();
        _updateCatCounter(chk.closest('.admin-tool-category'));
      });
    });

    // Wire category-level toggle (enable/disable all in category)
    list.querySelectorAll('input[data-tool-cat-toggle]').forEach(chk => {
      chk.addEventListener('change', async () => {
        const catEl = chk.closest('.admin-tool-category');
        if (!catEl) return;
        const checked = chk.checked;
        catEl.querySelectorAll('input[data-tool-id]').forEach(c => { c.checked = checked; });
        await _saveToolState();
        _updateCatCounter(catEl);
      });
    });
  } catch (e) {
    console.error('Failed to load tools:', e);
    list.innerHTML = '<div class="admin-empty">Failed to load tools</div>';
  }
}

async function loadMcpServers() {
  const list = el('adm-mcpList');
  if (!list) return;  // MCP section not visible / not yet rendered
  try {
    const res = await fetch('/api/mcp/servers', { credentials: 'same-origin' });
    const servers = await res.json();
    if (!servers.length) { list.innerHTML = '<div class="admin-empty">No MCP servers configured</div>'; return; }
    list.innerHTML = servers.map(s => {
      const statusColor = s.needs_oauth ? '#e5a33a' : s.status === 'connected' ? 'var(--fg)' : s.status === 'error' ? 'var(--red)' : 'color-mix(in srgb, var(--fg) 50%, transparent)';
      const toolInfo = s.status === 'connected' ? `${s.enabled_tool_count}/${s.tool_count} tools enabled` : '';
      const statusText = s.needs_oauth ? 'Needs authorization' : s.status === 'connected' ? `Connected (${toolInfo})` : s.status === 'error' ? `Error: ${s.error || 'unknown'}` : 'Disconnected';
      const hasTools = s.status === 'connected' && s.tool_count > 0;
      return `<div class="admin-user-row" data-adm-mcp-id="${s.id}">
        <div style="display:flex;align-items:center;justify-content:space-between;${hasTools ? 'cursor:pointer;' : ''}padding:4px 0;" data-adm-mcp-header="${s.id}">
          <div class="admin-user-info" style="flex:1;flex-wrap:wrap;gap:0.3rem;">
            <span class="admin-user-name">${esc(s.name)}</span>
            <span class="admin-badge" style="background:${statusColor}33;color:${statusColor}">${statusText}</span>
            ${hasTools ? `<span style="font-size:10px;opacity:0.4;">Click to manage tools</span>` : ''}
          </div>
          <div style="display:flex;gap:4px;align-items:center;">
            ${s.needs_oauth ? `<a href="/api/mcp/oauth/authorize/${s.id}" target="_blank" class="ow-btn ow-btn-compact ow-btn-destructive" style="text-decoration:none;">Authorize</a>` : ''}
            <button class="ow-btn ow-btn-compact" data-adm-mcp-reconnect="${s.id}">Reconnect</button>
            <button class="ow-btn ow-btn-compact${s.is_enabled ? ' ow-btn-destructive' : ''}" data-adm-mcp-toggle="${s.id}" data-adm-mcp-enable="${!s.is_enabled}">${s.is_enabled ? 'Disable' : 'Enable'}</button>
            <button class="ow-btn ow-btn-compact ow-btn-destructive" data-adm-mcp-delete="${s.id}">Delete</button>
            ${hasTools ? '<svg class="admin-user-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;transition:transform 0.2s,opacity 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>' : ''}
          </div>
        </div>
        ${hasTools ? `<div class="mcp-tools-panel hidden" data-adm-mcp-tools-panel="${s.id}"></div>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-adm-mcp-reconnect]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const msg = el('adm-mcpMsg'); msg.textContent = 'Reconnecting...'; msg.className = '';
        try {
          const res = await fetch(`/api/mcp/servers/${btn.dataset.admMcpReconnect}/reconnect`, { method: 'POST', credentials: 'same-origin' });
          const data = await res.json();
          msg.textContent = data.connected ? `Reconnected (${data.tool_count} tools)` : `Failed: ${data.error || 'unknown'}`;
          msg.className = data.connected ? 'admin-success' : 'admin-error';
          loadMcpServers();
        } catch (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'admin-error'; }
      });
    });
    list.querySelectorAll('[data-adm-mcp-toggle]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fd = new FormData(); fd.append('is_enabled', btn.dataset.admMcpEnable);
        await fetch(`/api/mcp/servers/${btn.dataset.admMcpToggle}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
        loadMcpServers();
      });
    });
    list.querySelectorAll('[data-adm-mcp-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await uiModule.styledConfirm('Delete this MCP server?', { confirmText: 'Delete', danger: true })) return;
        await fetch(`/api/mcp/servers/${btn.dataset.admMcpDelete}`, { method: 'DELETE', credentials: 'same-origin' });
        loadMcpServers();
      });
    });
    // Tools expand/collapse (click anywhere on card)
    list.querySelectorAll('[data-adm-mcp-id]').forEach(row => {
      const header = row.querySelector('[data-adm-mcp-header]');
      if (!header) return;
      let _toolsLoaded = false;
      row.style.cursor = 'pointer';
      row.addEventListener('click', async (e) => {
        if (e.target.closest('.ow-btn, a, .mcp-tools-list, .mcp-tools-header')) return;
        const sid = header.dataset.admMcpHeader;
        const panel = row.querySelector(`[data-adm-mcp-tools-panel="${sid}"]`);
        if (!panel) return;
        panel.classList.toggle('hidden');
        const chevron = row.querySelector('.admin-user-chevron');
        const isOpen = !panel.classList.contains('hidden');
        if (chevron) {
          chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
          chevron.style.opacity = isOpen ? '0.7' : '0.3';
        }
        if (!_toolsLoaded && isOpen) {
          _toolsLoaded = true;
          panel.innerHTML = '<span style="opacity:0.5;font-size:11px;">Loading tools...</span>';
          try {
            const res = await fetch(`/api/mcp/servers/${sid}/tools`, { credentials: 'same-origin' });
            const tools = await res.json();
            if (!tools.length) { panel.innerHTML = '<span style="opacity:0.5;font-size:11px;">No tools</span>'; return; }
            const disabled = new Set(tools.filter(t => t.is_disabled).map(t => t.name));
            panel.innerHTML = `<div class="mcp-tools-header">
              <span>Tools</span>
              <span style="display:flex;gap:8px;align-items:center;">
                <span class="mcp-tools-count">${tools.length - disabled.size}/${tools.length} enabled</span>
                <a href="#" data-mcp-select-all="${sid}">All</a>
                <a href="#" data-mcp-select-none="${sid}">None</a>
              </span>
            </div><div class="mcp-tools-list">` + tools.map(t =>
              `<label title="${esc(t.description)}">
                <input type="checkbox" data-mcp-tool-name="${esc(t.name)}" ${!t.is_disabled ? 'checked' : ''}>
                <span><strong>${esc(t.name)}</strong> <span style="opacity:0.5;">— ${esc((t.description || '').slice(0, 80))}</span></span>
              </label>`
            ).join('') + '</div>';
            panel.querySelector(`[data-mcp-select-all="${sid}"]`)?.addEventListener('click', (e) => {
              e.preventDefault();
              panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
              _saveMcpToolState(sid, panel);
            });
            panel.querySelector(`[data-mcp-select-none="${sid}"]`)?.addEventListener('click', (e) => {
              e.preventDefault();
              panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
              _saveMcpToolState(sid, panel);
            });
            panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
              cb.addEventListener('change', () => _saveMcpToolState(sid, panel));
            });
          } catch (e) { panel.innerHTML = '<span class="admin-error" style="font-size:11px;">Failed to load tools</span>'; }
        }
      });
    });
  } catch (e) { if (list) list.innerHTML = '<div class="admin-error">Failed to load MCP servers</div>'; }
}

async function _saveMcpToolState(serverId, panel) {
  const disabled = [];
  panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
    if (!cb.checked) disabled.push(cb.dataset.mcpToolName);
  });
  const total = panel.querySelectorAll('input[type=checkbox]').length;
  try {
    await fetch(`/api/mcp/servers/${serverId}/tools`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ disabled }),
    });
    // Update the count label in the panel
    const countLabel = panel.querySelector('.mcp-tools-count');
    if (countLabel) countLabel.textContent = `${total - disabled.length}/${total} enabled`;
    // Update badge in the server row
    const row = panel.closest('[data-adm-mcp-id]');
    if (row) {
      const badge = row.querySelector('.admin-badge');
      if (badge) badge.textContent = `Connected (${total - disabled.length}/${total} tools enabled)`;
    }
  } catch (e) { /* silent */ }
}

function initMcpForm() {
  const cmdEl = el('adm-mcpCommand');
  if (!cmdEl) return;  // MCP form not present in this build — nothing to wire
  const transportSel = el('adm-mcpTransport');
  const sseRow = el('adm-mcpSseRow');
  const envRow = el('adm-mcpEnvRow');
  const envFieldsWrap = el('adm-mcpEnvFields');
  const helpBox = el('adm-mcpHelp');
  const cmdRow = cmdEl.parentElement;
  let _activeHelp = null;
  let _envKeys = []; // track which env keys have dedicated fields
  let _activeOauthFile = null; // preset oauthFile config (for Google servers)
  let _activeOauth = null;     // preset OAuth flow config (provider, scopes, etc.)

  function _clearEnvFields() {
    envFieldsWrap.innerHTML = '';
    _envKeys = [];
    envRow.style.display = 'none';
    el('adm-mcpEnv').value = '';
    _activeOauth = null;
  }

  function _buildEnvFields(envObj, help, preset) {
    _clearEnvFields();
    const keys = Object.keys(envObj);
    if (!keys.length) return;
    _envKeys = keys;

    // Provider dropdown (e.g. for Email IMAP/SMTP)
    if (preset?.providerDropdown) {
      const pd = preset.providerDropdown;
      const row = document.createElement('div');
      row.className = 'admin-model-form-row';
      row.style.cssText = 'gap:6px;align-items:center;';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px;opacity:0.55;min-width:0;white-space:nowrap;';
      label.textContent = pd.label || 'Provider';
      const select = document.createElement('select');
      select.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;';
      pd.options.forEach((opt, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = opt.name;
        select.appendChild(o);
      });
      select.addEventListener('change', () => {
        const opt = pd.options[parseInt(select.value)];
        for (const [envKey, field] of Object.entries(pd.targets)) {
          const inp = envFieldsWrap.querySelector(`.mcp-env-input[data-env-key="${envKey}"]`);
          if (inp) inp.value = opt[field] || '';
        }
      });
      row.appendChild(label);
      row.appendChild(select);
      envFieldsWrap.appendChild(row);
      // Auto-fill with first provider after inputs are created
      setTimeout(() => {
        const first = pd.options[0];
        for (const [envKey, field] of Object.entries(pd.targets)) {
          const inp = envFieldsWrap.querySelector(`.mcp-env-input[data-env-key="${envKey}"]`);
          if (inp && !inp.value) inp.value = first[field] || '';
        }
      }, 0);
    }

    for (const key of keys) {
      const row = document.createElement('div');
      row.className = 'admin-model-form-row';
      row.style.cssText = 'gap:6px;align-items:center;';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px;opacity:0.55;min-width:0;white-space:nowrap;';
      label.textContent = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const input = document.createElement('input');
      input.type = key.toLowerCase().includes('secret') || key.toLowerCase().includes('token') || key.toLowerCase().includes('key') || key.toLowerCase().includes('password') ? 'password' : 'text';
      input.placeholder = key;
      input.dataset.envKey = key;
      input.className = 'mcp-env-input';
      input.style.cssText = 'flex:1;';
      if (envObj[key]) input.value = envObj[key];
      row.appendChild(label);
      row.appendChild(input);
      envFieldsWrap.appendChild(row);
    }
    // Help toggle link
    if (help) {
      _activeHelp = help;
      const helpLink = document.createElement('a');
      helpLink.textContent = 'How do I get these?';
      helpLink.href = '#';
      helpLink.style.cssText = 'font-size:10.5px;opacity:0.5;margin-top:2px;display:inline-block;';
      helpLink.addEventListener('click', (e) => {
        e.preventDefault();
        helpBox.style.display = helpBox.style.display === 'none' ? '' : 'none';
      });
      envFieldsWrap.appendChild(helpLink);
      helpBox.textContent = help;
      helpBox.style.display = 'none';
    } else {
      _activeHelp = null;
      helpBox.style.display = 'none';
    }
  }

  // Collect env from either dedicated fields or raw JSON fallback
  function _collectEnv() {
    if (_envKeys.length) {
      const obj = {};
      envFieldsWrap.querySelectorAll('.mcp-env-input').forEach(inp => {
        if (inp.value.trim()) obj[inp.dataset.envKey] = inp.value.trim();
      });
      return JSON.stringify(obj);
    }
    return el('adm-mcpEnv').value.trim() || '{}';
  }

  transportSel.addEventListener('change', () => {
    const isSse = transportSel.value === 'sse';
    sseRow.style.display = isSse ? '' : 'none';
    cmdRow.style.display = isSse ? 'none' : '';
    if (isSse) { _clearEnvFields(); helpBox.style.display = 'none'; }
  });

  // Preset catalog
  const presetSel = el('adm-mcpPreset');
  if (presetSel) {
    MCP_PRESETS.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = p.name + (Object.keys(p.env).length ? '  (requires keys)' : '');
      presetSel.appendChild(opt);
    });
    presetSel.addEventListener('change', () => {
      if (presetSel.value === '') return;
      const p = MCP_PRESETS[parseInt(presetSel.value)];
      el('adm-mcpName').value = p.name.toLowerCase().replace(/\s+/g, '-');
      transportSel.value = 'stdio';
      el('adm-mcpCommand').value = p.command;
      el('adm-mcpArgs').value = JSON.stringify(p.args);
      sseRow.style.display = 'none';
      cmdRow.style.display = '';
      _buildEnvFields(p.env, p.help || null, p);
      _activeOauthFile = p.oauthFile || null;
      _activeOauth = p.oauth || null;
      presetSel.value = '';
      // Focus first env field if keys are needed
      const firstInput = envFieldsWrap.querySelector('.mcp-env-input');
      if (firstInput) firstInput.focus();
      else el('adm-mcpAddBtn').focus();
    });
  }

  el('adm-mcpAddBtn').addEventListener('click', async () => {
    const name = el('adm-mcpName').value.trim();
    const transport = transportSel.value;
    const command = el('adm-mcpCommand').value.trim();
    const args = el('adm-mcpArgs').value.trim() || '[]';
    const env = _collectEnv();
    const url = el('adm-mcpUrl').value.trim();
    const msg = el('adm-mcpMsg');
    if (!name) { msg.textContent = 'Name is required'; msg.className = 'admin-error'; return; }
    if (transport === 'stdio' && !command) { msg.textContent = 'Command is required for stdio'; msg.className = 'admin-error'; return; }
    if (transport === 'sse' && !url) { msg.textContent = 'URL is required for SSE'; msg.className = 'admin-error'; return; }
    try { JSON.parse(env); } catch { msg.textContent = 'Env must be valid JSON'; msg.className = 'admin-error'; return; }
    const fd = new FormData();
    fd.append('name', name); fd.append('transport', transport); fd.append('command', command); fd.append('args', args); fd.append('env', env); fd.append('url', url);
    // If preset has oauthFile config, send credentials for file generation
    if (_activeOauthFile) {
      const envObj = JSON.parse(env);
      fd.append('oauth_file', JSON.stringify({
        dir: _activeOauthFile.dir,
        filename: _activeOauthFile.filename,
        client_id: envObj.GOOGLE_CLIENT_ID || '',
        client_secret: envObj.GOOGLE_CLIENT_SECRET || '',
      }));
    }
    // If preset has OAuth flow config, send it so the server can handle authorization
    if (_activeOauth) {
      fd.append('oauth_config', JSON.stringify(_activeOauth));
    }
    msg.textContent = 'Adding...'; msg.className = '';
    try {
      const res = await fetch('/api/mcp/servers', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (data.needs_oauth) {
        msg.innerHTML = `Added ${esc(name)} — <a href="/api/mcp/oauth/authorize/${data.id}" target="_blank" style="color:var(--red);font-weight:600;">Authorize with Google</a> to connect`;
        msg.className = 'admin-success';
      } else if (data.connected) {
        msg.textContent = `Added ${name} (${data.tool_count} tools discovered)`; msg.className = 'admin-success';
      } else { msg.textContent = `Added but connection failed: ${data.error || 'unknown'}`; msg.className = 'admin-error'; }
      el('adm-mcpName').value = ''; el('adm-mcpCommand').value = ''; el('adm-mcpArgs').value = ''; el('adm-mcpUrl').value = '';
      _clearEnvFields(); helpBox.style.display = 'none'; _activeHelp = null; _activeOauthFile = null; _activeOauth = null;
      loadMcpServers();
    } catch (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'admin-error'; }
  });
}

/* ── Embedding model ──
   No settings UI: the embedding model (RAG, semantic memory, tool selection)
   is fixed infrastructure that ships with the app, and swapping it would
   invalidate every existing vector. Configure via the FASTEMBED_MODEL /
   EMBEDDING_URL env vars if you really need to override it. */

/* ── RAG ── */
async function loadRag() {
  try {
    const res = await fetch('/api/personal');
    const data = await res.json();
    const dirList = el('adm-ragDirList');
    const dirs = data.directories || [];
    if (dirs.length === 0) { dirList.innerHTML = '<div class="admin-empty">No directories indexed</div>'; }
    else {
      dirList.innerHTML = dirs.map(d => `<div class="admin-rag-item"><span class="admin-rag-item-name" title="${esc(d)}">${esc(d)}</span><button class="ow-btn ow-btn-compact ow-btn-destructive" data-adm-rag-dir="${esc(d)}">Remove</button></div>`).join('');
      dirList.querySelectorAll('[data-adm-rag-dir]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!await uiModule.styledConfirm(`Remove directory "${btn.dataset.admRagDir}" from RAG?`, { confirmText: 'Remove', danger: true })) return;
          btn.disabled = true; btn.textContent = '...';
          try {
            const res = await fetch('/api/personal/remove_directory?directory=' + encodeURIComponent(btn.dataset.admRagDir), { method: 'DELETE' });
            if (res.ok) { ragMsg('Directory removed'); loadRag(); }
            else { const e = await res.json(); ragMsg(e.detail || 'Failed', true); }
          } catch (e) { ragMsg('Error: ' + e.message, true); }
        });
      });
    }
    const fileList = el('adm-ragFileList');
    const files = data.files || [];
    if (files.length === 0) { fileList.innerHTML = '<div class="admin-empty">No files indexed</div>'; }
    else {
      fileList.innerHTML = files.map(f => {
        const size = f.size ? (f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B') : '';
        return `<div class="admin-rag-item"><span class="admin-rag-item-name" title="${esc(f.path || f.name)}">${esc(f.name)}</span><span class="admin-rag-item-meta">${size}</span><button class="ow-btn ow-btn-compact ow-btn-destructive" data-adm-rag-file="${esc(f.path || f.name)}">Delete</button></div>`;
      }).join('');
      fileList.querySelectorAll('[data-adm-rag-file]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!await uiModule.styledConfirm(`Delete "${btn.dataset.admRagFile}" from RAG?`, { confirmText: 'Delete', danger: true })) return;
          btn.disabled = true; btn.textContent = '...';
          try {
            const res = await fetch('/api/personal/file?filepath=' + encodeURIComponent(btn.dataset.admRagFile), { method: 'DELETE' });
            if (res.ok) { ragMsg('File removed'); loadRag(); }
            else { const e = await res.json(); ragMsg(e.detail || 'Failed', true); }
          } catch (e) { ragMsg('Error: ' + e.message, true); }
        });
      });
    }
  } catch (e) {
    el('adm-ragDirList').innerHTML = '<div class="admin-error">Failed to load</div>';
    el('adm-ragFileList').innerHTML = '';
  }
}

let _ragMsgTimer = null;
function ragMsg(text, isError, persist) {
  const s = el('adm-ragStatus');
  s.textContent = text; s.style.color = isError ? 'var(--red)' : 'var(--fg)';
  if (_ragMsgTimer) { clearTimeout(_ragMsgTimer); _ragMsgTimer = null; }
  if (text && !persist) _ragMsgTimer = setTimeout(() => { s.textContent = ''; }, 5000);
}

async function ragUpload(files) {
  if (!files || files.length === 0) return;
  ragMsg('Uploading ' + files.length + ' file(s)...', false, true);
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  try {
    const res = await fetch('/api/personal/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.success) { ragMsg(`Uploaded ${data.uploaded.length} file(s), ${data.indexed_count} chunks indexed`); loadRag(); }
    else ragMsg(data.detail || 'Upload failed', true);
  } catch (e) { ragMsg('Upload error: ' + e.message, true); }
}

function initRag() {
  const dropZone = el('adm-ragDropZone');
  const fileInput = el('adm-ragFileInput');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => ragUpload(fileInput.files));
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); ragUpload(e.dataTransfer.files); });
  el('adm-ragAddDirBtn').addEventListener('click', async () => {
    const dir = el('adm-ragDirInput').value.trim();
    if (!dir) return;
    const btn = el('adm-ragAddDirBtn');
    btn.disabled = true; btn.textContent = 'Indexing...';
    try {
      const res = await fetch('/api/personal/add_directory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: dir }) });
      const data = await res.json();
      if (data.success) { ragMsg(`Indexed ${data.indexed_count} chunks from directory`); el('adm-ragDirInput').value = ''; loadRag(); }
      else ragMsg(data.detail || data.message || 'Failed', true);
    } catch (e) { ragMsg('Error: ' + e.message, true); }
    btn.disabled = false; btn.textContent = 'Add Directory';
  });
  el('adm-ragReloadBtn').addEventListener('click', async () => {
    const btn = el('adm-ragReloadBtn');
    btn.disabled = true; btn.textContent = 'Reloading...';
    try {
      const res = await fetch('/api/personal/reload', { method: 'POST' });
      const data = await res.json();
      ragMsg(`Index reloaded: ${data.count} documents`);
      loadRag();
    } catch (e) { ragMsg('Reload failed: ' + e.message, true); }
    btn.disabled = false; btn.textContent = 'Reload Index';
  });
}

/* ═══════════════════════════════════════════
   SYSTEM TAB — Tokens
   ═══════════════════════════════════════════ */
async function loadTokens() {
  const list = el('adm-tokenList');
  try {
    const res = await fetch('/api/tokens', { credentials: 'same-origin' });
    const tokens = await res.json();
    if (!tokens.length) { list.innerHTML = '<div class="admin-empty">No API tokens</div>'; return; }
    list.innerHTML = tokens.map(t => `
      <div class="admin-user-row">
        <div class="admin-user-info" style="flex:1;flex-wrap:wrap;gap:0.3rem;">
          <span class="admin-user-name">${esc(t.name)}</span>
          <span class="admin-badge">${esc(t.token_prefix)}...</span>
          <span class="admin-badge" title="Allowed API scopes">${esc((t.scopes || ['chat']).join(', '))}</span>
          ${t.owner ? `<span style="font-size:0.75rem;opacity:0.5;">Owner: ${esc(t.owner)}</span>` : ''}
          ${t.last_used_at ? `<span style="font-size:0.75rem;opacity:0.5;">Last used: ${new Date(t.last_used_at).toLocaleDateString()}</span>` : '<span style="font-size:0.75rem;opacity:0.4;">Never used</span>'}
        </div>
        <button class="ow-btn ow-btn-compact ow-btn-destructive" data-adm-del-token="${t.id}">Revoke</button>
      </div>`).join('');
    list.querySelectorAll('[data-adm-del-token]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await uiModule.styledConfirm('Revoke this API token? External integrations using it will stop working.', { confirmText: 'Revoke', danger: true })) return;
        await fetch(`/api/tokens/${btn.dataset.admDelToken}`, { method: 'DELETE', credentials: 'same-origin' });
        loadTokens();
      });
    });
  } catch (e) { list.innerHTML = '<div class="admin-error">Failed to load tokens</div>'; }
}

function initTokenForm() {
  el('adm-tokenAddBtn').addEventListener('click', async () => {
    const msg = el('adm-tokenMsg');
    const reveal = el('adm-tokenReveal');
    msg.textContent = ''; msg.className = ''; reveal.style.display = 'none';
    const name = el('adm-tokenName').value.trim();
    if (!name) { msg.textContent = 'Token name is required'; msg.className = 'admin-error'; return; }
    const fd = new FormData(); fd.append('name', name);
    try {
      const res = await fetch('/api/tokens', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (res.ok) { el('adm-tokenValue').textContent = data.token; reveal.style.display = ''; el('adm-tokenName').value = ''; loadTokens(); }
      else { msg.textContent = data.detail || 'Failed'; msg.className = 'admin-error'; }
    } catch (e) { msg.textContent = 'Request failed'; msg.className = 'admin-error'; }
  });
  el('adm-tokenCopyBtn').addEventListener('click', () => {
    const val = el('adm-tokenValue').textContent;
    navigator.clipboard.writeText(val).then(() => {
      el('adm-tokenCopyBtn').textContent = 'Copied!';
      setTimeout(() => { el('adm-tokenCopyBtn').textContent = 'Copy'; }, 2000);
    });
  });
}

/* ── Webhooks ── */
async function loadWebhooks() {
  const list = el('adm-whList');
  try {
    const res = await fetch('/api/webhooks', { credentials: 'same-origin' });
    const hooks = await res.json();
    if (!hooks.length) { list.innerHTML = '<div class="admin-empty">No webhooks configured</div>'; return; }
    list.innerHTML = hooks.map(w => {
      const events = (w.events || []).map(e => `<span class="admin-badge">${esc(e)}</span>`).join(' ');
      const statusBadge = w.last_status_code
        ? `<span class="admin-badge" style="background:${w.last_status_code < 400 ? 'color-mix(in srgb, var(--fg) 20%, transparent)' : 'color-mix(in srgb, var(--red) 20%, transparent)'};color:${w.last_status_code < 400 ? 'var(--fg)' : 'var(--red)'};">${w.last_status_code}</span>`
        : '';
      const lastTriggered = w.last_triggered_at ? new Date(w.last_triggered_at).toLocaleString() : 'Never';
      const errorText = w.last_error ? `<div style="font-size:0.75rem;color:var(--red);margin-top:0.2rem;">Error: ${esc(w.last_error.substring(0, 80))}</div>` : '';
      return `
        <div class="admin-ep-item" style="flex-wrap:wrap;">
          <div class="admin-ep-info" style="flex:1;min-width:200px;">
            <div class="admin-ep-name">${esc(w.name)} ${w.is_active ? '' : '<span class="admin-badge admin-badge-off">disabled</span>'} ${w.has_secret ? '<span class="admin-badge">signed</span>' : ''}</div>
            <div class="admin-ep-detail">${esc(w.url)}</div>
            <div style="margin-top:0.3rem;">${events}</div>
            <div class="admin-ep-detail">Last: ${lastTriggered} ${statusBadge}</div>
            ${errorText}
          </div>
          <div class="admin-ep-actions">
            <button class="ow-btn ow-btn-compact" data-adm-wh-test="${w.id}">Test</button>
            <button class="ow-btn ow-btn-compact" data-adm-wh-toggle="${w.id}">${w.is_active ? 'Disable' : 'Enable'}</button>
            <button class="ow-btn ow-btn-compact ow-btn-destructive" data-adm-wh-delete="${w.id}">Delete</button>
          </div>
        </div>`;
    }).join('');
    list.querySelectorAll('[data-adm-wh-test]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const msg = el('adm-whMsg'); msg.textContent = 'Sending test...'; msg.className = '';
        try {
          const res = await fetch(`/api/webhooks/${btn.dataset.admWhTest}/test`, { method: 'POST', credentials: 'same-origin' });
          msg.textContent = res.ok ? 'Test sent!' : 'Test failed'; msg.className = res.ok ? 'admin-success' : 'admin-error';
          setTimeout(() => loadWebhooks(), 1000);
        } catch (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'admin-error'; }
      });
    });
    list.querySelectorAll('[data-adm-wh-toggle]').forEach(btn => {
      btn.addEventListener('click', async () => { await fetch(`/api/webhooks/${btn.dataset.admWhToggle}`, { method: 'PATCH', credentials: 'same-origin' }); loadWebhooks(); });
    });
    list.querySelectorAll('[data-adm-wh-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await uiModule.styledConfirm('Delete this webhook?', { confirmText: 'Delete', danger: true })) return;
        await fetch(`/api/webhooks/${btn.dataset.admWhDelete}`, { method: 'DELETE', credentials: 'same-origin' }); loadWebhooks();
      });
    });
  } catch (e) { list.innerHTML = '<div class="admin-error">Failed to load webhooks</div>'; }
}

function initWebhookForm() {
  el('adm-whAddBtn').addEventListener('click', async () => {
    const msg = el('adm-whMsg');
    msg.textContent = ''; msg.className = '';
    const name = el('adm-whName').value.trim();
    const url = el('adm-whUrl').value.trim();
    const secret = el('adm-whSecret').value.trim();
    const events = Array.from(modalEl.querySelectorAll('.adm-wh-event:checked')).map(e => e.value).join(',');
    if (!name) { msg.textContent = 'Name is required'; msg.className = 'admin-error'; return; }
    if (!url) { msg.textContent = 'URL is required'; msg.className = 'admin-error'; return; }
    if (!events) { msg.textContent = 'Select at least one event'; msg.className = 'admin-error'; return; }
    const fd = new FormData();
    fd.append('name', name); fd.append('url', url); fd.append('secret', secret); fd.append('events', events);
    try {
      const res = await fetch('/api/webhooks', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (res.ok) { msg.textContent = 'Webhook added'; msg.className = 'admin-success'; el('adm-whName').value = ''; el('adm-whUrl').value = ''; el('adm-whSecret').value = ''; loadWebhooks(); }
      else { const d = await res.json(); msg.textContent = d.detail || 'Failed'; msg.className = 'admin-error'; }
    } catch (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'admin-error'; }
  });
}

/* ── Features ── */
const featureLabels = {
  web_search: 'Web Search', deep_research: 'Deep Research',
  memory: 'Memory', document_editor: 'Document Editor', rag: 'RAG Knowledge Base', sensitive_filter: 'Sensitive Info Filter',
  gallery: 'Gallery'
};

async function loadFeatures() {
  const container = el('adm-featureToggles');
  try {
    const res = await fetch('/api/auth/features', { credentials: 'same-origin' });
    const features = await res.json();
    container.innerHTML = Object.entries(featureLabels).map(([key, label]) => `
      <div class="admin-toggle-row" style="padding:0.4rem 0;border-bottom:1px solid var(--border);">
        <div class="admin-toggle-label">${label}</div>
        <label class="ow-switch"><input type="checkbox" data-adm-feature="${key}" ${features[key] ? 'checked' : ''}><span class="ow-switch-track"></span></label>
      </div>`).join('');
    container.querySelectorAll('input[data-adm-feature]').forEach(toggle => {
      toggle.addEventListener('change', async () => {
        const body = {}; body[toggle.dataset.admFeature] = toggle.checked;
        await fetch('/api/auth/features', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      });
    });
  } catch (e) { container.innerHTML = '<div class="admin-error">Failed to load features</div>'; }
}

/* ── CalDAV Config ── */
function initCalDAV() {
  const urlIn = el('caldav-url');
  const userIn = el('caldav-user');
  const passIn = el('caldav-pass');
  const saveBtn = el('caldav-save-btn');
  const testBtn = el('caldav-test-btn');
  const status = el('caldav-status');
  if (!urlIn || !saveBtn) return;

  // Load current config
  fetch(`${API_BASE}/api/calendar/config`, { credentials: 'same-origin' })
    .then(r => r.json()).then(d => {
      urlIn.value = d.caldav_url || '';
      userIn.value = d.caldav_username || '';
      passIn.value = d.caldav_password || '';
    }).catch(() => {});

  saveBtn.addEventListener('click', async () => {
    status.textContent = 'Saving...';
    try {
      const res = await fetch(`${API_BASE}/api/calendar/config`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caldav_url: urlIn.value, caldav_username: userIn.value, caldav_password: passIn.value }),
      });
      const d = await res.json();
      status.textContent = d.ok ? 'Saved' : 'Error';
      status.style.color = d.ok ? 'var(--green)' : 'var(--red)';
    } catch (e) { status.textContent = 'Error'; status.style.color = 'var(--red)'; }
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3000);
  });

  testBtn.addEventListener('click', async () => {
    status.textContent = 'Testing...';
    try {
      // Save first
      await fetch(`${API_BASE}/api/calendar/config`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caldav_url: urlIn.value, caldav_username: userIn.value, caldav_password: passIn.value }),
      });
      const res = await fetch(`${API_BASE}/api/calendar/test`, { method: 'POST', credentials: 'same-origin' });
      const d = await res.json();
      status.textContent = d.ok ? `Connected (${d.calendars} calendars)` : `Failed: ${d.error}`;
      status.style.color = d.ok ? 'var(--green)' : 'var(--red)';
    } catch (e) { status.textContent = 'Error'; status.style.color = 'var(--red)'; }
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 5000);
  });
}

/* ── Data Backup (export/import) ── */
function initBackup() {
  el('adm-exportDataBtn').addEventListener('click', async () => {
    const btn = el('adm-exportDataBtn');
    const msg = el('adm-backupMsg');
    btn.disabled = true; btn.textContent = 'Exporting...'; msg.textContent = '';
    try {
      const res = await fetch('/api/export', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename=(.+)/);
      const filename = match ? match[1] : 'orwell_backup.json';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      msg.textContent = 'Export downloaded.'; msg.className = 'admin-success';
    } catch (e) { msg.textContent = 'Export failed: ' + e.message; msg.className = 'admin-error'; }
    btn.disabled = false; btn.textContent = 'Export Data';
  });

  const fileInput = el('adm-importFile');
  el('adm-importDataBtn').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const msg = el('adm-backupMsg');
    const btn = el('adm-importDataBtn');
    btn.disabled = true; btn.textContent = 'Importing...'; msg.textContent = '';
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '').trim();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('Invalid backup file: ' + e.message);
      }
      const res = await fetch('/api/import', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json().catch(() => null);
      if (!result) {
        throw new Error(`Import failed: server returned ${res.status}`);
      }
      if (res.ok && result.ok) {
        msg.textContent = result.message || 'Import successful.'; msg.className = 'admin-success';
      } else {
        msg.textContent = result.message || result.detail || 'Import failed'; msg.className = 'admin-error';
      }
    } catch (e) { msg.textContent = 'Import failed: ' + e.message; msg.className = 'admin-error'; }
    btn.disabled = false; btn.textContent = 'Import Data';
  });
}

/* ── Danger Zone ── */
function initDangerZone() {
  // Per-category Danger Zone wipes. Each button declares its target
  // via data-wipe-kind; one delegated handler handles double-confirm,
  // POSTs to /api/admin/wipe/{kind}, and writes the result.
  const _LABELS = {
    chats: 'chats', memory: 'memory entries', skills: 'skills',
    notes: 'notes', tasks: 'tasks', documents: 'documents',
    gallery: 'gallery images', calendar: 'calendar items',
  };
  const _wipeMsg = el('adm-wipeMsg');
  modalEl.querySelectorAll('[data-wipe-kind]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.wipeKind;
      const label = _LABELS[kind] || kind;
      if (!await uiModule.styledConfirm(`Wipe ALL ${label}? This cannot be undone.`, { confirmText: 'Wipe', danger: true })) return;
      if (!await uiModule.styledConfirm(`Really wipe every one of your ${label}?`, { confirmText: 'Yes, wipe everything', danger: true })) return;
      btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Wiping…';
      if (_wipeMsg) { _wipeMsg.textContent = ''; _wipeMsg.className = ''; }
      try {
        const res = await fetch(`/api/admin/wipe/${kind}`, { method: 'DELETE', credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          if (_wipeMsg) { _wipeMsg.textContent = `Wiped ${data.count ?? 0} ${label}.`; _wipeMsg.className = 'admin-success'; }
        } else {
          if (_wipeMsg) { _wipeMsg.textContent = data.detail || 'Failed'; _wipeMsg.className = 'admin-error'; }
        }
      } catch (e) {
        if (_wipeMsg) { _wipeMsg.textContent = 'Request failed: ' + e.message; _wipeMsg.className = 'admin-error'; }
      }
      btn.disabled = false; btn.textContent = prev;
    });
  });
}

/* ── Transcripts (Feature 0053) — quiet, read-only admin debug access ── */
function initTranscripts() {
  const card = el('adm-transcripts-card');
  if (!card) return;  // not rendered (non-admin DOM) — nothing to wire
  const listEl = el('adm-transcripts-list');
  const filterEl = el('adm-transcripts-filter');
  const loadBtn = el('adm-transcripts-load');
  const msgEl = el('adm-transcripts-msg');

  async function load() {
    if (msgEl) { msgEl.textContent = 'Loading…'; msgEl.className = ''; }
    const owner = (filterEl && filterEl.value || '').trim();
    const qs = new URLSearchParams();
    if (owner) qs.set('user', owner);
    try {
      const res = await fetch('/api/admin/transcripts?' + qs.toString(), { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = data.detail || 'Failed'; msgEl.className = 'admin-error'; }
        return;
      }
      render(data.transcripts || []);
      if (msgEl) {
        msgEl.textContent = `${(data.transcripts || []).length} of ${data.total ?? 0} session(s).`;
        msgEl.className = 'admin-toggle-sub';
      }
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Request failed: ' + e.message; msgEl.className = 'admin-error'; }
    }
  }

  function render(rows) {
    if (!listEl) return;
    if (!rows.length) { listEl.innerHTML = '<div class="admin-toggle-sub">No sessions.</div>'; return; }
    listEl.innerHTML = rows.map(r => `
      <div class="settings-row settings-row--end settings-gap-top">
        <div>
          <div class="admin-toggle-label">${esc(r.title || r.id)}${r.is_game_session ? ' <span class="admin-badge">GAME</span>' : ''}</div>
          <div class="admin-toggle-sub">${esc(r.owner || '(unknown)')} · ${r.message_count ?? 0} msg · ${esc((r.updated_at || '').slice(0, 16).replace('T', ' '))}</div>
        </div>
        <div style="display:flex;gap:6px;white-space:nowrap;">
          <a class="ow-btn ow-btn-compact" style="text-decoration:none;" href="/api/admin/transcripts/${encodeURIComponent(r.id)}?format=json" target="_blank" rel="noopener">JSON</a>
          <a class="ow-btn ow-btn-compact" style="text-decoration:none;" href="/api/admin/transcripts/${encodeURIComponent(r.id)}?format=md" target="_blank" rel="noopener">MD</a>
        </div>
      </div>`).join('');
  }

  if (loadBtn) loadBtn.addEventListener('click', load);
  if (filterEl) filterEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
}

/* ── Health & Logs (Lane G1) — UI-based health checking + the failure log ── */
function initHealthLogs() {
  const card = el('adm-health-card');
  if (!card) return;  // not rendered (non-admin DOM) — nothing to wire
  const rowsEl = el('adm-health-rows');
  const refreshBtn = el('adm-health-refresh');
  const msgEl = el('adm-health-msg');

  // #1644 (rendered audit §2 / HIG "apply colour to the background not the text"): green/red status
  // TEXT on a faint 16%-tint fill measured ~2.1:1. Convey status via an OPAQUE pastel status fill +
  // a DARK ink on it — reads ≥7:1 on ANY theme (the flat presets carry no polarity class to scope a
  // light-only fix), and colour still signals ok/fail through the fill.
  const badge = (ok, text) => _adminStatusBadge(ok, text);

  const row = (label, valueHtml) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px;">
      <div class="admin-toggle-label">${esc(label)}</div>
      <div class="admin-toggle-sub" style="text-align:right;">${valueHtml}</div>
    </div>`;

  const fmtUptime = (s) => {
    s = Math.max(0, Number(s) || 0);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${Math.floor(s)}s`;
  };

  function render(d) {
    const eng = d.engine || {};
    const rows = [];
    // Build (deployed checkout's short commit SHA) + version (PR-derived "vX.XX"), for
    // one-glance "what is running here?" triage. Absent on a history-less/old engine ⇒ skipped.
    const ver = d.versions || {};
    const verBits = [];
    if (ver.build) verBits.push(esc(String(ver.build)));
    if (ver.frontend) verBits.push(esc(String(ver.frontend)));
    if (verBits.length) rows.push(row('Build · version', verBits.join(' · ')));
    let engineVal = badge(!!eng.ok, eng.ok ? 'REACHABLE' : 'DOWN');
    if (eng.latencyMs != null) engineVal += ` ${esc(String(eng.latencyMs))} ms`;
    if (eng.uptimeSeconds != null) engineVal += ` · up ${esc(fmtUptime(eng.uptimeSeconds))}`;
    if (eng.error) engineVal += ` · ${esc(eng.error)}`;
    rows.push(row('Engine', engineVal));
    rows.push(row('Tiers agree', badge(!!d.tiersAgree, d.tiersAgree ? 'YES' : 'NO')));
    const emb = eng.embeddings;
    if (emb) {
      rows.push(row('Embeddings', `${esc(emb.provider || '?')} ${emb.degraded ? badge(false, 'DEGRADED') : badge(true, 'OK')}`));
    } else {
      rows.push(row('Embeddings', badge(false, 'UNKNOWN')));
    }
    const img = d.images || {};
    let imgVal = img.available ? badge(true, 'AVAILABLE') : badge(false, img.enabled ? 'NO USABLE MODEL' : 'DISABLED');
    if (img.model) imgVal += ` ${esc(img.model)}`;
    // G20: portrait completeness over the active cast (the reconciler retries the gap).
    const por = img.portraits;
    if (por && por.total) imgVal += ` · ${badge(!por.missing, `portraits ${por.present}/${por.total}`)}`;
    rows.push(row('Image generation', imgVal));
    const tc = eng.toolCalls;
    if (tc) rows.push(row('Tool calls (since engine start)', `${esc(String(tc.total ?? 0))} total · ${esc(String(tc.failed ?? 0))} failed`));
    const store = (d.frontend || {}).store || {};
    if (store.sessions != null) {
      rows.push(row('Front-end store', `${esc(String(store.sessions))} session(s) · ${esc(String(store.messages ?? 0))} message(s)` +
        (store.database_size_mb != null ? ` · ${esc(String(store.database_size_mb))} MB` : '')));
    }
    if (rowsEl) rowsEl.innerHTML = rows.join('');

    // G1b: the failure log moved to the standalone /admin/status page.
  }

  async function load() {
    if (msgEl) { msgEl.textContent = 'Checking…'; msgEl.className = ''; }
    try {
      const res = await fetch('/api/admin/health', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = data.detail || 'Failed'; msgEl.className = 'admin-error'; }
        return;
      }
      render(data);
      if (msgEl) { msgEl.textContent = `Checked ${new Date().toLocaleTimeString()}.`; msgEl.className = 'admin-toggle-sub'; }
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Request failed: ' + e.message; msgEl.className = 'admin-error'; }
    }
  }

  if (refreshBtn) refreshBtn.addEventListener('click', load);

  // DEBUG · owner override of mandate #2: the SPOILER bundle download. The plain
  // "Download debug bundle" <a> above stays Vault-free; this button navigates to ?vault=1 (the
  // route's explicit opt-in) so the downloaded JSON ALSO carries the live Producer's Vault — behind
  // the same spoiler confirm as the status-page unseal. The default download is untouched.
  const bundleVaultBtn = el('adm-health-bundle-vault');
  if (bundleVaultBtn) bundleVaultBtn.addEventListener('click', () => {
    if (!confirm("DOWNLOAD THE DEBUG BUNDLE WITH THE PRODUCER'S VAULT?\n\nThe downloaded file will deliberately INCLUDE your LIVE game's SECRETS — off-screen scheming, NPC confessionals, hidden ties, the sealed twists, and the real eviction votes. It overrides the God-Mode Vault wall (mandate #2) for debugging.\n\nThis file WILL spoil your in-progress game — do not share it. Continue?")) return;
    window.location.href = '/api/admin/debug-bundle?vault=1';
  });

  load();  // live rows on open — the card is a health surface, not a form
}

/* ── Public deployment (0068) — the "Connect to the internet" operator console ──
   Mirrors initHealthLogs: load + render the public-exposure posture + a green/amber
   security checklist, drive the Connect wizard (apply → poll ops-status), and the
   Disconnect button. The connector TOKEN is WRITE-ONLY — it is sent on apply and is
   never rendered back (status reports installed/active/url, never the token). */
function initPublicDeployment() {
  const card = el('adm-public-deployment-card');
  if (!card) return;  // not rendered (non-admin DOM) — nothing to wire

  const statusEl = el('adm-pubdep-status');
  const checklistEl = el('adm-pubdep-checklist');
  const wizardEl = el('adm-pubdep-wizard');
  const toggleBtn = el('adm-pubdep-connect-toggle');
  const applyBtn = el('adm-pubdep-apply');
  const disconnectBtn = el('adm-pubdep-disconnect');
  const domainsInput = el('adm-pubdep-domains');
  const originsInput = el('adm-pubdep-origins');
  const tokenInput = el('adm-pubdep-token');
  const progressEl = el('adm-pubdep-progress');
  const msgEl = el('adm-pubdep-msg');

  let pollTimer = null;

  // #1644 (rendered audit §2 / HIG): status via an OPAQUE pastel fill + DARK ink (green ok / amber
  // not-ok) — theme-independent, ≥6:1, colour still carried by the fill (the flat presets have no
  // polarity class for a light-only ink fix).
  const badge = (ok, text) => _adminStatusBadge(ok, text, '#ffe2b3', '#7a4f00');

  const row = (label, valueHtml) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px;">
      <div class="admin-toggle-label">${esc(label)}</div>
      <div class="admin-toggle-sub" style="text-align:right;">${valueHtml}</div>
    </div>`;

  function renderStatus(d) {
    const t = d.tunnel || {};
    const rows = [];
    rows.push(row('Internet exposure', badge(!!d.enabled, d.enabled ? 'PUBLIC' : 'LAN-ONLY')));
    rows.push(row('Front-end bind', `<span class="admin-toggle-sub">${esc(d.bindHost || '?')}</span>`));
    const hosts = Array.isArray(d.allowedHosts) ? d.allowedHosts : [];
    rows.push(row('Allowed hosts', hosts.length ? `<span class="admin-toggle-sub">${esc(hosts.join(', '))}</span>` : badge(false, 'NONE')));
    let tunnelVal = badge(!!t.installed, t.installed ? 'INSTALLED' : 'NOT INSTALLED');
    tunnelVal += ' ' + badge(!!t.active, t.active ? 'ACTIVE' : 'INACTIVE');
    rows.push(row('Cloudflare tunnel', tunnelVal));
    if (t.publicUrl) {
      rows.push(row('Public URL', `<a href="${esc(t.publicUrl)}" target="_blank" rel="noopener">${esc(t.publicUrl)}</a>`));
    }
    if (statusEl) statusEl.innerHTML = rows.join('');

    // The green/amber security checklist (each is a posture boolean from the status route).
    const checks = [
      ['Authentication on', !!d.authEnabled],
      ['Secure cookies', !!d.secureCookies],
      ['Host pinned', !!d.hostPinned],
    ];
    if (checklistEl) {
      checklistEl.innerHTML = checks.map(([label, ok]) =>
        row(label, badge(ok, ok ? 'OK' : 'CHECK'))).join('');
    }
  }

  async function load() {
    if (msgEl) { msgEl.textContent = 'Checking…'; msgEl.className = ''; }
    try {
      const res = await fetch('/api/admin/public-deployment-status', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = data.detail || 'Failed'; msgEl.className = 'admin-error'; }
        return;
      }
      renderStatus(data);
      // Reflect a prior apply's progress (if the ops file remembers one).
      if (data.lastApply) renderProgress(data.lastApply);
      if (msgEl) { msgEl.textContent = `Checked ${new Date().toLocaleTimeString()}.`; msgEl.className = 'admin-toggle-sub'; }
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Request failed: ' + e.message; msgEl.className = 'admin-error'; }
    }
  }

  function renderProgress(s) {
    if (!progressEl) return;
    if (!s) { progressEl.innerHTML = ''; return; }
    const step = (s.step != null && s.total) ? `${s.step}/${s.total} · ` : '';
    let cls = 'admin-toggle-sub';
    let label = s.message || (s.running ? 'Working…' : (s.ok ? 'Done.' : ''));
    if (s.error) { cls = 'admin-error'; label = s.error; }
    else if (s.ok && !s.running) { cls = 'admin-toggle-sub'; }
    progressEl.innerHTML = `<div class="${cls}">${esc(step + (label || ''))}</div>`;
  }

  // Poll the shared ops-status endpoint for the "public-deployment" action until it settles.
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/admin/ops-status', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        const s = data && data.actions ? data.actions['public-deployment'] : null;
        renderProgress(s);
        if (s && !s.running) {
          clearInterval(pollTimer); pollTimer = null;
          load();  // refresh posture once the apply settles
        }
      } catch (_) { /* a transient poll error is non-fatal — keep polling */ }
    }, 2000);
  }

  async function apply() {
    const domains = (domainsInput && domainsInput.value || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const allowedOrigins = (originsInput && originsInput.value || '').trim() || null;
    const tunnelToken = (tokenInput && tokenInput.value || '').trim() || null;
    if (!domains.length) {
      if (msgEl) { msgEl.textContent = 'Enter at least one domain.'; msgEl.className = 'admin-error'; }
      return;
    }
    if (applyBtn) applyBtn.disabled = true;
    if (msgEl) { msgEl.textContent = 'Connecting…'; msgEl.className = 'admin-toggle-sub'; }
    try {
      const res = await fetch('/api/admin/public-deployment/apply', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains, allowedOrigins, tunnelToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = data.detail || 'Apply failed.'; msgEl.className = 'admin-error'; }
        return;
      }
      if (tokenInput) tokenInput.value = '';  // never keep the token around in the DOM
      if (data.started) {
        if (msgEl) { msgEl.textContent = 'Applying — this restarts the front-end to take effect.'; msgEl.className = 'admin-toggle-sub'; }
        startPolling();
      } else {
        if (msgEl) { msgEl.textContent = data.error || 'Could not start the apply.'; msgEl.className = 'admin-error'; }
      }
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Request failed: ' + e.message; msgEl.className = 'admin-error'; }
    } finally {
      if (applyBtn) applyBtn.disabled = false;
    }
  }

  async function disconnect() {
    if (disconnectBtn) disconnectBtn.disabled = true;
    if (msgEl) { msgEl.textContent = 'Disconnecting…'; msgEl.className = 'admin-toggle-sub'; }
    try {
      const res = await fetch('/api/admin/public-deployment/disconnect', {
        method: 'POST', credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = data.detail || 'Disconnect failed.'; msgEl.className = 'admin-error'; }
        return;
      }
      if (data.started) {
        if (msgEl) { msgEl.textContent = 'Disconnecting — returning to LAN-only.'; msgEl.className = 'admin-toggle-sub'; }
        startPolling();
      } else {
        if (msgEl) { msgEl.textContent = data.error || 'Could not start the disconnect.'; msgEl.className = 'admin-error'; }
      }
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Request failed: ' + e.message; msgEl.className = 'admin-error'; }
    } finally {
      if (disconnectBtn) disconnectBtn.disabled = false;
    }
  }

  if (toggleBtn && wizardEl) {
    toggleBtn.addEventListener('click', () => {
      wizardEl.hidden = !wizardEl.hidden;
      toggleBtn.textContent = wizardEl.hidden ? 'Connect to the internet' : 'Hide wizard';
    });
  }
  if (applyBtn) applyBtn.addEventListener('click', apply);
  if (disconnectBtn) disconnectBtn.addEventListener('click', disconnect);
  load();  // live posture on open — the card is a status surface, not a form
}

function initLocalTls() {
  const card = el('adm-tls-card');
  if (!card) return;  // not rendered (non-admin DOM) — nothing to wire

  const statusEl = el('adm-tls-status');
  const caEl = el('adm-tls-ca');
  const wizardEl = el('adm-tls-wizard');
  const toggleBtn = el('adm-tls-enable-toggle');
  const applyBtn = el('adm-tls-apply');
  const disableBtn = el('adm-tls-disable');
  const localNamesInput = el('adm-tls-local-names');
  const domainsInput = el('adm-tls-domains');
  const dnsProviderInput = el('adm-tls-dns-provider');
  const dnsTokenInput = el('adm-tls-dns-token');
  const progressEl = el('adm-tls-progress');
  const msgEl = el('adm-tls-msg');

  let pollTimer = null;

  // #1644 (rendered audit §2 / HIG): status via an OPAQUE pastel fill + DARK ink (green ok / amber
  // not-ok) — theme-independent, ≥6:1, colour still carried by the fill (the flat presets have no
  // polarity class for a light-only ink fix).
  const badge = (ok, text) => _adminStatusBadge(ok, text, '#ffe2b3', '#7a4f00');

  const row = (label, valueHtml) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px;">
      <div class="admin-toggle-label">${esc(label)}</div>
      <div class="admin-toggle-sub" style="text-align:right;">${valueHtml}</div>
    </div>`;

  function renderStatus(d) {
    const rows = [];
    const on = (d.mode === 'local');
    rows.push(row('Local HTTPS', badge(on, on ? 'ON' : 'OFF')));
    const names = Array.isArray(d.localNames) ? d.localNames : [];
    rows.push(row('Local names', names.length ? `<span class="admin-toggle-sub">${esc(names.join(', '))}</span>` : badge(false, 'NONE')));
    const domains = Array.isArray(d.domains) ? d.domains : [];
    if (domains.length) rows.push(row('Public domain (trusted)', `<span class="admin-toggle-sub">${esc(domains.join(', '))}</span>`));
    const c = d.caddy || {};
    rows.push(row('Terminator (Caddy)', badge(!!c.installed, c.installed ? 'INSTALLED' : 'NOT INSTALLED') + ' ' + badge(!!c.active, c.active ? 'ACTIVE' : 'INACTIVE')));
    rows.push(row('Secure cookies', badge(!!d.secureCookies, d.secureCookies ? 'OK' : 'OFF')));
    if (statusEl) statusEl.innerHTML = rows.join('');

    // The CA-root download — the one-time step that kills the browser warning on the local names.
    const ca = d.rootCa || {};
    if (caEl) {
      if (on && ca.available && ca.downloadUrl) {
        caEl.innerHTML =
          `<div class="admin-toggle-label">Trust the local certificate (one time per device)</div>` +
          `<div class="settings-row" style="margin-top:6px;"><a class="ow-btn ow-btn-prominent" style="text-decoration:none;" href="${esc(ca.downloadUrl)}" download>Download CA root</a></div>` +
          `<div class="admin-toggle-sub" style="margin-top:6px;">Install it as a trusted root: macOS → Keychain ▸ System ▸ Always Trust · Windows → Local Machine ▸ Trusted Root CAs · iOS → install profile, then Settings ▸ General ▸ About ▸ Certificate Trust · Android → Settings ▸ Security ▸ Install certificate.</div>`;
      } else {
        caEl.innerHTML = '';
      }
    }
  }

  async function load() {
    if (msgEl) { msgEl.textContent = 'Checking…'; msgEl.className = ''; }
    try {
      const res = await fetch('/api/admin/tls-status', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = data.detail || 'Failed'; msgEl.className = 'admin-error'; }
        return;
      }
      renderStatus(data);
      if (data.lastApply) renderProgress(data.lastApply);
      if (msgEl) { msgEl.textContent = `Checked ${new Date().toLocaleTimeString()}.`; msgEl.className = 'admin-toggle-sub'; }
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Request failed: ' + e.message; msgEl.className = 'admin-error'; }
    }
  }

  function renderProgress(s) {
    if (!progressEl) return;
    if (!s) { progressEl.innerHTML = ''; return; }
    const step = (s.step != null && s.total) ? `${s.step}/${s.total} · ` : '';
    let cls = 'admin-toggle-sub';
    let label = s.message || (s.running ? 'Working…' : (s.ok ? 'Done.' : ''));
    if (s.error) { cls = 'admin-error'; label = s.error; }
    progressEl.innerHTML = `<div class="${cls}">${esc(step + (label || ''))}</div>`;
  }

  // Poll the shared ops-status endpoint for the "tls" action until it settles.
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/admin/ops-status', { credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        const s = data && data.actions ? data.actions['tls'] : null;
        renderProgress(s);
        if (s && !s.running) {
          clearInterval(pollTimer); pollTimer = null;
          load();  // refresh posture once the apply settles
        }
      } catch (_) { /* a transient poll error is non-fatal — keep polling */ }
    }, 2000);
  }

  async function apply() {
    const localNames = (localNamesInput && localNamesInput.value || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const domains = (domainsInput && domainsInput.value || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const dnsProvider = (dnsProviderInput && dnsProviderInput.value || '').trim() || null;
    const dnsApiToken = (dnsTokenInput && dnsTokenInput.value || '').trim() || null;
    if (applyBtn) applyBtn.disabled = true;
    if (msgEl) { msgEl.textContent = 'Enabling…'; msgEl.className = 'admin-toggle-sub'; }
    try {
      const res = await fetch('/api/admin/tls/apply', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localNames, domains, dnsProvider, dnsApiToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = data.detail || 'Apply failed.'; msgEl.className = 'admin-error'; }
        return;
      }
      if (dnsTokenInput) dnsTokenInput.value = '';  // never keep the token around in the DOM
      if (data.started) {
        if (msgEl) { msgEl.textContent = 'Enabling — this restarts the front-end to take effect.'; msgEl.className = 'admin-toggle-sub'; }
        startPolling();
      } else {
        if (msgEl) { msgEl.textContent = data.error || 'Could not start the apply.'; msgEl.className = 'admin-error'; }
      }
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Request failed: ' + e.message; msgEl.className = 'admin-error'; }
    } finally {
      if (applyBtn) applyBtn.disabled = false;
    }
  }

  async function disable() {
    if (disableBtn) disableBtn.disabled = true;
    if (msgEl) { msgEl.textContent = 'Disabling…'; msgEl.className = 'admin-toggle-sub'; }
    try {
      const res = await fetch('/api/admin/tls/disconnect', {
        method: 'POST', credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) { msgEl.textContent = data.detail || 'Disable failed.'; msgEl.className = 'admin-error'; }
        return;
      }
      if (data.started) {
        if (msgEl) { msgEl.textContent = 'Disabling — returning to plain HTTP.'; msgEl.className = 'admin-toggle-sub'; }
        startPolling();
      } else {
        if (msgEl) { msgEl.textContent = data.error || 'Could not start the disable.'; msgEl.className = 'admin-error'; }
      }
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Request failed: ' + e.message; msgEl.className = 'admin-error'; }
    } finally {
      if (disableBtn) disableBtn.disabled = false;
    }
  }

  if (toggleBtn && wizardEl) {
    toggleBtn.addEventListener('click', () => {
      wizardEl.hidden = !wizardEl.hidden;
      toggleBtn.textContent = wizardEl.hidden ? 'Enable local HTTPS' : 'Hide';
    });
  }
  if (applyBtn) applyBtn.addEventListener('click', apply);
  if (disableBtn) disableBtn.addEventListener('click', disable);
  load();  // live posture on open — the card is a status surface, not a form
}

/* ═══════════════════════════════════════════
   LOGIN BACKGROUND (#764) — admin config for the pre-auth login glass page's
   animated background. Source picker + per-source rich controls (gradient
   palette/speed/intensity, particle density/speed/color, photo upload + URL).
   The card is BUILT here and injected into the (admin) services panel so we
   don't touch index.html; it persists via the admin-gated POST /api/auth/settings
   and a photo POST /api/auth/login-background/photo. The login page READS the
   cosmetic-only public GET. (The deferred #765 admin glass pass will reskin it.)
   ═══════════════════════════════════════════ */
function initLoginBackground() {
  // Inject once, into the admin "services" panel (the default admin tab).
  if (el('adm-loginbg-card')) return;
  const panel = document.querySelector('[data-settings-panel="services"]');
  if (!panel) return;  // non-admin DOM — nothing to wire

  const PRESETS = ['aurora', 'sunset', 'ocean', 'gold', 'lavender'];
  const card = document.createElement('div');
  card.className = 'admin-card';
  card.id = 'adm-loginbg-card';
  card.innerHTML = `
    <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;opacity:0.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>Login background</h2>
    <div class="admin-toggle-sub" style="margin-bottom:10px">The animated background behind the sign-in glass panel (shown to everyone before they log in). Cosmetic only.</div>

    <div class="admin-model-form-row" style="align-items:center;gap:8px;">
      <label for="adm-loginbg-source" class="admin-toggle-label" style="flex:0 0 70px;">Source</label>
      <select id="adm-loginbg-source" class="ow-select" style="flex:1;">
        <option value="gradient">Animated gradient</option>
        <option value="particles">Particles</option>
        <option value="photo">Photo</option>
        <option value="bundled">Bundled pattern</option>
      </select>
    </div>

    <!-- Gradient settings -->
    <div id="adm-loginbg-grp-gradient" class="adm-loginbg-group" style="margin-top:8px;">
      <div class="admin-model-form-row" style="align-items:center;gap:8px;">
        <label for="adm-loginbg-preset" class="admin-toggle-label" style="flex:0 0 70px;">Palette</label>
        <select id="adm-loginbg-preset" class="ow-select" style="flex:1;">
          <option value="aurora">Aurora</option>
          <option value="sunset">Sunset</option>
          <option value="ocean">Ocean</option>
          <option value="gold">Gold / Teal</option>
          <option value="lavender">Lavender</option>
        </select>
      </div>
      <div class="admin-model-form-row" style="align-items:center;gap:8px;">
        <label for="adm-loginbg-gspeed" class="admin-toggle-label" style="flex:0 0 70px;">Speed</label>
        <input id="adm-loginbg-gspeed" type="range" class="ow-slider" min="8" max="60" step="1" style="flex:1;">
        <span id="adm-loginbg-gspeed-val" class="admin-toggle-sub" style="flex:0 0 46px;text-align:right;"></span>
      </div>
      <div class="admin-model-form-row" style="align-items:center;gap:8px;">
        <label for="adm-loginbg-gint" class="admin-toggle-label" style="flex:0 0 70px;">Intensity</label>
        <input id="adm-loginbg-gint" type="range" class="ow-slider" min="0.4" max="1.4" step="0.05" style="flex:1;">
        <span id="adm-loginbg-gint-val" class="admin-toggle-sub" style="flex:0 0 46px;text-align:right;"></span>
      </div>
    </div>

    <!-- Particle settings -->
    <div id="adm-loginbg-grp-particles" class="adm-loginbg-group" style="margin-top:8px;">
      <div class="admin-model-form-row" style="align-items:center;gap:8px;">
        <label for="adm-loginbg-pdensity" class="admin-toggle-label" style="flex:0 0 70px;">Density</label>
        <input id="adm-loginbg-pdensity" type="range" class="ow-slider" min="12" max="160" step="1" style="flex:1;">
        <span id="adm-loginbg-pdensity-val" class="admin-toggle-sub" style="flex:0 0 46px;text-align:right;"></span>
      </div>
      <div class="admin-model-form-row" style="align-items:center;gap:8px;">
        <label for="adm-loginbg-pspeed" class="admin-toggle-label" style="flex:0 0 70px;">Speed</label>
        <input id="adm-loginbg-pspeed" type="range" class="ow-slider" min="0.05" max="1.2" step="0.05" style="flex:1;">
        <span id="adm-loginbg-pspeed-val" class="admin-toggle-sub" style="flex:0 0 46px;text-align:right;"></span>
      </div>
      <div class="admin-model-form-row" style="align-items:center;gap:8px;">
        <label for="adm-loginbg-pcolor" class="admin-toggle-label" style="flex:0 0 70px;">Dot color</label>
        <input id="adm-loginbg-pcolor" type="text" class="ow-field" placeholder="default (white) — e.g. #9cdef2" style="flex:1;">
      </div>
    </div>

    <!-- Photo settings -->
    <div id="adm-loginbg-grp-photo" class="adm-loginbg-group" style="margin-top:8px;">
      <div class="admin-model-form-row" style="align-items:center;gap:8px;">
        <button class="ow-btn ow-btn-secondary" id="adm-loginbg-upload-btn" type="button">Upload image…</button>
        <input id="adm-loginbg-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none;">
        <span id="adm-loginbg-upload-status" class="admin-toggle-sub" style="flex:1;"></span>
      </div>
      <div class="admin-model-form-row" style="align-items:center;gap:8px;">
        <label for="adm-loginbg-photourl" class="admin-toggle-label" style="flex:0 0 70px;">or URL</label>
        <input id="adm-loginbg-photourl" type="text" class="ow-field" placeholder="https://… or /static/…" style="flex:1;">
      </div>
    </div>

    <div class="admin-model-form-row" style="align-items:center;gap:8px;margin-top:10px;">
      <span style="flex:1"></span>
      <span id="adm-loginbg-msg" class="admin-toggle-sub"></span>
      <button class="ow-btn ow-btn-prominent" id="adm-loginbg-save" type="button" style="min-width:80px;text-align:center;">Save</button>
    </div>

    <!-- Element-kit demo link (#773) — a Developer/Design reference of the shared
         OrwellElement primitives. Admin-gated chrome; opens in a new tab. Composes
         the kit .ow-btn .ow-btn-secondary (the standard neutral-glass action). -->
    <div class="admin-model-form-row" style="align-items:center;gap:8px;margin-top:6px;border-top:1px solid var(--border);padding-top:10px;">
      <span class="admin-toggle-sub" style="flex:1">Design reference</span>
      <a class="ow-btn ow-btn-secondary" id="adm-loginbg-kitdemo" href="/static/element_kit_demo.html" target="_blank" rel="noopener" style="text-decoration:none;font-size:0.85rem;padding:6px 14px;">Element kit demo</a>
    </div>`;
  panel.appendChild(card);

  const $ = (id) => el(id);
  const sourceSel = $('adm-loginbg-source');
  const presetSel = $('adm-loginbg-preset');
  const gspeed = $('adm-loginbg-gspeed'), gspeedVal = $('adm-loginbg-gspeed-val');
  const gint = $('adm-loginbg-gint'), gintVal = $('adm-loginbg-gint-val');
  const pdensity = $('adm-loginbg-pdensity'), pdensityVal = $('adm-loginbg-pdensity-val');
  const pspeed = $('adm-loginbg-pspeed'), pspeedVal = $('adm-loginbg-pspeed-val');
  const pcolor = $('adm-loginbg-pcolor');
  const photoUrl = $('adm-loginbg-photourl');
  const fileInput = $('adm-loginbg-file');
  const uploadBtn = $('adm-loginbg-upload-btn');
  const uploadStatus = $('adm-loginbg-upload-status');
  const msg = $('adm-loginbg-msg');
  const saveBtn = $('adm-loginbg-save');

  function syncGroups() {
    const src = sourceSel.value;
    $('adm-loginbg-grp-gradient').style.display = (src === 'photo' || src === 'bundled') ? 'none' : '';
    $('adm-loginbg-grp-particles').style.display = (src === 'particles') ? '' : 'none';
    $('adm-loginbg-grp-photo').style.display = (src === 'photo') ? '' : 'none';
  }
  function syncLabels() {
    if (gspeedVal) gspeedVal.textContent = gspeed.value + 's';
    if (gintVal) gintVal.textContent = Number(gint.value).toFixed(2);
    if (pdensityVal) pdensityVal.textContent = pdensity.value;
    if (pspeedVal) pspeedVal.textContent = Number(pspeed.value).toFixed(2);
  }
  sourceSel.addEventListener('change', syncGroups);
  [gspeed, gint, pdensity, pspeed].forEach(r => r.addEventListener('input', syncLabels));

  // Load current config from the public cosmetic GET (admin reads the same shape).
  fetch('/api/auth/login-background', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => {
      sourceSel.value = PRESETS && d.source ? d.source : 'gradient';
      const g = d.gradient || {};
      presetSel.value = g.preset || 'aurora';
      gspeed.value = g.speed != null ? g.speed : 26;
      gint.value = g.intensity != null ? g.intensity : 1;
      const p = d.particles || {};
      pdensity.value = p.density != null ? p.density : 64;
      pspeed.value = p.speed != null ? p.speed : 0.25;
      pcolor.value = p.color || '';
      photoUrl.value = d.photo_url || '';
      syncGroups(); syncLabels();
    })
    .catch(() => { syncGroups(); syncLabels(); });

  // Photo upload (admin-gated POST; stores file + flips source to photo).
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    uploadStatus.textContent = 'Uploading…';
    uploadStatus.style.color = '';
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/auth/login-background/photo', {
        method: 'POST', credentials: 'same-origin', body: fd,
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.detail || 'Upload failed');
      photoUrl.value = d.photo_url || '';
      sourceSel.value = 'photo';
      syncGroups();
      uploadStatus.textContent = 'Uploaded';
      uploadStatus.style.color = 'var(--green)';
    } catch (e) {
      uploadStatus.textContent = e.message || 'Upload failed';
      uploadStatus.style.color = 'var(--red)';
    }
    setTimeout(() => { uploadStatus.textContent = ''; uploadStatus.style.color = ''; }, 4000);
  });

  // Save all cosmetic settings through the admin-gated settings POST.
  saveBtn.addEventListener('click', async () => {
    msg.textContent = 'Saving…'; msg.style.color = '';
    const body = {
      login_background: sourceSel.value,
      login_gradient_preset: presetSel.value,
      login_gradient_speed: Number(gspeed.value),
      login_gradient_intensity: Number(gint.value),
      login_particles_density: Number(pdensity.value),
      login_particles_speed: Number(pspeed.value),
      login_particles_color: pcolor.value.trim(),
      login_background_photo_url: photoUrl.value.trim(),
    };
    try {
      const res = await fetch('/api/auth/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || 'Save failed'); }
      msg.textContent = 'Saved'; msg.style.color = 'var(--green)';
    } catch (e) {
      msg.textContent = e.message || 'Save failed'; msg.style.color = 'var(--red)';
    }
    setTimeout(() => { msg.textContent = ''; msg.style.color = ''; }, 3000);
  });
}

/* ═══════════════════════════════════════════
   INIT & REFRESH
   ═══════════════════════════════════════════ */
function initAll() {
  modalEl = el('settings-modal');
  const inits = [initSignupToggle, initAddUser, initEndpointForm, initMcpForm, initCalDAV, initBackup, initDangerZone, initTranscripts, initHealthLogs, initPublicDeployment, initLocalTls, initLoginBackground, () => settingsModule.initIntegrations()];
  for (const fn of inits) {
    try { fn(); } catch (e) { console.error('Admin init error in', fn.name || 'anonymous', e); }
  }
  initialized = true;
  refreshAll();
}

function refreshAll() {
  loadUsers();
  loadEndpoints();
  loadBuiltinTools();
  loadMcpServers();
}

/* ═══════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════ */
export function _initData() {
  if (!initialized) initAll();
  else refreshAll();
}

export function open(tab) {
  _initData();
  settingsModule.open(tab || 'services');
}

export function close() {
  settingsModule.close();
}

const adminModule = { open, close, _initData, get _initialized() { return initialized; } };
export default adminModule;
