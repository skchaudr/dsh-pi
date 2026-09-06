import { describe, expect, it } from 'vitest'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { ControlPlaneManager } from '../control.js'
import { AcpSessionMirror, mirrorAcpMessageToDsh, type AcpMessage } from '../acp-mirror.js'

describe('S5: ACP Message Mirroring into Canonical DSH SessionEvents', () => {
  it('mirrors session/prompt to user/message', () => {
    const msg: AcpMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: {
        sessionId: 'test-session-123',
        prompt: 'Refactor the trajectory builder',
      },
    }

    const event = mirrorAcpMessageToDsh(msg)

    expect(event).not.toBeNull()
    expect(event?.type).toBe('user/message')
    expect(event?.data).toEqual({
      sessionId: 'test-session-123',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Refactor the trajectory builder' }],
      },
      source: 'acp/session-prompt',
    })
  })

  it('mirrors diff/apply to tool/call for edit/write operations', () => {
    const msg: AcpMessage = {
      jsonrpc: '2.0',
      id: 2,
      method: 'diff/apply',
      params: {
        sessionId: 'test-session-123',
        path: 'src/guardrails.ts',
        patch: '@@ -1,3 +1,3 @@',
      },
    }

    const event = mirrorAcpMessageToDsh(msg)

    expect(event).not.toBeNull()
    expect(event?.type).toBe('tool/call')
    const data = event?.data as { name: string; arguments: { path: string; patch: string }; source: string }
    expect(data.name).toBe('edit')
    expect(data.arguments.path).toBe('src/guardrails.ts')
    expect(data.arguments.patch).toBe('@@ -1,3 +1,3 @@')
    expect(data.source).toBe('acp/diff-apply')
  })

  it('mirrors session/update to assistant/message', () => {
    const msg: AcpMessage = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'test-session-123',
        status: 'running',
        message: 'Analyzing codebase AST...',
        turn: 2,
      },
    }

    const event = mirrorAcpMessageToDsh(msg)

    expect(event).not.toBeNull()
    expect(event?.type).toBe('assistant/message')
    const data = event?.data as { turn: number; status: string; message: { content: Array<{ text: string }> } }
    expect(data.turn).toBe(2)
    expect(data.status).toBe('running')
    expect(data.message.content[0]?.text).toBe('Analyzing codebase AST...')
  })

  it('ingests messages and connects session/cancel to ControlPlaneManager', async () => {
    const controlManager = new ControlPlaneManager()
    const controller = new AbortController()
    controlManager.registerSession('session-acp-abort', controller)

    const mirror = new AcpSessionMirror('session-acp-abort', controlManager)

    const promptRes = await mirror.ingestMessage({
      method: 'session/prompt',
      params: { sessionId: 'session-acp-abort', prompt: 'Do work' },
    })
    expect(promptRes.event?.type).toBe('user/message')
    expect(controller.signal.aborted).toBe(false)

    const cancelRes = await mirror.ingestMessage({
      method: 'session/cancel',
      params: { sessionId: 'session-acp-abort', reason: 'User hit cancel in Zed' },
    })

    expect(cancelRes.event?.type).toBe('control/intervention')
    expect(cancelRes.controlResult?.ok).toBe(true)
    expect(cancelRes.controlResult?.auditEvent.outcome).toBe('success')
    expect((cancelRes.event?.data as { outcome?: string }).outcome).toBe('success')
    expect((cancelRes.event?.data as { outcome?: string }).outcome)
      .toBe(cancelRes.controlResult?.auditEvent.outcome)
    expect(controller.signal.aborted).toBe(true)
    expect(mirror.getMirroredEvents()).toHaveLength(2)
  })

  it('uses manager abort outcome as sole cancel audit truth (noop/missing actuator)', async () => {
    const controlManager = new ControlPlaneManager()
    const mirror = new AcpSessionMirror('missing-session', controlManager)

    const missing = await mirror.ingestMessage({
      method: 'session/cancel',
      params: { sessionId: 'missing-session', reason: 'gone' },
    })
    expect(missing.controlResult?.auditEvent.outcome).toBe('noop')
    expect((missing.event?.data as { outcome?: string }).outcome).toBe('noop')
    expect(mirrorAcpMessageToDsh({ method: 'session/cancel', params: { sessionId: 'x' } })).toBeNull()

    controlManager.registerSession('no-controller', { meta: { bare: true } })
    const failed = await mirror.ingestMessage({
      method: 'session/cancel',
      params: { sessionId: 'no-controller', reason: 'no actuator' },
    })
    expect(failed.controlResult?.ok).toBe(false)
    expect(failed.controlResult?.auditEvent.outcome).toBe('failed')
    expect((failed.event?.data as { outcome?: string }).outcome).toBe('failed')
    expect((failed.event?.data as { details?: { actuator?: string } }).details?.actuator)
      .toBe('AbortController')
  })

  it('lands exactly one canonical receipt per mirrored cancel, matching manager outcome', async () => {
    const session = Session.create('sess-acp-mirror-001' as SessionId)
    const controlManager = new ControlPlaneManager()
    controlManager.registerSession('acp-live', new AbortController())
    controlManager.registerSession('acp-bare', { meta: { bare: true } })
    const mirror = new AcpSessionMirror('acp-live', controlManager, session)

    const ok = await mirror.ingestMessage({
      method: 'session/cancel',
      params: { sessionId: 'acp-live', reason: 'stop' },
    })
    const noop = await mirror.ingestMessage({
      method: 'session/cancel',
      params: { sessionId: 'acp-live', reason: 'again' },
    })
    const failed = await mirror.ingestMessage({
      method: 'session/cancel',
      params: { sessionId: 'acp-bare', reason: 'no actuator' },
    })

    const results = [ok, noop, failed]
    expect(results.map(r => r.controlResult?.auditEvent.outcome)).toEqual(['success', 'noop', 'failed'])

    const receipts = session.events.filter(e => e.type === 'control/intervention')
    expect(receipts).toHaveLength(3)
    // Session is the sole sequence allocator.
    expect(receipts.map(e => e.seq)).toEqual([0, 1, 2])
    // Receipt outcome is the manager outcome — no fabricated success.
    expect(receipts.map(e => (e.data as { outcome: string }).outcome))
      .toEqual(results.map(r => r.controlResult?.auditEvent.outcome))
    expect(receipts.map(e => (e.data as { verb: string }).verb)).toEqual(['abort', 'abort', 'abort'])
    // Receipt and mirrored event carry the same audit payload.
    for (const [i, r] of results.entries()) {
      const { type: _type, ...receiptPayload } = r.controlResult!.auditEvent
      expect(receipts[i]!.data).toEqual(receiptPayload)
    }
  })
})
