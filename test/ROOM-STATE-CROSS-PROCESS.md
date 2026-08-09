# Room-state cross-process regression design

## Current proof

- § `rooms.test.ts` launches 16 independent Bun processes.
- § each opens same `default`, waits at file barrier, then writes distinct `agentCursors` key through `RoomHandle.updateState`.
- § assertion: persisted distinct keys < writers; pass = lost-update reproduced.
- ∵ process-local `sharedRoomStates` chain only; § `src/domain/rooms.ts:500-510,561-578`.
- ∵ each process independently read→mutate→rename; § `src/domain/rooms.ts:564-570`.
- atomic rename prevents torn bytes, non-CAS last rename overwrites a peer; § `src/core/store.ts:30-44`.

## Required future lock/CAS suite

1. contention — 2+ Bun processes, barrier-synchronized distinct deltas → every delta survives.
2. stale lock — preseed expired lock → successor reclaims; mutation survives.
3. live owner — unexpired lock → contender waits/retries; no concurrent critical section.
4. owner death — holder child killed after acquisition, before write → contender reclaims after lease/owner-death rule; state remains parseable.
5. timeout — lock never becomes available → bounded rejection; no state mutation; diagnostic identifies timeout.
6. no-op bytes — lock/CAS no-op mutation leaves `state.json` bytes exactly unchanged; no replacement inode/mtime if contract requires it.
7. atomic rename — pause/crash writer before rename → readers observe either complete old JSON or complete new JSON, never parse failure/torn bytes.
8. CAS conflict — contender reads version A, peer commits B, contender detects mismatch then retries from B; both deltas survive.
9. lock cleanup — success, mutation throw, write/rename throw → ownership artifact removed only by owner; next writer proceeds.
10. lock identity — pid reuse/foreign-host or nonce mismatch never grants stale owner authority; reclamation needs lease plus identity rule.
