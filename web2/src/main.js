// Entry point. The daemon serves these modules directly (no bundler); they are
// plain browser JavaScript, typechecked via JSDoc (web2/tsconfig.json).
import { loadApp } from "./actions.js";
import { focusComposerFromBackground, initComposer, installComposerRouting } from "./composer.js";
import { $ } from "./dom.js";
import { installKeybindings } from "./keys.js";
import { installOpenModifierTracking } from "./links.js";
import { mountApp, render } from "./render.js";
import { clockText } from "./statusbar.js";
import { initTheme } from "./themes.js";
import { installVoiceLifecycle } from "./voice.js";
// Region renderers registered by import side effect.
import "./panel.js";
import "./settings.js";
import "./sidebar.js";
import "./tabsbar.js";
import "./transcript.js";

// Restore the theme and pane widths before the first paint so there is no flash.
initTheme();
restoreColumnWidths();

mountApp();
initComposer();

installOpenModifierTracking();
installComposerRouting();
installKeybindings();
installVoiceLifecycle();
installDevReload();
window.addEventListener("pointerdown", focusComposerFromBackground);

// First paint of every region (empty states), then load the app.
render();

// Keep the status-bar clock current without re-rendering anything else.
setInterval(() => {
  const clock = $("#statusClock");
  if (clock) clock.textContent = clockText();
}, 15000);

void loadApp();

function restoreColumnWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem("gaia.cols") ?? "{}");
    if (saved.left) document.documentElement.style.setProperty("--w-left", saved.left);
    if (saved.right) document.documentElement.style.setProperty("--w-right", saved.right);
  } catch {
    // no saved widths — defaults from the stylesheet apply.
  }
}

// Live-reload while the daemon runs in dev mode. Guarded so a server-injected
// snippet and this listener never double-connect; outside dev mode the first
// failed connect closes the source for good (no reconnect spam).
function installDevReload() {
  const w = /** @type {any} */ (window);
  if (w.__gaiaDevReload) return;
  w.__gaiaDevReload = true;
  let hadConnection = false;
  let reconnectAfterDrop = false;
  const source = new EventSource("/__dev/reload");
  source.addEventListener("ready", () => {
    if (hadConnection && reconnectAfterDrop) window.location.reload();
    hadConnection = true;
    reconnectAfterDrop = false;
  });
  source.addEventListener("reload", () => window.location.reload());
  source.onerror = () => {
    if (hadConnection) reconnectAfterDrop = true;
    else source.close();
  };
}
