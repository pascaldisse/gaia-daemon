/** @param {string} workspaceId @param {string} roomId */
export function composerDraftKey(workspaceId, roomId) {
  return `gaia.draft.${workspaceId}.${roomId}`;
}

/** @param {Storage} storage @param {string} key @param {string} text */
export function saveComposerDraft(storage, key, text) {
  if (text.trim()) storage.setItem(key, text);
  else storage.removeItem(key);
}

/** @param {Storage} storage @param {string} key */
export function loadComposerDraft(storage, key) {
  return storage.getItem(key) ?? "";
}

/** @param {Storage} storage @param {string} key */
export function clearComposerDraft(storage, key) {
  storage.removeItem(key);
}

/** @param {Storage} storage @param {string} key @param {string} text */
export function composerDraftStatus(storage, key, text) {
  if (!text.trim()) return "";
  return storage.getItem(key) === text ? "draft saved" : "draft unsaved";
}
