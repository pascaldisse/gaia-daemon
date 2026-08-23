export interface ToolSummaryInput {
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
}
export function toolSummaryText(tool: ToolSummaryInput): string;
