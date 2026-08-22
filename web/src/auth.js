// Human-session surface. Accounts are distinct from harness provider accounts.
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { loadApp } from "./actions.js";
import { markDirty, registerRegion, setError } from "./render.js";

/** @type {{id:string, username:string, displayName:string}|null} */
let current = null;
/** @type {"login"|"register"} */
let mode = "login";
let username = "";
let password = "";
let displayName = "";
let busy = false;

/** The signed-in human, or null. Callers gate account-scoped requests on this
 * so a logged-out client never fires a request the server can only answer 401.
 * @returns {{id:string, username:string, displayName:string}|null} */
export function humanSession() {
  return current;
}

export async function loadHumanSession() {
  try { current = (await api("/api/auth/me")).user ?? null; } catch { current = null; }
  markDirty("auth");
}

async function submit() {
  if (busy) return;
  busy = true; markDirty("auth");
  try {
    const path = mode === "login" ? "/api/auth/login" : "/api/auth/users";
    const body = mode === "login" ? { username, password } : { username, password, displayName };
    const result = await api(path, { method: "POST", body: JSON.stringify(body) });
    // Registration creates an identity; login mints the browser session cookie.
    // Keep the two server contracts separate while making the form one action.
    const session = mode === "register"
      ? await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) })
      : result;
    current = session.user;
    password = "";
    await loadApp();
  } catch (error) { setError(error); }
  finally { busy = false; markDirty("auth"); }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); current = null; await loadApp(); }
  catch (error) { setError(error); }
  markDirty("auth");
}

function renderAuth() {
  const slot = $("#overlay-auth");
  if (!slot) return;
  if (current) {
    slot.replaceChildren(h("button", { class: "auth-user", title: "log out", onclick: () => void logout(), text: `${current.displayName || current.username} · log out` }));
    return;
  }
  slot.replaceChildren(h("div", { class: "auth-backdrop" }, h("form", {
    class: "auth-card", onsubmit: (event) => { event.preventDefault(); void submit(); },
  },
  h("h2", { text: mode === "login" ? "Sign in" : "Create account" }),
  h("label", {}, "Username", h("input", { required: true, autocomplete: "username", value: username, oninput: (e) => { username = /** @type {HTMLInputElement} */ (e.target).value; } })),
  mode === "register" ? h("label", {}, "Display name", h("input", { value: displayName, oninput: (e) => { displayName = /** @type {HTMLInputElement} */ (e.target).value; } })) : null,
  h("label", {}, "Password", h("input", { required: true, type: "password", autocomplete: mode === "login" ? "current-password" : "new-password", value: password, oninput: (e) => { password = /** @type {HTMLInputElement} */ (e.target).value; } })),
  h("button", { type: "submit", disabled: busy, text: busy ? "working…" : mode === "login" ? "Sign in" : "Create account" }),
  h("button", { type: "button", class: "auth-switch", onclick: () => { mode = mode === "login" ? "register" : "login"; markDirty("auth"); }, text: mode === "login" ? "Create account" : "Use existing account" }),
  )));
}
registerRegion("auth", renderAuth);
