/**
 * client/main.js — Bootstrap.
 * Creates the store, backfills the story from the journal, connects the
 * network, wires the view + header controls (name, new game, connection dot).
 */

import { SessionStore } from './kernel/store.js';
import { NetClient } from './kernel/net.js';
import { View } from './kernel/view.js';
import { MusicEngine } from './kernel/music.js';
import { TrackMusicPlayer } from './kernel/musicplayer.js';
import { QuestJournal } from './kernel/journal.js';
import { CharacterSheet } from './kernel/charsheet.js';
import { mountAddons, initAddonSettings } from './kernel/addons.js';
import { FrontDoor } from './kernel/frontdoor.js';
import { deriveSuggestions } from './kernel/suggestions.js';

const PORT = typeof __TTRPG_PORT__ !== 'undefined' ? __TTRPG_PORT__ : '8420';
const HTTP = `http://${location.hostname}:${PORT}`;

// ---- Player identity (drives which PC is yours — multiplayer) ----

const who = localStorage.getItem('ttrpg_who') || ('Adventurer-' + Math.random().toString(36).slice(2, 5));
localStorage.setItem('ttrpg_who', who);

const nameInput = document.getElementById('player-name');
nameInput.value = who;
nameInput.addEventListener('change', () => {
  const next = nameInput.value.trim();
  if (!next || next === who) return;
  localStorage.setItem('ttrpg_who', next);
  location.reload(); // rejoin as the new player — server rebinds the PC
});

// ---- Store + view ----

const store = new SessionStore();
const view = new View(store);
view.myName = who;

// ---- Session-zero front door, then story backfill + connection ----

const net = new NetClient(store, who);
view.onAction = (text, move, target, zone) => net.sendAction(text, move, target, zone);
let started = false;

async function startSession(afterSnapshot) {
  if (started) return;
  started = true;
  try {
    const res = await fetch(`${HTTP}/events?since=0&limit=1000`);
    const { events } = await res.json();
    view.backfill(events || []);
  } catch (_) {
    // Server not up yet or no history — the live stream still works.
  }
  if (afterSnapshot) net.onConnected(afterSnapshot);
  net.connect();
  initAddonSettings({ button: document.getElementById('settings-toggle'), serverBase: HTTP });
  mountAddons({ serverBase: HTTP, store, net, view, who: net.who })
    .catch(e => console.error('[main] addon mounting failed:', e));
}

const frontDoor = new FrontDoor({
  serverBase: HTTP,
  who,
  onContinue: () => startSession(),
  onBegin: ({ fallback, protagonist }) => {
    // New identity must be in place before the websocket hello claims a PC.
    net.who = protagonist.name;
    view.myName = protagonist.name;
    nameInput.value = protagonist.name;
    startSession(() => {
      if (fallback) net.sendOps([{ op: 'reset' }]);
    // Deliberately programmatic: this is the cold-open prompt, not visible input.
      net.sendAction('look around');
    });
  },
});
frontDoor.mount();

// ---- Save-slot picker (front door — resume a specific save, or quick-start one) ----
// kernel/frontdoor.js is NOT owned by this atom (its rich campaign/archetype flow
// stays as-is and is the fallback here). This picker is a self-contained addition:
// once it can determine the active campaign, it hides frontDoor's screen (toggling
// .style.display, never frontDoor.close(), so its epilogue watcher keeps running)
// and shows a save list + quick new-game-by-slot instead. "Full campaign setup…"
// hands control back to the existing flow untouched.
mountSavePicker();

async function mountSavePicker() {
  const panel = document.getElementById('save-picker');
  if (!panel) return; // markup missing — leave the existing frontDoor screen as-is
  const list = document.getElementById('save-picker-list');
  const status = document.getElementById('save-picker-status');
  const slotInput = document.getElementById('save-picker-new-slot');
  const newBtn = document.getElementById('save-picker-new-btn');
  const fullBtn = document.getElementById('save-picker-full-btn');

  // "Active campaign" = whatever the server currently has loaded; falls back
  // to the sole campaign if none is running yet (e.g. very first boot).
  let campaign = null;
  try {
    const info = await (await fetch(`${HTTP}/game`)).json();
    if (info && info.campaign) campaign = info.campaign;
  } catch (_) { /* server not up yet — fall through to frontDoor's own screen */ }
  if (!campaign) {
    try {
      const { campaigns } = await (await fetch(`${HTTP}/campaigns`)).json();
      if (campaigns && campaigns.length === 1) campaign = campaigns[0].id;
    } catch (_) { /* server not up yet */ }
  }
  if (!campaign) return; // ambiguous/unavailable — keep frontDoor's existing screen

  let saves = [];
  try {
    const data = await (await fetch(`${HTTP}/saves?campaign=${encodeURIComponent(campaign)}`)).json();
    saves = data.saves || [];
  } catch (_) { /* treat as no saves */ }

  list.replaceChildren();
  if (!saves.length) {
    const empty = document.createElement('p');
    empty.className = 'frontdoor-hint';
    empty.textContent = 'No saves yet';
    list.appendChild(empty);
  } else {
    for (const { slot, mtime } of saves) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'campaign-card';
      const strong = document.createElement('strong');
      strong.textContent = slot;
      const span = document.createElement('span');
      span.textContent = new Date(mtime).toLocaleString();
      row.append(strong, span);
      row.addEventListener('click', () => resumeSlot(campaign, slot, row, status, panel));
      list.appendChild(row);
    }
  }

  newBtn.addEventListener('click', () => startNewSlot(campaign, slotInput, newBtn, status, panel));
  fullBtn.addEventListener('click', () => {
    panel.style.display = 'none';
    frontDoor.el.style.display = '';
  });

  frontDoor.el.style.display = 'none';
  panel.style.display = '';
}

