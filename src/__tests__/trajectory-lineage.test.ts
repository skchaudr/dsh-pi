import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { appendPiEvents } from '../append.js'
import { createTranslationContext, parsePiJsonlStream } from '../ingest.js'
import {
  foldFleetDispatches,
  foldSubagentRunToToolCallBlock,
  type PiChildToolEvent,
  type PiSubagentDispatchEvent,
  type ToolCallBlock,
} from '../trajectory.js'

const lineageFixturePath = fileURLToPath(
  new URL('./fixtures/pi-subagent-lineage-sanitized.jsonl', import.meta.url),
)
const lineageJsonl = readFileSync(lineageFixturePath, 'utf8')

type DescriptorData = {
  dispatchCallId: string
  subagentName: string
  task: string
  parentCallId?: string
  block: ToolCallBlock
}

function blockToChild(block: ToolCallBlock, parentId: string): PiChildToolEvent {
  return {
    callId: block.callId,
    parentId,
    name: block.name,
    arguments: block.arguments,
    ...(block.result !== undefined ? { result: block.result } : {}),
    subCalls: block.subCalls.map(nested => blockToChild(nested, block.callId)),
  }
}

function dispatchFromDescriptor(data: DescriptorData): PiSubagentDispatchEvent {
  return {
    dispatchCallId: data.dispatchCallId,
    subagentName: data.subagentName,
    task: data.task,
    childTools: data.block.subCalls.map(child => blockToChild(child, data.dispatchCallId)),
    ...(data.block.result !== undefined ? { result: data.block.result } : {}),
  }
}

function recoverFleetFromPersisted(events: readonly SessionEvent[]): ToolCallBlock[] {
  const parentCalls = events
    .filter(event => event.type === 'tool/call')
    .map(event => {
      const data = event.data as { callId: string; name: string; arguments: unknown }
      return {
        callId: data.callId,
        name: data.name,
        arguments: typeof data.arguments === 'string'
          ? JSON.parse(data.arguments) as unknown
          : data.arguments,
      }
    })

  const runsByParent = new Map<string, PiSubagentDispatchEvent[]>()
  for (const event of events) {
    if (event.type !== 'subagent/descriptor') continue
    const data = event.data as DescriptorData
    const parentId = data.parentCallId
    if (parentId === undefined) continue
    const existing = runsByParent.get(parentId) ?? []
    existing.push(dispatchFromDescriptor(data))
    runsByParent.set(parentId, existing)
  }

  return foldFleetDispatches(parentCalls, runsByParent)
}

