export function register() {
  return { contributions: { commands: [{
    name: "rpg-engine",
    description: "RPG engine status",
    run: () => ({ reply: "RPG engine is available to runner contributions." }),
  }] } };
}
