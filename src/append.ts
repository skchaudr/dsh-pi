import type { Session, SessionEvent, SessionEventMap, SurfaceIntent } from '@deepseek-ai/dsh-session'
import type { DshSessionEvent } from './ingest.js'
import { assertVocabularyKnown } from './vocabulary.js'

/**
 * Appends translated Pi events to a DSH session. `Session.append` is the sole
 * writer and sequence allocator: the translated `seq`/`time` on a
 * DshSessionEvent are Pi source positions and are never persisted — the
 * session assigns both. Surface-eligible events carry the required
 * SurfaceIntent (`surfaceOp: 'append'`); log-only events carry none.
 */
export function appendPiEvents(session: Session, events: readonly DshSessionEvent[]): SessionEvent[] {
  assertVocabularyKnown()
  const appended: SessionEvent[] = []
  const toolCallSeqs = new Map<string, number>()

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/start':
      case 'step/end':
        appended.push(session.append(event.type, event.data as SessionEventMap[typeof event.type]))
        break
      case 'user/message':
        appended.push(session.append(
          'user/message',
          event.data as SessionEventMap['user/message'],
          { surfaceOp: 'append' },
        ))
        break
      case 'tool/call': {
        const data = event.data as SessionEventMap['tool/call']
        const logged = session.append('tool/call', data)
        toolCallSeqs.set(String(data.callId), logged.seq)
        appended.push(logged)
        break
      }
      case 'tool/result': {
        const data = event.data as SessionEventMap['tool/result']
        const callSeq = toolCallSeqs.get(String(data.message.source.callId))
        // An absent sourceEventSeqs is valid; an empty one is rejected.
        const intent: SurfaceIntent = callSeq === undefined
          ? { surfaceOp: 'append' }
          : { surfaceOp: 'append', sourceEventSeqs: [callSeq] }
        appended.push(session.append('tool/result', data, intent))
        break
      }
      case 'subagent/descriptor':
        appended.push(session.append(
          'subagent/descriptor',
          event.data as SessionEventMap['subagent/descriptor'],
        ))
        break
      default:
        throw new Error(`appendPiEvents: unsupported translated event type "${event.type}"`)
    }
  }
  return appended
}
