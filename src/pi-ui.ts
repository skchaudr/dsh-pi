/**
 * Hawk footer status and the warden panel are replace-in-place Pi UI, not
 * transcript rows. The host records each whole snapshot as an ignorable
 * `pi-ui/state` event; this fold serves the current badge to the web client.
 */

export const PI_UI_EVENT = 'pi-ui/state'

export interface PiUiItem {
  readonly kind: 'status' | 'widget'
  readonly key: string
  readonly level: 'info' | 'warning' | 'error'
  readonly text: string
}

export interface PiUiState {
  readonly items: readonly PiUiItem[]
}

interface PiUiProjectionDefinition {
  readonly key: 'piUi'
  readonly stateVersion: number
  readonly stateSchema: { parse(value: unknown): PiUiState }
  init(): PiUiState
  apply(state: PiUiState, event: { type: string; data: unknown }): PiUiState
  readonly wire: {
    readonly viewSchema: { parse(value: unknown): PiUiState }
    view(state: PiUiState): PiUiState
  }
}

const EMPTY: PiUiState = { items: [] }
const lastPayload = new WeakMap<object, string>()

function sameItems(left: readonly PiUiItem[], right: readonly PiUiItem[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return false
    if (a.kind !== b.kind || a.key !== b.key || a.level !== b.level || a.text !== b.text) return false
  }
  return true
}

function parseState(value: unknown): PiUiState {
  if (typeof value !== 'object' || value === null || !('items' in value) || !Array.isArray(value.items)) {
    throw new Error('pi-ui/state payload must be a whole badge snapshot')
  }
  const items: PiUiItem[] = []
  for (const item of value.items) {
    if (typeof item !== 'object' || item === null) throw new Error('pi-ui/state item is invalid')
    const row = item as Record<string, unknown>
    const kind = row['kind']
    const key = row['key']
    const level = row['level']
    const text = row['text']
    if ((kind !== 'status' && kind !== 'widget')
      || typeof key !== 'string' || key === ''
      || (level !== 'info' && level !== 'warning' && level !== 'error')
      || typeof text !== 'string') {
      throw new Error('pi-ui/state item is invalid')
    }
    items.push({ kind, key, level, text })
  }
  return { items }
}

/** Keyed status and widget rows. Notices stay on the coalesced message path. */
export function piUiItems(state: readonly { kind: string; key?: string; level: string; text: string }[]): PiUiItem[] {
  const items: PiUiItem[] = []
  for (const entry of state) {
    if (entry.kind !== 'status' && entry.kind !== 'widget') continue
    if (entry.key === undefined || entry.key === '') continue
    if (entry.level !== 'info' && entry.level !== 'warning' && entry.level !== 'error') continue
    items.push({ kind: entry.kind, key: entry.key, level: entry.level, text: entry.text })
  }
  return items
}

/** Fold of ignorable `pi-ui/state` events. The wire value is the whole snapshot. */
export const piUiProjectionDefinition: PiUiProjectionDefinition = {
  key: 'piUi',
  stateVersion: 1,
  stateSchema: { parse: parseState },
  init: () => EMPTY,
  apply(state, event) {
    if (event.type !== PI_UI_EVENT) return state
    const next = parseState(event.data)
    if (sameItems(state.items, next.items)) return state
    return next
  },
  wire: {
    viewSchema: { parse: parseState },
    view: state => state,
  },
}

interface PiUiAppend {
  append?: (type: string, data: PiUiState, opts: { readonly ignorable: true }) => unknown
}

/**
 * Append one whole badge snapshot. An unchanged snapshot is not written again.
 * `ignorable` keeps an out-of-repo event reloadable and off the transcript.
 * Sessions without `append` (older test doubles) are skipped.
 */
export function appendPiUiState(session: object, items: readonly PiUiItem[]): void {
  const writer = session as unknown as PiUiAppend
  if (typeof writer.append !== 'function') return
  const data: PiUiState = { items: items.map(item => ({ ...item })) }
  const encoded = JSON.stringify(data)
  if (lastPayload.get(session) === encoded) return
  writer.append(PI_UI_EVENT, data, { ignorable: true })
  lastPayload.set(session, encoded)
}

/** Register the badge fold when this host exposes `ctx.sessionProjections`. */
export function registerPiUiProjection(ctx: {
  inject?: (names: readonly string[], run: (scoped: object) => void) => unknown
}): void {
  ctx.inject?.(['sessionProjections'], (scoped) => {
    const registry = (scoped as { sessionProjections?: { register(definition: PiUiProjectionDefinition): () => void } }).sessionProjections
    registry?.register(piUiProjectionDefinition)
  })
}
