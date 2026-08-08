// Tiny hyperscript helper + query shorthand. All views build DOM through h().

/**
 * @typedef {{
 *   [attr: string]: unknown,
 *   class?: string,
 *   id?: string|null,
 *   text?: string,
 *   value?: string,
 *   title?: string|null,
 *   style?: string|null,
 *   type?: string,
 *   rows?: string,
 *   placeholder?: string,
 *   draggable?: string,
 *   disabled?: boolean,
 *   selected?: boolean,
 *   open?: boolean,
 *   hidden?: boolean,
 *   onclick?: ((event: MouseEvent) => void)|null,
 *   oninput?: (event: Event) => void,
 *   onchange?: (event: Event) => void,
 *   onkeydown?: (event: KeyboardEvent) => void,
 *   onpaste?: (event: ClipboardEvent) => void,
 *   onsubmit?: (event: SubmitEvent) => void,
 *   ontoggle?: (event: Event) => void,
 *   onpointerdown?: ((event: PointerEvent) => void)|null,
 *   onpointermove?: ((event: PointerEvent) => void)|null,
 *   onpointerup?: ((event: PointerEvent) => void)|null,
 *   onpointercancel?: ((event: PointerEvent) => void)|null,
 *   onmousedown?: (event: MouseEvent) => void,
 *   onmouseenter?: (event: MouseEvent) => void,
 *   oncontextmenu?: (event: MouseEvent) => void,
 *   ondragstart?: (event: DragEvent) => void,
 *   ondragend?: (event: DragEvent) => void,
 *   ondragover?: (event: DragEvent) => void,
 *   ondrop?: (event: DragEvent) => void,
 * }} HAttrs
 */

/** @typedef {Node|string|number|null|undefined|false} HChild */

/**
 * @param {string} tag
 * @param {HAttrs} [attrs]
 * @param {...(HChild|HChild[])} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  if (tag === "textarea" || tag === "input") {
    // Typed text here is @mentions, /commands, ids and code — never prose. The
    // OS text layer (macOS autocorrect bubble in the WKWebView shell, spellcheck
    // squiggles, and the Sequoia inline "writing suggestions" ghost text —
    // writingsuggestions is a distinct Safari 18 feature autocorrect=off does NOT
    // cover) mangles it, so every text field opts out unless the caller explicitly
    // passes one of these attrs back on.
    for (const [key, value] of [["autocorrect", "off"], ["autocapitalize", "off"], ["spellcheck", "false"], ["writingsuggestions", "false"]]) {
      if (!(key in (attrs ?? {}))) node.setAttribute(key, value);
    }
  }
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "value") /** @type {HTMLInputElement} */ (node).value = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement|null}
 */
export function $(selector, root = document) {
  return /** @type {HTMLElement|null} */ (root.querySelector(selector));
}
