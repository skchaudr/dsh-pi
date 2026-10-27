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
