# C00 Contract Discovery: DSH Pi Host & Observability Architecture

## 1. Goal & Architectural Ask
Synthesize contract discovery across DSH native session event writing, Pi extension lifecycle reconciliation, trajectory tree aggregation, control plane interventions, and canary verification. This document establishes verified architectural facts, the smallest deep module integration interface, exact isolated canary commands, and explicit stop conditions.

---

## 2. Verified Architectural Facts vs Unresolved Gates

### Verified Facts
1. **DSH as Sole Canonical Event Writer & Monotonic Sequence Allocator**:
   - `Session.prototype.append(type, data, ...opts)` is the single authoritative entry point for recording session events in DSH (`node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:212`).
   - Sequence numbering (`seq`) is monotonically allocated by `Session.prototype.append` based on internal log length (`this.log.length`). No plugin or external process allocates or mutates `seq` directly during live sessions.
   - Surface events (`'user/message' | 'assistant/message' | 'tool/result'`) require trailing `SurfaceIntent` (`surfaceOp: 'append' | { op: 'replace', start: number, end: number }`, optional `sourceEventSeqs`).
   - Append operations validate data via `isJsonValue`, commit synchronously to the internal in-memory log, and emit `session/event` to subscribers. Reentrant appends during publication fail closed.
2. **Direction of Pi `ExtensionEvent` vs DSH `SessionEvent`**:
   - DSH lifecycle drives Pi: DSH `turn/start` triggers Pi `turn_start`; DSH `turn/end` triggers Pi `agent_end` / `agent_settled`.
   - Pi outputs (custom user messages, steer/followup) are routed through DSH Agent APIs (`agent.steer()`, `agent.followup()`, `agent.send()`), which append canonical DSH `SessionEvent`s through `agent.session.append()`.
3. **Trajectory Folding vs Flat Events**:
   - Flat persisted events store sequential `tool/call` and `tool/result` items.
   - `src/trajectory.ts` (`foldSubagentRunToToolCallBlock`, `foldFleetDispatches`) folds flat child calls into hierarchical `ToolCallBlock` trees using `dispatchCallId` and `parentId` links without mutating raw event logs.
4. **Control Plane Seam**:
   - `ControlPlaneManager` in `src/control.ts` handles 5 verbs: `abort`, `steer`, `annotate`, `reassign`, `respawn`.
   - Registration binds via `controlManager.registerSession(sessionId, handle)` at agent mount (`ctx.on('agent/ready')` or `mountAgent`), and unregisters at `ctx.on('agent/disposed')`.
5. **Observability Database Safety**:
   - `agent-observability` supports runtime database redirection via the `AGENT_OBS_DB` environment variable or `--db <path>` flag.
   - Ingestion from DSH session directories into SQLite can run strictly isolated with pre/post SHA256 checksum verification on production database paths (`~/.local/share/agent-obs/agent-obs.db`).

### Unresolved Gates
1. **DSH Native Session Flush Backend**:
   - DSH `SessionStore` keeps active sessions in-memory. Persistence to disk/JSONL depends on subscriber plugins attached to `ctx.on('session/event')`. For canary CLI inspection, we must verify whether the targeted DSH profile configures a file-backed session sink or relies on explicit memory dump / ACP stream.
2. **ACP Headless Execution Flags**:
   - Verification of exact headless invocation flags in the canary runner environment (e.g. `dsh acp` vs `--profile canary`) before automated CI pipeline integration.

---

## 3. Smallest Deep Module Interface for `dsh-pi` Runtime

The runtime bridge requires the minimal surface that preserves DSH writer invariants while exposing control operations:

```typescript
import type { SessionEvent, SessionEventType, SessionEventMap, SurfaceEventType, SurfaceIntent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ControlPlaneManager, SessionControlHandle } from './control.js'

/**
 * Minimal interface to append canonical DSH events without direct JSONL manipulation.
 */
export interface DshSessionEventWriter {
  readonly sessionId: string
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T>
}

/**
 * Minimal lifecycle seam for binding agent control handles into ControlPlaneManager.
 */
export interface SessionControlBinding {
  register(agent: Agent, controlManager: ControlPlaneManager, extraHandle?: Partial<SessionControlHandle>): () => void
}
```

Implementation notes:
- Reuses DSH native types (`SessionEventType`, `SessionEventMap`, `SurfaceIntent`).
- Unregister callback returned by `register` guarantees clean teardown during `agent/disposed`.

---

## 4. Exact Canary Commands (Verified Local Toolchains)

All canary executions run in ephemeral, isolated sandboxes without touching production DBs, user credentials, or remote model APIs.

### A. Environment Sandboxing & Verification
```bash
# 1. Setup isolated directories
export CANARY_DIR=$(mktemp -d /tmp/dsh-canary-XXXXXX)
export DSH_HOME="${CANARY_DIR}/dsh_home"
export AGENT_OBS_DB="${CANARY_DIR}/agent-obs-canary.db"
mkdir -p "${DSH_HOME}/profiles/canary" "${DSH_HOME}/sessions"

# 2. Record production DB baseline checksum (if present)
if [ -f ~/.local/share/agent-obs/agent-obs.db ]; then
  shasum -a 256 ~/.local/share/agent-obs/agent-obs.db > /tmp/prod_db_pre.sha256
fi
```

### B. In-Repo Unit & Static Analysis Gate
```bash
# In /Users/sab-mini/repos/dsh-pi:
pnpm check
```

### C. Agent Observability Ingestion & Audit
```bash
# Ingest isolated session directory into canary database
/Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" ingest "${DSH_HOME}/sessions"

# Query canary database metrics
/Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" list
/Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" stats
```

### D. Post-Flight Integrity Verification & Cleanup
```bash
# Verify production database remained untouched
if [ -f /tmp/prod_db_pre.sha256 ]; then
  shasum -a 256 -c /tmp/prod_db_pre.sha256
  rm -f /tmp/prod_db_pre.sha256
fi

# Remove sandbox
rm -rf "${CANARY_DIR}"
```

---

## 5. Stop Conditions

Halt execution and alert supervisor immediately if any of the following occur:
1. **Production DB Touch**: `shasum -a 256 -c /tmp/prod_db_pre.sha256` fails, indicating unintended modification of production `agent-obs.db`.
2. **Bypassing `session.append`**: Any component attempts to write directly to JSONL session log files or manually inject `seq` numbers bypassing DSH's internal sequence allocator.
3. **Paid Provider Invocation**: Any canary or test run initiates external network requests or calls paid LLM provider endpoints instead of local mock fixtures.
4. **Lifecycle Desynchronization**: Agent disposal occurs without deregistering control handles in `ControlPlaneManager`, causing memory leaks or dangling steer references.