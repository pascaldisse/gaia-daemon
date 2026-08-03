/** client/kernel/frontdoor.js — Session-zero campaign and character front door. */

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

export class FrontDoor {
  constructor({ serverBase, who, onContinue, onBegin }) {
    this.serverBase = serverBase;
    this.who = who;
    this.onContinue = onContinue;
    this.onBegin = onBegin;
    this.el = node('main', 'frontdoor');
    this.el.setAttribute('aria-label', 'Start game');
    this._epilogueShown = false; // guard: epilogue appears once per completion
  }

  mount() {
    document.body.appendChild(this.el);
    this.title();
    this._watchEpilogue();
  }

  close() { this.el.remove(); }

  /**
   * Read-only watcher for the campaign epilogue. Opens its own WebSocket
   * (mirroring net.js's snapshot/ops handling) purely to notice when
   * world-state's flags.campaignComplete flips true — it never sends
   * `hello` or ops, so it cannot bind a PC or otherwise disturb the live
   * player session driven by main.js's own NetClient.
   */
  _watchEpilogue() {
    const port = typeof __TTRPG_PORT__ !== 'undefined' ? __TTRPG_PORT__ : '8420';
    let entities = new Map();
    let closedByUs = false;

    const checkComplete = () => {
      const ws = entities.get('world-state');
      const complete = !!(ws && ws.flags && ws.flags.campaignComplete);
      if (complete) {
        if (!this._epilogueShown) {
          this._epilogueShown = true;
          this.epilogue(new Map(entities));
        }
      } else {
        // Falsy again (e.g. a fresh campaign) re-arms the guard so the
        // epilogue can appear once more on the *next* completion.
        this._epilogueShown = false;
      }
    };

    const applyOp = (op) => {
      switch (op.op) {
        case 'spawn':
          if (op.id) entities.set(op.id, { ...(op.components || {}) });
          break;
        case 'set':
          if (op.id && entities.has(op.id) && op.component) {
            const comps = entities.get(op.id);
            if (op.value === null || op.value === undefined) delete comps[op.component];
            else comps[op.component] = (op.value && typeof op.value === 'object') ? { ...op.value } : op.value;
          }
          break;
        case 'merge':
          if (op.id) {
            if (!entities.has(op.id)) entities.set(op.id, {});
            const comps = entities.get(op.id);
            if (op.component && op.value) comps[op.component] = { ...(comps[op.component] || {}), ...op.value };
          }
          break;
        case 'despawn':
          if (op.id) entities.delete(op.id);
          break;
      }
    };

    const connect = () => {
      let socket;
      try {
        socket = new WebSocket(`ws://${location.hostname}:${port}`);
      } catch (_) {
        return;
      }
      socket.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === 'snapshot') {
          entities = new Map(Object.entries(msg.entities || {}));
          checkComplete();
        } else if (msg.type === 'ops') {
          for (const op of msg.ops || []) applyOp(op);
          checkComplete();
        }
      };
      socket.onclose = () => { if (!closedByUs) setTimeout(connect, 2000); };
      socket.onerror = () => {};
      this._epilogueSocket = socket;
    };
    connect();
    this._stopWatchingEpilogue = () => { closedByUs = true; if (this._epilogueSocket) this._epilogueSocket.close(); };
  }

  async request(path, options) {
    const res = await fetch(this.serverBase + path, options);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  title() {
    this.el.replaceChildren();
    const backdrop = node('div', 'frontdoor-backdrop');
    const art = new Image();
    art.src = `${this.serverBase}/art/world-state`;
    art.alt = '';
    art.onload = () => backdrop.style.backgroundImage = `url("${art.src}")`;
    // The CSS gradient remains visible when art is unavailable.
    backdrop.appendChild(art);
    const panel = node('section', 'frontdoor-panel frontdoor-title');
    panel.append(node('div', 'frontdoor-kicker', 'SESSION ZERO'), node('h1', '', '⟁ AI-TTRPG'), node('p', 'frontdoor-copy', 'A world is waiting for your first step.'));
    const controls = node('div', 'frontdoor-actions');
    const newGame = node('button', 'frontdoor-primary', 'New Game');
    const cont = node('button', 'frontdoor-secondary', 'Continue');
    cont.disabled = true;
    const hint = node('div', 'frontdoor-hint', 'Checking for a saved journey…');
    newGame.onclick = () => this.campaigns();
    cont.onclick = () => { this.close(); this.onContinue(); };
    controls.append(newGame, cont);
    panel.append(controls, hint);
    this.el.append(backdrop, panel);
    this.canContinue().then(ok => {
      cont.disabled = !ok;
      hint.textContent = ok ? 'Your previous journey is ready.' : 'No saved journey found.';
    });
  }

  /**
   * Campaign epilogue overlay — shown once flags.campaignComplete flips true
   * (live broadcast, or already-true on load after a reload). Reuses the
   * title-screen visual language (backdrop/panel/actions) so it reads as
   * part of the same front door, and hands "Return to Title" straight back
   * to title() rather than reloading the page.
   * @param {Map<string, object>} entities — snapshot at time of completion
   */
  epilogue(entities) {
    if (!this.el.isConnected) document.body.appendChild(this.el);
    this.el.replaceChildren();
    const backdrop = node('div', 'frontdoor-backdrop');
    const art = new Image();
    art.src = `${this.serverBase}/art/world-state`;
    art.alt = '';
    art.onload = () => backdrop.style.backgroundImage = `url("${art.src}")`;
    // The CSS gradient remains visible when art is unavailable.
    backdrop.appendChild(art);
    const panel = node('section', 'frontdoor-panel frontdoor-title');
    panel.append(node('div', 'frontdoor-kicker', 'EPILOGUE'), node('h1', '', 'FIN.'));

    const quests = [];
    const party = [];
    for (const [, comps] of entities) {
      const identity = comps.identity || {};
      if (identity.kind === 'quest' && comps.quest && comps.quest.phase === 'completed') {
        quests.push(identity.name || 'Unnamed quest');
      } else if (identity.kind === 'pc') {
        party.push(identity.name || 'Unnamed adventurer');
      }
    }

    const recap = node('div', 'frontdoor-copy');
    recap.style.textAlign = 'left';
    recap.appendChild(node('p', '', party.length ? `Party: ${party.join(', ')}` : 'No party members recorded.'));
    const questLabel = node('p', '', 'Quests completed:');
    questLabel.style.margin = '0.75rem 0 0.25rem';
    recap.appendChild(questLabel);
    if (quests.length) {
      const list = node('ul');
      list.style.margin = '0';
      list.style.paddingLeft = '1.25rem';
      for (const name of quests) list.appendChild(node('li', '', name));
      recap.appendChild(list);
    } else {
      recap.appendChild(node('p', '', 'None recorded.'));
    }
    panel.appendChild(recap);

    const controls = node('div', 'frontdoor-actions');
    const toTitle = node('button', 'frontdoor-primary', 'Return to Title');
    toTitle.onclick = () => this.title();
    controls.appendChild(toTitle);
    panel.appendChild(controls);

    this.el.append(backdrop, panel);
  }

  async canContinue() {
    try {
      await this.request('/game');
      const history = await this.request('/events?limit=1');
      return Array.isArray(history.events) && history.events.length > 0;
    } catch (_) { return false; }
  }

  async campaigns() {
    this.el.replaceChildren();
    const panel = node('section', 'frontdoor-panel frontdoor-wide');
    panel.append(node('div', 'frontdoor-kicker', 'NEW GAME'), node('h2', '', 'Choose a campaign'));
    const cards = node('div', 'campaign-cards');
    panel.append(cards);
    this.el.appendChild(panel);
    let campaigns;
    let fallback = false;
    try {
      const data = await this.request('/campaigns');
      campaigns = data.campaigns || [];
    } catch (_) {
      fallback = true;
      campaigns = [{ id: 'necrotopia', name: 'Necrotopia', tagline: 'A city of graves, debts, and second chances.' }];
    }
    if (!campaigns.length) cards.appendChild(node('p', 'frontdoor-hint', 'No campaigns are available.'));
    for (const campaign of campaigns) {
      const card = node('button', 'campaign-card');
      if (campaign.cover) {
        const img = new Image();
        img.src = `${this.serverBase}/art/${encodeURIComponent(campaign.cover)}`;
        img.alt = '';
        img.className = 'campaign-cover';
        img.onerror = () => img.remove();
        card.appendChild(img);
      }
      card.append(node('strong', '', campaign.name || campaign.id), node('span', '', campaign.tagline || 'Begin a new story.'));
      card.onclick = () => this.character(campaign, fallback);
      cards.appendChild(card);
    }
    const back = node('button', 'frontdoor-back', '← Back');
    back.onclick = () => this.title();
    panel.appendChild(back);
  }

  /**
   * Injects a single scoped <style> block (once) covering the archetype
   * card layout that index.html's baseline frontdoor-* CSS doesn't already
   * provide. Reuses `.archetype-choice` (border/padding/radius) from
   * index.html as the base and layers on card-only rules here.
   */
  _ensureArchetypeStyles() {
    if (document.getElementById('frontdoor-archetype-style')) return;
    const style = document.createElement('style');
    style.id = 'frontdoor-archetype-style';
    style.textContent = '.archetype-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.6rem;}'
      + '.archetype-card{position:relative;display:flex;flex-direction:column;gap:.2rem;align-items:flex-start;text-align:left;cursor:pointer;padding:.7rem .8rem;}'
      + '.archetype-card input[type=radio]{position:absolute;top:.6rem;right:.6rem;margin:0;}'
      + '.archetype-card-info{display:flex;flex-direction:column;gap:.2rem;padding-right:1.1rem;}'
      + '.archetype-card-info strong{color:#f3f4f6;font-size:.9rem;}'
      + '.archetype-card-info small{color:#9ca3af;font-size:.75rem;line-height:1.3;}'
      + '.archetype-card-stats{color:#93c5fd;font-size:.75rem;margin-top:.15rem;}'
      + '.archetype-card.is-selected{border-color:#2563eb;background:#172554;}';
    document.head.appendChild(style);
  }

  async character(campaign, fallback) {
    this.el.replaceChildren();
    const panel = node('section', 'frontdoor-panel frontdoor-character');
    panel.append(node('div', 'frontdoor-kicker', campaign.name || 'CAMPAIGN'), node('h2', '', 'Who enters the world?'));
    const form = node('form', 'frontdoor-form');
    const name = document.createElement('input');
    name.required = true; name.maxLength = 80; name.value = localStorage.getItem('ttrpg_who') || this.who;
    name.placeholder = 'Character name'; name.setAttribute('aria-label', 'Character name');
    form.append(node('label', '', 'Name'), name);
    if (Array.isArray(campaign.archetypes) && campaign.archetypes.length) {
      this._ensureArchetypeStyles();
      const choices = node('fieldset', 'archetype-list archetype-cards');
      choices.appendChild(node('legend', '', 'Archetype'));
      const markSelected = () => {
        choices.querySelectorAll('.archetype-card').forEach(card => {
          const input = card.querySelector('input[type=radio]');
          card.classList.toggle('is-selected', !!(input && input.checked));
        });
      };
      campaign.archetypes.forEach((archetype, index) => {
        const id = archetype.id != null ? String(archetype.id) : String(index);
        const label = node('label', 'archetype-choice archetype-card');
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'archetype'; radio.value = id; radio.checked = index === 0;
        radio.onchange = markSelected;
        label.appendChild(radio);
        const info = node('div', 'archetype-card-info');
        info.appendChild(node('strong', '', archetype.name || id));
        if (archetype.description) info.appendChild(node('small', '', archetype.description));
        if (archetype.hp != null || archetype.armor != null) {
          info.appendChild(node('span', 'archetype-card-stats', `HP ${archetype.hp ?? '—'} · Armor ${archetype.armor ?? '—'}`));
        }
        label.appendChild(info);
        choices.appendChild(label);
      });
      form.appendChild(choices);
      markSelected();
    } else {
      let schema = null;
      try { schema = await this.request('/schema'); } catch (_) { /* description-only is intentional */ }
      const templates = schema && (schema.actorTemplates || (schema.ruleset && schema.ruleset.actorTemplates));
      if (templates && typeof templates === 'object' && Object.keys(templates).length) {
        const choices = node('fieldset', 'archetype-list');
        choices.appendChild(node('legend', '', 'Archetype'));
        Object.keys(templates).forEach((key, index) => {
          const label = node('label', 'archetype-choice');
          const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'archetype'; radio.value = key; radio.checked = index === 0;
          label.append(radio, document.createTextNode(key)); choices.appendChild(label);
        });
        form.appendChild(choices);
      }
    }
    const description = document.createElement('textarea');
    description.rows = 1; description.maxLength = 180; description.placeholder = 'One-line description (optional)';
    description.setAttribute('aria-label', 'Character description');
    form.append(node('label', '', 'Description'), description);
    const begin = node('button', 'frontdoor-primary', 'Begin'); begin.type = 'submit';
    const status = node('div', 'frontdoor-hint');
    form.append(begin, status);
    form.onsubmit = async event => {
      event.preventDefault(); begin.disabled = true; status.textContent = 'Opening the first scene…';
      const protagonist = { name: name.value.trim(), description: description.value.trim() };
      const archetypeChoice = form.querySelector('input[name="archetype"]:checked');
      if (archetypeChoice) protagonist.templateId = archetypeChoice.value;
      if (!protagonist.name) { begin.disabled = false; return; }
      localStorage.setItem('ttrpg_who', protagonist.name);
      try {
        if (fallback) throw new Error('Lifecycle unavailable');
        const result = await this.request('/game/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign: campaign.id, slot: 'default', protagonist }) });
        if (!result.ok) throw new Error('Game creation failed');
        // The creator stays visually/source-owned by TTRPG. This is only the
        // GAIA room-state seam: persist the PC assignment in its parent room.
        if (window.parent !== window) window.parent.postMessage({ type: 'gaia-rpg-pc', pc: { ...protagonist, campaign: campaign.id } }, location.origin);
        this.close(); this.onBegin({ fallback: false, protagonist });
      } catch (_) {
        // Existing servers have no lifecycle API: preserve a usable session-zero path.
        this.close(); this.onBegin({ fallback: true, protagonist });
      }
    };
    const back = node('button', 'frontdoor-back', '← Campaigns'); back.type = 'button'; back.onclick = () => this.campaigns();
    panel.append(form, back); this.el.appendChild(panel);
  }
}
