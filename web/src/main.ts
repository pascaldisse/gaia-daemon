// Entry point. The Node server serves these modules directly (no bundler);
// they are plain browser JavaScript kept under .ts paths.
import { loadApp } from "./actions.ts";
import { focusComposerFromBackground, installComposerRouting } from "./composer.ts";
import { installOpenModifierTracking } from "./links.ts";

installOpenModifierTracking();
installComposerRouting();
window.addEventListener("pointerdown", focusComposerFromBackground);
void loadApp();
