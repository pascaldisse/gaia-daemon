import rpg from "./plugin.mjs";
export function register() {
  return { contributions: { commands: [{
    name: rpg.command,
    description: rpg.description ?? "",
    run: (_context, request) => ({
      ...rpg.run(request.args, request.pluginContext),
      panel: rpg.panel,
      prompt: rpg.prompt,
      renderCap: rpg.renderCap,
      turnStart: rpg.turnStart,
    }),
  }] } };
}
