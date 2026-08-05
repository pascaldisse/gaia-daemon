// Artifact side drawer. Kept in its own overlay slot so ordinary panel/transcript
// redraws never replace an open artifact editor.
import { ArtifactCanvas } from "./artifact-canvas.js";
import { artifactPanelOpen, roomArtifacts, selectArtifact, selectedArtifact, setArtifactPanelOpen, upsertArtifact } from "./artifacts.js";
import { sendArtifactPrompt } from "./composer.js";
import { $, h } from "./dom.js";
import { markDirty, registerRegion } from "./render.js";

function renderArtifacts() {
  const slot = $("#overlay-artifacts");
  if (!slot) return;
  if (!artifactPanelOpen()) {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(ArtifactPanel());
}

registerRegion("artifacts", renderArtifacts);

/** @returns {HTMLElement} */
function ArtifactPanel() {
  const artifacts = roomArtifacts();
  const selected = selectedArtifact();
  const prompt = /** @type {HTMLInputElement} */ (h("input", { class: "artifact-prompt-input", placeholder: "describe a revision…" }));
  const form = h(
    "form",
    {
      class: "artifact-prompt",
      onsubmit: (event) => {
        event.preventDefault();
        const text = prompt.value.trim();
        if (!text) return;
        prompt.value = "";
        void sendArtifactPrompt(text);
      },
    },
    prompt,
    h("button", { type: "submit", class: "artifact-prompt-send", title: "ask the active agent to generate or revise this artifact", text: "send" }),
  );
  return h(
    "aside",
    { class: "artifact-panel", role: "dialog", "aria-label": "Artifacts" },
    h(
      "header",
      { class: "artifact-panel-head" },
      h("div", {}, h("strong", { text: "Artifacts" }), h("small", { text: artifacts.length ? `${artifacts.length} room-local` : "awaiting an artifact fence" })),
      h("button", { type: "button", class: "artifact-close", title: "close artifacts", text: "×", onclick: () => setArtifactPanelOpen(false) }),
    ),
    h(
      "div",
      { class: "artifact-list", role: "tablist", "aria-label": "Artifacts" },
      artifacts.length
        ? artifacts.map((artifact) =>
            h("button", {
              type: "button",
              class: `artifact-tab ${artifact.id === selected?.id ? "active" : ""}`,
              role: "tab",
              "aria-selected": artifact.id === selected?.id,
              title: artifact.id,
              text: `${artifact.type} · ${artifact.id}`,
              onclick: () => selectArtifact(artifact.id),
            }),
          )
        : h("span", { class: "empty", text: "Ask an agent for html, json, or design artifact output." }),
    ),
    h("section", { class: "artifact-view" }, selected ? ArtifactView(selected) : h("div", { class: "artifact-empty", text: "No artifact selected." })),
    form,
  );
}

/** @param {{ id: string, type: "html"|"json"|"design", content: string, updated: number }} artifact @returns {HTMLElement} */
function ArtifactView(artifact) {
  if (artifact.type === "html") {
    return h("iframe", { class: "artifact-html", sandbox: "", srcdoc: artifact.content, title: artifact.id });
  }
  if (artifact.type === "json") {
    return h("pre", { class: "artifact-json", text: prettyJson(artifact.content) });
  }
  return ArtifactCanvas(artifact.content, (content) => {
    upsertArtifact({ ...artifact, content, updated: Date.now() });
    markDirty("artifacts");
  });
}

/** @param {string} content */
function prettyJson(content) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
