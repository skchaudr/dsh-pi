import { SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { PiExtensionRuntime } from '../runtime.js'
import type { UiDecisionRequest, UiPublication } from '../ui-bridge.js'

const fixture = (name: string) => new URL(`./fixtures/${name}.ts`, import.meta.url).pathname

describe('workflow bridge surfaces', () => {
  it('durably persists workflow messages once and suppresses duplicate delivery', async () => {
    const sessionManager = SessionManager.inMemory('/workspace')
    const delivered: unknown[] = []
    const runtime = await PiExtensionRuntime.fromPaths([fixture('workflow-bridge')], {
      cwd: '/workspace',
      sessionManager,
      bridge: { sendMessage: message => { delivered.push(message) } },
    })
    await runtime.start('startup')
    expect((await runtime.executeTool('workflow_probe', { action: 'send', id: 'wf-1' }, { callId: 'call-1' })).isError).not.toBe(true)
    expect((await runtime.executeTool('workflow_probe', { action: 'send', id: 'wf-1' }, { callId: 'call-2' })).isError).not.toBe(true)
    expect(sessionManager.getBranch().filter(entry => entry.type === 'custom_message')).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    await runtime.executeTool('workflow_probe', { action: 'send', id: 'wf-2' }, { callId: 'call-3' })
    expect(sessionManager.getBranch().filter(entry => entry.type === 'custom_message')).toHaveLength(2)
    expect(delivered).toHaveLength(2)
    await runtime.shutdown()
  })

  it('publishes notifications visibly, reports hasUI false, and fails dialogs closed without a decision callback', async () => {
    const published: UiPublication[] = []
    const runtime = await PiExtensionRuntime.fromPaths([fixture('workflow-bridge')], {
      cwd: '/workspace',
      bridge: { publishUi: event => { published.push(event) } },
    })
    await runtime.start('startup')
    expect((await runtime.executeTool('workflow_probe', { action: 'hasui', id: '' }, { callId: 'a' })).content)
      .toEqual([{ type: 'text', text: 'false' }])
    expect((await runtime.executeTool('workflow_probe', { action: 'notify', id: '' }, { callId: 'b' })).isError).not.toBe(true)
    expect(published.some(event => event.text === 'hello from pi' && event.level === 'info')).toBe(true)
    expect((await runtime.executeTool('workflow_probe', { action: 'select', id: '' }, { callId: 'c' })).isError).toBe(true)
    expect(published.some(event => event.kind === 'unsupported')).toBe(true)
    await runtime.shutdown()
  })

  it('routes dialogs through the decision callback and reports interactive capability', async () => {
    const requests: UiDecisionRequest[] = []
    const runtime = await PiExtensionRuntime.fromPaths([fixture('workflow-bridge')], {
      cwd: '/workspace',
      bridge: {
        publishUi: () => {},
        requestDecision: async request => {
          requests.push(request)
          return 'beta'
        },
      },
    })
    await runtime.start('startup')
    expect((await runtime.executeTool('workflow_probe', { action: 'hasui', id: '' }, { callId: 'a' })).content)
      .toEqual([{ type: 'text', text: 'true' }])
    expect((await runtime.executeTool('workflow_probe', { action: 'select', id: '' }, { callId: 'b' })).content)
      .toEqual([{ type: 'text', text: 'beta' }])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.kind).toBe('select')
    await runtime.shutdown()
  })
})
