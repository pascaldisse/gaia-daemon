export interface GaiaThinkSplit { thought: string; remainder: string; closed: boolean; }
export function splitLeadingGaiaThink(text: string): GaiaThinkSplit | null;
export function stripGaiaThinking(text: string): string;
