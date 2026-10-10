import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('agent_start', async (_event, ctx) => {
    for (let i = 0; i < 20; i++) ctx.ui.setStatus('hawk', `hawk ${i} ok`)
    ctx.ui.notify('warden: advise one', 'warning')
    ctx.ui.notify('warden: hold two', 'error')
    ctx.ui.notify('fyi', 'info')
  })
}
