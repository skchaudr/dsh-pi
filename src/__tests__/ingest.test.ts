import { describe, expect, it } from 'vitest'
import {
  createTranslationContext,
  parsePiJsonlStream,
  streamPiEventsToDsh,
  translatePiEvent,
  type PiSessionRawEvent,
} from '../ingest.js'

describe('S1: Single-Writer Ingestion Adapter', () => {
  it('translates Pi session lifecycle and user message into turn/start and user/message', () => {
    const rawEvents: PiSessionRawEvent[] = [
      {
        type: 'session',
        version: 3,
        id: 'sess-001',
        timestamp: '2026-09-01T12:00:00.000Z',
        cwd: '/Users/sab-mini/test',
      },
      {
        type: 'session_info',
        name: 'test-session',
        timestamp: '2026-09-01T12:00:01.000Z',
      },
      {
        type: 'message',
        timestamp: '2026-09-01T12:00:02.000Z',
        message: {
          role: 'user',
          content: 'Hello Pi, please audit this codebase.',
        },
      },
      {
        type: 'agent_end',
        status: 'completed',
        timestamp: '2026-09-01T12:00:05.000Z',
      },
    ]

    const dshEvents = streamPiEventsToDsh(rawEvents)

    expect(dshEvents).toHaveLength(5)
    expect(dshEvents[0]?.type).toBe('turn/start')
    expect(dshEvents[0]?.data).toEqual({ turn: 1 })
    expect(dshEvents[1]?.type).toBe('step/start')
    expect(dshEvents[1]?.data).toEqual({ turn: 1, step: 1 })
    expect(dshEvents[2]?.type).toBe('user/message')
    const userMsg = dshEvents[2]?.data as any
    expect(userMsg.role).toBe('user')
    expect(userMsg.source).toEqual({ kind: 'user' })
    expect(userMsg.content).toEqual([{ type: 'text', text: 'Hello Pi, please audit this codebase.' }])

    expect(dshEvents[3]?.type).toBe('step/end')
    expect(dshEvents[3]?.data).toEqual({ turn: 1, step: 1 })
    expect(dshEvents[4]?.type).toBe('turn/end')
    expect(dshEvents[4]?.data).toEqual({
      turn: 1,
      reason: { kind: 'completed' },
    })
  })

  it('translates assistant toolCall and toolResult pairing with preserved callId', () => {
    const ctx = createTranslationContext(10)
    const rawEvents: PiSessionRawEvent[] = [
      {
        type: 'session',
        id: 'sess-002',
      },
      {
        type: 'message',
        message: {
          role: 'user',
          content: 'Read package.json',
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-read-01',
              name: 'read',
              arguments: { path: 'package.json' },
            },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-read-01',
          toolName: 'read',
          content: [{ type: 'text', text: '{"name": "dsh-pi"}' }],
          details: { lines: 10 },
        },
      },
      {
        type: 'agent_end',
        status: 'completed',
      },
    ]

    const dshEvents = streamPiEventsToDsh(rawEvents, ctx)

    const toolCallEvent = dshEvents.find(e => e.type === 'tool/call')
    expect(toolCallEvent).toBeDefined()
    expect(toolCallEvent?.data).toEqual({
      turn: 1,
      step: 1,
      callId: 'call-read-01',
      name: 'read',
      arguments: JSON.stringify({ path: 'package.json' }),
    })

    const toolResultEvent = dshEvents.find(e => e.type === 'tool/result')
    expect(toolResultEvent).toBeDefined()
    const toolData = toolResultEvent?.data as any
    expect(toolData.turn).toBe(1)
    expect(toolData.step).toBe(1)
    expect(toolData.meta).toEqual({ lines: 10 })
    expect(toolData.message.role).toBe('user')
    expect(toolData.message.source).toEqual({ kind: 'tool', callId: 'call-read-01' })
    expect(toolData.message.content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'call-read-01',
      isError: false,
      content: [{ type: 'text', text: '{"name": "dsh-pi"}' }],
    })
  })

  it('translates subagent_spawn with folded ToolCallBlock and ignorable marker', () => {
    const rawEvent: PiSessionRawEvent = {
      type: 'subagent_spawn',
      dispatchCallId: 'dispatch-worker-1',
      subagentName: 'worker',
      task: 'Run build and test',
      childTools: [
        {
          callId: 'child-call-01',
          parentId: 'dispatch-worker-1',
          name: 'bash',
          arguments: { command: 'pnpm test' },
          result: { content: [{ type: 'text', text: '69 passed' }] },
        },
      ],
      result: {
        content: [{ type: 'text', text: 'All tests passed cleanly' }],
      },
    }

    const ctx = createTranslationContext(0)
    const translated = translatePiEvent(rawEvent, ctx)

    expect(translated).toHaveLength(1)
    const descriptorEvent = translated[0]!
    expect(descriptorEvent.type).toBe('subagent/descriptor')
    expect(descriptorEvent.ignorable).toBe(true)
    expect((descriptorEvent.data as any).dispatchCallId).toBe('dispatch-worker-1')
    expect((descriptorEvent.data as any).block.subCalls).toHaveLength(1)
    expect((descriptorEvent.data as any).block.subCalls[0].name).toBe('bash')
  })

  it('parses raw JSONL text stream ignoring blank or corrupted lines', () => {
    const jsonl = `
      {"type":"session","id":"sess-stream"}

      {"type":"message","message":{"role":"user","content":"Stream test"}}
      {corrupted-json-line
      {"type":"agent_end","status":"completed"}
    `

    const events = parsePiJsonlStream(jsonl)
    expect(events.length).toBeGreaterThanOrEqual(4)
    expect(events[0]?.type).toBe('turn/start')
    expect(events.some(e => e.type === 'user/message')).toBe(true)
    expect(events.some(e => e.type === 'turn/end')).toBe(true)
  })

  it('correctly maps error and aborted turn_end statuses', () => {
    const errorEvent: PiSessionRawEvent = {
      type: 'agent_end',
      status: 'error',
      error: { message: 'Out of context tokens', code: 'CTX_EXCEEDED' },
    }
    const ctx1 = createTranslationContext()
    ctx1.currentTurn = 1
    ctx1.currentStep = 1
    const errorResults = translatePiEvent(errorEvent, ctx1)
    const turnEndError = errorResults.find(e => e.type === 'turn/end')
    expect((turnEndError?.data as any).reason).toEqual({
      kind: 'error',
      error: { message: 'Out of context tokens', code: 'CTX_EXCEEDED' },
    })

    const abortEvent: PiSessionRawEvent = {
      type: 'agent_end',
      status: 'aborted',
    }
    const ctx2 = createTranslationContext()
    ctx2.currentTurn = 1
    ctx2.currentStep = 1
    const abortResults = translatePiEvent(abortEvent, ctx2)
    const turnEndAbort = abortResults.find(e => e.type === 'turn/end')
    expect((turnEndAbort?.data as any).reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'user' },
    })
  })
})
