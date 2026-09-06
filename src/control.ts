import type { Session } from '@deepseek-ai/dsh-session'

export type ControlVerb = 'abort' | 'annotate' | 'steer' | 'reassign' | 'respawn'

export interface ControlAuditEvent {
  type: 'control/intervention'
  verb: ControlVerb
  targetSessionId: string
  targetNodeId?: string
  operator: string
  reason?: string
  timestamp: string
  outcome: 'success' | 'failed' | 'noop'
  details?: Record<string, unknown>
}

export interface AnnotateControlRequest {
  targetSessionId: string
  targetNodeId?: string
  annotation: string
  flag?: string
  operator: string
  reason?: string
  timestamp?: string
}

export interface SteerControlRequest {
  targetSessionId: string
  targetNodeId?: string
  prompt: string
  operator: string
  priority?: 'immediate' | 'next_turn'
  reason?: string
  timestamp?: string
}

export interface ReassignControlRequest {
  targetSessionId: string
  targetNodeId?: string
  model?: string
  provider?: string
  permissionMode?: string
  operator: string
  reason?: string
  timestamp?: string
}

export interface RespawnControlRequest {
  targetSessionId: string
  targetNodeId?: string
  overrideParams?: Record<string, unknown>
  operator: string
  reason?: string
  timestamp?: string
}

export interface AbortControlRequest {
  targetSessionId: string
  targetNodeId?: string
  reason: string
  operator: string
  checkpoint?: boolean
  timestamp?: string
}

export interface ControlResult<T = ControlAuditEvent> {
  ok: boolean
  auditEvent: T
  error?: string
  data?: Record<string, unknown>
}

export interface AbortControlResult {
  ok: boolean
  aborted: boolean
  auditEvent: ControlAuditEvent
  error?: string
}

export interface SessionControlHandle {
  controller?: AbortController
  meta?: Record<string, unknown>
  onSteer?: (req: SteerControlRequest) => Promise<void> | void
  onReassign?: (req: ReassignControlRequest) => Promise<void> | void
  onRespawn?: (req: RespawnControlRequest) => Promise<{ newSessionId?: string } | void> | { newSessionId?: string } | void
  onAnnotate?: (req: AnnotateControlRequest) => Promise<void> | void
}

interface RegisteredSessionEntry {
  sessionId: string
  handle: SessionControlHandle
  aborted: boolean
}

