// Generic host for plugin-owned, same-origin experiences. It does not create
// plugin controls: the embedded application supplies its own existing UI.
import { runPluginAction } from "./actions.js";
import { $, h } from "./dom.js";
import { registerRegion } from "./render.js";
import { state } from "./state.js";

function renderPluginPanels() {
  const root = $("#plugin-panels");
  if (!root) return;
  const panels = Object.entries(state.snapshot?.room.pluginPanels ?? {}).filter(([, panel]) => panel.embed);
  root.hidden = panels.length === 0;
  root.replaceChildren(...panels.flatMap(([, panel]) => {
    const embed = panel.embed;
    return embed ? [h("iframe", {
      class: "plugin-embed",
      src: embed.src,
      title: embed.title ?? panel.title,
    })] : [];
  }));
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || !event.data || event.data.type !== "gaia-rpg-pc") return;
  const pc = event.data.pc;
  if (!pc || typeof pc.name !== "string") return;
  void runPluginAction("rpg", ["pc", pc.name, typeof pc.description === "string" ? pc.description : "", typeof pc.archetype === "string" ? pc.archetype : ""]);
});

registerRegion("plugins", renderPluginPanels);
