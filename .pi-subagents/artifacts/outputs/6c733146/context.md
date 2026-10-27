# DSH Persistence Backend & Session Event Inspection

## Files Retrieved
1. `~/.dsh/profiles/acp/package.json` (lines 1-13) - Installed profile bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-acp-app`).
2. `~/.dsh/profiles/acp/cordis.yml` and `cordis.patch.yml` - Profile root and user patches (empty arrays).
3. `~/.dsh/profiles/web/cordis.patch.yml` - Installed web profile user patch overrides.
4. `~/.config/deepseek-harness/packages/session/session-persistence/src/coordinator.ts` (lines 1084-1180) - `PersistenceCoordinator` write-path setup subscribing to Cordis events `session/created`, `session/event`, `session/flush`, and `session/disposed`.
5. `~/.config/deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts` (lines 1-105) - Plugin registration for `@deepseek-ai/dsh-session-persistence-jsonl`, configuration schema, and defaults.
6. `~/.config/deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts` - Path resolution (`dshHomePath('sessions')`), session log layout, project/session directory structure, and compression rules.

## Key Code & Interfaces

### Event Subscription Seam (`coordinator.ts`)
```ts
// From coordinator.ts: ctx.on write path registration
ctx.on('session/created', (session) => {
  void this.initFor(session)
})

ctx.on('session/event', (session, event) => {
  const live = this.initFor(session)
  live.writes.enqueue(event)
})

ctx.on('session/flush', session => this.flush(session))

ctx.on('session/disposed', (session) => { this.retire(session) })
```

### Profile Backend Configuration
From `dsh --profile acp --dump-config` and `dsh --profile web --dump-config`:
```yaml
# id: session-persistence-jsonl
name: '@deepseek-ai/dsh-session-persistence-jsonl'
config:
  root: !!js dshHomePath('sessions') # -> <DSH_HOME>/sessions
```

## Architecture & Findings

### 1. Active Persistence Backend
- Both installed profiles (`acp` and `web`) inherit from bundle `@deepseek-ai/dsh-base`, which activates plugin **`@deepseek-ai/dsh-session-persistence-jsonl`** (`id: session-persistence-jsonl`).
- Note: SQLite is also loaded as `@deepseek-ai/dsh-session-query-sqlite` (configured with `path: ':memory:'`, `openAt: never`), but it serves strictly as an in-memory query index, not durable session storage.

### 2. Subscriber to `session/event`
- Plugin: `@deepseek-ai/dsh-session-persistence-jsonl`.
- The plugin instantiates `PersistenceCoordinator` (from `@deepseek-ai/dsh-session-persistence`), which registers event handlers on the Cordis application context:
  - `session/created`: captures metadata header.
  - `session/event`: buffers live event into a write-behind queue (`live.writes.enqueue(event)`).
  - `session/flush`: immediate durability barrier; drains pending writes in the queue to disk.
  - `session/disposed`: drains remaining writes, flushes, and retires the session.

### 3. Canonical Storage Format & Path
- **Base Root**: `<DSH_HOME>/sessions/` (on this machine: `~/.dsh/sessions/`).
- **Hierarchy**: `<DSH_HOME>/sessions/<projectSlug>/<sessionId>/session.jsonl` (or `.jsonl.zst` when compressed).
- **Format**:
  - Line 1: Header JSON containing metadata (`SessionHeader`).
  - Subsequent lines: Contiguous `SessionEvent` JSON records. When `packChunks` is true (default: true), consecutive streaming deltas (`assistant/chunk`) are coalesced into packed chunk rows.
  - Compression: Defaults to Zstandard checksummed frames (`compression: 'zstd'`).

### 4. Flush Semantics
- Write batching is managed by `SessionWriteBehind`.
- Events are enqueued and coalesced within a time window governed by `writeBatchMaxDelayMs` (default: 200ms).
- Explicit `ctx.emit('session/flush', session)` acts as a write barrier, immediately awaiting write serialization and filesystem sync (`fsync`/`fdatasync`).
- Disposals trigger `retireCore(session)`, guaranteeing an orderly final flush before teardown.

### 5. Integration with `dsh-pi`: Preventing Second-Writer Conflicts
- **Avoid Direct Filesystem Writes**: `dsh-pi` should NOT write or modify `.jsonl` / `.jsonl.zst` files in `~/.dsh/sessions/`.
- **Rely on DSH Pipeline**: `dsh-pi` can emit standard `session/event` Cordis events on the session context. The harness's existing `PersistenceCoordinator` and `@deepseek-ai/dsh-session-persistence-jsonl` handle all queueing, chunk packing, serialization, and disk flushing.
- **For Durability Barriers**: When `dsh-pi` requires that events are committed to disk before proceeding, it should emit/call `ctx.emit('session/flush', session)` rather than invoking ad-hoc filesystem syncs.

## Start Here
Inspect `~/.config/deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts` to see how `@deepseek-ai/dsh-session-persistence-jsonl` exposes `ctx.sessionPersistence` and links to `PersistenceCoordinator`.
