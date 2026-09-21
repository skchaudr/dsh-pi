import { resolve } from 'node:path'
import { PiExtensionRuntime } from '../src/runtime.js'

const entry = resolve('node_modules/pi-warden/extensions/index.js')
console.log('entry:', entry)

const runtime = await PiExtensionRuntime.fromPaths([entry], {
  cwd: process.cwd(),
  projectTrusted: false,
  bridge: {
    reportError: context => console.log('host reported error:', context),
    sendMessage: (message: unknown) => console.log('pi.sendMessage:', JSON.stringify(message)),
    appendEntry: (type: string, data: unknown) => console.log('appendEntry:', type, JSON.stringify(data).slice(0, 200)),
  },
})
await runtime.start('startup')

console.log('tools:', runtime.tools().map(t => t.name))
console.log('commands:', runtime.commands().map(c => c.invocationName))

// Warden starts dormant; activate offline guards via its command.
try {
  const notifications = await runtime.executeCommand('warden', 'enable', undefined)
  console.log('warden enable notifications:', JSON.stringify(notifications))
} catch (error) {
  console.log('warden enable failed:', (error as Error).message)
}

// Offline guard check: a known-dangerous bash call must be held locally
// (pattern list, no Jev request needed).
const result = await runtime.emit({
  type: 'tool_call',
  toolCallId: 'warden-smoke-1',
  toolName: 'bash',
  input: { command: 'rm -rf /tmp/warden-smoke-target' },
})
console.log('dangerous call verdict:', JSON.stringify(result))

const safe = await runtime.emit({
  type: 'tool_call',
  toolCallId: 'warden-smoke-2',
  toolName: 'bash',
  input: { command: 'git status' },
})
console.log('safe call verdict:', JSON.stringify(safe))

// Built-in deny rules block unconditionally, even offline with no Jev key.
const denied = await runtime.emit({
  type: 'tool_call',
  toolCallId: 'warden-smoke-3',
  toolName: 'bash',
  input: { command: 'git push --force origin main' },
})
console.log('force-push verdict:', JSON.stringify(denied))

await runtime.shutdown()
