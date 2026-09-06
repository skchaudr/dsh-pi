import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import plugin, { apply, liveControlPlane } from '../index.js'
import { AcpSessionMirror } from '../acp-mirror.js'
import { attachDshSessionControl } from '../control.js'

const fixture = (name: string) => new URL(`./fixtures/${name}.ts`, import.meta.url).pathname

function createLiveHarness() {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const tools = new Set<string>()
  let cleanup: (() => Promise<void>) | undefined
  const session = Session.create('agent-1' as SessionId)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const inbox = { hasPending: false }
  const attachments = {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1_048_576,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: string }) => ({
      attachmentId: 'saved-image', mediaType: input.mediaType,
      bytes: input.data.byteLength, width: 1, height: 1,
    })),
    readImage: vi.fn(async (ref: unknown) => ({ ref, data: Uint8Array.from([1, 2, 3]) })),
  }
  const ctx = {
    logger, attachments,
    systemPrompt: { assemble: async () => ({ sections: [], contexts: [], variables: {}, tools: [] }) },
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, handler) },
    effect: (factory: () => () => Promise<void>) => { cleanup = factory() },
  }
  const agent = {
    id: 'agent-1', status: 'running' as const, options: { provider: 'test', model: 'base' },
    inbox, cancel: vi.fn(), whenIdle: vi.fn(async () => {}),
    send: vi.fn(), followup: vi.fn(), steer: vi.fn(), inject: vi.fn(),
    session,
    ctx: {
      inject: (_services: string[], callback: (ctx: unknown) => void) => {
        callback(agent.ctx)
        return Object.assign(Promise.resolve(), { dispose: vi.fn(async () => {}) })
      },
      tools: { register: (tool: { name: string }) => {
        tools.add(tool.name)
        return () => { tools.delete(tool.name) }
      } },
      commands: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    },
  }
  apply(ctx as never, {
    extensions: [fixture('full')], projectTrusted: false, allowLocalPaths: true,
    strict: true, flags: {},
  })
  const mount = async () => {
    await handlers.get('agent/pre-step')?.(
      {
        agent, messages: [createUserMessage({
          content: [{ type: 'text', text: 'hello' }], source: { kind: 'plugin', plugin: 'test' },
        })],
        turn: 1, step: 1, signal: new AbortController().signal,
      } as never,
      (() => Promise.resolve({ kind: 'enter', messages: [] })) as never,
    )
  }
  return {
    agent, handlers, session,
    dispose: async () => {
      handlers.get('agent/disposed')?.({ agent } as never)
      await cleanup?.()
    },
    mount,
  }
}

