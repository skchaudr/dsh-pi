import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import {
  ControlPlaneManager,
  createDshReceiptSink,
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

  describe('fail-closed without required actuators', () => {
    it('rejects annotate/steer/reassign/respawn/abort when target or actuator is missing', async () => {
      const manager = new ControlPlaneManager()
      manager.registerSession('session_no_actuators', { meta: { agent: 'bare' } })

      const annotate = await manager.annotate({
        targetSessionId: 'session_no_actuators',
        annotation: 'note',
        operator: 'sab',
      })
      expect(annotate.ok).toBe(false)
      expect(annotate.auditEvent.outcome).toBe('failed')
      expect(annotate.auditEvent.details?.['actuator']).toBe('onAnnotate')

      const steer = await manager.steer({
        targetSessionId: 'session_no_actuators',
        prompt: 'go left',
        operator: 'sab',
      })
      expect(steer.ok).toBe(false)
      expect(steer.auditEvent.outcome).toBe('failed')
      expect(steer.auditEvent.details?.['actuator']).toBe('onSteer')

      const reassign = await manager.reassign({
        targetSessionId: 'session_no_actuators',
        model: 'x',
        operator: 'sab',
      })
      expect(reassign.ok).toBe(false)
      expect(reassign.auditEvent.details?.['actuator']).toBe('onReassign')

      const respawn = await manager.respawn({
        targetSessionId: 'session_no_actuators',
        operator: 'sab',
      })
      expect(respawn.ok).toBe(false)
      expect(respawn.auditEvent.details?.['actuator']).toBe('onRespawn')

      const abort = await manager.abort({
        targetSessionId: 'session_no_actuators',
        operator: 'sab',
        reason: 'stop',
      })
      expect(abort.ok).toBe(false)
      expect(abort.aborted).toBe(false)
      expect(abort.auditEvent.details?.['actuator']).toBe('AbortController')

      const missing = await manager.annotate({
        targetSessionId: 'missing',
        annotation: 'x',
        operator: 'sab',
      })
      expect(missing.ok).toBe(false)
      expect(missing.auditEvent.outcome).toBe('noop')
    })

    it('invokes receipt sink once per recorded audit event', async () => {
      const receipts: string[] = []
      const manager = new ControlPlaneManager({
        receiptSink: (event) => { receipts.push(`${event.verb}:${event.outcome}`) },
      })
      const controller = new AbortController()
      manager.registerSession('session_sink', {
        controller,
        onAnnotate: vi.fn(),
      })

      await manager.annotate({ targetSessionId: 'session_sink', annotation: 'a', operator: 'sab' })
      await manager.abort({ targetSessionId: 'session_sink', operator: 'sab', reason: 'done' })
      await manager.abort({ targetSessionId: 'session_sink', operator: 'sab', reason: 'again' })

      expect(receipts).toEqual(['annotate:success', 'abort:success', 'abort:noop'])
    })

    it('reports failure, never success, when an actuator throws', async () => {
      const manager = new ControlPlaneManager()
      const controller = new AbortController()
      manager.registerSession('session_throwing', {
        controller,
        onAnnotate: vi.fn().mockRejectedValue(new Error('annotate backend down')),
        onSteer: vi.fn().mockRejectedValue(new Error('steer channel closed')),
        onReassign: vi.fn().mockRejectedValue(new Error('provider rejected model')),
        onRespawn: vi.fn().mockRejectedValue(new Error('respawn budget exhausted')),
      })

      const annotate = await manager.annotate({ targetSessionId: 'session_throwing', annotation: 'x', operator: 'sab' })
      expect(annotate.ok).toBe(false)
      expect(annotate.auditEvent.outcome).toBe('failed')
      expect(annotate.error).toBe('annotate backend down')

      const steer = await manager.steer({ targetSessionId: 'session_throwing', prompt: 'x', operator: 'sab' })
      expect(steer.ok).toBe(false)
      expect(steer.auditEvent.outcome).toBe('failed')
      expect(steer.error).toBe('steer channel closed')

      const reassign = await manager.reassign({ targetSessionId: 'session_throwing', model: 'm', operator: 'sab' })
      expect(reassign.ok).toBe(false)
      expect(reassign.auditEvent.outcome).toBe('failed')
      expect(reassign.error).toBe('provider rejected model')

      const respawn = await manager.respawn({ targetSessionId: 'session_throwing', operator: 'sab' })
      expect(respawn.ok).toBe(false)
      expect(respawn.auditEvent.outcome).toBe('failed')
      expect(respawn.error).toBe('respawn budget exhausted')

      const history = manager.getAuditHistory('session_throwing')
      expect(history).toHaveLength(4)
      expect(history.every(h => h.outcome === 'failed')).toBe(true)
    })

    it('never reports success when the receipt sink itself fails', async () => {
      const manager = new ControlPlaneManager({
        receiptSink: () => { throw new Error('receipt store full') },
      })
      manager.registerSession('session_sink_fail', { onAnnotate: vi.fn() })

      await expect(
        manager.annotate({ targetSessionId: 'session_sink_fail', annotation: 'x', operator: 'sab' }),
      ).rejects.toThrow('receipt store full')
    })
  })

  describe('canonical DSH receipt sink', () => {
    it('appends exactly one receipt per control action with session-allocated seq', async () => {
      const session = Session.create('sess-control-001' as SessionId)
      const manager = new ControlPlaneManager({ receiptSink: createDshReceiptSink(session) })
      const controller = new AbortController()
      manager.registerSession('session_sink_dsh', {
        controller,
        onAnnotate: vi.fn(),
        meta: { agent: 'worker-1' },
      })

      await manager.annotate({
        targetSessionId: 'session_sink_dsh',
        annotation: 'flagged',
        operator: 'sab',
        timestamp: '2026-09-01T15:30:00.000Z',
      })
      await manager.abort({ targetSessionId: 'session_sink_dsh', operator: 'sab', reason: 'done' })
      await manager.abort({ targetSessionId: 'session_sink_dsh', operator: 'sab', reason: 'redundant' })
      await manager.steer({ targetSessionId: 'missing_session', prompt: 'x', operator: 'sab' })

      const receipts = session.events.filter(e => e.type === 'control/intervention')
      expect(receipts).toHaveLength(4)
      expect(receipts.map(e => e.seq)).toEqual([0, 1, 2, 3])
      expect(receipts.map(e => (e.data as any).outcome)).toEqual(['success', 'success', 'noop', 'noop'])
      expect(receipts.map(e => (e.data as any).verb)).toEqual(['annotate', 'abort', 'abort', 'steer'])
      // Session is the sole writer: manager audit history and DSH log agree 1:1.
      expect(manager.getAuditHistory()).toHaveLength(receipts.length)
      // The operator timestamp is a source position, not session time.
      expect((receipts[0]!.data as any).timestamp).toBe('2026-09-01T15:30:00.000Z')
    })

    it('replays receipts end-to-end: append, flush to JSONL, reload from temp root', async () => {
      const session = Session.create('sess-control-002' as SessionId)
      const manager = new ControlPlaneManager({ receiptSink: createDshReceiptSink(session) })
      const controller = new AbortController()
      manager.registerSession('session_replay', {
        controller,
        onSteer: vi.fn(),
        meta: { model: 'grok-4.6' },
      })

      await manager.steer({
        targetSessionId: 'session_replay',
        prompt: 'use ripgrep',
        operator: 'sab',
        timestamp: '2026-09-01T15:40:00.000Z',
      })
      await manager.abort({ targetSessionId: 'session_replay', operator: 'sab', reason: 'halt', checkpoint: true })
      await manager.annotate({ targetSessionId: 'session_replay', annotation: 'post-halt note', operator: 'sab' })

      // Flush: serialize the canonical log to a temp DSH root.
      const root = mkdtempSync(join(tmpdir(), 'dsh-control-replay-'))
      const logPath = join(root, 'sess-control-002.jsonl')
      writeFileSync(logPath, session.events.map(e => JSON.stringify(e)).join('\n') + '\n')

      // Reload: parse the flushed log and replay it through Session seeding.
      const seed = readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as SessionEvent)
      expect(seed).toHaveLength(3)

      const replayed = Session.create('sess-control-002' as SessionId, seed)
      const replayedReceipts = replayed.events.filter(e => e.type === 'control/intervention')
      expect(replayedReceipts.map(e => e.data)).toEqual(
        session.events.filter(e => e.type === 'control/intervention').map(e => e.data),
      )
      // Replay lifecycle appends its trailing seed-boundary marker on top.
      expect(replayed.events.map(e => e.type)).toEqual([
        ...session.events.map(e => e.type),
        'session/end-seed',
      ])
      expect(replayed.events.map(e => e.seq)).toEqual(replayed.events.map((_, i) => i))
      // A failed receipt (actuator missing on the aborted-but-registered
      // session) round-trips byte-identical: replay preserves audit truth.
      expect((replayedReceipts[2]!.data as any).outcome).toBe('failed')
      expect((replayedReceipts[2]!.data as any).details).toEqual({
        annotation: 'post-halt note',
        sessionMeta: { model: 'grok-4.6' },
        note: 'actuator_missing',
        actuator: 'onAnnotate',
      })
    })
  })

  describe('audit history', () => {
    it('records sequence of diverse control verbs in global and per-session timeline', async () => {
      const manager = new ControlPlaneManager()
      const c1 = new AbortController()

      manager.registerSession('session_1', {
        controller: c1,
        onAnnotate: vi.fn(),
        onSteer: vi.fn(),
        onReassign: vi.fn(),
      })

      await manager.annotate({ targetSessionId: 'session_1', annotation: 'flagged note', operator: 'sab' })
      await manager.steer({ targetSessionId: 'session_1', prompt: 'steer direction', operator: 'sab' })
      await manager.reassign({ targetSessionId: 'session_1', model: 'claude-3.7', operator: 'sab' })
      await manager.abort({ targetSessionId: 'session_1', operator: 'sab', reason: 'clean halt' })

      const history = manager.getAuditHistory('session_1')
      expect(history).toHaveLength(4)
      expect(history.map(h => h.verb)).toEqual(['annotate', 'steer', 'reassign', 'abort'])
      expect(history.every(h => h.outcome === 'success')).toBe(true)
    })
  })
})
