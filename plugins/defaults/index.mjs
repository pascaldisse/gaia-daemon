import dogMode from "./dog-mode.mjs";
const commands = Array.isArray(dogMode.command) ? dogMode.command : [dogMode.command];
export function register() {
  return { contributions: { commands: commands.map((name) => ({
    name,
    description: dogMode.description ?? "",
    run: (_context, request) => ({
      ...dogMode.run(request.args, { ...request.pluginContext, command: name }),
      panel: dogMode.panel,
      prompt: dogMode.prompt,
      renderCap: dogMode.renderCap,
      turnStart: dogMode.turnStart,
    }),
  })) } };
}
