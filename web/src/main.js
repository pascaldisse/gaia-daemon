// Entry point. The daemon serves these modules directly (no bundler); they are
// plain browser JavaScript, typechecked via JSDoc (web2/tsconfig.json).
import { loadApp } from "./actions.js";
import { focusComposerFromBackground, initComposer, installComposerRouting } from "./composer.js";
import { $ } from "./dom.js";
import { installKeybindings } from "./keys.js";
import { installOpenModifierTracking } from "./links.js";
import { markDirty, mountApp } from "./render.js";
import { clockText } from "./statusbar.js";
import { initTheme } from "./themes.js";
import { installVoiceLifecycle } from "./voice.js";
// Region renderers registered by import side effect.
import "./dario.js";
import "./contextgate.js";
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
window.addEventListener("pointerdown", focusComposerFromBackground);

// First paint of every region (empty states), then load the app.
markDirty();

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

// Live-reload while the daemon runs in dev mode is provided by a server-injected
// snippet (see devReloadSnippet in src/server/http.ts), added to index.html only
// in dev — so it never fires, or connects to a non-existent route, outside dev.
