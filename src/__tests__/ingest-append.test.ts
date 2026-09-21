import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  isSurfaceEvent,
  type SessionEvent,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import { appendPiEvents } from '../append.js'
import { createTranslationContext, parsePiJsonlStream } from '../ingest.js'
import { PI_DSH_EVENT_TYPES } from '../vocabulary.js'

const fixturePath = fileURLToPath(new URL('./fixtures/pi-session-sanitized.jsonl', import.meta.url))
const fixtureJsonl = readFileSync(fixturePath, 'utf8')

describe('W01A: append adapter over the DSH event vocabulary', () => {
  it('keeps every emitted type inside the DSH known-event catalog', () => {
    for (const type of PI_DSH_EVENT_TYPES) {
      expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
    }
  })

  it('appends the sanitized fixture with contiguous session-allocated seq, never translated seq', () => {
    // Translated seqs start at 7 to prove they are Pi source positions only.
    const translated = parsePiJsonlStream(fixtureJsonl, createTranslationContext(7))
    expect(translated.map(e => e.seq)).toEqual(translated.map((_, i) => i + 7))

    const session = Session.create('sess-fixture-001' as SessionId)
    const appended = appendPiEvents(session, translated)

    expect(appended.map(e => e.seq)).toEqual(appended.map((_, i) => i))
    expect(appended.map(e => e.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'tool/call',
      'tool/result',
      'subagent/descriptor',
      'step/end',
      'turn/end',
    ])
    // Session is the sole writer: log and return carry the same events.
    expect(session.snapshotEvents()).toHaveLength(appended.length)
    expect(session.snapshotEvents().map(e => e.seq)).toEqual(appended.map(e => e.seq))
  })

  it('carries the required SurfaceIntent on surface events and none on log-only events', () => {
    const session = Session.create('sess-fixture-001' as SessionId)
    const appended = appendPiEvents(session, parsePiJsonlStream(fixtureJsonl))

    const byType: Map<string, SessionEvent> = new Map(appended.map(e => [e.type, e]))
    const userMessage = byType.get('user/message')!
    const toolResult = byType.get('tool/result')!
    const toolCall = byType.get('tool/call')!

    expect(isSurfaceEvent(userMessage)).toBe(true)
    expect(isSurfaceEvent(toolResult)).toBe(true)
    expect((userMessage as any).surfaceOp).toBe('append')
    expect((toolResult as any).surfaceOp).toBe('append')
    // The result cites its paired call's session-allocated seq as provenance.
    expect((toolResult as any).sourceEventSeqs).toEqual([toolCall.seq])

    for (const type of ['turn/start', 'step/start', 'tool/call', 'subagent/descriptor', 'step/end', 'turn/end']) {
      const event = byType.get(type)!
      expect(isSurfaceEvent(event)).toBe(false)
      expect((event as any).surfaceOp).toBeUndefined()
      expect((event as any).sourceEventSeqs).toBeUndefined()
    }
  })

  it('replays the persisted log including subagent/descriptor (custom event is replay-safe)', () => {
    const session = Session.create('sess-fixture-001' as SessionId)
    appendPiEvents(session, parsePiJsonlStream(fixtureJsonl))

    const descriptor = session.snapshotEvents().find(e => e.type === 'subagent/descriptor')!
    expect((descriptor.data as any).block.subCalls[0].name).toBe('read')

    // Reconstruction from the flat log: seed validation and the surface fold
    // accept every event; derived messages match the live session. The replay
    // lifecycle appends its own trailing seed-boundary marker on top.
    const replayed = Session.create('sess-fixture-001' as SessionId, session.snapshotEvents())
    expect(replayed.snapshotEvents().map(e => e.type)).toEqual([...session.snapshotEvents().map(e => e.type), 'session/end-seed'])
    expect([...replayed.surface.nodes]).toEqual([...session.surface.nodes])
    expect(replayed.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('rejects translated event types outside the adapter vocabulary', () => {
    const session = Session.create('sess-fixture-001' as SessionId)
    const foreign = [{ seq: 0, time: 1, type: 'control/intervention', data: {} }] as const
    expect(() => appendPiEvents(session, foreign as unknown as any[])).toThrow(/unsupported translated event type/)
    expect(session.snapshotEvents()).toHaveLength(0)
  })
})
