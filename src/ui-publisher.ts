import type { UiPublication } from './ui-bridge.js'

export interface UiPublisherOptions {
  /** Deliver one model-visible, non-waking next-turn message. */
  sendNextTurn(text: string): void
  /** Called when replace-in-place state changes (badge/log surface). Never a transcript message. */
  onState?(state: readonly UiPublication[]): void
  /** True when no model turn is running (e.g. a user command is executing). */
  isIdle?(): boolean
  /** Every info notice is reported here (log surface) even when not delivered. */
  onInfo?(text: string): void
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

const INFO_STATE_CAP = 20

/**
 * Pi's UI is a replace-in-place status bar plus transient notices, not a log.
 * status/widget -> keyed state (no message, no turn).
 * warning/error notify, warning widgets, unsupported errors -> buffered, deduped by exact
 * text with a repeat count, flushed as ONE non-waking message.
 * info notify -> delivered (non-waking) when idle (user command output); during a model
 * turn it is kept in state, reported via onInfo, and rides along with a warning summary.
 */
export function createUiPublisher(options: UiPublisherOptions): UiPublisher {
  const states = new Map<string, UiPublication>()
  const buffer = new Map<string, { event: UiPublication; count: number }>()
  const infoBuffer: string[] = []
  const turnInfo: string[] = []
  const announcedWidgets = new Set<string>()
  const add = (event: UiPublication): void => {
    const id = `${event.kind}:${event.level}:${event.text}`
    const hit = buffer.get(id)
    if (hit === undefined) buffer.set(id, { event, count: 1 })
    else hit.count += 1
  }
  const publish = (event: UiPublication): void => {
    if (event.kind === 'status' || event.kind === 'widget') {
      const id = `${event.kind}:${event.key ?? ''}`
      if (event.clear === true) {
        if (!states.delete(id)) return
      } else {
        const prev = states.get(id)
        if (event.kind === 'widget' && event.level === 'warning' && !announcedWidgets.has(event.text)) {
          announcedWidgets.add(event.text)
          add(event)
        }
        if (prev !== undefined && prev.text === event.text && prev.level === event.level) return
        states.set(id, event)
      }
      options.onState?.([...states.values()])
      return
    }
    if (event.level === 'info') {
      options.onInfo?.(event.text)
      if (options.isIdle?.() === true) { infoBuffer.push(event.text); return }
      turnInfo.push(event.text)
      const id = `notify:info:${event.text}`
      states.delete(id)
      states.set(id, event)
      const infoIds = [...states.keys()].filter(k => k.startsWith('notify:info:'))
      for (const old of infoIds.slice(0, Math.max(0, infoIds.length - INFO_STATE_CAP))) states.delete(old)
      return
    }
    add(event)
  }
  const flush = (): void => {
    if (buffer.size === 0 && infoBuffer.length === 0) { return }
    const items = [...buffer.values()]
    buffer.clear()
    const lines = items.map(({ event, count }) => `- [${event.level}] ${event.text}${count > 1 ? ` (x${count})` : ''}`)
    const infos = items.length > 0 ? turnInfo.splice(0) : []
    turnInfo.length = items.length > 0 ? 0 : turnInfo.length
    infos.push(...infoBuffer.splice(0))
    for (const text of infos) lines.push(`- [info] ${text}`)
    const n = items.length + infos.length
    options.sendNextTurn(`[pi:notice] ${n} ${n === 1 ? 'notice' : 'notices'} from Pi extensions\n${lines.join('\n')}`)
  }
  return {
    publish, flush, state: () => [...states.values()],
    pending: () => buffer.size > 0 || infoBuffer.length > 0,
  }
}
