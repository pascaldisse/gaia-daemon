/**
 * server/addons.js — the addon/plugin loader.
 *
 * An ADDON is a directory with an `addon.json` manifest. It can ship any mix of:
 *   - a full campaign (`world/` — scenes + ruleset, same layout as campaigns/*)
 *   - a server hook  (`server` — ES module; `register(ctx)` runs after the engines boot)
 *   - a client plugin (`client` — ES module served at /addons/<id>/… and mounted
 *     by the player client with the addon API: {store, net, view, who, serverBase})
 *   - DM-prompt extensions (`systemAppend` — files appended to the system prompt)
 *
 * manifest shape:
 *   { "id": "kasumi-quest", "name": "Kasumi's Quest", "version": "0.1.0",
 *     "description": "…", "world": "world", "ruleset": "kasumi",
 *     "client": "client/index.js", "server": "server/index.js",
 *     "systemAppend": ["prompts/style.md"] }
 *
 * DISCOVERY — two sources, merged:
 *   - `addons.json` at the repo root (or $TTRPG_ADDONS_CONFIG): [{path, enabled}]
 *     — the persistent install list, editable from the client settings panel.
 *   - `TTRPG_ADDONS` env var — path-list ("," or ":" separated), always enabled.
 *
 * WORLD RESOLUTION: when TTRPG_WORLD is unset and an enabled addon ships a world,
 * that world (and its manifest `ruleset`) becomes the campaign — so
 * `TTRPG_ADDONS=/path/to/addon npm run dev` just works.
 *
 * RUNTIME LOADING: POST /addons/config can install + live-load an addon's static
 * files and server hook without a restart. Its world/ruleset still need a reboot
 * (the session is already seeded); disabling a loaded server hook needs one too.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.html': 'text/html', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

/** Read one addon dir's manifest → a normalized record (or null + warning). */
export function readManifest(dir, enabled = true) {
  const abs = path.resolve(dir);
  const manifestPath = path.join(abs, 'addon.json');
  let m;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    console.warn(`[addons] Skipping "${dir}": ${e.message}`);
    return null;
  }
  if (!m.id || !/^[a-z0-9][a-z0-9-_]*$/i.test(m.id)) {
    console.warn(`[addons] Skipping "${dir}": manifest needs an id ([a-z0-9-_])`);
    return null;
  }
  return {
    id: m.id,
    name: m.name || m.id,
    version: m.version || '0.0.0',
    description: m.description || '',
    dir: abs,
    world: m.world ? path.join(abs, m.world) : null,
    ruleset: m.ruleset || null,
    client: m.client || null,
    server: m.server || null,
    systemAppend: Array.isArray(m.systemAppend) ? m.systemAppend : [],
    enabled,
  };
}

/** Where the persistent install list lives (env override keeps tests hermetic). */
export function configPath(rootDir, env = process.env) {
  return env.TTRPG_ADDONS_CONFIG || path.join(rootDir, 'addons.json');
}

/**
 * Resolve the full addon list: addons.json entries + TTRPG_ADDONS env paths.
 * Duplicate ids: first one wins (env paths load after the config file).
 * @returns {{addons: object[], configFile: string}}
 */
export function loadAddons({ rootDir, env = process.env }) {
  const configFile = configPath(rootDir, env);
  const addons = [];
  const seen = new Set();

  const push = (record) => {
    if (!record) return;
    if (seen.has(record.id)) {
      console.warn(`[addons] Duplicate addon id "${record.id}" — keeping the first`);
      return;
    }
    seen.add(record.id);
    addons.push(record);
  };

  if (fs.existsSync(configFile)) {
    try {
      const list = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      for (const entry of Array.isArray(list) ? list : []) {
        if (!entry || !entry.path) continue;
        push(readManifest(path.resolve(rootDir, entry.path), entry.enabled !== false));
      }
    } catch (e) {
      console.warn(`[addons] Could not read ${configFile}: ${e.message}`);
    }
  }

  for (const p of String(env.TTRPG_ADDONS || '').split(/[,:]/).map(s => s.trim()).filter(Boolean)) {
    push(readManifest(path.resolve(rootDir, p), true));
  }

  if (addons.length) {
    console.log(`[addons] ${addons.length} addon(s): ${addons.map(a => `${a.id}${a.enabled ? '' : ' (off)'}`).join(', ')}`);
  }
  return { addons, configFile };
}

/** The first enabled addon that ships a world → {id, world, ruleset} | null. */
export function addonWorldOf(addons) {
  const a = addons.find(a => a.enabled && a.world && fs.existsSync(a.world));
  return a ? { id: a.id, world: a.world, ruleset: a.ruleset } : null;
}

