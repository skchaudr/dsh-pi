# Task for context-builder

Synthesize C00 contract discovery from two scout reports. Produce an executable evidence-backed contract packet, separating verified facts from unresolved gates. Preserve DSH as sole canonical event writer; distinguish flat events from derived trajectory snapshots; define the smallest deep module interface for dsh-pi runtime integration; provide exact canary commands only where verified; and list stop conditions.

DSH native writer report:

# Code Context: DSH Session Event Writer and Lifecycle Architecture

## Files Retrieved
1. `node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts` (lines 99-270, lines 300-380) - Authoritative `Session` class, `SessionStore`, and `session.append(type, data, ...opts)` implementation/signatures.
2. `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts` (lines 215-450) - Authoritative `SessionEventMap`, `SessionEvent`, `SurfaceEventType`, `SurfaceOp`, and `SurfaceIntent` types.
3. `src/index.ts` (lines 1-135, lines 360-560) - Plugin entry point, `apply(ctx: Context, config: Config)`, agent lifecycle handlers (`session/event`, `before_agent_start`, `agent/disposed`, `ctx.sessions`).
4. `src/control.ts` (lines 1-140) - `ControlPlaneManager`, `SessionControlHandle`, and registration lifecycle.
5. `src/ingest.ts` (lines 1-180) - Ingestion adapter between Pi raw session events and canonical DSH events.
6. `src/trajectory.ts` (lines 1-90) - Trajectory tree folding for flat tool events into hierarchical `ToolCallBlock`s.

## Key Code

### 1. Authoritative Event Writer and Sequence Allocator
In DSH, the single authoritative event writer and sequence allocator is `Session.prototype.append`:
```typescript
// node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:212
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
): SessionEvent<T>;
```
- **Sequence Allocator**: Monotonic `seq` is assigned internally within `session.append` (`this.log.length`). No plugin or external caller allocates `seq` directly when writing live sessions.
- **Surface Intent**: Events producing LLM messages (`SurfaceEventType`: `'user/message' | 'assistant/message' | 'tool/result'`) require a trailing `SurfaceIntent`:
  ```typescript
  export interface SurfaceIntent {
    surfaceOp: SurfaceOp; // 'append' | { op: 'replace', start: number, end: number }
    sourceEventSeqs?: number[];
  }
  ```
- **Envelope Produced**:
  ```typescript
  export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    type: T;
    seq: number;
    time: number;
    data: SessionEventMap[T];
    ignorable?: true;
    sourceEventSeqs?: number[];
    surfaceOp?: SurfaceOp;
  };
  ```

### 2. Persistence Location and Lifecycle Guarantees
- **In-Memory Store**: `SessionStore` (`ctx.sessions`) holds in-memory active sessions (`node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts`).
- **Persistence Boundary**: `SessionStore` does not write directly to disk or JSONL files. Instead, persistence backends subscribe to the post-commit `ctx.on('session/event', (session, event) => ...)` hook and flush when `ctx.sessions.flush(session)` or session disposal is invoked.
- **Synchronous Append / Fail-Closed**: `session.append` validates inputs via `isJsonValue`, checks surface replacements, commits to internal log synchronously, and then publishes to listeners. Reentrant appends during publication throw an error.

### 3. How `src/index.ts` Accesses Active Session / Agent
- In `src/index.ts`:
  - `ctx.inject = ['agents', 'tools', 'commands', 'systemPrompt', 'attachments']` (and optionally `sessions`).
  - Via Agent registration: `ctx.on('agent/ready', ({ agent }) => ...)` or intercepting `before_agent_start`, `session/event`, where `agent.session` is directly available:
    ```typescript
    const session: Session = agent.session;
    ```
  - Via Session store: `ctx.sessions.get(sessionId)` or `ctx.on('session/created', session => ...)`.

