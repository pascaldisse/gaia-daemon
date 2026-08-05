// Room-local artifact state. The server endpoint is deliberately isolated here:
// lane A owns persistence; until it lands, every mutation stays durable in the
// browser under `gaia.artifacts.<room>`.
import { api } from "./api.js";
import { markDirty } from "./render.js";
import { state } from "./state.js";

/** @typedef {"html"|"json"|"design"} ArtifactKind */
/** @typedef {{ id: string, kind: ArtifactKind, content: string, updated: number }} Artifact */

/** @type {Artifact[]} */
let artifacts = [];
let roomId = "";
let panelOpen = false;
/** @type {string|null} */
let selectedId = null;
/** @type {Set<string>} */
const hydratedRooms = new Set();

/** @returns {string|null} */
function currentRoomId() {
  return state.snapshot?.room.id ?? null;
}

/** @param {string} id */
function storageKey(id) {
  return `gaia.artifacts.${id}`;
}

function ensureRoom() {
  const nextRoomId = currentRoomId() ?? "";
  if (nextRoomId === roomId) return;
  roomId = nextRoomId;
  artifacts = nextRoomId ? readLocal(nextRoomId) : [];
  selectedId = artifacts.at(-1)?.id ?? null;
  panelOpen = false;
}

/** @param {string} id @returns {Artifact[]} */
function readLocal(id) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(id)) ?? "[]");
    return Array.isArray(saved) ? saved.filter(isArtifact).sort((a, b) => a.updated - b.updated) : [];
  } catch {
    return [];
  }
}

/** @param {unknown} value @returns {value is Artifact} */
function isArtifact(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = /** @type {{ id?: unknown, kind?: unknown, content?: unknown, updated?: unknown }} */ (value);
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "html" || candidate.kind === "json" || candidate.kind === "design") &&
    typeof candidate.content === "string" &&
    typeof candidate.updated === "number"
  );
}

function persistLocal() {
  if (!roomId) return;
  try {
    localStorage.setItem(storageKey(roomId), JSON.stringify(artifacts));
  } catch {
    // Storage may be disabled; the in-memory view remains usable this session.
  }
}

/** @returns {Artifact[]} */
export function roomArtifacts() {
  ensureRoom();
  return artifacts;
}

/** @returns {Artifact|null} */
export function selectedArtifact() {
  ensureRoom();
  return artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts.at(-1) ?? null;
}

/** @returns {boolean} */
export function artifactPanelOpen() {
  ensureRoom();
  return panelOpen;
}

/** @param {boolean} open */
export function setArtifactPanelOpen(open) {
  ensureRoom();
  panelOpen = open;
  if (open) void hydrateArtifacts();
  markDirty("artifacts", "status");
}

export function toggleArtifactPanel() {
  setArtifactPanelOpen(!artifactPanelOpen());
}

/** @param {string} id */
export function selectArtifact(id) {
  ensureRoom();
  if (!artifacts.some((artifact) => artifact.id === id)) return;
  selectedId = id;
  markDirty("artifacts");
}

/** @param {Artifact} artifact */
export function upsertArtifact(artifact) {
  ensureRoom();
  if (!roomId || !isArtifact(artifact)) return;
  const index = artifacts.findIndex((candidate) => candidate.id === artifact.id);
  const existing = index === -1 ? undefined : artifacts[index];
  if (existing && existing.kind === artifact.kind && existing.content === artifact.content) return;
  const next = { ...artifact, updated: artifact.updated || Date.now() };
  if (index === -1) artifacts = [...artifacts, next];
  else artifacts = [...artifacts.slice(0, index), next, ...artifacts.slice(index + 1)];
  artifacts.sort((a, b) => a.updated - b.updated);
  selectedId = next.id;
  panelOpen = true;
  persistLocal();
  void saveArtifact(next);
  markDirty("artifacts", "status");
}

