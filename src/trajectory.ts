import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export interface ToolResultNode {
  isError?: boolean
  content: Array<{ type: string; text?: string; [key: string]: unknown }>
  details?: JsonValue
}

export interface ToolCallBlock {
  callId: string
  name: string
  arguments: unknown
  result?: ToolResultNode
  subCalls: readonly ToolCallBlock[]
}

export interface PiChildToolEvent {
  callId: string
  parentId: string
  name: string
  arguments: unknown
  result?: ToolResultNode
  subCalls?: PiChildToolEvent[]
}

export interface PiSubagentDispatchEvent {
  dispatchCallId: string
  subagentName: string
  task: string
  childTools: PiChildToolEvent[]
  result?: ToolResultNode
}

/**
 * Folds a Pi parent tool call and its executed child subagent tool events
 * into DSH's native hierarchical ToolCallBlock tree (recursive subCalls).
 */
export function foldSubagentRunToToolCallBlock(dispatch: PiSubagentDispatchEvent): ToolCallBlock {
  function mapChildToBlock(child: PiChildToolEvent): ToolCallBlock {
    const nestedSubs = (child.subCalls ?? []).map(mapChildToBlock)
    return {
      callId: child.callId,
      name: child.name,
      arguments: child.arguments,
      ...(child.result !== undefined ? { result: child.result } : {}),
      subCalls: nestedSubs,
    }
  }

  return {
    callId: dispatch.dispatchCallId,
    name: 'subagent',
    arguments: {
      agent: dispatch.subagentName,
      task: dispatch.task,
    },
    ...(dispatch.result !== undefined ? { result: dispatch.result } : {}),
    subCalls: dispatch.childTools.map(mapChildToBlock),
  }
}

/**
 * Folds multiple parallel subagent dispatches into a parent session's tool call list.
 */
export function foldFleetDispatches(
  parentToolCalls: Array<{ callId: string; name: string; arguments: unknown; result?: ToolResultNode }>,
  subagentRunsByParentCallId: Map<string, PiSubagentDispatchEvent[]>,
): ToolCallBlock[] {
  return parentToolCalls.map(parentCall => {
    const childRuns = subagentRunsByParentCallId.get(parentCall.callId) ?? []
    if (childRuns.length === 0) {
      return {
        callId: parentCall.callId,
        name: parentCall.name,
        arguments: parentCall.arguments,
        ...(parentCall.result !== undefined ? { result: parentCall.result } : {}),
        subCalls: [],
      }
    }

    const subBlocks = childRuns.map(run => foldSubagentRunToToolCallBlock(run))
    return {
      callId: parentCall.callId,
      name: parentCall.name,
      arguments: parentCall.arguments,
      ...(parentCall.result !== undefined ? { result: parentCall.result } : {}),
      subCalls: subBlocks,
    }
  })
}
