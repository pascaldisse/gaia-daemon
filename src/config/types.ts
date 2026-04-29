import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export type PersonaKey = "gaia" | "sidia" | "monad";

export interface PersonaConfig {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
}

export interface MemoryConfig {
  dir: string;
  userLimit: number;
  personaLimit: number;
}

export interface SafetyConfig {
  confirmRiskyTools: boolean;
  blockOnNoTty: boolean;
}

export interface UiConfig {
  showToolEvents: boolean;
}

export interface MonadConfig {
  order: Array<"gaia" | "sidia">;
}

export interface GaiaConfig {
  personas: Record<PersonaKey, PersonaConfig>;
  memory: MemoryConfig;
  safety: SafetyConfig;
  ui: UiConfig;
  monad: MonadConfig;
}
