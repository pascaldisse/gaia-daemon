import { api } from "./api.js";
import { $, h } from "./dom.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { state } from "./state.js";

const WORKSPACES = ["FENYX", "PERSONAL", "PALOPTIC"];

export async function openKeymaker() {
  state.keymaker.open = true;
  markDirty("keymaker");
  await refreshKeymaker();
}

async function refreshKeymaker() {
  state.keymaker.loading = true;
  state.keymaker.error = "";
  markDirty("keymaker");
  try {
    state.keymaker.data = await api("/api/keymaker");
  } catch (error) {
    state.keymaker.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.keymaker.loading = false;
    markDirty("keymaker");
  }
}

function closeKeymaker() {
  state.keymaker.open = false;
  markDirty("keymaker");
}

/** @param {string} workspaceId */
async function bindRoom(workspaceId) {
  const roomId = state.snapshot?.room.id;
  if (!roomId) return;
  try {
    state.keymaker.data = await api("/api/keymaker/room-binding", { method: "POST", body: JSON.stringify({ roomId, workspaceId }) });
    markDirty("keymaker");
  } catch (error) {
    setError(error);
  }
}

/** @param {HTMLFormElement} form */
async function importCredentialFromForm(form) {
  const fd = new FormData(form);
  const scopes = String(fd.get("scopes") ?? "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const secret = String(fd.get("secret") ?? "");
  try {
    const result = await api("/api/keymaker/credentials", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: String(fd.get("workspaceId") ?? ""),
        provider: String(fd.get("provider") ?? ""),
        capability: String(fd.get("capability") ?? ""),
        account: String(fd.get("account") ?? ""),
        scopes,
        ...(secret ? { secret } : {}),
      }),
    });
    state.keymaker.data = result.state;
    form.reset();
    const select = $("select[name='workspaceId']", form);
    if (select && state.snapshot?.room.id) /** @type {HTMLSelectElement} */ (select).value = activeWorkspaceId();
    markDirty("keymaker");
  } catch (error) {
    setError(error);
  }
}

/** @param {string} id */
async function checkCredential(id) {
  try {
    const result = await api(`/api/keymaker/credentials/${encodeURIComponent(id)}/check`, { method: "POST", body: "{}" });
    state.keymaker.data = result.state;
    markDirty("keymaker");
  } catch (error) {
    setError(error);
  }
}

function activeWorkspaceId() {
  const roomId = state.snapshot?.room.id;
  const bound = roomId ? state.keymaker.data?.roomBindings?.[roomId] : "";
  return WORKSPACES.includes(bound) ? bound : "PERSONAL";
}

function renderKeymaker() {
  const mount = $("#overlay-keymaker");
  if (!mount) return;
  if (!state.keymaker.open) {
    mount.replaceChildren();
    return;
  }
  const data = state.keymaker.data;
  const roomId = state.snapshot?.room.id;
  const active = activeWorkspaceId();
  const credentials = Array.isArray(data?.credentials) ? data.credentials : [];
  const audit = Array.isArray(data?.audit) ? data.audit.slice(-12).reverse() : [];
  mount.replaceChildren(
    h(
      "div",
      { class: "keymaker-backdrop", onclick: (event) => { if (event.target === event.currentTarget) closeKeymaker(); } },
      h(
        "section",
        { class: "keymaker-modal" },
        h(
          "header",
          { class: "keymaker-head" },
          h("div", {}, h("p", { class: "eyebrow", text: "FOLLOW THE WHITE RABBIT" }), h("h2", { text: "Keymaker" })),
          h("button", { class: "icon-btn", title: "close", onclick: closeKeymaker, text: "×" }),
        ),
        state.keymaker.error ? h("p", { class: "keymaker-error", text: state.keymaker.error }) : null,
        state.keymaker.loading ? h("p", { class: "muted", text: "checking vault…" }) : null,
        h(
          "section",
          { class: "rabbit-grid" },
          h(
            "div",
            { class: "rabbit-card active-identity" },
            h("p", { class: "eyebrow", text: "ACTIVE IDENTITY" }),
            h("h3", { text: active }),
            h("p", { class: "muted", text: roomId ? `room binding: ${roomId}` : "no room bound" }),
            h(
              "div",
              { class: "identity-pills" },
              WORKSPACES.map((id) => h("button", { class: `identity-pill ${id === active ? "active" : ""}`, onclick: () => void bindRoom(id), text: id })),
            ),
          ),
          h(
            "form",
            {
              class: "rabbit-card import-card",
              onsubmit: (event) => {
                event.preventDefault();
                void importCredentialFromForm(/** @type {HTMLFormElement} */ (event.currentTarget));
              },
            },
            h("p", { class: "eyebrow", text: "SECURE IMPORT" }),
            h("div", { class: "form-row" }, Select("workspaceId", WORKSPACES, active), Input("provider", "provider · hubspot / n8n"), Input("capability", "capability · crm/read")),
            h("div", { class: "form-row" }, Input("account", "account label"), Input("scopes", "scopes · crm.objects.contacts.read")),
            h("input", { name: "secret", type: "password", placeholder: "paste secret · stored in Keychain when available", autocomplete: "off" }),
            h("button", { class: "primary-btn", type: "submit", text: "store credential" }),
            h("p", { class: "microcopy", text: "Raw secrets never render back into the interface. Metadata only after submit." }),
          ),
        ),
        h(
          "section",
          { class: "rabbit-card" },
          h("p", { class: "eyebrow", text: "CONNECTION OVERVIEW" }),
          h(
            "div",
            { class: "credential-table" },
            credentials.length ? credentials.map(CredentialRow) : h("p", { class: "muted", text: "No credentials yet. Add HubSpot or n8n first." }),
          ),
        ),
        h(
          "section",
          { class: "rabbit-card audit-card" },
          h("p", { class: "eyebrow", text: "AUDIT" }),
          audit.length ? audit.map((/** @type {any} */ item) => h("div", { class: "audit-row" }, h("span", { text: item.action }), h("small", { text: `${item.workspaceId ?? "—"} · ${new Date(item.at).toLocaleString()}` }))) : h("p", { class: "muted", text: "No activity yet." }),
        ),
      ),
    ),
  );
}

/** @param {string} name @param {string} placeholder */
function Input(name, placeholder) {
  return h("input", { name, placeholder });
}

/** @param {string} name @param {string[]} values @param {string} selected */
function Select(name, values, selected) {
  return h("select", { name }, values.map((value) => h("option", { value, selected: value === selected, text: value })));
}

/** @param {any} credential */
function CredentialRow(credential) {
  return h(
    "div",
    { class: "credential-row" },
    h("strong", { text: credential.provider }),
    h("span", { text: credential.capability }),
    h("span", { text: credential.workspaceId }),
    h("span", { class: `status-chip ${credential.status}`, text: credential.status }),
    h("small", { text: credential.account || credential.secretRef }),
    h("button", { onclick: () => void checkCredential(credential.id), text: "check" }),
  );
}

registerRegion("keymaker", renderKeymaker);
