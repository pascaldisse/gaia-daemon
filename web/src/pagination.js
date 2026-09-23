// Sidebar list pagination — pure, DOM-free (see sidebar.js WorkspaceList/RoomTree).

/**
 * Pagination escape hatch: entries the cap must never hide.
 *
 * A capped list slices the first N entries, so anything below the cap renders
 * NO ROW — and a row that doesn't exist cannot show a running dot. d2882bae
 * capped both sidebar lists (current selection was the only exemption), which
 * made live agent activity in workspace/room #9+ invisible: the sidebar looked
 * like the dots only worked for the selected chat. Live entries are appended
 * after the slice — order preserved, still ahead of the show-more button — so
 * a running agent always owns a visible row wherever it sits in the order.
 *
 * @template T
 * @param {T[]} all every entry, in display order
 * @param {number} shown how many the cap renders
 * @param {(item: T) => boolean} [pinned] entries kept visible past the cap
 * @returns {T[]}
 */
export function visibleWithPinned(all, shown, pinned = () => false) {
  const visible = all.slice(0, shown);
  for (const item of all.slice(shown)) if (pinned(item)) visible.push(item);
  return visible;
}
