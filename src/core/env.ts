/** The trimmed value of `process.env[name]`, or undefined when unset/blank. */
export function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}
