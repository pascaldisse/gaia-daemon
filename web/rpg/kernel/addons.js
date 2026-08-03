/**
 * client/kernel/addons.js — client-side addon mounting + the ⚙ settings panel.
 *
 * The server lists installed addons at GET /addons; any addon with a `client`
 * entry is dynamically imported from /addons/<id>/<entry> and mounted with:
 *
 *   mount({ addon, serverBase, store, net, view, who, root })
 *
 *   - store — SessionStore (entities mirror; onChange for events)
 *   - net   — NetClient (sendAction / sendOps / sendControl)
 *   - view  — the View (DOM owner; addons may decorate)
 *   - root  — a dedicated <div data-addon=id> appended to <body> for overlays
 *
 * Per-browser enable/disable is localStorage (`ttrpg_addon_<id>`: 'off' hides it
 * here without touching the server). The settings panel also drives the server
 * install list via POST /addons/config (install by path, enable/disable).
 */

const lsKey = (id) => `ttrpg_addon_${id}`;
const clientEnabled = (id) => localStorage.getItem(lsKey(id)) !== 'off';

/** Fetch the server's addon list ([] when the server is down or has none). */
export async function fetchAddons(serverBase) {
  try {
    const res = await fetch(`${serverBase}/addons`);
    return (await res.json()).addons || [];
  } catch {
    return [];
  }
}

/**
 * Import + mount every enabled addon's client entry.
 * @returns {Promise<object[]>} the fetched addon list (for the settings panel)
 */
export async function mountAddons({ serverBase, store, net, view, who }) {
  const addons = await fetchAddons(serverBase);
  for (const addon of addons) {
    if (!addon.enabled || !addon.client || !clientEnabled(addon.id)) continue;
    try {
      const mod = await import(/* @vite-ignore */ `${serverBase}/addons/${addon.id}/${addon.client}`);
      if (typeof mod.mount === 'function') {
        const root = document.createElement('div');
        root.dataset.addon = addon.id;
        document.body.appendChild(root);
        await mod.mount({ addon, serverBase, store, net, view, who, root });
        console.log(`[addons] Mounted ${addon.id} v${addon.version}`);
      }
    } catch (e) {
      console.error(`[addons] Mount failed for ${addon.id}:`, e);
    }
  }
  return addons;
}

/**
 * The ⚙ settings panel: lists addons with per-browser toggles, server-side
 * enable/disable, and an install-by-path field. Reload applies changes.
 * @param {{button:HTMLElement, serverBase:string}} opts
 */
export function initAddonSettings({ button, serverBase }) {
  if (!button) return;

  let overlay = null;

  async function postConfig(payload) {
    const res = await fetch(`${serverBase}/addons/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  async function open() {
    close();
    const addons = await fetchAddons(serverBase);

    overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const rows = addons.map(a => `
      <div class="flex items-start gap-3 py-2 border-b border-gray-800" data-id="${a.id}">
        <div class="flex-1 min-w-0">
          <div class="text-sm text-gray-100 font-medium">${a.name}
            <span class="text-xs text-gray-500">v${a.version}</span>
            ${a.world ? '<span class="text-xs text-amber-400/80 ml-1" title="ships a campaign">world</span>' : ''}
            ${a.server ? '<span class="text-xs text-blue-400/80 ml-1" title="has a server hook">server</span>' : ''}
            ${!a.enabled ? '<span class="text-xs text-red-400/80 ml-1">disabled on server</span>' : ''}
          </div>
          <div class="text-xs text-gray-500 truncate">${a.description || ''}</div>
        </div>
        <label class="text-xs text-gray-400 flex items-center gap-1 shrink-0" title="Show this addon's UI in this browser">
          <input type="checkbox" data-toggle-client="${a.id}" ${clientEnabled(a.id) ? 'checked' : ''}> UI
        </label>
        <button data-toggle-server="${a.id}" class="text-xs px-2 py-0.5 rounded border ${a.enabled ? 'border-red-900/60 text-red-400/90 hover:bg-red-950/40' : 'border-green-900/60 text-green-400/90 hover:bg-green-950/40'}">
          ${a.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>`).join('');

    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg max-h-[80vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div class="flex items-center">
          <span class="text-amber-300 font-bold">⚙ Addons</span>
          <div class="flex-1"></div>
          <button data-close class="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <div>${rows || '<div class="text-sm text-gray-500 italic py-2">No addons installed.</div>'}</div>
        <div class="flex gap-2">
          <input data-path placeholder="/path/to/addon (directory with addon.json)"
            class="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500">
          <button data-install class="text-xs px-3 rounded bg-blue-600 hover:bg-blue-500 text-white">Install</button>
        </div>
        <div class="text-[11px] text-gray-600 leading-snug">
          Addons load from <code>addons.json</code> / <code>TTRPG_ADDONS</code>. UI + server hooks
          load live; an addon's <b>campaign (world/ruleset) needs a server restart</b>.
          Changes here reload the page.
        </div>
      </div>`;

    overlay.querySelector('[data-close]').addEventListener('click', close);
    overlay.querySelectorAll('[data-toggle-client]').forEach(cb => {
      cb.addEventListener('change', () => {
        localStorage.setItem(lsKey(cb.dataset.toggleClient), cb.checked ? 'on' : 'off');
        location.reload();
      });
    });
    overlay.querySelectorAll('[data-toggle-server]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const addon = addons.find(a => a.id === btn.dataset.toggleServer);
        const out = await postConfig({ id: addon.id, enabled: !addon.enabled });
        if (out.note) alert(out.note);
        location.reload();
      });
    });
    overlay.querySelector('[data-install]').addEventListener('click', async () => {
      const p = overlay.querySelector('[data-path]').value.trim();
      if (!p) return;
      const out = await postConfig({ path: p, enabled: true });
      if (!out.ok) { alert(out.error || 'Install failed'); return; }
      if (out.note) alert(out.note);
      location.reload();
    });

    document.body.appendChild(overlay);
  }

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  button.addEventListener('click', () => (overlay ? close() : open()));
}
