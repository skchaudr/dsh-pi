import { describe, expect, it } from 'vitest'
import {
  foldFleetDispatches,
  foldSubagentRunToToolCallBlock,
  type PiChildToolEvent,
  type PiSubagentDispatchEvent,
} from '../trajectory.js'

describe('S0: Trajectory Lineage Ingestion & Fold', () => {
  it('folds a single Pi subagent run with child tool executions into a nested ToolCallBlock', () => {
    const childTools: PiChildToolEvent[] = [
      {
        callId: 'call_child_read_01',
        parentId: 'dispatch_01',
        name: 'read',
        arguments: { path: '/tmp/test.txt' },
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
          arguments: { path: '/Users/sab-mini/.dsh/plans/unified-fleet-observability-plan.md' },
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

    // Child 1 verification
    const child1 = rootNode.subCalls[0]!
    expect(child1.callId).toBe('child_run_worker_1')
    expect(child1.name).toBe('subagent')
    expect(child1.subCalls).toHaveLength(2)
    expect(child1.subCalls[0]?.name).toBe('read')
    expect(child1.subCalls[1]?.name).toBe('write')

    // Child 2 verification
    const child2 = rootNode.subCalls[1]!
    expect(child2.callId).toBe('child_run_worker_2')
    expect(child2.name).toBe('subagent')
    expect(child2.subCalls).toHaveLength(1)
    expect(child2.subCalls[0]?.name).toBe('bash')
    expect(child2.subCalls[0]?.result?.content[0]?.text).toBe('All 68 tests passed')
  })
})