/**
 * STUB: replace these paths when lane A's src/ artifact persistence API lands.
 * Proposed contract: GET /api/rooms/:room/artifacts -> {artifacts:[...]};
 * POST /api/rooms/:room/artifacts/:id -> {artifact}. A missing endpoint falls
 * back silently to the localStorage record above.
 */
async function hydrateArtifacts() {
  ensureRoom();
  const id = roomId;
  if (!id || hydratedRooms.has(id)) return;
  hydratedRooms.add(id);
  try {
    const body = await api(`/api/rooms/${encodeURIComponent(id)}/artifacts`);
    if (!Array.isArray(body.artifacts) || roomId !== id) return;
    const remote = /** @type {Artifact[]} */ (body.artifacts.filter(isArtifact));
    if (remote.length === 0) return;
    artifacts = remote.sort((a, b) => a.updated - b.updated);
    selectedId = artifacts.at(-1)?.id ?? null;
    persistLocal();
    markDirty("artifacts");
  } catch {
    // Lane A endpoint absent: localStorage is the intentional fallback.
  }
}

/** @param {Artifact} artifact */
async function saveArtifact(artifact) {
  const id = roomId;
  if (!id) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifact.id)}`, {
      method: "POST",
      body: JSON.stringify({ artifact }),
    });
  } catch {
    // Lane A endpoint absent: persistLocal() already committed the fallback.
  }
}

/** @param {string} text @param {unknown} [payload] */
export function detectArtifacts(text, payload) {
  const candidates = [text, payloadText(payload)];
  for (const candidate of candidates) {
    for (const artifact of artifactsFromText(candidate)) upsertArtifact(artifact);
  }
  const direct = artifactFromValue(payload);
  if (direct) upsertArtifact(direct);
}

/** @param {unknown} payload @returns {string} */
function payloadText(payload) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
}

/** @param {string} text @returns {Artifact[]} */
function artifactsFromText(text) {
  /** @type {Artifact[]} */
  const found = [];
  const fences = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fences)) {
    const language = match[1].toLowerCase();
    const content = match[2].trim();
    if (!content) continue;
    if (language === "html") {
      found.push(normalizeArtifact({ kind: "html", content }));
      continue;
    }
    if (language === "json" || language === "design" || !language) {
      const parsed = parseArtifact(content, language === "design" ? "design" : undefined);
      if (parsed) found.push(parsed);
    }
  }
  return found;
}

/** @param {string} content @param {ArtifactKind|undefined} hinted @returns {Artifact|null} */
function parseArtifact(content, hinted) {
  try {
    const parsed = JSON.parse(content);
    const wrapped = parsed && typeof parsed === "object" && "artifact" in parsed ? parsed.artifact : undefined;
    const value = wrapped && typeof wrapped === "object" ? wrapped : parsed;
    if (!value || typeof value !== "object") return null;
    const candidate = /** @type {{ id?: unknown, kind?: unknown, type?: unknown, content?: unknown }} */ (value);
    const declared = candidate.kind ?? candidate.type; // accept legacy `type` payloads leniently
    const kind = declared === "html" || declared === "json" || declared === "design" ? declared : hinted;
    if (!kind) return null;
    const normalizedContent = typeof candidate.content === "string" ? candidate.content : kind === "design" ? JSON.stringify(candidate) : content;
    return normalizeArtifact({ id: typeof candidate.id === "string" ? candidate.id : undefined, kind, content: normalizedContent });
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {Artifact|null} */
function artifactFromValue(value) {
  if (!value || typeof value !== "object") return null;
  try {
    return parseArtifact(JSON.stringify(value), undefined);
  } catch {
    return null;
  }
}

/** @param {{ id?: string, kind: ArtifactKind, content: string }} value @returns {Artifact} */
function normalizeArtifact(value) {
  return {
    id: value.id ?? `${value.kind}-${stableHash(value.content)}`,
    kind: value.kind,
    content: value.content,
    updated: Date.now(),
  };
}

/** Stable small id for a fence with no explicit artifact id. @param {string} value */
function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
