import { describe, expect, it } from 'vitest'
import {
  PI_UI_EVENT,
  appendPiUiState,
  piUiItems,
  piUiProjectionDefinition,
  registerPiUiProjection,
} from '../pi-ui.js'

const hawk = { kind: 'status' as const, key: 'hawk', level: 'info' as const, text: 'hawk 19 ok' }
const panel = { kind: 'widget' as const, key: 'warden', level: 'warning' as const, text: 'hold rm' }

describe('pi ui projection', () => {
  it('drops notices and keeps keyed status and widget rows', () => {
    expect(piUiItems([
      hawk,
      { kind: 'notify', level: 'warning', text: 'advise' },
      { kind: 'widget', key: 'warden', level: 'warning', text: 'hold rm' },
      { kind: 'status', level: 'info', text: 'no key' },
    ])).toEqual([hawk, panel])
  })

  it('starts empty and replaces the whole badge on pi-ui/state', () => {
    const initial = piUiProjectionDefinition.init()
    expect(initial).toEqual({ items: [] })
    expect(piUiProjectionDefinition.apply(initial, { type: 'turn/start', data: { turn: 1 } })).toBe(initial)
    const next = piUiProjectionDefinition.apply(initial, { type: PI_UI_EVENT, data: { items: [hawk, panel] } })
    expect(next).toEqual({ items: [hawk, panel] })
    expect(piUiProjectionDefinition.wire.view(next)).toBe(next)
    expect(piUiProjectionDefinition.apply(next, { type: PI_UI_EVENT, data: { items: [hawk, panel] } })).toBe(next)
    expect(piUiProjectionDefinition.apply(next, { type: PI_UI_EVENT, data: { items: [] } })).toEqual({ items: [] })
  })

  it('rejects a pi-ui/state payload that is not a whole badge snapshot', () => {
    const initial = piUiProjectionDefinition.init()
    expect(() => piUiProjectionDefinition.apply(initial, { type: PI_UI_EVENT, data: { items: [{ kind: 'notify' }] } }))
      .toThrow(/pi-ui\/state/)
  })

  it('writes one ignorable whole-value event and skips an unchanged snapshot', () => {
    const calls: unknown[][] = []
    const session = {
      append: (...args: unknown[]) => { calls.push(args) },
    }
    appendPiUiState(session, [hawk])
    appendPiUiState(session, [hawk])
    appendPiUiState(session, [])
    expect(calls).toEqual([
      [PI_UI_EVENT, { items: [hawk] }, { ignorable: true }],
      [PI_UI_EVENT, { items: [] }, { ignorable: true }],
    ])
  })

  it('registers the piUi unit when the host has session projections', () => {
    const registered: { key?: string }[] = []
    registerPiUiProjection({
      inject: (_names, run) => {
        run({ sessionProjections: { register: (definition: { key?: string }) => { registered.push(definition); return () => {} } } })
      },
    })
    expect(registered.map(definition => definition.key)).toEqual(['piUi'])
    expect(registerPiUiProjection({})).toBeUndefined()
  })
})
