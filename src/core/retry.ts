/** Wait without blocking the event loop. Shared by polling and retry loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
