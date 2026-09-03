export function register() {
  return { contributions: { commands: [{
    name: "fugu",
    description: "Fugu artifact routing status",
    run: () => ({ reply: "Fugu artifact routing is available to runner contributions." }),
  }] } };
}
