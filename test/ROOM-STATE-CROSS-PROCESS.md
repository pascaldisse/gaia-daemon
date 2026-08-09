# Room-state cross-process proof

- writer=`RoomHandle.updateState` only
- lock=`state.json.lock.sqlite` + `BEGIN IMMEDIATE`
- scope=processes sharing local filesystem; NFS/distributed-lock claim=none
- critical=state read → normalize/patch → atomic rename
- source=state.json; lock db=coordination only
- owner `SIGKILL` → SQLite closes transaction → successor proceeds
- bounded busy → diagnostic rejection; no state rewrite
- no-op → no rename; bytes unchanged
- foreign `state()` → disk read; no process-local cache claim
- `test/rooms.test.ts`: 16 barrier writers → all deltas; killed holder → successor; held holder → bounded error
- transcript append/race=separate atom; this lock covers state mutation only
