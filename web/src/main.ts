// Entry point. The Node server serves these modules directly (no bundler);
// they are plain browser JavaScript kept under .ts paths.
import { loadApp } from "./actions.ts";
import { focusComposerFromBackground, installComposerRouting } from "./composer.ts";
import { installKeybindings } from "./keys.ts";
import { installOpenModifierTracking } from "./links.ts";
import { clockText } from "./render.ts";
import { initTheme } from "./themes.ts";
import { installVoiceLifecycle } from "./voice.ts";

// Restore the theme and pane widths before the first paint so there is no flash.
initTheme();
restoreColumnWidths();

installOpenModifierTracking();
installComposerRouting();
installKeybindings();
installVoiceLifecycle();
window.addEventListener("pointerdown", focusComposerFromBackground);

// Keep the status-bar clock current without re-rendering the whole app.
setInterval(() => {
  const clock = document.querySelector("#statusClock");
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
