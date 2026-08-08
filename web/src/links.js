// Cmd/Ctrl+click opens paths and URLs from anywhere in the UI: web targets in
// a new tab, local paths through the daemon's /api/open-target.
import { api } from "./api.js";
import { h } from "./dom.js";
import { setError } from "./render.js";
import { state } from "./state.js";

/** @typedef {{ text: string, target?: string }} LinkedSegment */

/** @param {MouseEvent|KeyboardEvent} event */
export function isOpenModifier(event) {
  return event.metaKey || event.ctrlKey;
}

/** @param {string} target */
function isWebTarget(target) {
  return /^https?:\/\//i.test(target) || /^www\./i.test(target);
}

/** @param {string} target */
function normalizeWebTarget(target) {
  return /^www\./i.test(target) ? `https://${target}` : target;
}

/** @param {string} target */
function looksOpenableTarget(target) {
  return (
    isWebTarget(target) ||
    target.startsWith("/") ||
    target.startsWith("~/") ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    target.startsWith("file://") ||
    target.includes("/") ||
    /\.[a-z0-9]{1,8}(?::\d+(?::\d+)?)?$/i.test(target)
  );
}

/** @param {string} raw */
function trimTarget(raw) {
  let target = raw;
  while (/[.,;:!?)]$/.test(target) && !/:\d+$/.test(target)) target = target.slice(0, -1);
  return target;
}

/** @param {string} text @returns {LinkedSegment[]} */
function findLinkedSegments(text) {
  /** @type {LinkedSegment[]} */
  const segments = [];
  const pattern =
    /(`[^`\n]+`|https?:\/\/[^\s<>"')\]}]+|www\.[^\s<>"')\]}]+|(?:~|\.{1,2}|\/)[^\s<>"')\]}]+|(?:[A-Za-z0-9_.-]+\/)+[^\s<>"')\]}]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)/gi;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const wrapped = raw.startsWith("`") && raw.endsWith("`");
    const inner = wrapped ? raw.slice(1, -1) : raw;
    const target = trimTarget(inner);
    const suffixLength = inner.length - target.length;
    const tokenText = wrapped ? `\`${target}\`` : target;
    const prefixText = text.slice(cursor, index);
    if (prefixText) segments.push({ text: prefixText });
    if (target && looksOpenableTarget(target)) {
      segments.push({ text: tokenText, target });
      if (suffixLength > 0) segments.push({ text: inner.slice(-suffixLength) });
    } else {
      segments.push({ text: raw });
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/** @param {string} target */
async function openLinkedTarget(target) {
  try {
    if (isWebTarget(target)) {
      window.open(normalizeWebTarget(target), "_blank", "noopener");
      return;
    }
    await api("/api/open-target", {
      method: "POST",
      body: JSON.stringify({ target, workspaceId: state.snapshot?.workspace.id }),
    });
  } catch (error) {
    setError(error);
  }
}

/** @param {string} text @param {string} target */
function linkToken(text, target) {
  return h(
    "span",
    {
      class: "link-token",
      "data-target": target,
      title: target,
      onclick: (event) => {
        if (!isOpenModifier(event)) return;
        event.preventDefault();
        event.stopPropagation();
        void openLinkedTarget(target);
      },
    },
    text,
  );
}

/**
 * @param {unknown} text
 * @param {{ class?: string, target?: string }} [attrs]
 */
export function LinkedText(text, attrs = {}) {
  const className = ["linkified-text", attrs.class].filter(Boolean).join(" ");
  if (attrs.target) {
    return h("span", { class: className }, linkToken(String(text ?? ""), attrs.target));
  }
  return h(
    "span",
    { class: className },
    findLinkedSegments(String(text ?? "")).map((segment) => (segment.target ? linkToken(segment.text, segment.target) : segment.text)),
  );
}

/** @param {string} path */
export function PathText(path) {
  return LinkedText(path, { target: path });
}

export function installOpenModifierTracking() {
  /** @param {boolean} active */
  const update = (active) => document.body.classList.toggle("open-link-mode", active);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Meta" || event.key === "Control") update(true);
  });
  window.addEventListener("keyup", (event) => {
    if (event.key === "Meta" || event.key === "Control") update(event.metaKey || event.ctrlKey);
  });
  window.addEventListener("blur", () => update(false));
}
