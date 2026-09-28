import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI): void {
  pi.on('session_start', () => {
    pi.sendMessage({ customType: 'source-probe', content: 'custom message', display: true })
    pi.sendUserMessage('user message')
  })
  pi.on('input', event => ({ action: 'transform', text: event.text.toUpperCase() }))
}