describe('S0: Trajectory Lineage Ingestion & Fold', () => {
  it('folds a single Pi subagent run with child tool executions into a nested ToolCallBlock', () => {
    const childTools: PiChildToolEvent[] = [
      {
        callId: 'call_child_read_01',
        parentId: 'dispatch_01',
        name: 'read',
        arguments: { path: '/tmp/dsh-fixture/example.txt' },
        result: {
          content: [{ type: 'text', text: 'file content' }],
        },
      },
    ]

    const dispatch: PiSubagentDispatchEvent = {
      dispatchCallId: 'dispatch_01',
      subagentName: 'advocate',
      task: 'Build the case for proposal',
      childTools,
      result: {
        content: [{ type: 'text', text: 'Case built' }],
        details: { confidence: 85 },
      },
    }

    const block = foldSubagentRunToToolCallBlock(dispatch)

    expect(block.callId).toBe('dispatch_01')
    expect(block.name).toBe('subagent')
    expect(block.arguments).toEqual({
      agent: 'advocate',
      task: 'Build the case for proposal',
    })
    expect(block.result?.details).toEqual({ confidence: 85 })
    expect(block.subCalls).toHaveLength(1)
    expect(block.subCalls[0]?.callId).toBe('call_child_read_01')
    expect(block.subCalls[0]?.name).toBe('read')
    expect(block.subCalls[0]?.result?.content[0]?.text).toBe('file content')
  })

  it('recursively folds nested child.subCalls into the ToolCallBlock tree', () => {
    const dispatch: PiSubagentDispatchEvent = {
      dispatchCallId: 'dispatch_nested',
      subagentName: 'explorer',
      task: 'Walk nested tools',
      childTools: [
        {
          callId: 'call_grep',
          parentId: 'dispatch_nested',
          name: 'grep',
          arguments: { pattern: 'export' },
          subCalls: [
            {
              callId: 'call_grep_read',
              parentId: 'call_grep',
              name: 'read',
              arguments: { path: '/tmp/dsh-fixture/src/index.ts' },
              result: { content: [{ type: 'text', text: 'matched' }] },
            },
          ],
          result: { content: [{ type: 'text', text: '1 match' }] },
        },
      ],
    }

    const block = foldSubagentRunToToolCallBlock(dispatch)
    expect(block.subCalls[0]?.callId).toBe('call_grep')
    expect(block.subCalls[0]?.subCalls).toHaveLength(1)
    expect(block.subCalls[0]?.subCalls[0]?.callId).toBe('call_grep_read')
    expect(block.subCalls[0]?.subCalls[0]?.name).toBe('read')
  })

  it('proves 1 parent session + 2 parallel child subagents fold into DSH ToolCallBlock tree', () => {
    const parentCalls = [
      {
        callId: 'parent_fleet_dispatch_001',
        name: 'subagent_fanout',
        arguments: { count: 2 },
      },
    ]

    const childWorker1: PiSubagentDispatchEvent = {
      dispatchCallId: 'child_run_worker_1',
      subagentName: 'code-worker',
      task: 'Implement S0 fold',
      childTools: [
        {
          callId: 'call_w1_read',
          parentId: 'child_run_worker_1',
          name: 'read',
          arguments: { path: '/tmp/dsh-fixture/README.md' },
          result: { content: [{ type: 'text', text: '# Plan' }] },
        },
        {
          callId: 'call_w1_write',
          parentId: 'child_run_worker_1',
          name: 'write',
          arguments: { path: 'src/trajectory.ts' },
          result: { content: [{ type: 'text', text: 'written' }] },
        },
      ],
      result: { content: [{ type: 'text', text: 'Worker 1 complete' }] },
    }

    const childWorker2: PiSubagentDispatchEvent = {
      dispatchCallId: 'child_run_worker_2',
      subagentName: 'reviewer',
      task: 'Audit implementation',
      childTools: [
        {
          callId: 'call_w2_bash',
          parentId: 'child_run_worker_2',
          name: 'bash',
          arguments: { command: 'pnpm test' },
          result: { content: [{ type: 'text', text: 'All 68 tests passed' }] },
        },
      ],
      result: { content: [{ type: 'text', text: 'Worker 2 audit clean' }] },
    }

    const subagentMap = new Map<string, PiSubagentDispatchEvent[]>([
      ['parent_fleet_dispatch_001', [childWorker1, childWorker2]],
    ])

    const foldedTree = foldFleetDispatches(parentCalls, subagentMap)

    expect(foldedTree).toHaveLength(1)
    const rootNode = foldedTree[0]!

    expect(rootNode.callId).toBe('parent_fleet_dispatch_001')
    expect(rootNode.subCalls).toHaveLength(2)

    const child1 = rootNode.subCalls[0]!
    expect(child1.callId).toBe('child_run_worker_1')
    expect(child1.name).toBe('subagent')
    expect(child1.subCalls).toHaveLength(2)
    expect(child1.subCalls[0]?.name).toBe('read')
    expect(child1.subCalls[1]?.name).toBe('write')

    const child2 = rootNode.subCalls[1]!
    expect(child2.callId).toBe('child_run_worker_2')
    expect(child2.name).toBe('subagent')
    expect(child2.subCalls).toHaveLength(1)
    expect(child2.subCalls[0]?.name).toBe('bash')
    expect(child2.subCalls[0]?.result?.content[0]?.text).toBe('All 68 tests passed')
  })

  it('leaves unmatched parent calls with empty subCalls', () => {
    const folded = foldFleetDispatches(
      [{ callId: 'orphan_parent', name: 'bash', arguments: { command: 'true' } }],
      new Map(),
    )
    expect(folded[0]?.subCalls).toEqual([])
  })
})

