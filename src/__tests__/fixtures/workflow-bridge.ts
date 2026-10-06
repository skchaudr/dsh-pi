import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'workflow_probe',
    label: 'Workflow probe',
    description: 'Exercise sendMessage durability, UI publication, and dialogs',
    parameters: Type.Object({ action: Type.String(), id: Type.String({ default: '' }) }),
    async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
      if (params.action === 'send') {
        pi.sendMessage(
          { customType: 'workflow_message', content: 'packet', display: true, details: { workflowMessageId: params.id } },
          { triggerTurn: false },
        )
        return { content: [{ type: 'text', text: 'sent' }], details: {} }
      }
      if (params.action === 'notify') {
        ctx.ui.notify('hello from pi', 'info')
        return { content: [{ type: 'text', text: 'notified' }], details: {} }
      }
      if (params.action === 'hasui') {
        return { content: [{ type: 'text', text: String(ctx.hasUI) }], details: {} }
      }
      if (params.action === 'select') {
        const choice = await ctx.ui.select('Pick one', ['alpha', 'beta'])
        return { content: [{ type: 'text', text: String(choice) }], details: {} }
      }
      return { content: [{ type: 'text', text: 'unknown' }], details: {} }
    },
  })
}
