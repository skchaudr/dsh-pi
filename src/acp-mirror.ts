import type { DshSessionEvent } from './ingest.js'
import type { ControlPlaneManager, ControlResult } from './control.js'

export interface AcpMessage {
  jsonrpc?: string
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface AcpPromptParams {
  sessionId?: string
  prompt: string | Array<{ type: string; text?: string; [key: string]: unknown }>
  images?: unknown[]
}

export interface AcpCancelParams {
  sessionId: string
  reason?: string
}

export interface AcpUpdateParams {
  sessionId: string
  status?: string
  message?: string
  turn?: number
  metadata?: Record<string, unknown>
}

export interface AcpDiffApplyParams {
  sessionId: string
  path: string
  patch?: string
  content?: string
  callId?: string
}

/**
 * Translates an ACP message into a canonical DSH SessionEvent record.
 */
export function mirrorAcpMessageToDsh(
  message: AcpMessage,
  fallbackSessionId: string = 'default-acp-session',
  options: { seq?: number; time?: number } = {},
): DshSessionEvent | null {
  const seq = options.seq ?? 1
  const time = options.time ?? Date.now()
  const params = message.params ?? {}
  const sessionId = (typeof params.sessionId === 'string' ? params.sessionId : fallbackSessionId)

  switch (message.method) {
    case 'session/prompt': {
      const rawPrompt = params.prompt
      let text = ''
      if (typeof rawPrompt === 'string') {
        text = rawPrompt
      } else if (Array.isArray(rawPrompt)) {
        text = rawPrompt
          .filter(b => typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('\n')
      }

      return {
        seq,
        time,
        type: 'user/message',
        data: {
          sessionId,
          message: {
            role: 'user',
            content: [{ type: 'text', text }],
          },
          source: 'acp/session-prompt',
        },
      }
    }

    case 'session/cancel': {
      const reason = typeof params.reason === 'string' ? params.reason : 'Cancelled via ACP'
      return {
        seq,
        time,
        type: 'control/intervention',
        data: {
          verb: 'abort',
          targetSessionId: sessionId,
          operator: 'acp-client',
          reason,
          timestamp: new Date(time).toISOString(),
          outcome: 'success',
        },
      }
    }

    case 'session/update': {
      const status = typeof params.status === 'string' ? params.status : undefined
      const updateMsg = typeof params.message === 'string' ? params.message : undefined
      const turn = typeof params.turn === 'number' ? params.turn : undefined
      const metadata = typeof params.metadata === 'object' && params.metadata !== null
        ? params.metadata as Record<string, unknown>
        : undefined

      return {
        seq,
        time,
        type: 'assistant/message',
        data: {
          sessionId,
          ...(turn !== undefined ? { turn } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          message: {
            role: 'assistant',
            content: updateMsg !== undefined ? [{ type: 'text', text: updateMsg }] : [],
          },
          source: 'acp/session-update',
        },
      }
    }

    case 'diff/apply': {
      const path = typeof params.path === 'string' ? params.path : 'unknown'
      const patch = typeof params.patch === 'string' ? params.patch : undefined
      const content = typeof params.content === 'string' ? params.content : undefined
      const callId = typeof params.callId === 'string' ? params.callId : `acp_diff_${seq}`

      return {
        seq,
        time,
        type: 'tool/call',
        data: {
          callId,
          name: patch !== undefined ? 'edit' : 'write',
          arguments: {
            path,
            ...(patch !== undefined ? { patch } : {}),
            ...(content !== undefined ? { content } : {}),
          },
          source: 'acp/diff-apply',
        },
      }
    }

    default:
      return null
  }
}

export class AcpSessionMirror {
  private seq = 0
  private readonly events: DshSessionEvent[] = []

  constructor(
    private readonly defaultSessionId: string = 'acp-session',
    private readonly controlManager?: ControlPlaneManager,
  ) {}

  getMirroredEvents(): readonly DshSessionEvent[] {
    return this.events
  }

  async ingestMessage(message: AcpMessage): Promise<{
    event: DshSessionEvent | null
    controlResult?: ControlResult
  }> {
    this.seq++
    const time = Date.now()
    const event = mirrorAcpMessageToDsh(message, this.defaultSessionId, { seq: this.seq, time })

    if (event !== null) {
      this.events.push(event)
    }

    let controlResult: ControlResult | undefined

    if (message.method === 'session/cancel' && this.controlManager !== undefined) {
      const sessionId = typeof message.params?.sessionId === 'string'
        ? message.params.sessionId
        : this.defaultSessionId
      const reason = typeof message.params?.reason === 'string'
        ? message.params.reason
        : 'Cancelled by ACP client'

      const abortRes = await this.controlManager.abort({
        targetSessionId: sessionId,
        operator: 'acp-client',
        reason,
      })

      controlResult = {
        ok: abortRes.ok,
        auditEvent: abortRes.auditEvent,
        ...(abortRes.error !== undefined ? { error: abortRes.error } : {}),
      }
    }

    return {
      event,
      ...(controlResult !== undefined ? { controlResult } : {}),
    }
  }
}
