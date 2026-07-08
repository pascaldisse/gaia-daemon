// prompt.js — an in-app single-line text prompt.
//
// window.prompt() is unimplemented in the native (WKWebView) shell: it silently
// returns null, so anything gated behind it ("+ new room", "add workspace") did
// nothing there while working fine in a browser. This is a self-contained,
// promise-based replacement that behaves identically in both — an overlay reusing
// the shared .modal-backdrop / .modal styling. No snapshot/render-region wiring:
// a prompt is a one-shot imperative interaction, so it manages its own DOM.

import { h } from "./dom.js";

/**
 * Ask the user for a line of text. Resolves the trimmed value, or null if the
 * user cancels (Esc, Cancel, backdrop click) or submits it empty.
 * @param {string} message the label shown above the input
 * @param {{ placeholder?: string, value?: string, okLabel?: string }} [opts]
 * @returns {Promise<string|null>}
 */
export function promptText(message, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    /** @param {string|null} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };

    const input = h("input", {
      type: "text",
      class: "prompt-input",
      ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
      ...(opts.value ? { value: opts.value } : {}),
      onkeydown: (/** @type {KeyboardEvent} */ event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      },
    });
    const submit = () => {
      const value = /** @type {HTMLInputElement} */ (input).value.trim();
      finish(value ? value : null);
    };

    // Capture Escape at the window level so it wins even if focus wandered.
    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };
    window.addEventListener("keydown", onKey, true);

    const backdrop = h(
      "div",
      {
        class: "modal-backdrop",
        // Click on the dimmed area (not the dialog) cancels.
        onmousedown: (/** @type {MouseEvent} */ event) => {
          if (event.target === backdrop) finish(null);
        },
      },
      h(
        "section",
        { class: "modal prompt-modal" },
        h("div", { class: "panel-head" }, h("h2", { text: message })),
        input,
        h(
          "div",
          { class: "prompt-actions" },
          h("button", { class: "prompt-btn", onclick: () => finish(null), text: "Cancel" }),
          h("button", { class: "prompt-btn primary", onclick: submit, text: opts.okLabel ?? "OK" }),
        ),
      ),
    );
    document.body.append(backdrop);
    input.focus();
  });
}

/**
 * Ask the user to confirm a destructive action. Resolves true only if they
 * explicitly confirm; Esc / Cancel / backdrop click resolve false. Like
 * promptText, this replaces window.confirm() (unimplemented in the native shell)
 * and behaves identically in a browser.
 * @param {string} message
 * @param {{ detail?: string, okLabel?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    /** @param {boolean} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };

    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
    };
    window.addEventListener("keydown", onKey, true);

    const backdrop = h(
      "div",
      {
        class: "modal-backdrop",
        onmousedown: (/** @type {MouseEvent} */ event) => {
          if (event.target === backdrop) finish(false);
        },
      },
      h(
        "section",
        { class: "modal prompt-modal" },
        h("div", { class: "panel-head" }, h("h2", { text: message })),
        opts.detail ? h("p", { class: "prompt-detail", text: opts.detail }) : null,
        h(
          "div",
          { class: "prompt-actions" },
          h("button", { class: "prompt-btn", onclick: () => finish(false), text: "Cancel" }),
          h("button", { class: `prompt-btn ${opts.danger ? "danger" : "primary"}`, onclick: () => finish(true), text: opts.okLabel ?? "OK" }),
        ),
      ),
    );
    document.body.append(backdrop);
    const confirmBtn = /** @type {HTMLElement|null} */ (backdrop.querySelector(".prompt-btn.danger, .prompt-btn.primary"));
    confirmBtn?.focus();
  });
}
