# Task for reviewer

[Read from: /Users/sab-mini/repos/dsh-pi/plan.md, /Users/sab-mini/repos/dsh-pi/progress.md]

Synthesize the C00 follow-up into a binary readiness verdict for implementation. Require exact persistence adapter, canonical path/format, deterministic integration harness, actual method names, and executable verification. List only verified facts and explicit unresolved gates.

Persistence report:

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

Canary report:

# Code Context: Deterministic Pi-Backed DSH Canary & Integration Test Harness

## Files Retrieved
1. `src/control.ts` (lines 1-400) - `ControlPlaneManager` implementation, 5-verb control requests (`abort`, `steer`, `annotate`, `reassign`, `respawn`), audit events, and `SessionControlHandle`.
2. `src/__tests__/control.test.ts` (lines 1-300) - Complete unit test fixtures exercising all 5 control verbs on `ControlPlaneManager`.
3. `src/__tests__/index.test.ts` (lines 1-125) - Authoritative mock harness pattern (`createHarness`) showing exact DSH plugin application (`apply`), agent mock structures, and lifecycle event simulation.
4. `src/index.ts` (lines 1-150) - Plugin entry point, cordis service injections (`ctx.on`, `agent/pre-step`, `agent/session-start`, `agent/session-end`), and tool adaptation.
5. `package.json` (lines 35-65) - Installed packages: devDependencies include `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, etc., but **not** `@deepseek-ai/dsh-agent-loop`.

---

## Key Code & Types

### 1. ControlPlaneManager & Verbs (`src/control.ts`)
```typescript
import {
  ControlPlaneManager,
  type SessionControlHandle,
  type SteerControlRequest,
  type AbortControlRequest,
  type ControlResult,
  type AbortControlResult
} from '../control.js'

// Actual method names on ControlPlaneManager:
// - registerSession(sessionId, handleOrController, meta?)
// - unregisterSession(sessionId)
// - steer(req: SteerControlRequest): Promise<ControlResult>
// - abort(req: AbortControlRequest): Promise<AbortControlResult>
// - annotate(req: AnnotateControlRequest): Promise<ControlResult>
// - reassign(req: ReassignControlRequest): Promise<ControlResult>
// - respawn(req: RespawnControlRequest): Promise<ControlResult>
// - getAuditHistory(sessionId?): ControlAuditEvent[]
```
*(Notice: methods are named `.steer(...)` and `.abort(...)`, NOT `.steerSession(...)` or `.abortSession(...)`)*

### 2. Pi Plugin Application (`src/index.ts`)
```typescript
import plugin, { apply, Config } from '../index.js'

// Applied to cordis Context:
apply(ctx as never, {
  extensions: [fixturePath],
  projectTrusted: false,
  allowLocalPaths: true,
  strict: true,
  flags: {},
})
```

---

## Deterministic Canary Architecture & Missing Seams

### Architecture Reality
1. **Installed Dependencies**: The workspace has `@deepseek-ai/dsh-agent` (which defines `AgentRegistry`, `Agent`, `CreateAgentOptions`, `AgentFactory`), but does **not** install `@deepseek-ai/dsh-agent-loop` (the concrete runtime factory that runs a real loop fiber and calls LLM adapters).
2. **Missing Test Seam**: In the current codebase:
   - There is no installed `@deepseek-ai/dsh-agent-loop` to instantiate a real driving loop in local tests.
   - `src/index.ts` does not yet register session handles into `ControlPlaneManager` automatically (it manages tool/command translation and `agent/pre-step`).
3. **The Deterministic Executable Seam**:
   To test a real deterministic Pi-backed DSH integration test with zero network/secrets:
   - Use Cordis `Context` with the mock/in-memory DSH Agent harness demonstrated in `src/__tests__/index.test.ts`.
   - Wire a Pi extension fixture (e.g. `src/__tests__/fixtures/full.ts` or `bridge.ts`).
   - Wire a real instance of `ControlPlaneManager`.
   - Bind `agent.steer` and `agent.cancel` to `SessionControlHandle.onSteer` and `AbortController`.

---

## Executable Deterministic Test Harness Specification

### Setup Sequence
```typescript
import { describe, it, expect, vi } from 'vitest'
import { ControlPlaneManager, type SessionControlHandle } from '../control.js'
import plugin, { apply } from '../index.js'

