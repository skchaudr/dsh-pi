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
