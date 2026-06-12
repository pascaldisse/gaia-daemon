// Entry point. The Node server serves these modules directly (no bundler);
// they are plain browser JavaScript kept under .ts paths.
import { loadApp } from "./actions.ts";
import { focusComposerFromBackground, installComposerRouting } from "./composer.ts";
import { installOpenModifierTracking } from "./links.ts";
import { installVoiceLifecycle } from "./voice.ts";

installOpenModifierTracking();
installComposerRouting();
installVoiceLifecycle();
window.addEventListener("pointerdown", focusComposerFromBackground);
void loadApp();
