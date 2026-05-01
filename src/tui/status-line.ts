export function renderStatusLine(roomId: string, defaultAgent: string): string {
  return `[room: ${roomId}] [default: @${defaultAgent}]`;
}
