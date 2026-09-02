#!/usr/bin/env bun
// telegram-bridge.mjs — a standalone process bridging ONE Telegram chat to
// ONE GAIA room. Talks to the daemon purely over its existing public HTTP +
// SSE API, logged in as an ordinary human (domain/users.ts) — no daemon
// source changes, no special daemon-internal wiring. AGENTS.md: "Channel
// bridges (Telegram/Discord/...) = plugins, never core." This is that: a
// sibling process, same shape as scripts/edge-proxy.mjs.
//
// Direction Telegram -> GAIA: long-polls Telegram's getUpdates, posts each
// text message into the room as the bridge's logged-in human (so it shows up
// attributed like every other multi-user message — see the humanId/
// humanLabel work in domain/rooms.ts).
//
// Direction GAIA -> Telegram: subscribes to /api/events?workspaceId=&roomId=
// (SSE), forwards each agent-authored room-event to the Telegram chat via
// sendMessage. Never echoes the bridge's own human-authored posts back out
// through the registered channel package — otherwise every relayed message
// would loop.
//
// Config (env):
//   TELEGRAM_BOT_TOKEN       required — from @BotFather.
//   TELEGRAM_CHAT_ID         required — numeric chat id. Unset: the bridge
//                             logs every incoming chat id it sees and exits,
//                             so you can grab it (send the bot any message,
//                             read the log, set the var, restart).
//   GAIA_BASE_URL             default http://127.0.0.1:8787 — loopback to the
//                             daemon, not through any reverse-proxy auth wall.
//   GAIA_WORKSPACE_ID        required.
//   GAIA_ROOM_ID              required.
//   GAIA_BRIDGE_USERNAME      required — a domain/users.ts login
//                             (`gaia user create <username> <password>`).
//   GAIA_BRIDGE_PASSWORD      required.
//
// UNVERIFIED (2026-08-18): the Telegram-API half (getUpdates/sendMessage)
// has never run against a real bot token — I have none; @BotFather is a
// manual human step. The GAIA-side half (login, post-as-human, SSE read) is
// separately live-verified (see the room-service/http commits this session).
// The manifest channel package has unit coverage; Telegram API remains
// unverified.

import { pathToFileURL } from "node:url";
import { bundledDir } from "../src/core/paths.ts";
import { CapabilityBroker } from "../src/services/capabilities/broker.ts";
import { PluginRegistry } from "../src/services/plugins/registry.ts";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`telegram-bridge: missing required env ${name}`);
    process.exit(1);
  }
  return value.trim();
}

const BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const GAIA_BASE_URL = (process.env.GAIA_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const WORKSPACE_ID = requireEnv("GAIA_WORKSPACE_ID");
const ROOM_ID = requireEnv("GAIA_ROOM_ID");
const BRIDGE_USERNAME = requireEnv("GAIA_BRIDGE_USERNAME");
const BRIDGE_PASSWORD = requireEnv("GAIA_BRIDGE_PASSWORD");
let CHAT_ID = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : undefined;

async function installTelegramBridge() {
  const registry = new PluginRegistry({
    pluginsRoot: bundledDir("addons"),
    placement: "daemon",
    // The bridge declares no capabilities; false is the conservative forced
    // floor if a future manifest adds one without host-side policy wiring.
    capabilityBroker: new CapabilityBroker({ grantSource: () => undefined, trustSource: () => false }),
    importer: (entrypoint) => import(pathToFileURL(entrypoint).href),
  });
  const staged = await registry.stageReload();
  if (staged.status === "failed") throw new Error(`telegram manifest registration failed: ${staged.reason}`);
  await registry.applyTurnBoundary();
  return async (direction, payload) => {
    const result = await registry.invokeChannelBridge("gaia.telegram", "telegram", {
      roomId: ROOM_ID,
      agentId: "telegram-bridge",
    }, { direction, payload });
    return result.handled ? result.payload : undefined;
  };
}

const telegramBridge = installTelegramBridge();

// Override for tests only (fake Telegram server) — unset in real use, real
// Telegram API by default.
const TELEGRAM_API = `${(process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "")}/bot${BOT_TOKEN}`;

async function telegramCall(method, params) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`telegram ${method} failed: ${body.description ?? res.status}`);
  return body.result;
}