const fixture = (name: string) => new URL(`./fixtures/${name}.ts`, import.meta.url).pathname

it('exercises Pi lifecycle and acknowledges steer/abort via ControlPlaneManager', async () => {
  const sessionId = 'session-canary-001'
  const controlManager = new ControlPlaneManager()
  const abortController = new AbortController()

  // 1. Mock DSH Agent & Context
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const tools = new Set<string>()
  let cleanup: (() => Promise<void>) | undefined

  const agent = {
    id: sessionId,
    status: 'running',
    steer: vi.fn(),
    cancel: vi.fn(() => abortController.abort()),
    session: { header: { cwd: '/workspace' } },
    ctx: {
      inject: (_services: string[], callback: (ctx: unknown) => void) => {
        callback(agent.ctx)
        return Object.assign(Promise.resolve(), { dispose: vi.fn(async () => {}) })
      },
      tools: {
        register: (tool: { name: string }) => {
          tools.add(tool.name)
          return () => { tools.delete(tool.name) }
        }
      },
      commands: { register: () => () => {} },
      systemPrompt: { section: () => () => {} }
    }
  }

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    attachments: {},
    systemPrompt: { assemble: vi.fn() },
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, handler) },
    effect: (factory: () => () => Promise<void>) => { cleanup = factory() }
  }

  // 2. Apply dsh-pi plugin with a real Pi extension fixture
  apply(ctx as never, {
    extensions: [fixture('full')],
    projectTrusted: false,
    allowLocalPaths: true,
    strict: true,
    flags: {},
  })

  // 3. Register real ControlPlaneManager handle
  const handle: SessionControlHandle = {
    controller: abortController,
    meta: { agentId: agent.id },
    onSteer: async (req) => {
      agent.steer(req.prompt)
    }
  }
  controlManager.registerSession(sessionId, handle)

  // 4. Trigger Pi startup lifecycle
  handlers.get('agent/session-start')?.({ agent, source: 'startup' } as never)
  await new Promise(resolve => setImmediate(resolve))
  expect(tools).toContain('echo')

  // 5. Execute Control: steer
  const steerRes = await controlManager.steer({
    targetSessionId: sessionId,
    prompt: 'divert execution',
    operator: 'canary-runner',
    priority: 'immediate'
  })
  expect(steerRes.ok).toBe(true)
  expect(steerRes.auditEvent.outcome).toBe('success')
  expect(agent.steer).toHaveBeenCalledWith('divert execution')

  // 6. Execute Control: abort
  const abortRes = await controlManager.abort({
    targetSessionId: sessionId,
    reason: 'test completed',
    operator: 'canary-runner'
  })
  expect(abortRes.ok).toBe(true)
  expect(abortRes.aborted).toBe(true)
  expect(abortRes.auditEvent.outcome).toBe('success')
  expect(abortController.signal.aborted).toBe(true)

  // 7. Cleanup
  controlManager.unregisterSession(sessionId)
  if (cleanup) await cleanup()
})
```

### Execution Command & Timeout
- Command: `pnpm vitest run src/__tests__/canary.test.ts` (or `pnpm test`)
- Timeout: 5000ms (entire run finishes in <150ms due to deterministic in-memory event loop and zero network).

### Expected Events & Audit Receipts
- `control/intervention` with `verb: 'steer'`, `outcome: 'success'`, `targetSessionId: 'session-canary-001'`.
- `control/intervention` with `verb: 'abort'`, `outcome: 'success'`, `targetSessionId: 'session-canary-001'`.
- Audit history contains 2 verified receipts in `controlManager.getAuditHistory('session-canary-001')`.

---

## Start Here
Open `src/control.ts` to inspect the 5 control verbs and `src/__tests__/index.test.ts` for the exact Cordis context injection pattern.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```