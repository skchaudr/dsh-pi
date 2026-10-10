import type { UiPublication } from './ui-bridge.js'

export interface UiPublisherOptions {
  /** Deliver one model-visible, non-waking next-turn message. */
  sendNextTurn(text: string): void
  /** Called when replace-in-place state changes (badge/log surface). Never a transcript message. */
  onState?(state: readonly UiPublication[]): void
}

export interface UiPublisher {
  publish(event: UiPublication): void
  /** Emit at most one coalesced summary for buffered escalations. */
  flush(): void
  /** Latest replace-in-place status/widget state. */
  state(): readonly UiPublication[]
  /** True when escalations are buffered. */
  pending(): boolean
}

const normalize = (text: string): string => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()

/**
 * Pi's UI is a replace-in-place status bar plus transient notices, not a log.
 * status/widget -> keyed state (no message, no turn). warning/error notify and
 * unsupported errors -> buffered, deduped, flushed as ONE non-waking message.
 * info notify -> dropped from the transcript (rulings are warning/error).
 */
export function createUiPublisher(options: UiPublisherOptions): UiPublisher {
  const states = new Map<string, UiPublication>()
  const buffer = new Map<string, UiPublication>()
  const publish = (event: UiPublication): void => {
    if (event.kind === 'status' || event.kind === 'widget') {
      const id = `${event.kind}:${event.key ?? ''}`
      if (event.clear === true) {
        if (!states.delete(id)) return
      } else {
        const prev = states.get(id)
        if (prev !== undefined && prev.text === event.text && prev.level === event.level) return
        states.set(id, event)
      }
      options.onState?.([...states.values()])
      return
    }
    if (event.level === 'info') return
    const id = `${event.kind}:${event.level}:${normalize(event.text)}`
    if (!buffer.has(id)) buffer.set(id, event)
  }
  const flush = (): void => {
    if (buffer.size === 0) return
    const items = [...buffer.values()]
    buffer.clear()
    const lines = items.map(item => `- [${item.level}] ${item.text}`)
    const head = items.length === 1 ? '[pi:notice] 1 advisory from Pi extensions' : `[pi:notice] ${items.length} advisories from Pi extensions`
    options.sendNextTurn(`${head}\n${lines.join('\n')}`)
  }
  return { publish, flush, state: () => [...states.values()], pending: () => buffer.size > 0 }
}
