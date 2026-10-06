import type { SessionManager } from '@earendil-works/pi-coding-agent'

/** The upstream coordinator recognizes top-level custom_message entries, not wrapped messages. */
export function workflowMessageEntryId(session: Pick<SessionManager, 'getBranch'>, workflowMessageId: string): string | undefined {
  for (const entry of session.getBranch()) {
    if (entry.type === 'custom_message' && isRecord(entry.details)
      && entry.details.workflowMessageId === workflowMessageId) return entry.id
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Persist before sendMessage returns: pi-workflows immediately reports its branch to the server.
 * The caller owns visible delivery/turn scheduling, and must not enqueue an already persisted ID.
 * This keeps the upstream server/coordinator authoritative; it does not create a second workflow engine.
 */
export function persistWorkflowMessage(
  session: Pick<SessionManager, 'getBranch' | 'appendCustomMessageEntry'>,
  message: { customType: string; content: Parameters<SessionManager['appendCustomMessageEntry']>[1]; display: boolean; details?: unknown },
): { entryId: string; duplicate: boolean } | undefined {
  if (!isRecord(message.details) || !('workflowMessageId' in message.details)) return undefined
  const id = message.details.workflowMessageId
  if (typeof id !== 'string' || id.length === 0) throw new Error('Invalid workflow message identity')
  const existing = workflowMessageEntryId(session, id)
  if (existing !== undefined) return { entryId: existing, duplicate: true }
  return {
    entryId: session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details),
    duplicate: false,
  }
}