describe('Track B: live DSH lifecycle control receipts', () => {
  it('keeps liveControlPlane on the plugin export surface', () => {
    expect(plugin).toBe(apply)
    expect(typeof liveControlPlane).toBe('function')
  })

  it('registers the mounted agent and records canonical receipts on the live session', async () => {
    const harness = createLiveHarness()
    expect(liveControlPlane(harness.agent as never)).toBeUndefined()

    await harness.mount()
    const manager = liveControlPlane(harness.agent as never)
    expect(manager).toBeDefined()
    expect(manager?.getSession('agent-1')?.controller).toBeInstanceOf(AbortController)

    const steered = await manager!.steer({
      targetSessionId: 'agent-1',
      prompt: 'use ripgrep',
      operator: 'sab',
      timestamp: '2026-09-06T01:00:00.000Z',
    })
    expect(steered.ok).toBe(true)
    expect(harness.agent.steer).toHaveBeenCalledOnce()

    const reassigned = await manager!.reassign({
      targetSessionId: 'agent-1',
      model: 'upgraded',
      operator: 'sab',
    })
    expect(reassigned.ok).toBe(true)
    expect(harness.agent.options.model).toBe('upgraded')

    const aborted = await manager!.abort({
      targetSessionId: 'agent-1',
      operator: 'sab',
      reason: 'halt live run',
      checkpoint: true,
    })
    expect(aborted.ok).toBe(true)
    expect(aborted.aborted).toBe(true)
    expect(harness.agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'Control plane abort' })

    const receipts = harness.session.events.filter(e => e.type === 'control/intervention')
    expect(receipts).toHaveLength(3)
    expect(receipts.map(e => e.seq)).toEqual([0, 1, 2])
    expect(receipts.map(e => (e.data as { verb: string }).verb)).toEqual(['steer', 'reassign', 'abort'])
    expect(receipts.map(e => (e.data as { outcome: string }).outcome)).toEqual(['success', 'success', 'success'])
    expect(manager!.getAuditHistory()).toHaveLength(receipts.length)

    await harness.dispose()
    expect(liveControlPlane(harness.agent as never)).toBeUndefined()
    expect(manager!.getSession('agent-1')).toBeUndefined()
  })

  it('replays live receipts after append, JSONL flush, and Session reload', async () => {
    const harness = createLiveHarness()
    await harness.mount()
    const manager = liveControlPlane(harness.agent as never)!

    await manager.annotate({
      targetSessionId: 'agent-1',
      annotation: 'operator flag',
      operator: 'sab',
      timestamp: '2026-09-06T01:10:00.000Z',
    })
    await manager.abort({ targetSessionId: 'agent-1', operator: 'sab', reason: 'done' })

    const root = mkdtempSync(join(tmpdir(), 'dsh-live-control-'))
    const logPath = join(root, `${String(harness.session.id)}.jsonl`)
    writeFileSync(logPath, harness.session.events.map(e => JSON.stringify(e)).join('\n') + '\n')

    const seed = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as SessionEvent)
    const replayed = Session.create(harness.session.id, seed)
    const liveReceipts = harness.session.events.filter(e => e.type === 'control/intervention')
    const replayedReceipts = replayed.events.filter(e => e.type === 'control/intervention')
    expect(replayedReceipts.map(e => e.data)).toEqual(liveReceipts.map(e => e.data))
    expect(replayed.events.map(e => e.type)).toEqual([...harness.session.events.map(e => e.type), 'session/end-seed'])
    expect((replayedReceipts[0]!.data as { timestamp: string }).timestamp).toBe('2026-09-06T01:10:00.000Z')

    await harness.dispose()
  })

  it('never reports success when actuation throws or the receipt cannot persist', async () => {
    const harness = createLiveHarness()
    await harness.mount()
    const manager = liveControlPlane(harness.agent as never)!
    harness.agent.steer.mockImplementation(() => { throw new Error('steer channel closed') })

    const steered = await manager.steer({
      targetSessionId: 'agent-1',
      prompt: 'nope',
      operator: 'sab',
    })
    expect(steered.ok).toBe(false)
    expect(steered.auditEvent.outcome).toBe('failed')
    expect(steered.error).toBe('steer channel closed')

    const failedReceipts = harness.session.events.filter(e => e.type === 'control/intervention')
    expect(failedReceipts).toHaveLength(1)
    expect((failedReceipts[0]!.data as { outcome: string }).outcome).toBe('failed')

    const respawned = await manager.respawn({ targetSessionId: 'agent-1', operator: 'sab' })
    expect(respawned.ok).toBe(false)
    expect(respawned.auditEvent.details?.['actuator']).toBe('onRespawn')

    await harness.dispose()

    const session = Session.create('sess-unpersisted' as SessionId)
    const append = vi.spyOn(session, 'append').mockImplementation(() => {
      throw new Error('append rejected')
    })
    const isolated = attachDshSessionControl(session, 'sess-unpersisted', {
      onAnnotate: () => {},
    })
    await expect(isolated.annotate({
      targetSessionId: 'sess-unpersisted',
      annotation: 'x',
      operator: 'sab',
    })).rejects.toThrow('append rejected')
    expect(append).toHaveBeenCalledOnce()
    append.mockRestore()
    expect(session.events.filter(e => e.type === 'control/intervention')).toHaveLength(0)
  })

  it('does not duplicate receipts when ACP cancel uses the manager-owned sink', async () => {
    const harness = createLiveHarness()
    await harness.mount()
    const manager = liveControlPlane(harness.agent as never)!
    const mirror = new AcpSessionMirror('agent-1', manager)

    const cancel = await mirror.ingestMessage({
      method: 'session/cancel',
      params: { sessionId: 'agent-1', reason: 'client cancel' },
    })
    expect(cancel.controlResult?.ok).toBe(true)
    const receipts = harness.session.events.filter(e => e.type === 'control/intervention')
    expect(receipts).toHaveLength(1)
    expect((receipts[0]!.data as { verb: string }).verb).toBe('abort')
    expect(harness.agent.cancel).toHaveBeenCalledOnce()

    await harness.dispose()
  })
})
