import { describe, expect, it, vi } from 'vitest'
import { createUiPublisher } from '../ui-publisher.js'

const setup = () => {
  const sent: string[] = []
  const wake = vi.fn()
  const states: unknown[] = []
  const publisher = createUiPublisher({
    sendNextTurn: text => { sent.push(text) },
    onState: s => { states.push(s) },
  })
  return { sent, wake, states, publisher }
}

describe('ui publisher (flood fix)', () => {
  it('20 changing setStatus calls produce zero messages and one replaced state', () => {
    const { sent, publisher } = setup()
    for (let i = 0; i < 20; i++) publisher.publish({ kind: 'status', key: 'hawk', level: 'info', text: `hawk ${i} ok` })
    publisher.flush()
    expect(sent).toHaveLength(0)
    expect(publisher.state()).toEqual([{ kind: 'status', key: 'hawk', level: 'info', text: 'hawk 19 ok' }])
  })

  it('repeated setWidget replaces state in place and clear removes it', () => {
    const { sent, publisher } = setup()
    for (let i = 0; i < 5; i++) publisher.publish({ kind: 'widget', key: 'w', level: 'info', text: `rev ${i}` })
    publisher.flush()
    expect(publisher.state()).toHaveLength(1)
    expect(publisher.state()[0]!.text).toBe('rev 4')
    publisher.publish({ kind: 'widget', key: 'w', level: 'info', text: 'x', clear: true })
    expect(publisher.state()).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('one warning yields exactly one non-waking next-turn message', () => {
    const { sent, publisher } = setup()
    publisher.publish({ kind: 'notify', level: 'warning', text: 'warden: advise rm -rf' })
    expect(sent).toHaveLength(0)
    publisher.flush()
    publisher.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('warden: advise rm -rf')
  })

  it('3 warnings in one turn coalesce to one message; digit-varying duplicates collapse', () => {
    const { sent, publisher } = setup()
    publisher.publish({ kind: 'notify', level: 'warning', text: 'advisory A' })
    publisher.publish({ kind: 'notify', level: 'error', text: 'hold B' })
    publisher.publish({ kind: 'notify', level: 'warning', text: 'advisory A' })
    publisher.publish({ kind: 'notify', level: 'warning', text: 'slop 3 of 9' })
    publisher.publish({ kind: 'notify', level: 'warning', text: 'slop 4 of 9' })
    publisher.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('advisory A')
    expect(sent[0]).toContain('hold B')
    expect(sent[0]!.match(/slop/g)).toHaveLength(1)
  })

  it('info notify is never a message', () => {
    const { sent, publisher } = setup()
    for (let i = 0; i < 10; i++) publisher.publish({ kind: 'notify', level: 'info', text: `fyi ${i}` })
    publisher.flush()
    expect(sent).toHaveLength(0)
  })

  it('widget factory fallbacks and unsupported-info stay silent; unsupported errors surface once', () => {
    const { sent, publisher } = setup()
    publisher.publish({ kind: 'widget', key: 'f', level: 'warning', text: '[Pi widget f: DSH cannot render terminal components]', placement: 'aboveEditor' })
    publisher.publish({ kind: 'unsupported', level: 'error', text: 'Pi UI custom is unsupported' })
    publisher.publish({ kind: 'unsupported', level: 'error', text: 'Pi UI custom is unsupported' })
    publisher.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain('widget f')
  })
})