### 4. Direction of Pi ExtensionEvent vs Canonical DSH SessionEvent
- **Pi `ExtensionEvent`**: Internal agent runtime lifecycle events produced by/for Pi extensions (e.g. `turn_start`, `agent_start`, `turn_end`, `agent_end`, `tool_call`, `message`).
- **Canonical DSH `SessionEvent`**: The append-only, durable truth of the DSH agent interaction (`turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/message`, `tool/call`, `tool/result`, `request/header`).
- **Direction**:
  - DSH Session and Agent drive Pi Extension Events (DSH `turn/start` -> Pi `turn_start`, DSH `turn/end` -> Pi `turn_end`/`agent_end`).
  - Pi Extension outputs (e.g., custom user messages, steer/followup) are routed into DSH Agent methods (`agent.steer()`, `agent.followup()`, `agent.send()`), which in turn commit canonical DSH `SessionEvent`s through `session.append()`.

### 5. Seam for Registering / Unregistering `ControlPlaneManager` Handles
- **Registration Seam**: When an agent session mounts in `src/index.ts` (inside `mountAgent` or `ctx.on('agent/ready')`):
  ```typescript
  controlManager.registerSession(agent.session.header.id, {
    controller: abortController,
    onSteer: req => { agent.steer(createUserMessage({ content: [{ type: 'text', text: req.prompt }] })); },
    onAnnotate: req => { /* append log-only annotation event */ },
  });
  ```
- **Unregistration Seam**: In `ctx.on('agent/disposed', ({ agent }) => ...)`:
  ```typescript
  controlManager.unregisterSession(agent.session.header.id);
  ```

### 6. How Derived Trajectory Snapshots Should Consume Flat Persisted Events
- A flat DSH `SessionEvent[]` or raw log contains flat sequences of `tool/call` and `tool/result`.
- For subagent runs or tree-like hierarchies, subagent events carry `dispatchCallId` and `parentId`.
- `foldFleetDispatches` and `foldSubagentRunToToolCallBlock` in `src/trajectory.ts` group child calls under parent `callId` into recursive `ToolCallBlock`s:
  1. Index flat events into root tool calls and child calls mapped by `parentId` / `callId`.
  2. Map subagent dispatches into `PiSubagentDispatchEvent`.
  3. Recursively construct `ToolCallBlock` trees with nested `subCalls`.

## Architecture
- **Cordis Context (`ctx`)** orchestrates decoupled services: `agents`, `sessions`, `tools`.
- **DSH Session (`Session`)** maintains the ground truth log and assigns monotonic sequences on `session.append`.
- **DSH Agent (`Agent`)** orchestrates execution turns, dispatches LLM steps, and invokes tools.
- **Pi Host Plugin (`src/index.ts`)** sits between DSH's Cordis lifecycle hooks and Pi's `PiExtensionRuntime`.
- **Control Plane (`ControlPlaneManager`)** provides an out-of-band management surface (abort, steer, annotate) hooked into active agent handles during session lifetime.

## Smallest Deep Module Interface Proposal
To bridge DSH session events without direct JSONL writing and preserving invariants:
```typescript
export interface DshSessionEventWriter {
  readonly sessionId: string;
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T>;
}

export interface SessionControlBinding {
  register(agent: Agent, controlManager: ControlPlaneManager): () => void;
}
```

## Start Here
Open `node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts` (around line 212) and `src/index.ts` (around line 480) to inspect how `session.append` and agent event hooks interconnect.

Canary preflight report:

# Code Context

## Files Retrieved
1. `/Users/sab-mini/repos/dsh-pi/package.json` (lines 1-75) - Package configuration, dependencies (`@earendil-works/pi-coding-agent`, `@deepseek-ai/*`), and verification scripts (`check`, `test`, `compat`).
2. `/Users/sab-mini/repos/dsh-pi/src/control.ts` (lines 1-366) - Backend for 5 control plane verbs: `abort`, `steer`, `annotate`, `reassign`, `respawn` with audit logs and events.
3. `/Users/sab-mini/repos/dsh-pi/src/acp-mirror.ts` (lines 1-203) - ACP session mirroring and event synthesis (`session_start`, `steer_accepted`, `abort_acknowledged`).
4. `/Users/sab-mini/repos/dsh-pi/src/guardrails.ts` (lines 1-191) - Guardrail metrics monitor (TTFT, cost, cache tracking).
5. `/Users/sab-mini/repos/agent-observability/pyproject.toml` (lines 1-45) - Python CLI configuration for `agent-obs`.
6. `/Users/sab-mini/repos/agent-observability/src/agent_obs/core/paths.py` (lines 1-60) - Default database path logic and `AGENT_OBS_DB` override handling.
7. `/Users/sab-mini/repos/agent-observability/src/agent_obs/cli.py` (lines 1-100) - CLI options supporting `--db` and `AGENT_OBS_DB`.