async function resumeSlot(campaign, slot, row, status, panel) {
  row.disabled = true;
  status.textContent = `Resuming "${slot}"…`;
  try {
    const res = await fetch(`${HTTP}/game/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign, slot }),
    });
    const result = await res.json();
    if (!result.ok) throw new Error('continue failed');
    // Not yet connected at this point (session hasn't started) — the
    // {type:'game-changed'} → net.reconnect() handling below only applies
    // to an already-live session, so mirror frontDoor's own onContinue path.
    panel.style.display = 'none';
    startSession();
  } catch (_) {
    status.textContent = `Could not resume "${slot}".`;
    row.disabled = false;
  }
}

// Mirrors server/session-manager.js's SLOT_RE exactly (letters/digits, then
// letters/digits/dot/dash/underscore — not just lowercase+dash as a quick
// gloss might suggest).
const SAVE_SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function startNewSlot(campaign, slotInput, newBtn, status, panel) {
  const slot = (slotInput.value || 'default').trim() || 'default';
  if (!SAVE_SLOT_RE.test(slot)) {
    status.textContent = 'Slot must start with a letter/digit, then letters, digits, dots, dashes, or underscores.';
    return;
  }
  newBtn.disabled = true;
  status.textContent = 'Starting a new game…';
  try {
    const res = await fetch(`${HTTP}/game/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign, slot, protagonist: { name: who } }),
    });
    const result = await res.json();
    if (!result.ok) throw new Error('new game failed');
    // Mirrors frontDoor's own onBegin path (minus the fallback/no-lifecycle branch).
    panel.style.display = 'none';
    startSession(() => net.sendAction('look around'));
  } catch (_) {
    status.textContent = 'Could not start a new game.';
    newBtn.disabled = false;
  }
}

// ---- Track-based music player (DM/addon-cued WS {"type":"music",...}) ----

const trackPlayer = new TrackMusicPlayer({
  volumeSlider: document.getElementById('track-volume'),
  muteButton: document.getElementById('track-mute'),
  serverBase: HTTP,
});

// A new-game broadcast replaces the server world. Reconnect to receive its snapshot.
// net.js only keeps a single onServerMessage slot, so every non-store message
// (game-changed, music, …) is routed through this one handler.
net.onServerMessage((msg) => {
  if (msg.type === 'game-changed') net.reconnect();
  trackPlayer.handleServerMessage(msg);
});

// ---- Quest journal ('J' key / 📜 toolbar button) ----

new QuestJournal({ store, button: document.getElementById('journal-toggle') });

// ---- Character sheet ('C' key) ----

new CharacterSheet({ store, who: () => net.who });

// ---- Action input ----

const actionInput = document.getElementById('action-input');
const actionSend = document.getElementById('action-send');
const suggestionRow = document.getElementById('suggestion-row');

function sendAction() {
  const text = actionInput.value.trim();
  if (!text) return;
  net.sendAction(text);
  actionInput.value = '';
  actionInput.focus();
}

function renderSuggestions() {
  const suggestions = deriveSuggestions(store);
  suggestionRow.replaceChildren();
  suggestionRow.hidden = suggestions.length === 0;
  for (const text of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-pill';
    button.textContent = text;
    button.title = text;
    button.addEventListener('click', () => {
      actionInput.value = text;
      sendAction();
    });
    suggestionRow.appendChild(button);
  }
}

store.onChange(renderSuggestions);
renderSuggestions();

actionSend.addEventListener('click', sendAction);
actionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAction();
  }
});

// ---- New game (reset to the campaign start) ----

document.getElementById('new-game').addEventListener('click', () => {
  if (!confirm('Start a new game? The current world state will be reset to the campaign start.')) return;
  net.sendOps([{ op: 'reset' }]);
});

// ---- Mood music (procedural Web Audio — the 🔊 header toggle) ----

const music = new MusicEngine();
const musicBtn = document.getElementById('music-toggle');

function currentMood() {
  // my PC → its location's map style; night darkens; combat overrides; DM knob wins.
  let locStyle = null;
  for (const [, comps] of store.entities) {
    if ((comps.identity || {}).kind === 'pc' && (comps.agent || {}).controller === who) {
      const loc = store.entities.get((comps.place || {}).locationId);
      locStyle = loc && loc.tiles ? loc.tiles.style : null;
      break;
    }
  }
  const ws = store.entities.get('world-state') || {};
  const enc = (store.entities.get('encounter') || {}).encounter || {};
  return music.resolveMood({
    locStyle,
    phase: (ws.clock || {}).phase,
    inCombat: !!enc.active,
    dmMood: (ws.flags || {}).mood || null,
  });
}

if (musicBtn) {
  const paint = () => { musicBtn.textContent = music.enabled ? '🔊' : '🔇'; musicBtn.title = music.enabled ? 'Music on' : 'Music off'; };
  musicBtn.addEventListener('click', () => { music.toggle(); if (music.enabled) music.setMood(currentMood()); paint(); });
  paint();
}
store.onChange(() => { if (music.enabled) music.setMood(currentMood()); });

// ---- Connection dot ----

const connDot = document.getElementById('conn-dot');
setInterval(() => {
  const open = net.ws && net.ws.readyState === 1;
  connDot.className = `w-2 h-2 rounded-full ${open ? 'bg-green-500' : 'bg-red-500'}`;
  connDot.title = open ? `connected as ${who}` : 'disconnected — retrying…';
}, 1000);

net.onConnected(() => console.log('[main] Ready! Connected as', who));
console.log('[main] Booted — waiting for connection…');
