// Renders room-local plugin dialogs as a themed, transient overlay popup \u2014
// never a persistent sidebar panel, never an iframe. A plugin's panel() is
// present in the snapshot only while its own state says it's open (e.g.
// rpg.mjs's `open` flag, cleared once an action completes or its `close`
// action runs); like contextgate.js's modal, this is purely snapshot-driven
// with no independent client-side open/close flag \u2014 resolving/closing always
// round-trips through the plugin action so the two can't fall out of sync.
// Every element here reuses the shared .modal-backdrop/.modal/.prompt-*
// theme-variable classes: zero plugin-owned colors.
import { runPluginAction } from "./actions.js";
import { $, h } from "./dom.js";
import { registerRegion } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").PluginPanelField} PluginPanelField */

/** @param {string} command @param {string[]} args */
function submit(command, args) {
  void runPluginAction(command, args);
}

/**
 * @param {PluginPanelField} field
 * @param {Record<string, HTMLInputElement|HTMLSelectElement>} refs
 */
function Field(field, refs) {
  const control = field.type === "select"
    ? h(
        "select",
        { class: "prompt-input" },
        (field.options ?? []).map((opt) => h("option", { value: opt.value, text: opt.label, selected: opt.value === field.value })),
      )
    : h("input", { type: "text", class: "prompt-input", ...(field.value ? { value: field.value } : {}) });
  refs[field.name] = /** @type {HTMLInputElement|HTMLSelectElement} */ (control);
  return h("label", { class: "plugin-field" }, h("span", { class: "plugin-field-label", text: field.label }), control);
}

/** @param {string} command @param {{action:string,label:string,fields:PluginPanelField[]}} form */
function Form(command, form) {
  /** @type {Record<string, HTMLInputElement|HTMLSelectElement>} */
  const refs = {};
  const run = () => submit(command, [form.action, ...form.fields.map((field) => refs[field.name]?.value ?? "")]);
  return h(
    "form",
    { class: "plugin-form", onsubmit: (/** @type {SubmitEvent} */ event) => { event.preventDefault(); run(); } },
    h("div", { class: "plugin-form-label", text: form.label }),
    form.fields.map((field) => Field(field, refs)),
    h("button", { class: "prompt-btn primary", type: "submit", text: form.label }),
  );
}

/** @param {string} command @param {{title:string,detail?:string,actions?:Array<{action:string,label:string,args?:string[],danger?:boolean}>}} item */
function Item(command, item) {
  return h(
    "div",
    { class: "plugin-item" },
    h("strong", { text: item.title }),
    item.detail ? h("p", { class: "prompt-detail", text: item.detail }) : null,
    item.actions?.length
      ? h(
          "div",
          { class: "plugin-item-actions" },
          item.actions.map((action) =>
            h("button", {
              class: `prompt-btn ${action.danger ? "danger" : ""}`,
              onclick: () => submit(command, [action.action, ...(action.args ?? [])]),
              text: action.label,
            }),
          ),
        )
      : null,
  );
}

/** @param {string} command @param {import("./types.js").PluginPanel} panel */
function PluginModal(command, panel) {
  const close = () => submit(command, ["close"]);
  const backdrop = h(
    "div",
    {
      class: "modal-backdrop",
      onmousedown: (/** @type {MouseEvent} */ event) => { if (event.target === backdrop) close(); },
    },
    h(
      "section",
      { class: "modal prompt-modal plugin-dialog" },
      h("div", { class: "panel-head" }, h("h2", { text: panel.title })),
      panel.description ? h("p", { class: "prompt-detail", text: panel.description }) : null,
      (panel.forms ?? []).map((form) => Form(command, form)),
      (panel.items ?? []).map((item) => Item(command, item)),
      h("div", { class: "prompt-actions" }, h("button", { class: "prompt-btn", onclick: close, text: "Close" })),
    ),
  );
  return backdrop;
}

/** @param {KeyboardEvent} event */
function onEscape(event) {
  if (event.key !== "Escape") return;
  const panels = openPanels();
  if (panels.length === 0) return;
  event.preventDefault();
  const [command] = panels[panels.length - 1];
  submit(command, ["close"]);
}

function openPanels() {
  return Object.entries(state.snapshot?.room.pluginPanels ?? {}).filter(([, panel]) => (panel.forms?.length ?? 0) > 0 || (panel.items?.length ?? 0) > 0);
}

let escBound = false;

function renderPluginPanels() {
  const slot = $("#overlay-plugins");
  if (!slot) return;
  const panels = openPanels();
  if (panels.length === 0) {
    slot.replaceChildren();
    if (escBound) { window.removeEventListener("keydown", onEscape, true); escBound = false; }
    return;
  }
  if (!escBound) { window.addEventListener("keydown", onEscape, true); escBound = true; }
  slot.replaceChildren(...panels.map(([command, panel]) => PluginModal(command, panel)));
}

registerRegion("plugins", renderPluginPanels);