describe('W02A: authentic Pi lineage through append and trajectory fold', () => {
  it('translates sanitized spawn/delegate JSONL through appendPiEvents with session-allocated seq', () => {
    const translated = parsePiJsonlStream(lineageJsonl, createTranslationContext(40))
    expect(translated.map(event => event.seq)).toEqual(translated.map((_, index) => index + 40))
    expect(translated.map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'tool/call',
      'tool/result',
      'subagent/descriptor',
      'subagent/descriptor',
      'step/end',
      'turn/end',
    ])

    const session = Session.create('sess-lineage-001' as SessionId)
    const appended = appendPiEvents(session, translated)

    expect(appended.map(event => event.seq)).toEqual(appended.map((_, index) => index))
    expect(appended.every((event, index) => event.seq !== translated[index]!.seq)).toBe(true)
    expect(session.snapshotEvents()).toHaveLength(appended.length)
    expect(session.snapshotEvents().map(event => event.seq)).toEqual(appended.map(event => event.seq))
    expect(session.snapshotEvents().map(event => event.type)).toEqual(appended.map(event => event.type))
  })

  it('persists turn/step structure around the parent dispatch and both child descriptors', () => {
    const session = Session.create('sess-lineage-001' as SessionId)
    const appended = appendPiEvents(session, parsePiJsonlStream(lineageJsonl))

    const turnStart = appended.find(event => event.type === 'turn/start')!
    const stepStart = appended.find(event => event.type === 'step/start')!
    const toolCall = appended.find(event => event.type === 'tool/call')!
    const toolResult = appended.find(event => event.type === 'tool/result')!
    const descriptors = appended.filter(event => event.type === 'subagent/descriptor')
    const stepEnd = appended.find(event => event.type === 'step/end')!
    const turnEnd = appended.find(event => event.type === 'turn/end')!

    expect(turnStart.data).toEqual({ turn: 1 })
    expect(stepStart.data).toEqual({ turn: 1, step: 1 })
    expect(stepEnd.data).toEqual({ turn: 1, step: 1 })
    expect((turnEnd.data as { turn: number }).turn).toBe(1)

    expect((toolCall.data as { callId: string }).callId).toBe('call-parent-fanout')
    expect((toolCall.data as { turn: number; step: number }).turn).toBe(1)
    expect((toolCall.data as { turn: number; step: number }).step).toBe(1)
    expect((toolResult.data as { turn: number; step: number }).turn).toBe(1)
    expect((toolResult.data as { turn: number; step: number }).step).toBe(1)

    expect(descriptors).toHaveLength(2)
    expect(turnStart.seq).toBeLessThan(stepStart.seq)
    expect(stepStart.seq).toBeLessThan(toolCall.seq)
    expect(toolCall.seq).toBeLessThan(descriptors[0]!.seq)
    expect(descriptors[1]!.seq).toBeLessThan(stepEnd.seq)
    expect(stepEnd.seq).toBeLessThan(turnEnd.seq)
  })

  it('recovers parent→child call structure from persisted descriptors and fleet fold', () => {
    const session = Session.create('sess-lineage-001' as SessionId)
    appendPiEvents(session, parsePiJsonlStream(lineageJsonl))

    const descriptors = session.snapshotEvents()
      .filter(event => event.type === 'subagent/descriptor')
      .map(event => event.data as DescriptorData)

    expect(descriptors.map(data => data.parentCallId)).toEqual([
      'call-parent-fanout',
      'call-parent-fanout',
    ])
    expect(descriptors.map(data => data.dispatchCallId)).toEqual([
      'dispatch-worker-a',
      'dispatch-worker-b',
    ])

    const workerA = descriptors[0]!.block
    expect(workerA.callId).toBe('dispatch-worker-a')
    expect(workerA.name).toBe('subagent')
    expect(workerA.arguments).toEqual({
      agent: 'code-worker',
      task: 'Read the example source',
    })
    expect(workerA.subCalls.map(child => child.callId)).toEqual(['child-a-read', 'child-a-grep'])
    expect(workerA.subCalls[1]?.subCalls[0]?.callId).toBe('child-a-grep-read')
    expect(workerA.subCalls[1]?.subCalls[0]?.name).toBe('read')

    const workerB = descriptors[1]!.block
    expect(workerB.subCalls[0]?.callId).toBe('child-b-read')
    expect(workerB.result?.content[0]?.text).toBe('Worker B audit clean')

    const fleet = recoverFleetFromPersisted(session.snapshotEvents())
    expect(fleet).toHaveLength(1)
    expect(fleet[0]?.callId).toBe('call-parent-fanout')
    expect(fleet[0]?.name).toBe('subagent_fanout')
    expect(fleet[0]?.subCalls.map(child => child.callId)).toEqual([
      'dispatch-worker-a',
      'dispatch-worker-b',
    ])
    expect(fleet[0]?.subCalls[0]?.subCalls[1]?.subCalls[0]?.callId).toBe('child-a-grep-read')
  })

  it('replays the persisted lineage log without remapping seq or dropping descriptors', () => {
    const session = Session.create('sess-lineage-001' as SessionId)
    appendPiEvents(session, parsePiJsonlStream(lineageJsonl))

    const replayed = Session.create('sess-lineage-001' as SessionId, session.snapshotEvents())
    expect(replayed.snapshotEvents().map(event => event.type)).toEqual([
      ...session.snapshotEvents().map(event => event.type),
      'session/end-seed',
    ])
    expect(
      replayed.snapshotEvents().filter(event => event.type === 'subagent/descriptor'),
    ).toHaveLength(2)
    expect(recoverFleetFromPersisted(replayed.snapshotEvents())[0]?.subCalls.map(child => child.callId))
      .toEqual(['dispatch-worker-a', 'dispatch-worker-b'])
  })
})
