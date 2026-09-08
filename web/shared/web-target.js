// Shared by transcript links and the daemon opener. Bare names are ambiguous:
// common file suffixes stay local; use https:// to disambiguate those domains,
// or ./ to disambiguate domain-shaped local files/directories.
const FILE_SUFFIXES = new Set("js ts tsx jsx mjs cjs json md mdx txt css scss html htm png jpg jpeg gif svg webp sh bash zsh py rs go toml yml yaml lock log wasm db sqlite pdf zip tar gz exe dll swift vue svelte csv xml mp3 mp4 mov wav".split(" "));

/** @param {string} target @returns {string|null} */
export function webTargetUrl(target) {
  if (/^https?:\/\//i.test(target)) return target;
  if (/^www\./i.test(target)) return `https://${target}`;
  const match = target.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::[0-9]+)?(?:[/?#][^\s<>"'`]*)?$/i);
  if (!match) return null;
  const suffix = match[1].split(".").at(-1)?.toLowerCase() ?? "";
  if (!/^[a-z]{2,63}$/.test(suffix) || FILE_SUFFIXES.has(suffix)) return null;
  try {
    // URL validates port range too; preserve the original spelling/path.
    new URL(`https://${target}`);
    return `https://${target}`;
  } catch {
    return null;
  }
}