function buildBaseAudit(
  verb: ControlVerb,
  targetSessionId: string,
  operator: string,
  timestamp: string,
  targetNodeId?: string,
  reason?: string,
): Omit<ControlAuditEvent, 'outcome' | 'details'> {
  return {
    type: 'control/intervention',
    verb,
    targetSessionId,
    operator,
    timestamp,
    ...(targetNodeId !== undefined ? { targetNodeId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}

/** Optional sink invoked once per recorded audit event (receipt seam). */
export type ControlReceiptSink = (event: ControlAuditEvent) => void | Promise<void>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Canonical receipt for one control-plane actuation, recorded exactly
     * once per audit event whatever the outcome. Log-only (no SurfaceIntent);
     * the operator `timestamp` is a source position — Session allocates
     * seq/time. The known-type catalog has no control verb, so this extends
     * the vocabulary via the documented plugin-extension mechanism.
     */
    'control/intervention': Omit<ControlAuditEvent, 'type'>
  }
}

/**
 * Canonical receipt sink: bridge the control audit into a DSH session log.
 * `Session.append` is the sole writer/sequence allocator; a non-JSON payload
 * rejects at the append site and propagates — a receipt that did not land is
 * never reported as recorded (fail-closed).
 */
export function createDshReceiptSink(session: Session): ControlReceiptSink {
  return (event) => {
    const { type: _type, ...receipt } = event
    session.append('control/intervention', receipt)
  }
}

/**
 * Bind one live DSH session to a control manager whose only receipt writer is
 * `Session.append`. Callers that also construct `AcpSessionMirror` must not
 * pass the same session into the mirror — one sink owner per session.
 */
export function attachDshSessionControl(
  session: Session,
  sessionId: string,
  handle: SessionControlHandle,
): ControlPlaneManager {
  const manager = new ControlPlaneManager({ receiptSink: createDshReceiptSink(session) })
  manager.registerSession(sessionId, handle)
  return manager
}

export class ControlPlaneManager {
  private readonly sessions = new Map<string, RegisteredSessionEntry>()
  private readonly auditLog: ControlAuditEvent[] = []
  private readonly receiptSink: ControlReceiptSink | undefined

  constructor(options?: { receiptSink?: ControlReceiptSink }) {
    this.receiptSink = options?.receiptSink
  }

  registerSession(
    sessionId: string,
    handleOrController: AbortController | SessionControlHandle,
    meta?: Record<string, unknown>,
  ): void {
    const handle: SessionControlHandle = handleOrController instanceof AbortController
      ? {
        controller: handleOrController,
        ...(meta !== undefined ? { meta } : {}),
      }
      : {
        ...handleOrController,
        ...(meta !== undefined ? { meta: { ...handleOrController.meta, ...meta } } : {}),
      }

    const aborted = handle.controller?.signal.aborted ?? false

    this.sessions.set(sessionId, {
      sessionId,
      handle,
      aborted,
    })
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  getSession(sessionId: string): SessionControlHandle | undefined {
    return this.sessions.get(sessionId)?.handle
  }

  private async recordAudit(event: ControlAuditEvent): Promise<void> {
    this.auditLog.push(event)
    if (this.receiptSink !== undefined) {
      await this.receiptSink(event)
    }
  }

  async annotate(req: AnnotateControlRequest): Promise<ControlResult> {
    const timestamp = req.timestamp ?? new Date().toISOString()
    const base = buildBaseAudit('annotate', req.targetSessionId, req.operator, timestamp, req.targetNodeId, req.reason)
    const session = this.sessions.get(req.targetSessionId)

    const details: Record<string, unknown> = {
      annotation: req.annotation,
      ...(req.flag !== undefined ? { flag: req.flag } : {}),
      ...(session?.handle.meta !== undefined ? { sessionMeta: session.handle.meta } : {}),
    }

    if (session === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'noop',
        details: { ...details, note: 'session_not_found' },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: 'Session not found' }
    }

    if (session.handle.onAnnotate === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: { ...details, note: 'actuator_missing', actuator: 'onAnnotate' },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: 'Annotate actuator not registered' }
    }

    try {
      await session.handle.onAnnotate(req)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: { ...details, error: message },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: message }
    }

    const auditEvent: ControlAuditEvent = {
      ...base,
      outcome: 'success',
      details,
    }
    await this.recordAudit(auditEvent)
    return { ok: true, auditEvent }
  }

  async steer(req: SteerControlRequest): Promise<ControlResult> {
    const timestamp = req.timestamp ?? new Date().toISOString()
    const base = buildBaseAudit('steer', req.targetSessionId, req.operator, timestamp, req.targetNodeId, req.reason)
    const session = this.sessions.get(req.targetSessionId)

    const priority = req.priority ?? 'immediate'
    const details: Record<string, unknown> = {
      prompt: req.prompt,
      priority,
    }

    if (session === undefined || session.aborted) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'noop',
        details: { ...details, note: session === undefined ? 'session_not_found' : 'session_aborted' },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: 'Session not active' }
    }

    if (session.handle.onSteer === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: {
          ...details,
          note: 'actuator_missing',
          actuator: 'onSteer',
          ...(session.handle.meta !== undefined ? { sessionMeta: session.handle.meta } : {}),
        },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: 'Steer actuator not registered' }
    }

    try {
      await session.handle.onSteer(req)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: { ...details, error: message },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: message }
    }

    const auditEvent: ControlAuditEvent = {
      ...base,
      outcome: 'success',
      details: {
        ...details,
        ...(session.handle.meta !== undefined ? { sessionMeta: session.handle.meta } : {}),
      },
    }
    await this.recordAudit(auditEvent)
    return { ok: true, auditEvent }
  }

  async reassign(req: ReassignControlRequest): Promise<ControlResult> {
    const timestamp = req.timestamp ?? new Date().toISOString()
    const base = buildBaseAudit('reassign', req.targetSessionId, req.operator, timestamp, req.targetNodeId, req.reason)
    const session = this.sessions.get(req.targetSessionId)

    const reassignDetails: Record<string, unknown> = {
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.provider !== undefined ? { provider: req.provider } : {}),
      ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
    }

    if (session === undefined || session.aborted) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'noop',
        details: { ...reassignDetails, note: session === undefined ? 'session_not_found' : 'session_aborted' },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: 'Session not active' }
    }

    if (session.handle.onReassign === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: { ...reassignDetails, note: 'actuator_missing', actuator: 'onReassign' },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: 'Reassign actuator not registered' }
    }

    try {
      await session.handle.onReassign(req)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: { ...reassignDetails, error: message },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: message }
    }

    if (session.handle.meta === undefined) {
      session.handle.meta = {}
    }
    if (req.model !== undefined) session.handle.meta['model'] = req.model
    if (req.provider !== undefined) session.handle.meta['provider'] = req.provider
    if (req.permissionMode !== undefined) session.handle.meta['permissionMode'] = req.permissionMode

    const auditEvent: ControlAuditEvent = {
      ...base,
      outcome: 'success',
      details: {
        ...reassignDetails,
        sessionMeta: session.handle.meta,
      },
    }
    await this.recordAudit(auditEvent)
    return { ok: true, auditEvent }
  }

  async respawn(req: RespawnControlRequest): Promise<ControlResult> {
    const timestamp = req.timestamp ?? new Date().toISOString()
    const base = buildBaseAudit('respawn', req.targetSessionId, req.operator, timestamp, req.targetNodeId, req.reason)
    const session = this.sessions.get(req.targetSessionId)

    const details: Record<string, unknown> = {
      ...(req.overrideParams !== undefined ? { overrideParams: req.overrideParams } : {}),
    }

    if (session === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'noop',
        details: { ...details, note: 'session_not_found' },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: 'Session not found' }
    }

    if (session.handle.onRespawn === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: { ...details, note: 'actuator_missing', actuator: 'onRespawn' },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: 'Respawn actuator not registered' }
    }

    let respawnResult: Awaited<ReturnType<NonNullable<SessionControlHandle['onRespawn']>>>
    try {
      if (!session.aborted && session.handle.controller !== undefined) {
        session.handle.controller.abort(new Error(`Session respawned by operator ${req.operator}`))
        session.aborted = true
      }
      respawnResult = await session.handle.onRespawn(req)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: { ...details, error: message },
      }
      await this.recordAudit(auditEvent)
      return { ok: false, auditEvent, error: message }
    }

    const newSessionId = respawnResult && typeof respawnResult === 'object' && respawnResult.newSessionId !== undefined
      ? respawnResult.newSessionId
      : undefined

    const auditEvent: ControlAuditEvent = {
      ...base,
      outcome: 'success',
      details: {
        ...details,
        ...(newSessionId !== undefined ? { newSessionId } : {}),
      },
    }
    await this.recordAudit(auditEvent)
    return {
      ok: true,
      auditEvent,
      ...(newSessionId !== undefined ? { data: { newSessionId } } : {}),
    }
  }

  async abort(request: AbortControlRequest): Promise<AbortControlResult> {
    const timestamp = request.timestamp ?? new Date().toISOString()
    const session = this.sessions.get(request.targetSessionId)
    const base = buildBaseAudit('abort', request.targetSessionId, request.operator, timestamp, request.targetNodeId, request.reason)
    const checkpointMeta = request.checkpoint !== undefined ? { checkpoint: request.checkpoint } : {}

    if (session === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'noop',
        details: {
          note: 'session_not_found_or_already_unregistered',
          ...checkpointMeta,
        },
      }
      await this.recordAudit(auditEvent)
      return {
        ok: true,
        aborted: false,
        auditEvent,
      }
    }

    if (session.aborted || (session.handle.controller !== undefined && session.handle.controller.signal.aborted)) {
      session.aborted = true
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'noop',
        details: {
          note: 'already_aborted',
          ...checkpointMeta,
        },
      }
      await this.recordAudit(auditEvent)
      return {
        ok: true,
        aborted: false,
        auditEvent,
      }
    }

    if (session.handle.controller === undefined) {
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: {
          note: 'actuator_missing',
          actuator: 'AbortController',
          ...(session.handle.meta !== undefined ? { sessionMeta: session.handle.meta } : {}),
          ...checkpointMeta,
        },
      }
      await this.recordAudit(auditEvent)
      return {
        ok: false,
        aborted: false,
        auditEvent,
        error: 'Abort actuator not registered',
      }
    }

    try {
      session.handle.controller.abort(new Error(`Aborted by operator ${request.operator}: ${request.reason}`))
      session.aborted = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const auditEvent: ControlAuditEvent = {
        ...base,
        outcome: 'failed',
        details: {
          error: message,
          ...checkpointMeta,
        },
      }
      await this.recordAudit(auditEvent)
      return {
        ok: false,
        aborted: false,
        auditEvent,
        error: message,
      }
    }

    const auditEvent: ControlAuditEvent = {
      ...base,
      outcome: 'success',
      details: {
        ...(session.handle.meta !== undefined ? { sessionMeta: session.handle.meta } : {}),
        ...checkpointMeta,
      },
    }
    await this.recordAudit(auditEvent)
    return {
      ok: true,
      aborted: true,
      auditEvent,
    }
  }

  getAuditHistory(sessionId?: string): ControlAuditEvent[] {
    if (sessionId === undefined) {
      return [...this.auditLog]
    }
    return this.auditLog.filter(event => event.targetSessionId === sessionId)
  }
}
