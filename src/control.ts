export interface AbortControlRequest {
  targetSessionId: string
  targetNodeId?: string
  reason: string
  operator: string
  checkpoint?: boolean
  timestamp?: string
}

export interface ControlAuditEvent {
  type: 'control/intervention'
  verb: 'abort'
  targetSessionId: string
  targetNodeId?: string
  operator: string
  reason: string
  timestamp: string
  outcome: 'success' | 'failed' | 'noop'
  details?: Record<string, unknown>
}

export interface AbortControlResult {
  ok: boolean
  aborted: boolean
  auditEvent: ControlAuditEvent
  error?: string
}

interface RegisteredSession {
  sessionId: string
  controller: AbortController
  meta?: Record<string, unknown>
  aborted: boolean
}

export class ControlPlaneManager {
  private readonly sessions = new Map<string, RegisteredSession>()
  private readonly auditLog: ControlAuditEvent[] = []

  registerSession(
    sessionId: string,
    controller: AbortController,
    meta?: Record<string, unknown>,
  ): void {
    const entry: RegisteredSession = {
      sessionId,
      controller,
      aborted: controller.signal.aborted,
      ...(meta !== undefined ? { meta } : {}),
    }
    this.sessions.set(sessionId, entry)
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  async abort(request: AbortControlRequest): Promise<AbortControlResult> {
    const timestamp = request.timestamp ?? new Date().toISOString()
    const session = this.sessions.get(request.targetSessionId)

    const baseAudit: Omit<ControlAuditEvent, 'outcome' | 'details'> = {
      type: 'control/intervention',
      verb: 'abort',
      targetSessionId: request.targetSessionId,
      operator: request.operator,
      reason: request.reason,
      timestamp,
      ...(request.targetNodeId !== undefined ? { targetNodeId: request.targetNodeId } : {}),
    }

    const checkpointMeta = request.checkpoint !== undefined ? { checkpoint: request.checkpoint } : {}

    if (session === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...baseAudit,
        outcome: 'noop',
        details: {
          note: 'session_not_found_or_already_unregistered',
          ...checkpointMeta,
        },
      }
      this.auditLog.push(auditEvent)
      return {
        ok: true,
        aborted: false,
        auditEvent,
      }
    }

    if (session.aborted || session.controller.signal.aborted) {
      session.aborted = true
      const auditEvent: ControlAuditEvent = {
        ...baseAudit,
        outcome: 'noop',
        details: {
          note: 'already_aborted',
          ...checkpointMeta,
        },
      }
      this.auditLog.push(auditEvent)
      return {
        ok: true,
        aborted: false,
        auditEvent,
      }
    }

    try {
      session.controller.abort(new Error(`Aborted by operator ${request.operator}: ${request.reason}`))
      session.aborted = true

      const auditEvent: ControlAuditEvent = {
        ...baseAudit,
        outcome: 'success',
        details: {
          ...(session.meta !== undefined ? { sessionMeta: session.meta } : {}),
          ...checkpointMeta,
        },
      }
      this.auditLog.push(auditEvent)

      return {
        ok: true,
        aborted: true,
        auditEvent,
      }
    } catch (error) {
      const auditEvent: ControlAuditEvent = {
        ...baseAudit,
        outcome: 'failed',
        details: {
          error: error instanceof Error ? error.message : String(error),
          ...checkpointMeta,
        },
      }
      this.auditLog.push(auditEvent)

      return {
        ok: false,
        aborted: false,
        auditEvent,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  getAuditHistory(sessionId?: string): ControlAuditEvent[] {
    if (sessionId === undefined) {
      return [...this.auditLog]
    }
    return this.auditLog.filter(event => event.targetSessionId === sessionId)
  }
}
