import type { ControlPlaneManager, ControlResult } from './control.js'

export interface GuardrailConfig {
  /** Minimum acceptable cache hit ratio (e.g. 0.5 for 50%). Default: 0.3 */
  minCacheHitRatio?: number
  /** Maximum acceptable Time To First Token in milliseconds. Default: 10000 */
  maxTtftMs?: number
  /** Maximum cumulative cost budget in USD for the session. Default: 5.0 */
  maxCostUsd?: number
  /** Number of consecutive turns over which cache hit ratio is averaged. Default: 3 */
  consecutiveTurnWindow?: number
  /** Action taken when cache hit degradation is detected. Default: 'annotate' */
  onDegradationAction?: 'annotate' | 'reassign' | 'abort'
  /** Action taken when budget is exceeded. Default: 'abort' */
  onBudgetExceededAction?: 'annotate' | 'abort'
  /** Target model to reassign to when onDegradationAction is 'reassign' */
  fallbackModel?: string
  /** Operator name attached to automated control actions. Default: 'guardrail-monitor' */
  operatorName?: string
}

export interface TurnMetrics {
  turn: number
  inputTokens: number
  cacheReadTokens: number
  ttftMs?: number
  costUsd?: number
  timestamp?: string
}

export interface GuardrailViolation {
  type: 'low_cache_hit_ratio' | 'high_ttft' | 'budget_exceeded'
  message: string
  severity: 'warning' | 'critical'
  value: number
  threshold: number
}

export interface GuardrailEvaluation {
  ok: boolean
  sessionId: string
  turn: number
  cacheHitRatio: number
  cumulativeCostUsd: number
  violations: GuardrailViolation[]
  windowAverageCacheHitRatio?: number
  controlResult?: ControlResult
}

const DEFAULT_CONFIG: Required<Omit<GuardrailConfig, 'fallbackModel'>> = {
  minCacheHitRatio: 0.3,
  maxTtftMs: 10000,
  maxCostUsd: 5.0,
  consecutiveTurnWindow: 3,
  onDegradationAction: 'annotate',
  onBudgetExceededAction: 'abort',
  operatorName: 'guardrail-monitor',
}

export class GuardrailMonitor {
  private readonly config: GuardrailConfig
  private readonly sessionMetrics = new Map<string, TurnMetrics[]>()

  constructor(
    private readonly controlManager: ControlPlaneManager,
    config?: GuardrailConfig,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...(config !== undefined ? config : {}),
    }
  }

  getSessionMetrics(sessionId: string): TurnMetrics[] {
    return this.sessionMetrics.get(sessionId) ?? []
  }

  resetSession(sessionId: string): void {
    this.sessionMetrics.delete(sessionId)
  }

  async recordTurnMetrics(sessionId: string, metrics: TurnMetrics): Promise<GuardrailEvaluation> {
    const list = this.sessionMetrics.get(sessionId) ?? []
    list.push(metrics)
    this.sessionMetrics.set(sessionId, list)

    const minRatio = this.config.minCacheHitRatio ?? DEFAULT_CONFIG.minCacheHitRatio
    const maxTtft = this.config.maxTtftMs ?? DEFAULT_CONFIG.maxTtftMs
    const maxCost = this.config.maxCostUsd ?? DEFAULT_CONFIG.maxCostUsd
    const windowSize = this.config.consecutiveTurnWindow ?? DEFAULT_CONFIG.consecutiveTurnWindow
    const operator = this.config.operatorName ?? DEFAULT_CONFIG.operatorName

    const cacheHitRatio = metrics.inputTokens > 0
      ? metrics.cacheReadTokens / metrics.inputTokens
      : 0

    const cumulativeCostUsd = list.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)

    const violations: GuardrailViolation[] = []

    // 1. Check TTFT
    if (metrics.ttftMs !== undefined && metrics.ttftMs > maxTtft) {
      violations.push({
        type: 'high_ttft',
        message: `TTFT ${metrics.ttftMs}ms exceeded threshold ${maxTtft}ms`,
        severity: 'warning',
        value: metrics.ttftMs,
        threshold: maxTtft,
      })
    }

    // 2. Check cumulative budget
    if (cumulativeCostUsd > maxCost) {
      violations.push({
        type: 'budget_exceeded',
        message: `Cumulative cost $${cumulativeCostUsd.toFixed(4)} exceeded budget $${maxCost.toFixed(4)}`,
        severity: 'critical',
        value: cumulativeCostUsd,
        threshold: maxCost,
      })
    }

    // 3. Check windowed cache hit ratio
    let windowAverageCacheHitRatio: number | undefined
    if (list.length >= windowSize) {
      const recentWindow = list.slice(-windowSize)
      const totalInput = recentWindow.reduce((s, m) => s + m.inputTokens, 0)
      const totalCache = recentWindow.reduce((s, m) => s + m.cacheReadTokens, 0)
      windowAverageCacheHitRatio = totalInput > 0 ? totalCache / totalInput : 0

      if (windowAverageCacheHitRatio < minRatio) {
        violations.push({
          type: 'low_cache_hit_ratio',
          message: `Average cache hit ratio ${(windowAverageCacheHitRatio * 100).toFixed(1)}% across ${windowSize} turns below threshold ${(minRatio * 100).toFixed(1)}%`,
          severity: 'warning',
          value: windowAverageCacheHitRatio,
          threshold: minRatio,
        })
      }
    }

    let controlResult: ControlResult | undefined

    if (violations.length > 0) {
      const hasCritical = violations.some(v => v.severity === 'critical')
      const hasBudgetExceeded = violations.some(v => v.type === 'budget_exceeded')
      const hasCacheDegradation = violations.some(v => v.type === 'low_cache_hit_ratio')

      if (hasBudgetExceeded && (this.config.onBudgetExceededAction ?? DEFAULT_CONFIG.onBudgetExceededAction) === 'abort') {
        const abortRes = await this.controlManager.abort({
          targetSessionId: sessionId,
          operator,
          reason: `Auto-abort: Cumulative cost budget ($${maxCost}) exceeded`,
          checkpoint: true,
        })
        controlResult = {
          ok: abortRes.ok,
          auditEvent: abortRes.auditEvent,
          ...(abortRes.error !== undefined ? { error: abortRes.error } : {}),
        }
      } else if (hasCacheDegradation && this.config.onDegradationAction === 'reassign' && this.config.fallbackModel !== undefined) {
        controlResult = await this.controlManager.reassign({
          targetSessionId: sessionId,
          operator,
          model: this.config.fallbackModel,
          reason: `Auto-reassign: Cache hit ratio below threshold (${(minRatio * 100).toFixed(1)}%)`,
        })
      } else {
        const violationSummary = violations.map(v => v.message).join('; ')
        controlResult = await this.controlManager.annotate({
          targetSessionId: sessionId,
          operator,
          annotation: `[GUARDRAIL WARNING] ${violationSummary}`,
          flag: hasCritical ? 'critical_guardrail' : 'warning_guardrail',
          reason: 'Automated performance monitoring guardrail trigger',
        })
      }
    }

    return {
      ok: violations.length === 0,
      sessionId,
      turn: metrics.turn,
      cacheHitRatio,
      cumulativeCostUsd,
      violations,
      ...(windowAverageCacheHitRatio !== undefined ? { windowAverageCacheHitRatio } : {}),
      ...(controlResult !== undefined ? { controlResult } : {}),
    }
  }
}