## Key Code & Commands

### 1. Binaries and Package Scripts
- **Binaries verified**:
  - `dsh`: `/Users/sab-mini/.local/bin/dsh`
  - `pi`: `/Users/sab-mini/.pi/agent/bin/pi`
  - `node`: `/opt/homebrew/bin/node`
  - `pnpm`: `/opt/homebrew/bin/pnpm`
  - `agent-obs`: `/Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs`
- **Verification commands**:
  - In `dsh-pi`: `pnpm check` (runs `vitest run`, `tsc --noEmit`, and `tsc -p tsconfig.build.json`)
  - In `agent-observability`: `/Users/sab-mini/repos/agent-observability/.venv/bin/pytest tests`

### 2. Isolated Environment Setup (Canary DSH & Agent-Obs)
To guarantee zero mutations to user profiles, credentials, and production databases:
```bash
# Set isolated sandbox dirs
export CANARY_DIR=$(mktemp -d /tmp/dsh-canary-XXXXXX)
export DSH_HOME="${CANARY_DIR}/dsh_home"
export AGENT_OBS_DB="${CANARY_DIR}/agent-obs-canary.db"
mkdir -p "${DSH_HOME}/profiles/canary" "${DSH_HOME}/sessions"
```

### 3. Fake/Local Provider & Cordis Patch (No Paid APIs or Secrets)
Canary execution uses a dummy mock provider or dry-run configuration in `cordis.patch.yml`:
```yaml
- id: system-prompt
  config:
    persona: "Mock test agent"
- insert:
    - id: dsh-pi
      name: 'dsh-pi-host'
      config:
        extensions: []
        projectTrusted: false
        allowLocalPaths: false
        strict: true
```
Launch via:
```bash
dsh --profile canary --dump-config
# Or run with ACP stdio interface in isolated headless/acp mode
dsh acp --help
```

### 4. Known Session Creation & Steer / Abort Acknowledgement
Using `src/control.ts` and `src/acp-mirror.ts` interfaces:
- Session created with ID e.g. `session-canary-001`.
- Execute verb `steer` via `ControlPlaneManager.steerSession("session-canary-001", { directive: "stop test" })`.
- Execute verb `abort` via `ControlPlaneManager.abortSession("session-canary-001", { reason: "preflight-test" })`.
- Returns recorded event types: `steer_accepted` and `abort_acknowledged` in session event logs.

### 5. Ingestion, Queries, and Production DB Protection
- **Pre-execution hash capture**:
  ```bash
  shasum -a 256 ~/.local/share/agent-obs/agent-obs.db > /tmp/prod_db_pre.sha256
  ```
- **Canary ingestion into temporary DB**:
  ```bash
  /Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" ingest "${DSH_HOME}/sessions"
  /Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" list
  /Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" stats
  ```
- **Post-execution hash verification**:
  ```bash
  shasum -a 256 -c /tmp/prod_db_pre.sha256
  ```
- **Cleanup**:
  ```bash
  rm -rf "${CANARY_DIR}" /tmp/prod_db_pre.sha256
  ```

## Architecture
- `dsh-pi-host` acts as a Cordis plugin for DSH profiles, wrapping Pi extensions and lifecycle handlers.
- `ControlPlaneManager` handles `abort`, `steer`, `annotate`, `reassign`, and `respawn` events without requiring external model API calls.
- `agent-observability` reads sessions and events via `agent_obs.cli`, parameterized completely by `AGENT_OBS_DB` and custom roots/paths.

## Start Here
Open `src/control.ts` and `src/acp-mirror.ts` to see exact event payloads and verification steps for steer/abort verbs.

---
**Output:**
Write your findings to exactly this path: /Users/sab-mini/repos/dsh-pi/.pi-subagents/artifacts/outputs/c42657d4/context.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

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