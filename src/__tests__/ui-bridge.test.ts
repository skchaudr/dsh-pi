import { describe, expect, it, vi } from 'vitest'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { createUiBridge, type UiPublication } from '../ui-bridge.js'

const base = { theme: { fg: (_color: string, text: string) => text } } as ExtensionUIContext
const setup = () => {
  const events: UiPublication[] = []
  return { events, publish: (event: UiPublication) => { events.push(event) } }
}

describe('Pi visible UI bridge', () => {
  it('publishes notifications, keyed status/widget updates and clears', () => {
    const { events, publish } = setup()
    const { ui, hasUI } = createUiBridge(base, { publish })
    expect(hasUI).toBe(false)
    ui.notify('Guard blocked', 'warning')
    ui.setStatus('guard', 'confidence 0.8')
    ui.setWidget('review', ['first', 'second'], { placement: 'belowEditor' })
    ui.setStatus('guard', undefined)
    ui.setWidget('review', undefined)
    expect(events.map(e => e.kind)).toEqual(['notify', 'status', 'widget', 'status', 'widget'])
    expect(events[0]).toMatchObject({ text: 'Guard blocked', level: 'warning' })
    expect(events[2]).toMatchObject({ key: 'review', text: 'first\nsecond', placement: 'belowEditor' })
    expect(events.slice(3).every(e => e.clear && e.text.includes('cleared'))).toBe(true)
  })

  it('keeps every bridge method when Pi spreads the UI during installation', () => {
    const { events, publish } = setup()
    const { ui } = createUiBridge(base, { publish })
    const wrapped = { ...ui }
    wrapped.notify('visible after install')
    wrapped.setStatus('guard', 'blocked')
    expect(() => wrapped.setEditorText('draft')).toThrow('unsupported')
    expect(events).toHaveLength(3)
  })

  it('never invokes terminal widget factories and publishes a fallback', () => {
    const { events, publish } = setup()
    const { ui } = createUiBridge(base, { publish })
    const renderer = vi.fn(() => { throw new Error('must not render') })
    ui.setWidget('guard', renderer)
    expect(renderer).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ kind: 'widget', key: 'guard', level: 'warning' })
    expect(events[0]?.text).toContain('cannot render')
  })

  it('fails unavailable decisions visibly rather than choosing defaults', async () => {
    const { events, publish } = setup()
    const { ui } = createUiBridge(base, { publish })
    await expect(ui.select('Choose', ['one'])).rejects.toThrow('unavailable')
    await expect(ui.input('Input')).rejects.toThrow('unavailable')
    await expect(ui.confirm('Approve', 'Proceed?')).rejects.toThrow('unavailable')
    expect(events).toHaveLength(3)
    expect(events.every(e => e.level === 'error')).toBe(true)
  })

  it('awaits real decisions and preserves rejection and empty input', async () => {
    const { publish } = setup()
    let answer!: (value: boolean) => void
    const decide = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve }))
    const bridge = createUiBridge(base, { publish, decide })
    expect(bridge.hasUI).toBe(true)
    let settled = false
    const pending = bridge.ui.confirm('Approve', 'Proceed?').then(value => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    answer(false)
    await expect(pending).resolves.toBe(false)
    const input = createUiBridge(base, { publish, decide: async () => '' })
    await expect(input.ui.input('Value')).resolves.toBe('')
    const select = createUiBridge(base, { publish, decide: async () => 'two' })
    await expect(select.ui.select('Choose', ['one', 'two'])).resolves.toBe('two')
  })

  it('validates decision result types and redacts callback failures', async () => {
    const { events, publish } = setup()
    const bad = createUiBridge(base, { publish, decide: async () => 'yes' })
    await expect(bad.ui.confirm('Approve', '?')).rejects.toThrow('invalid answer')
    await expect(bad.ui.select('Choose', ['no'])).rejects.toThrow('invalid answer')
    const failed = createUiBridge(base, { publish, decide: async () => { throw new Error('SECRET token') } })
    await expect(failed.ui.input('Value')).rejects.toThrow('failed')
    expect(JSON.stringify(events)).not.toContain('SECRET')
  })

  it('maps explicit cancellation conservatively and tracks capability dynamically', async () => {
    const { publish } = setup()
    let interactive = true
    const bridge = createUiBridge(base, { publish, decide: async () => undefined, isInteractive: () => interactive })
    await expect(bridge.ui.confirm('Approve', '?')).resolves.toBe(false)
    await expect(bridge.ui.select('Choose', ['one'])).resolves.toBeUndefined()
    interactive = false
    expect(bridge.hasUI).toBe(false)
    await expect(bridge.ui.input('Value')).rejects.toThrow('unavailable')
  })

  it('cancels pending callbacks and rejects pre-aborted requests', async () => {
    const { publish } = setup()
    const controller = new AbortController()
    const signals: AbortSignal[] = []
    const decide = vi.fn(async (request: { signal: AbortSignal }) => {
      signals.push(request.signal)
      return new Promise<string>(() => {})
    })
    const { ui } = createUiBridge(base, { publish, decide, getSignal: () => controller.signal })
    const result = ui.input('Value')
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await expect(ui.confirm('Approve', '?')).rejects.toMatchObject({ name: 'AbortError' })
    expect(decide).toHaveBeenCalledTimes(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('forwards exact dialog content without truncating choices or edited text', async () => {
    const { publish } = setup()
    const requests: unknown[] = []
    const bridge = createUiBridge(base, { publish, decide: async request => {
      requests.push(request)
      return request.kind === 'confirm' ? true : 'result'
    } })
    await expect(bridge.ui.confirm('Title', 'Decision details')).resolves.toBe(true)
    await expect(bridge.ui.input('Input', 'hint')).resolves.toBe('result')
    await expect(bridge.ui.editor('Edit', 'original')).resolves.toBe('result')
    expect(requests).toEqual([
      expect.objectContaining({ kind: 'confirm', title: 'Title', message: 'Decision details' }),
      expect.objectContaining({ kind: 'input', title: 'Input', placeholder: 'hint' }),
      expect.objectContaining({ kind: 'editor', title: 'Edit', prefill: 'original' }),
    ])
  })

  it('honors dialog abort signals independently of the host operation', async () => {
    const { events, publish } = setup()
    const controller = new AbortController()
    const bridge = createUiBridge(base, { publish, decide: async () => new Promise<string>(() => {}) })
    const result = bridge.ui.select('Choice', ['a'], { signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.at(-1)).toMatchObject({ level: 'error', text: 'Pi UI select cancelled.' })
  })

  it('does not claim availability from an availability callback alone', () => {
    const { publish } = setup()
    expect(createUiBridge(base, { publish, isInteractive: () => true }).hasUI).toBe(false)
  })

  it('times out even when the callback ignores its signal', async () => {
    const { publish } = setup()
    const { ui } = createUiBridge(base, { publish, decide: async () => new Promise<string>(() => {}) })
    await expect(ui.input('Value', undefined, { timeout: 5 })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bounds and strips terminal control text without swallowing publication failures', () => {
    const { events, publish } = setup()
    const { ui } = createUiBridge(base, { publish })
    ui.notify('\u001b[31mred\u001b[0m' + 'x'.repeat(30_000))
    expect(events[0]?.text).not.toContain('\u001b')
    expect(events[0]!.text.length).toBeLessThanOrEqual(16_384)
    expect(events[0]?.text).toContain('[truncated]')
    const broken = createUiBridge(base, { publish: () => { throw new Error('sink failed') } })
    expect(() => broken.ui.notify('ruling')).toThrow('sink failed')
  })

  it('reports unsupported TUI controls instead of pretending they work', async () => {
    const { events, publish } = setup()
    const { ui } = createUiBridge(base, { publish })
    expect(() => ui.setEditorText('draft')).toThrow('unsupported')
    await expect(ui.custom(async () => { throw new Error('never called') })).rejects.toThrow('unsupported')
    expect(ui.setTheme('dark')).toMatchObject({ success: false })
    ui.setWorkingMessage('reviewing')
    expect(events.at(-1)?.text).toBe('reviewing')
    expect(ui.theme).toBe(base.theme)
  })
})
