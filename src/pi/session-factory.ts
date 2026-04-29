import type { Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { PersonaId } from "../personas/types.js";
import type { GaiaConfig, PersonaConfig } from "../config/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { createMemoryTool } from "../tools/memory-tool.js";
import { createPersonaResourceLoader } from "./resource-loader.js";
import { createSafetyExtension } from "../safety/confirmation.js";

export interface PersonaSessionBundle {
  id: PersonaId;
  session: AgentSession;
  modelLabel: string;
}

export class GaiaSessionFactory {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);

  constructor(
    private readonly cwd: string,
    private readonly config: GaiaConfig,
    private readonly memoryStore: MemoryStore,
  ) {}

  async createPersonaSession(persona: PersonaId): Promise<PersonaSessionBundle> {
    const personaConfig = this.config.personas[persona];
    const model = this.resolveModel(personaConfig);
    const loader = await createPersonaResourceLoader({
      cwd: this.cwd,
      persona,
      memoryStore: this.memoryStore,
      extensionFactories: [createSafetyExtension(this.config.safety)],
    });

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      thinkingLevel: personaConfig.thinking,
      tools: personaConfig.tools,
      customTools: [createMemoryTool(this.memoryStore, persona)],
      resourceLoader: loader,
      sessionManager: SessionManager.create(this.cwd),
      settingsManager: SettingsManager.create(this.cwd),
    });

    if (modelFallbackMessage) console.warn(modelFallbackMessage);
    return { id: persona, session, modelLabel: this.modelLabel(session.model) };
  }

  async createAll(): Promise<Record<PersonaId, PersonaSessionBundle>> {
    const [gaia, sidia, monad] = await Promise.all([
      this.createPersonaSession("gaia"),
      this.createPersonaSession("sidia"),
      this.createPersonaSession("monad"),
    ]);
    return { gaia, sidia, monad };
  }

  private resolveModel(config: PersonaConfig): Model<any> | undefined {
    if (!config.provider || !config.model) return undefined;
    const found = this.modelRegistry.find(config.provider, config.model);
    if (!found) console.warn(`Configured model not found: ${config.provider}/${config.model}; using Pi default fallback.`);
    return found;
  }

  private modelLabel(model: Model<any> | undefined): string {
    if (!model) return "Pi default";
    return `${model.provider}/${model.id}`;
  }
}
