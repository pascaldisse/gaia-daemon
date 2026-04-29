import type { GaiaConfig } from "../config/types.js";

export function buildSiblingPrompt(originalPrompt: string, monadResponse: string, sibling: "gaia" | "sidia"): string {
  const role = sibling === "gaia" ? "constructive builder" : "skeptical stress-tester";
  return `Monad has reviewed the user's request and produced director context.\n\nUser request:\n${originalPrompt}\n\nMonad director context:\n${monadResponse}\n\nRespond now as the ${role}. Be concise, useful, and do not repeat Monad unnecessarily.`;
}

export function monadOrder(config: GaiaConfig): Array<"gaia" | "sidia"> {
  const valid = config.monad.order.filter((id): id is "gaia" | "sidia" => id === "gaia" || id === "sidia");
  return valid.length > 0 ? valid : ["gaia", "sidia"];
}
