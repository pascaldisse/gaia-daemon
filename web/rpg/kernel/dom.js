/**
 * client/kernel/dom.js — tiny DOM helpers.
 * Framework-free: document.createElement, appendChild, etc.
 */

/**
 * Create an element with properties and children.
 * @param {string} tag
 * @param {object} props — attributes and properties to set
 * @param {(string|Node)[]} children
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const elem = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (key === 'className') {
      elem.className = val;
    } else if (key === 'textContent') {
      elem.textContent = val;
    } else if (key.startsWith('on')) {
      const event = key.slice(2).toLowerCase();
      elem.addEventListener(event, val);
    } else {
      elem.setAttribute(key, val);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      elem.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      elem.appendChild(child);
    }
  }
  return elem;
}

/**
 * Remove all children from a node.
 * @param {HTMLElement} node
 */
export function clear(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

/**
 * True when a keyboard event happened while the user is typing (focus in an
 * input/textarea/select/contentEditable) or holding a modifier (Ctrl/Cmd/Alt,
 * e.g. copy). Single-key global shortcuts (J, C, …) must check this first so
 * they never hijack normal typing or keyboard commands.
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function isTypingContext(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const t = e.target;
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return !!t.isContentEditable;
}
