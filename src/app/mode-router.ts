import type { Mode, PersonaId } from "../personas/types.js";
import type { GaiaConfig } from "../config/types.js";
import { buildSiblingPrompt, monadOrder } from "./monad-orchestrator.js";

export interface PromptSender {
  (persona: PersonaId, message: string): Promise<string>;
}

export async function routeMessage(mode: Mode, message: string, config: GaiaConfig, send: PromptSender): Promise<void> {
  if (mode !== "monad") {
    await send(mode, message);
    return;
  }

  const monadResponse = await send("monad", message);
  for (const sibling of monadOrder(config)) {
    await send(sibling, buildSiblingPrompt(message, monadResponse, sibling));
  }
}
