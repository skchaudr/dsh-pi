import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { ToolCallBlock } from './trajectory.js'

/**
 * DSH event vocabulary emitted by the Pi ingest path. Every type is drawn
 * from DSH's KNOWN_SESSION_EVENT_TYPES catalog so a persisted log replays
 * without the `ignorable` escape hatch. `subagent/descriptor` is known to the
 * catalog but untyped in this build's shipped SessionEventMap, so it is
 * merged here via the documented plugin-extension mechanism.
 */

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Folded record of one Pi subagent dispatch: the dispatch call plus its
     * child tool calls as a hierarchical ToolCallBlock tree. Log-only —
     * derived trajectory snapshots are rebuilt from the flat event log.
     */
    'subagent/descriptor': {
      dispatchCallId: string
      subagentName: string
      task: string
      /** Parent tool-call id when the spawn was nested under a dispatch. */
      parentCallId?: string
      block: ToolCallBlock
    }
  }
}

/** Every event type the Pi → DSH ingest path can emit. */
export const PI_DSH_EVENT_TYPES = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'tool/call',
  'tool/result',
  'subagent/descriptor',
] as const

export type PiDshEventType = (typeof PI_DSH_EVENT_TYPES)[number]

/** Guard the vocabulary against drift from the upstream known-type catalog. */
export function assertVocabularyKnown(types: readonly string[] = PI_DSH_EVENT_TYPES): void {
  const unknown = types.filter(type => !KNOWN_SESSION_EVENT_TYPES.has(type))
  if (unknown.length > 0) {
    throw new Error(`Pi ingest vocabulary outside DSH known event types: ${unknown.join(', ')}`)
  }
}
