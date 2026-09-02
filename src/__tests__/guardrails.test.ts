import { beforeEach, describe, expect, it } from 'vitest'
import { ControlPlaneManager } from '../control.js'
import { GuardrailMonitor, type GuardrailConfig, type TurnMetrics } from '../guardrails.js'

describe('S5: Automated Performance & Prefix-Cache Guardrails', () => {
  let controlManager: ControlPlaneManager

  beforeEach(() => {
    controlManager = new ControlPlaneManager()
  })

  it('evaluates healthy turns without violations', async () => {
    const monitor = new GuardrailMonitor(controlManager, {
      minCacheHitRatio: 0.5,
      maxTtftMs: 2000,
      maxCostUsd: 1.0,
      consecutiveTurnWindow: 2,
    })

    const evaluation = await monitor.recordTurnMetrics('session-healthy', {
      turn: 1,
      inputTokens: 1000,
      cacheReadTokens: 800,
      ttftMs: 500,
      costUsd: 0.01,
    })

    expect(evaluation.ok).toBe(true)
    expect(evaluation.cacheHitRatio).toBe(0.8)
    expect(evaluation.violations).toHaveLength(0)
    expect(evaluation.controlResult).toBeUndefined()
  })

  it('triggers annotation when TTFT exceeds threshold', async () => {
    const monitor = new GuardrailMonitor(controlManager, {
      maxTtftMs: 1500,
    })

    const evaluation = await monitor.recordTurnMetrics('session-ttft-spike', {
      turn: 1,
      inputTokens: 500,
      cacheReadTokens: 300,
      ttftMs: 2500,
    })

    expect(evaluation.ok).toBe(false)
    expect(evaluation.violations).toHaveLength(1)
    expect(evaluation.violations[0]?.type).toBe('high_ttft')
    expect(evaluation.controlResult?.ok).toBe(true)
    expect(evaluation.controlResult?.auditEvent.verb).toBe('annotate')
    expect(evaluation.controlResult?.auditEvent.details?.flag).toBe('warning_guardrail')
  })

  it('triggers auto-abort when cumulative budget is exceeded', async () => {
    const controller = new AbortController()
    controlManager.registerSession('session-costly', controller)

    const monitor = new GuardrailMonitor(controlManager, {
      maxCostUsd: 0.5,
      onBudgetExceededAction: 'abort',
    })

    await monitor.recordTurnMetrics('session-costly', {
      turn: 1,
      inputTokens: 1000,
      cacheReadTokens: 500,
      costUsd: 0.3,
    })

    expect(controller.signal.aborted).toBe(false)

    const evaluation = await monitor.recordTurnMetrics('session-costly', {
      turn: 2,
      inputTokens: 1000,
      cacheReadTokens: 500,
      costUsd: 0.3,
    })

    expect(evaluation.ok).toBe(false)
    expect(evaluation.cumulativeCostUsd).toBeCloseTo(0.6)
    expect(evaluation.violations.some(v => v.type === 'budget_exceeded')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(evaluation.controlResult?.auditEvent.verb).toBe('abort')
  })

  it('triggers reassign when windowed cache hit ratio drops below threshold', async () => {
    let reassignedModel: string | undefined
    controlManager.registerSession('session-cache-drop', {
      onReassign: req => {
        reassignedModel = req.model
      },
    })

    const monitor = new GuardrailMonitor(controlManager, {
      minCacheHitRatio: 0.6,
      consecutiveTurnWindow: 2,
      onDegradationAction: 'reassign',
      fallbackModel: 'deepseek/deepseek-chat-v3',
    })

    await monitor.recordTurnMetrics('session-cache-drop', {
      turn: 1,
      inputTokens: 1000,
      cacheReadTokens: 100, // 10%
    })

    const evaluation = await monitor.recordTurnMetrics('session-cache-drop', {
      turn: 2,
      inputTokens: 1000,
      cacheReadTokens: 200, // 20% -> window average: 15%
    })

    expect(evaluation.ok).toBe(false)
    expect(evaluation.windowAverageCacheHitRatio).toBe(0.15)
    expect(evaluation.violations.some(v => v.type === 'low_cache_hit_ratio')).toBe(true)
    expect(evaluation.controlResult?.auditEvent.verb).toBe('reassign')
    expect(reassignedModel).toBe('deepseek/deepseek-chat-v3')
  })
})
