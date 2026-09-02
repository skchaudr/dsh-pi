import { describe, expect, it, vi } from 'vitest'
import {
  ControlPlaneManager,
  type AbortControlRequest,
  type AnnotateControlRequest,
  type ReassignControlRequest,
  type RespawnControlRequest,
  type SteerControlRequest,
} from '../control.js'

describe('S4: Full 5-Verb Control Plane Backend', () => {
  describe('abort verb', () => {
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
  })

  describe('annotate verb', () => {
    it('creates inline metadata audit events for a session node', async () => {
      const manager = new ControlPlaneManager()
      const onAnnotate = vi.fn()

      manager.registerSession('session_gamma_03', {
        onAnnotate,
        meta: { agent: 'scout' },
      })

      const request: AnnotateControlRequest = {
        targetSessionId: 'session_gamma_03',
        targetNodeId: 'node_step_4',
        annotation: 'Model hallucinated file path',
        flag: 'hallucination',
        operator: 'sab',
        reason: 'Operator review',
        timestamp: '2026-09-01T15:05:00.000Z',
      }

      const result = await manager.annotate(request)

      expect(result.ok).toBe(true)
      expect(onAnnotate).toHaveBeenCalledWith(request)
      expect(result.auditEvent).toEqual({
        type: 'control/intervention',
        verb: 'annotate',
        targetSessionId: 'session_gamma_03',
        targetNodeId: 'node_step_4',
        operator: 'sab',
        reason: 'Operator review',
        timestamp: '2026-09-01T15:05:00.000Z',
        outcome: 'success',
        details: {
          annotation: 'Model hallucinated file path',
          flag: 'hallucination',
          sessionMeta: { agent: 'scout' },
        },
      })
    })
  })

  describe('steer verb', () => {
    it('dispatches steering prompt to an active session handle', async () => {
      const manager = new ControlPlaneManager()
      const onSteer = vi.fn()
      const controller = new AbortController()

      manager.registerSession('session_delta_04', {
        controller,
        onSteer,
        meta: { model: 'grok-4.6' },
      })

      const request: SteerControlRequest = {
        targetSessionId: 'session_delta_04',
        prompt: 'Pivot to using ripgrep instead of find',
        operator: 'sab',
        priority: 'immediate',
        timestamp: '2026-09-01T15:10:00.000Z',
      }

      const result = await manager.steer(request)

      expect(result.ok).toBe(true)
      expect(onSteer).toHaveBeenCalledWith(request)
      expect(result.auditEvent.verb).toBe('steer')
      expect(result.auditEvent.outcome).toBe('success')
      expect(result.auditEvent.details).toEqual({
        prompt: 'Pivot to using ripgrep instead of find',
        priority: 'immediate',
        sessionMeta: { model: 'grok-4.6' },
      })
    })

    it('rejects steering an aborted or non-existent session', async () => {
      const manager = new ControlPlaneManager()

      const result = await manager.steer({
        targetSessionId: 'non_existent_session',
        prompt: 'Steer prompt',
        operator: 'sab',
      })

      expect(result.ok).toBe(false)
      expect(result.auditEvent.outcome).toBe('noop')
      expect(result.auditEvent.details?.['note']).toBe('session_not_found')
    })
  })

  describe('reassign verb', () => {
    it('updates runtime model/provider configuration and mutates metadata', async () => {
      const manager = new ControlPlaneManager()
      const onReassign = vi.fn()

      manager.registerSession('session_epsilon_05', {
        onReassign,
        meta: { model: 'gemini-3.5-flash', provider: 'google' },
      })

      const request: ReassignControlRequest = {
        targetSessionId: 'session_epsilon_05',
        model: 'gemini-3.7-flash',
        provider: 'google-antigravity',
        permissionMode: 'always_approve',
        operator: 'sab',
        reason: 'Upgrade model for complex coding task',
        timestamp: '2026-09-01T15:15:00.000Z',
      }

      const result = await manager.reassign(request)

      expect(result.ok).toBe(true)
      expect(onReassign).toHaveBeenCalledWith(request)
      expect(result.auditEvent.verb).toBe('reassign')
      expect(result.auditEvent.outcome).toBe('success')
      expect(result.auditEvent.details).toEqual({
        model: 'gemini-3.7-flash',
        provider: 'google-antigravity',
        permissionMode: 'always_approve',
        sessionMeta: {
          model: 'gemini-3.7-flash',
          provider: 'google-antigravity',
          permissionMode: 'always_approve',
        },
      })

      const session = manager.getSession('session_epsilon_05')
      expect(session?.meta?.['model']).toBe('gemini-3.7-flash')
    })
  })

  describe('respawn verb', () => {
    it('aborts active execution and triggers respawn callback with newSessionId', async () => {
      const manager = new ControlPlaneManager()
      const controller = new AbortController()
      const onRespawn = vi.fn().mockResolvedValue({ newSessionId: 'session_zeta_respawned_06' })

      manager.registerSession('session_zeta_06', {
        controller,
        onRespawn,
        meta: { agent: 'worker' },
      })

      const request: RespawnControlRequest = {
        targetSessionId: 'session_zeta_06',
        overrideParams: { retries: 3, thinking: 'high' },
        operator: 'sab',
        reason: 'Subagent degraded; respawn with high thinking',
        timestamp: '2026-09-01T15:20:00.000Z',
      }

      const result = await manager.respawn(request)

      expect(result.ok).toBe(true)
      expect(controller.signal.aborted).toBe(true)
      expect(onRespawn).toHaveBeenCalledWith(request)
      expect(result.data?.['newSessionId']).toBe('session_zeta_respawned_06')
      expect(result.auditEvent.verb).toBe('respawn')
      expect(result.auditEvent.outcome).toBe('success')
      expect(result.auditEvent.details).toEqual({
        overrideParams: { retries: 3, thinking: 'high' },
        newSessionId: 'session_zeta_respawned_06',
      })
    })
  })

  describe('audit history', () => {
    it('records sequence of diverse control verbs in global and per-session timeline', async () => {
      const manager = new ControlPlaneManager()
      const c1 = new AbortController()

      manager.registerSession('session_1', c1)

      await manager.annotate({ targetSessionId: 'session_1', annotation: 'flagged note', operator: 'sab' })
      await manager.steer({ targetSessionId: 'session_1', prompt: 'steer direction', operator: 'sab' })
      await manager.reassign({ targetSessionId: 'session_1', model: 'claude-3.7', operator: 'sab' })
      await manager.abort({ targetSessionId: 'session_1', operator: 'sab', reason: 'clean halt' })

      const history = manager.getAuditHistory('session_1')
      expect(history).toHaveLength(4)
      expect(history.map(h => h.verb)).toEqual(['annotate', 'steer', 'reassign', 'abort'])
    })
  })
})