async function loginToGaia() {
  const res = await fetch(`${GAIA_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: BRIDGE_USERNAME, password: BRIDGE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`gaia login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie?.split(";")[0];
  if (!cookie) throw new Error("gaia login: no session cookie in response");
  const { user } = await res.json();
  return { cookie, userId: user.id };
}

async function postToGaia(cookie, text) {
  const res = await fetch(`${GAIA_BASE_URL}/api/workspaces/${WORKSPACE_ID}/rooms/${ROOM_ID}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`gaia post failed: ${res.status} ${await res.text()}`);
}

// --- Telegram -> GAIA: long-poll getUpdates ---------------------------------

async function pollTelegram(cookie) {
  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await telegramCall("getUpdates", { offset, timeout: 30 });
    } catch (error) {
      console.error(`telegram-bridge: getUpdates error, retrying in 5s: ${error.message}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const next = await (await telegramBridge)("incoming", { updates, offset });
    if (next && typeof next === "object" && typeof next.offset === "number") offset = next.offset;
    for (const raw of updates) {
      const parsed = await (await telegramBridge)("incoming", raw);
      if (!parsed || typeof parsed !== "object" || typeof parsed.chatId !== "number" || typeof parsed.fromLabel !== "string" || typeof parsed.text !== "string") continue;
      if (CHAT_ID === undefined) {
        console.log(`telegram-bridge: saw chat id ${parsed.chatId} from ${parsed.fromLabel} — set TELEGRAM_CHAT_ID and restart.`);
        continue;
      }
      if (parsed.chatId !== CHAT_ID) continue; // one chat per bridge instance
      try {
        await postToGaia(cookie, `${parsed.fromLabel} (telegram): ${parsed.text}`);
      } catch (error) {
        console.error(`telegram-bridge: failed to post to gaia: ${error.message}`);
      }
    }
  }
}

// --- GAIA -> Telegram: SSE subscription -------------------------------------

async function streamGaiaToTelegram(userId) {
  const url = `${GAIA_BASE_URL}/api/events?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&roomId=${encodeURIComponent(ROOM_ID)}`;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
      let eventName = "";
      for await (const chunk of res.body) {
        for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ") && eventName === "room-event") {
            await handleRoomEvent(JSON.parse(line.slice(6)), userId);
          }
        }
      }
    } catch (error) {
      console.error(`telegram-bridge: SSE stream error, reconnecting in 3s: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function handleRoomEvent(payload, bridgeUserId) {
  if (payload?.workspaceId !== WORKSPACE_ID || payload?.roomId !== ROOM_ID) return;
  if (CHAT_ID === undefined) return;
  const outgoing = await (await telegramBridge)("outgoing", { event: payload.event, bridgeUserId });
  if (!outgoing || typeof outgoing !== "object" || !Array.isArray(outgoing.chunks) || !outgoing.chunks.every((chunk) => typeof chunk === "string")) return;
  for (const chunk of outgoing.chunks) {
    try {
      await telegramCall("sendMessage", { chat_id: CHAT_ID, text: chunk });
    } catch (error) {
      console.error(`telegram-bridge: failed to send to telegram: ${error.message}`);
    }
  }
}

async function main() {
  console.log(`telegram-bridge: logging in to GAIA as ${BRIDGE_USERNAME}...`);
  const { cookie, userId } = await loginToGaia();
  console.log(`telegram-bridge: logged in (${userId}). bridging workspace=${WORKSPACE_ID} room=${ROOM_ID} <-> telegram chat=${CHAT_ID ?? "(unknown — waiting for a message)"}`);
  await Promise.all([pollTelegram(cookie), streamGaiaToTelegram(userId)]);
}

await main();
