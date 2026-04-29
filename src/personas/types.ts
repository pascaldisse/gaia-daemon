export type PersonaId = "gaia" | "sidia" | "monad";
export type Mode = PersonaId;

export interface PersonaMetadata {
  id: PersonaId;
  displayName: string;
  icon: string;
  memoryFile?: "GAIA.md" | "SIDIA.md";
  promptFile: string;
  configKey: PersonaId;
}

export const PERSONAS: Record<PersonaId, PersonaMetadata> = {
  gaia: {
    id: "gaia",
    displayName: "Gaia",
    icon: "☀",
    memoryFile: "GAIA.md",
    promptFile: "gaia.md",
    configKey: "gaia",
  },
  sidia: {
    id: "sidia",
    displayName: "Sidia",
    icon: "◆",
    memoryFile: "SIDIA.md",
    promptFile: "sidia.md",
    configKey: "sidia",
  },
  monad: {
    id: "monad",
    displayName: "Monad",
    icon: "◇",
    promptFile: "monad.md",
    configKey: "monad",
  },
};

export const PERSONA_IDS = Object.keys(PERSONAS) as PersonaId[];
