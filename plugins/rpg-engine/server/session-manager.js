import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Runtime owner of the currently active campaign session and its engines. */
export class SessionManager {
  constructor({ rootDir, createGame, activateGame }) {
    this.rootDir = path.resolve(rootDir);
    this.createGame = createGame;
    this.activateGame = activateGame;
    this.current = null;
    this._swapChain = Promise.resolve();
    this._rulesetImports = new Map();
  }

  /** Discover repository campaigns on every call so installs appear without reboot. */
  campaigns() {
    const found = [];
    const add = (id, dir) => {
      const manifestPath = path.join(dir, 'campaign.json');
      if (!fs.existsSync(manifestPath)) return;
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return; }
      const ruleset = discoverRuleset(dir, manifest.ruleset);
      found.push({
        id,
        name: manifest.name || manifest.title || id,
        tagline: manifest.tagline || manifest.blurb || id,
        ruleset,
        cover: manifest.cover || null,
        dir: path.relative(this.rootDir, dir) || '.',
        _dir: dir,
      });
    };

    add('default', path.join(this.rootDir, 'world'));
    const campaignsDir = path.join(this.rootDir, 'campaigns');
    if (fs.existsSync(campaignsDir)) {
      for (const id of fs.readdirSync(campaignsDir).sort()) {
        const dir = path.join(campaignsDir, id);
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) add(id, dir);
      }
    }
    return found;
  }

  async publicCampaigns() {
    return Promise.all(this.campaigns().map(async ({ _dir, ...campaign }) => ({
      ...campaign,
      archetypes: await this._publicArchetypes(_dir, campaign.ruleset),
    })));
  }

  async _publicArchetypes(campaignDir, ruleset) {
    if (!ruleset) return [];
    const bundle = path.join(campaignDir, 'ruleset', ruleset, 'ruleset.js');
    const url = pathToFileURL(bundle).href;
    let imported = this._rulesetImports.get(url);
    if (!imported) {
      imported = import(url).catch(() => null);
      this._rulesetImports.set(url, imported);
    }
    const mod = await imported;
    const templates = mod?.actorTemplates;
    if (!templates) return [];
    return Object.entries(templates)
      .filter(([id, template]) => id !== 'player' && Array.isArray(template?.tags) && template.tags.includes('player'))
      .map(([id, template]) => ({
        id,
        name: template.name,
        description: template.description,
        hp: template.stats?.hp,
        armor: template.stats?.armor,
      }));
  }

  resolveCampaign(id) {
    return this.campaigns().find(c => c.id === id) || null;
  }

  campaignIdForDir(worldDir) {
    const absolute = path.resolve(this.rootDir, worldDir);
    return (this.campaigns().find(c => c._dir === absolute) || {}).id ||
      (path.basename(absolute) || 'default');
  }

  saves(campaignId) {
    const campaign = this.resolveCampaign(campaignId);
    if (!campaign) throw httpError(404, `Unknown campaign: ${campaignId}`);
    const savesDir = path.join(campaign._dir, 'saves');
    if (!fs.existsSync(savesDir)) return [];
    const saves = [];
    for (const file of fs.readdirSync(savesDir)) {
      const match = /^session_(.+)\.json$/.exec(file);
      if (!match) continue;
      if (match[1].includes('.stale-')) continue; // quarantined saves are not resumable
      const stat = fs.statSync(path.join(savesDir, file));
      saves.push({ slot: match[1], mtime: stat.mtime.toISOString() });
    }
    return saves.sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  async boot({ worldDir, ruleset = null, slot = 'default' }) {
    validateSlot(slot);
    const absolute = path.resolve(this.rootDir, worldDir);
    const campaign = this.campaignIdForDir(absolute);
    const game = await this.createGame(absolute, ruleset, slot, { load: true });
    this._setCurrent(game, { campaign, slot, ruleset: ruleset || null, worldDir: absolute });
    return this.current;
  }

  newGame({ campaign, slot = 'default', protagonist } = {}) {
    if (!protagonist || typeof protagonist.name !== 'string' || !protagonist.name.trim()) {
      return Promise.reject(httpError(400, 'protagonist.name is required'));
    }
    return this._queueSwap({ campaign, slot, load: false, protagonist });
  }

  continueGame({ campaign, slot } = {}) {
    if (!slot) return Promise.reject(httpError(400, 'slot is required'));
    return this._queueSwap({ campaign, slot, load: true });
  }

  _queueSwap(options) {
    const run = () => this._swap(options);
    const result = this._swapChain.then(run, run);
    this._swapChain = result.catch(() => {});
    return result;
  }

  async _swap({ campaign: campaignId, slot = 'default', load, protagonist = null }) {
    validateSlot(slot);
    const campaign = this.resolveCampaign(campaignId);
    if (!campaign) throw httpError(404, `Unknown campaign: ${campaignId}`);
    const savePath = path.join(campaign._dir, 'saves', `session_${slot}.json`);
    if (load && !fs.existsSync(savePath)) throw httpError(404, `Save not found: ${campaignId}/${slot}`);

    if (this.current?.game) this.current.game.destroy();
    if (!load) fs.rmSync(savePath, { force: true });

    const game = await this.createGame(campaign._dir, campaign.ruleset, slot, { load, protagonist });
    this._setCurrent(game, {
      campaign: campaign.id,
      slot,
      ruleset: campaign.ruleset,
      worldDir: campaign._dir,
    });
    return this.current;
  }

  _setCurrent(game, meta) {
    this.current = { ...meta, game };
    this.activateGame(game, this.current);
  }

  info() {
    if (!this.current) return null;
    const { campaign, slot, ruleset } = this.current;
    return { campaign, slot, ruleset };
  }
}

function discoverRuleset(campaignDir, declared) {
  const root = path.join(campaignDir, 'ruleset');
  if (!fs.existsSync(root)) return null;
  const ids = fs.readdirSync(root).filter(id =>
    fs.existsSync(path.join(root, id, 'ruleset.js'))
  ).sort();
  if (declared && ids.includes(declared)) return declared;
  return ids.length === 1 ? ids[0] : null;
}

function validateSlot(slot) {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot) || slot.includes('..')) {
    throw httpError(400, 'Invalid save slot');
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
