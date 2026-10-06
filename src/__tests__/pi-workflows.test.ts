import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { persistWorkflowMessage, workflowMessageEntryId } from '../pi-workflows.js'

const message = {
  customType: 'workflow-agent-step', content: 'Inspect the work', display: true,
  details: { workflowMessageId: 'message-1', runId: 'run-1', contract: { allowedTools: ['read'] } },
}

describe('pi-workflows durable delivery', () => {
  it('persists recognizable custom entries synchronously and deduplicates delivery', () => {
    const session = SessionManager.inMemory('/tmp')
    const first = persistWorkflowMessage(session, message)!
    expect(first.duplicate).toBe(false)
    expect(workflowMessageEntryId(session, 'message-1')).toBe(first.entryId)
    expect(session.getBranch()[0]).toMatchObject({ type: 'custom_message', details: message.details })
    expect(persistWorkflowMessage(session, message)).toEqual({ ...first, duplicate: true })
    expect(session.getBranch()).toHaveLength(1)
  })

  it('leaves unrelated extensions alone and fails closed on malformed identities', () => {
    const session = SessionManager.inMemory('/tmp')
    expect(persistWorkflowMessage(session, { ...message, details: {} })).toBeUndefined()
    expect(() => persistWorkflowMessage(session, { ...message, details: { workflowMessageId: '' } })).toThrow('identity')
    expect(session.getBranch()).toHaveLength(0)
  })

  it('retains origin identity, parent history, and delivery IDs after reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-piw-'))
    try {
      const session = SessionManager.create(dir, dir)
      session.appendMessage({ role: 'user', content: 'Original task', timestamp: 1 })
      // Pi flushes a newly created session once an assistant message exists.
      session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Acknowledged' }], api: 'openai-responses', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 })
      const first = persistWorkflowMessage(session, message)!
      const restored = SessionManager.open(session.getSessionFile()!)
      expect(restored.getSessionId()).toBe(session.getSessionId())
      expect(restored.getBranch()).toHaveLength(3)
      expect(persistWorkflowMessage(restored, message)).toEqual({ ...first, duplicate: true })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

// Explicit fixture opt-in: reads the package only, never starts its server or inference.
const fixture = process.env.PI_WORKFLOWS_FIXTURE

describe.skipIf(!fixture)('installed pi-workflows coordinator contract', () => {
  async function setup(triggerTurn = true, kind = 'step') {
    const load = (file: string) => import(pathToFileURL(join(fixture!, 'dist', file)).href)
    const { WorkflowMessageCoordinator, branchWorkflowEntries } = await load('extension/workflow-message-coordinator.js')
    const { canonicalJson } = await load('state/json.js')
    const { WORKFLOW_TURN_REPORT_RECEIPT_SCHEMA } = await load('client/view.js')
    const session = SessionManager.inMemory('/tmp')
    const coordinator = new WorkflowMessageCoordinator()
    let idle = true
    const content = { schema: 'pi-workflows.workflow-message-content.v1', ...message, triggerTurn }
    const view = {
      sessionId: session.getSessionId(), coordinatorActive: true, coordinatorEpoch: 'epoch-1',
      branchReportRequired: true, openWorkflowTurn: null,
      workflowMessage: { workflowMessageId: 'message-1', runId: 'run-1', targetSessionId: session.getSessionId(), sourceId: 'step-1', kind, status: 'pending', triggerTurn, deliveryCancelled: false, content, contentDigest: createHash('sha256').update(canonicalJson(content)).digest('hex') },
    }
    const request = vi.fn(async (req: { operation: string; payload: Record<string, unknown> }) => {
      if (req.operation !== 'workflowTurn.report') return { outcome: 'accepted' }
      return { outcome: 'accepted', receipt: { schema: WORKFLOW_TURN_REPORT_RECEIPT_SCHEMA, ownership: req.payload.state === 'started' ? 'active' : 'settled', turn: { schema: 'pi-workflows.workflow-turn.v1', ...req.payload } } }
    })
    const client = { hydrateContent: async () => content, request }
    const ctx = { sessionManager: session, isIdle: () => idle, hasPendingMessages: () => false, abort: vi.fn() }
    const pi = { sendMessage: vi.fn((value: typeof message, delivery: { triggerTurn: boolean }) => {
      persistWorkflowMessage(session, value)
      expect(branchWorkflowEntries(session.getBranch()).get('message-1')).toBeDefined()
      if (delivery.triggerTurn) { idle = false; coordinator.startTurn() }
    }) }
    coordinator.updateView(view)
    return { coordinator, session, client, ctx, pi, view, request, setIdle: () => { idle = true } }
  }

  it('acknowledges durable delivery, guards tools, and settles a parent turn with its response ID', async () => {
    const f = await setup()
    await f.coordinator.synchronize(f.pi, f.client, f.ctx)
    expect(f.pi.sendMessage).toHaveBeenCalledOnce()
    expect(f.coordinator.toolCallBlockReason('read', {})).toBeUndefined()
    expect(f.coordinator.toolCallBlockReason('bash', {})).toContain('not allowed')
    f.coordinator.endTurn('completed', 'assistant-entry-1')
    f.setIdle()
    const beforeTurnEnd = vi.fn()
    await f.coordinator.synchronize(f.pi, f.client, f.ctx, { beforeTurnEnd })
    expect(beforeTurnEnd).toHaveBeenCalledOnce()
    expect(f.request.mock.calls.some(([r]) => r.operation === 'workflowTurn.report' && r.payload.state === 'ended' && r.payload.responseSessionEntryId === 'assistant-entry-1')).toBe(true)
    expect(f.pi.sendMessage).toHaveBeenCalledOnce()
  })

  it.each(['decision', 'notification'])('delivers visible %s messages without starting inference', async (kind) => {
    const f = await setup(false, kind)
    await f.coordinator.synchronize(f.pi, f.client, f.ctx)
    expect(f.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: true, details: message.details }), { triggerTurn: false })
    expect(f.ctx.isIdle()).toBe(true)
    expect(f.request.mock.calls.some(([r]) => r.operation === 'workflowTurn.report')).toBe(false)
    await f.coordinator.synchronize(f.pi, f.client, f.ctx)
    expect(f.pi.sendMessage).toHaveBeenCalledOnce()
  })

  it('recovers an existing branch delivery without enqueueing a duplicate turn', async () => {
    const f = await setup()
    const entry = persistWorkflowMessage(f.session, message)!
    await f.coordinator.synchronize(f.pi, f.client, f.ctx)
    expect(f.pi.sendMessage).not.toHaveBeenCalled()
    expect(f.request.mock.calls.some(([r]) => r.operation === 'workflowMessage.reportBranch' && r.payload.piSessionEntryId === entry.entryId)).toBe(true)
  })

  it('aborts owned turns once, fences tools on disconnect, and prevents duplicate replay', async () => {
    const f = await setup()
    await f.coordinator.synchronize(f.pi, f.client, f.ctx)
    f.view.workflowMessage.deliveryCancelled = true
    f.coordinator.updateView(f.view)
    f.coordinator.abortCancelledTurn(f.ctx)
    f.coordinator.abortCancelledTurn(f.ctx)
    expect(f.ctx.abort).toHaveBeenCalledOnce()
    expect(f.coordinator.toolCallBlockReason('read', {})).toContain('cancelled')
    f.coordinator.fence()
    expect(f.coordinator.toolCallBlockReason('read', {})).toContain('unavailable')
    await f.coordinator.synchronize(f.pi, f.client, f.ctx)
    expect(f.pi.sendMessage).toHaveBeenCalledOnce()
  })
})