/** Concatenate an addon's systemAppend files (missing files skip silently). */
export function readSystemAppends(addon) {
  const parts = [];
  for (const rel of addon.systemAppend || []) {
    const f = path.join(addon.dir, rel);
    try { parts.push(fs.readFileSync(f, 'utf-8')); } catch { /* optional */ }
  }
  return parts.join('\n\n');
}

/**
 * Import + run every enabled addon's server hook: `register(ctx)`.
 * A hook that throws is logged and skipped — an addon can never stop the boot.
 */
export async function runServerHooks(addons, ctx) {
  for (const addon of addons) {
    if (!addon.enabled || !addon.server) continue;
    await runServerHook(addon, ctx);
  }
}

async function runServerHook(addon, ctx) {
  try {
    const mod = await import(pathToFileURL(path.join(addon.dir, addon.server)).href);
    if (typeof mod.register === 'function') {
      await mod.register({ ...ctx, addon });
      console.log(`[addons] Server hook registered: ${addon.id}`);
    }
  } catch (e) {
    console.error(`[addons] Server hook "${addon.id}" failed: ${e.message}`);
  }
}

/**
 * The /addons HTTP surface. Returns a handler the server calls before its 404:
 *   GET  /addons                → { addons: [public manifests] }
 *   GET  /addons/<id>/<path>    → static file from the addon dir (traversal-safe)
 *   POST /addons/config         → {path, enabled} — persist to addons.json; a newly
 *                                 enabled addon live-loads (static + server hook).
 *
 * @param {{addons:object[], configFile:string, rootDir:string, getHookCtx:()=>object|null}} opts
 * @returns {(req,res,url)=>Promise<boolean>} true if the request was handled
 */
export function createAddonHttp({ addons, configFile, rootDir, getHookCtx }) {
  const publicView = (a) => ({
    id: a.id, name: a.name, version: a.version, description: a.description,
    client: a.client, server: !!a.server, world: !!a.world, ruleset: a.ruleset,
    enabled: a.enabled,
  });

  function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  }

  function persist() {
    const list = addons.map(a => ({ path: path.relative(rootDir, a.dir) || a.dir, enabled: a.enabled }));
    fs.writeFileSync(configFile, JSON.stringify(list, null, 2) + '\n');
  }

  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/addons')) return false;

    // GET /addons — the install list (public fields only).
    if (req.method === 'GET' && url.pathname === '/addons') {
      json(res, { addons: addons.map(publicView) });
      return true;
    }

    // POST /addons/config — install / enable / disable an addon by path.
    if (req.method === 'POST' && url.pathname === '/addons/config') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { json(res, { ok: false, error: 'Invalid JSON' }, 400); return true; }

      const enabled = payload.enabled !== false;
      let addon = payload.id ? addons.find(a => a.id === payload.id) : null;
      if (!addon && payload.path) {
        const dir = path.resolve(rootDir, payload.path);
        addon = addons.find(a => a.dir === dir);
        if (!addon) {
          addon = readManifest(dir, enabled);
          if (!addon) { json(res, { ok: false, error: `No loadable addon.json at ${dir}` }, 400); return true; }
          if (addons.some(a => a.id === addon.id)) { json(res, { ok: false, error: `Addon id "${addon.id}" already loaded` }, 409); return true; }
          addons.push(addon);
          // Live-load the server hook so client + routes work without a restart.
          const ctx = getHookCtx && getHookCtx();
          if (enabled && addon.server && ctx) await runServerHook(addon, ctx);
          persist();
          json(res, { ok: true, addon: publicView(addon), note: addon.world ? 'World/ruleset addons need a server restart to seed their campaign.' : undefined });
          return true;
        }
      }
      if (!addon) { json(res, { ok: false, error: 'Pass an addon path or id' }, 400); return true; }

      const wasEnabled = addon.enabled;
      addon.enabled = enabled;
      if (enabled && !wasEnabled && addon.server) {
        const ctx = getHookCtx && getHookCtx();
        if (ctx) await runServerHook(addon, ctx);
      }
      persist();
      json(res, {
        ok: true, addon: publicView(addon),
        note: (!enabled && addon.server) ? 'The server hook stays active until restart.' : undefined,
      });
      return true;
    }

    // GET /addons/<id>/<path> — static serving from the addon dir.
    const m = /^\/addons\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const addon = addons.find(a => a.id === decodeURIComponent(m[1]) && a.enabled);
      if (!addon) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); return true; }
      const file = path.resolve(addon.dir, decodeURIComponent(m[2]));
      // Traversal guard: the resolved path must stay inside the addon dir.
      if (!file.startsWith(addon.dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); return true;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store', // dev-loop friendly — addons iterate fast
        'Access-Control-Allow-Origin': '*',
      });
      res.end(fs.readFileSync(file));
      return true;
    }

    return false;
  };
}
