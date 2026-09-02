import { describe, expect, it } from 'vitest'
import {
  ControlPlaneManager,
  type AbortControlRequest,
} from '../control.js'

describe('S2: Single Audited Control Verb (abort)', () => {
  it('registers and cleanly aborts a running session controller', async () => {
    const manager = new ControlPlaneManager()
    const abortController = new AbortController()

    let abortedSignal = false
    abortController.signal.addEventListener('abort', () => {
      abortedSignal = true
    })

    manager.registerSession('session_alpha_01', abortController, { agent: 'worker-1' })

    const request: AbortControlRequest = {
      targetSessionId: 'session_alpha_01',
      targetNodeId: 'node_tool_001',
      operator: 'sab',
      reason: 'Infinite loop detected in subagent AST traversal',
      checkpoint: true,
      timestamp: '2026-09-01T15:00:00.000Z',
    }

    const result = await manager.abort(request)

    expect(result.ok).toBe(true)
    expect(result.aborted).toBe(true)
    expect(abortedSignal).toBe(true)
    expect(abortController.signal.aborted).toBe(true)

    expect(result.auditEvent).toEqual({
      type: 'control/intervention',
      verb: 'abort',
      targetSessionId: 'session_alpha_01',
      targetNodeId: 'node_tool_001',
      operator: 'sab',
      reason: 'Infinite loop detected in subagent AST traversal',
      timestamp: '2026-09-01T15:00:00.000Z',
      outcome: 'success',
      details: {
        sessionMeta: { agent: 'worker-1' },
        checkpoint: true,
      },
    })
  })

  it('handles idempotent repeated abort calls cleanly without throwing', async () => {
    const manager = new ControlPlaneManager()
    const abortController = new AbortController()

    manager.registerSession('session_beta_02', abortController)

    const request1: AbortControlRequest = {
      targetSessionId: 'session_beta_02',
      operator: 'operator-agent',
      reason: 'First abort call',
    }

    const res1 = await manager.abort(request1)
    expect(res1.ok).toBe(true)
    expect(res1.aborted).toBe(true)
    expect(res1.auditEvent.outcome).toBe('success')

    const request2: AbortControlRequest = {
      targetSessionId: 'session_beta_02',
      operator: 'operator-agent',
      reason: 'Second redundant abort call',
    }

    const res2 = await manager.abort(request2)
    expect(res2.ok).toBe(true)
    expect(res2.aborted).toBe(false)
    expect(res2.auditEvent.outcome).toBe('noop')
    expect(res2.auditEvent.details).toEqual({
      note: 'already_aborted',
    })

    const history = manager.getAuditHistory('session_beta_02')
    expect(history).toHaveLength(2)
    expect(history[0]?.outcome).toBe('success')
    expect(history[1]?.outcome).toBe('noop')
  })

  it('returns clean noop when aborting a non-existent or unregistered session', async () => {
    const manager = new ControlPlaneManager()

    const request: AbortControlRequest = {
      targetSessionId: 'unknown_session_xyz',
      operator: 'sab',
      reason: 'Operator intervention on ghost session',
      checkpoint: false,
    }

    const result = await manager.abort(request)

    expect(result.ok).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.auditEvent.outcome).toBe('noop')
    expect(result.auditEvent.details).toEqual({
      note: 'session_not_found_or_already_unregistered',
      checkpoint: false,
    })
  })

  it('unregisters sessions properly', async () => {
    const manager = new ControlPlaneManager()
    const controller = new AbortController()

    manager.registerSession('session_gamma_03', controller)
    manager.unregisterSession('session_gamma_03')

    const result = await manager.abort({
      targetSessionId: 'session_gamma_03',
      operator: 'sab',
      reason: 'After unregister',
    })

    expect(result.ok).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.auditEvent.outcome).toBe('noop')
    expect(controller.signal.aborted).toBe(false)
  })

  it('maintains global and per-session audit history', async () => {
    const manager = new ControlPlaneManager()
    const c1 = new AbortController()
    const c2 = new AbortController()

    manager.registerSession('session_1', c1)
    manager.registerSession('session_2', c2)

    await manager.abort({ targetSessionId: 'session_1', operator: 'sab', reason: 'reason 1' })
    await manager.abort({ targetSessionId: 'session_2', operator: 'sab', reason: 'reason 2' })

    expect(manager.getAuditHistory()).toHaveLength(2)
    expect(manager.getAuditHistory('session_1')).toHaveLength(1)
    expect(manager.getAuditHistory('session_2')).toHaveLength(1)
    expect(manager.getAuditHistory('session_3')).toHaveLength(0)
  })
})
