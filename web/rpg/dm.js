/**
 * client/dm.js — DMView bootstrap.
 * Same store + WS kernel as the player client, but joins as the `dm` seat and
 * renders the DM control surface. Backfills the story from the journal first
 * so a late-joining DM reads everything the players were told.
 */

import { SessionStore } from './kernel/store.js';
import { NetClient } from './kernel/net.js';
import { DMView } from './kernel/dm-view.js';

const PORT = typeof __TTRPG_PORT__ !== 'undefined' ? __TTRPG_PORT__ : '8420';

const store = new SessionStore();
const view = new DMView(store);

const who = localStorage.getItem('ttrpg_dm_who') || ('dm-' + Math.random().toString(36).slice(2, 6));
localStorage.setItem('ttrpg_dm_who', who);

const net = new NetClient(store, who, { seat: 'dm' });
view.net = net;
net.onServerMessage((msg) => view.handleServer(msg));

(async () => {
  try {
    const res = await fetch(`http://${location.hostname}:${PORT}/events?since=0&limit=1000`);
    const { events } = await res.json();
    view.backfill(events || []);
  } catch (_) {
    // no history yet — live stream still works
  }

  net.connect();

  net.onConnected(() => {
    console.log('[dm] Connected as', who, '(seat: dm)');
  });

  console.log('[dm] DMView booting…');
})();
