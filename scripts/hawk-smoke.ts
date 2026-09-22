import { resolve } from 'node:path'
import { PiExtensionRuntime } from '../src/runtime.js'

const entry = resolve('../pi-hawk/extensions/index.js')
const runtime = await PiExtensionRuntime.fromPaths([entry], {
  cwd: resolve('../pi-hawk'),
  projectTrusted: false,
  bridge: {
    reportError: c => console.log('error:', c),
    sendMessage: m => console.log('sendMessage:', JSON.stringify(m).slice(0, 300)),
  },
})
await runtime.start('startup')
console.log('commands:', runtime.commands().map(c => c.invocationName))

// deny-class pattern floor (no Jev)
const denied = await runtime.emit({
  type: 'tool_call', toolCallId: 'hawk-1', toolName: 'bash',
  input: { command: 'git push --force origin main' },
})
console.log('force-push:', JSON.stringify(denied))

// safe call -> judged allow
const safe = await runtime.emit({
  type: 'tool_call', toolCallId: 'hawk-2', toolName: 'bash',
  input: { command: 'git status' },
})
console.log('git status:', JSON.stringify(safe))

// costly detour with no supporting intent -> expect warn/hold
const detour = await runtime.emit({
  type: 'tool_call', toolCallId: 'hawk-3', toolName: 'bash',
  input: { command: 'aws s3 rb s3://production-backups --force' },
})
console.log('prod deletion:', JSON.stringify(detour))

await runtime.shutdown()
