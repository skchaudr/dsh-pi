import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { CallId, ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  foldSubagentRunToToolCallBlock,
  type PiChildToolEvent,
  type PiSubagentDispatchEvent,
  type ToolCallBlock,
} from './trajectory.js'

export interface DshSessionEvent<T extends string = string, D = unknown> {
  readonly seq: number
  readonly time: number
  readonly type: T
  readonly data: D
  readonly ignorable?: true
}

export interface PiSessionHeaderEvent {
  type: 'session'
  version?: number
  id: string
  timestamp?: string
  cwd?: string
}

export interface PiSessionInfoEvent {
  type: 'session_info'
  id?: string
  name?: string
  parentId?: string | null
  timestamp?: string
}

export interface PiUserMessageEvent {
  type: 'message'
  id?: string
  parentId?: string | null
  timestamp?: string
  message: {
    role: 'user'
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
    timestamp?: number
  }
}

export interface PiToolCallItem {
  type: 'toolCall'
  id: string
  name: string
  arguments: unknown
}

export interface PiTextItem {
  type: 'text'
  text: string
}

export interface PiThinkingItem {
  type: 'thinking'
  thinking: string
}

export type PiAssistantContentItem =
  | PiToolCallItem
  | PiTextItem
  | PiThinkingItem
  | { type: string; [key: string]: unknown }

export interface PiAssistantMessageEvent {
  type: 'message'
  id?: string
  parentId?: string | null
  timestamp?: string
  message: {
    role: 'assistant'
    content: PiAssistantContentItem[]
  }
}

export interface PiToolResultContentItem {
  type: string
  text?: string
  [key: string]: unknown
}

export interface PiToolResultMessageEvent {
  type: 'message'
  id?: string
  parentId?: string | null
  timestamp?: string
  message: {
    role: 'toolResult'
    toolCallId: string
    toolName?: string
    isError?: boolean
    content: PiToolResultContentItem[] | string
    details?: JsonValue
  }
}

export interface PiSubagentSpawnEvent {
  type: 'subagent_spawn' | 'subagent_delegate'
  dispatchCallId: string
  subagentName: string
  task: string
  parentId?: string
  childTools?: PiChildToolEvent[]
  result?: {
    isError?: boolean
    content: Array<{ type: string; text?: string }>
    details?: JsonValue
  }
}

export interface PiAgentEndEvent {
  type: 'agent_end' | 'turn_end'
  turn?: number
  status?: 'completed' | 'aborted' | 'error' | 'failed'
  error?: {
    message: string
    code?: string
  }
}

export type PiSessionRawEvent =
  | PiSessionHeaderEvent
  | PiSessionInfoEvent
  | PiUserMessageEvent
  | PiAssistantMessageEvent
  | PiToolResultMessageEvent
  | PiSubagentSpawnEvent
  | PiAgentEndEvent
  | { type: string; [key: string]: unknown }

export interface TranslationContext {
  nextSeq: number
  currentTurn: number
  currentStep: number
  activeSessionId?: string
  activeToolCalls: Map<string, { turn: number; step: number; name: string }>
}

export function createTranslationContext(initialSeq = 0): TranslationContext {
  return {
    nextSeq: initialSeq,
    currentTurn: 0,
    currentStep: 0,
    activeToolCalls: new Map(),
  }
}

function resolveTimestamp(timestampValue?: string | number): number {
  if (typeof timestampValue === 'number' && Number.isFinite(timestampValue)) {
    return timestampValue
  }
  if (typeof timestampValue === 'string') {
    const parsed = Date.parse(timestampValue)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

/**
 * Translates a single Pi raw event into zero or more canonical DSH SessionEvents.
 */
export function translatePiEvent(
  rawEvent: PiSessionRawEvent,
  ctx: TranslationContext,
): DshSessionEvent[] {
  const events: DshSessionEvent[] = []
  const time = resolveTimestamp((rawEvent as { timestamp?: string | number }).timestamp)

  if (rawEvent.type === 'session') {
    const header = rawEvent as PiSessionHeaderEvent
    ctx.activeSessionId = header.id
    ctx.currentTurn = 1
    ctx.currentStep = 0
    events.push({
      seq: ctx.nextSeq++,
      time,
      type: 'turn/start',
      data: { turn: ctx.currentTurn },
    })
    return events
  }

  if (rawEvent.type === 'session_info') {
    if (ctx.currentTurn === 0) {
      ctx.currentTurn = 1
      ctx.currentStep = 0
      events.push({
        seq: ctx.nextSeq++,
        time,
        type: 'turn/start',
        data: { turn: ctx.currentTurn },
      })
    }
    return events
  }

  if (rawEvent.type === 'message' && 'message' in rawEvent && rawEvent.message) {
    const msg = rawEvent.message as { role?: string; [key: string]: unknown }

    if (msg.role === 'user') {
      const userEvent = rawEvent as PiUserMessageEvent
      if (ctx.currentTurn === 0) {
        ctx.currentTurn = 1
        ctx.currentStep = 0
        events.push({
          seq: ctx.nextSeq++,
          time,
          type: 'turn/start',
          data: { turn: ctx.currentTurn },
        })
      }

      ctx.currentStep++
      events.push({
        seq: ctx.nextSeq++,
        time,
        type: 'step/start',
        data: { turn: ctx.currentTurn, step: ctx.currentStep },
      })

      const rawContent = userEvent.message.content
      const contentBlocks: ContentBlock[] = typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : rawContent.map(block => {
          if (block.type === 'text') return { type: 'text' as const, text: block.text ?? '' }
          return { type: 'text' as const, text: JSON.stringify(block) }
        })

      const userMessage: UserMessage = createUserMessage({
        content: contentBlocks,
        source: { kind: 'user' },
      })

      events.push({
        seq: ctx.nextSeq++,
        time,
        type: 'user/message',
        data: userMessage,
      })
      return events
    }

    if (msg.role === 'assistant') {
      const assistantEvent = rawEvent as PiAssistantMessageEvent
      const contentList = Array.isArray(assistantEvent.message.content) ? assistantEvent.message.content : []
      for (const item of contentList) {
        if (item.type === 'toolCall') {
          const toolCall = item as PiToolCallItem
          const callId = toolCall.id as CallId
          const argsStr = typeof toolCall.arguments === 'string'
            ? toolCall.arguments
            : JSON.stringify(toolCall.arguments ?? {})

          ctx.activeToolCalls.set(toolCall.id, {
            turn: ctx.currentTurn,
            step: ctx.currentStep,
            name: toolCall.name,
          })

          events.push({
            seq: ctx.nextSeq++,
            time,
            type: 'tool/call',
            data: {
              turn: ctx.currentTurn,
              step: ctx.currentStep,
              callId,
              name: toolCall.name,
              arguments: argsStr,
            },
          })
        }
      }
      return events
    }

    if (msg.role === 'toolResult') {
      const toolResult = rawEvent as PiToolResultMessageEvent
      const callMeta = ctx.activeToolCalls.get(toolResult.message.toolCallId)
      const turn = callMeta?.turn ?? ctx.currentTurn
      const step = callMeta?.step ?? ctx.currentStep

      const textContent = typeof toolResult.message.content === 'string'
        ? toolResult.message.content
        : (toolResult.message.content ?? [])
          .map(item => (typeof item.text === 'string' ? item.text : JSON.stringify(item)))
          .join('\n')

      const toolMessage = createToolResultMessage({
        callId: toolResult.message.toolCallId as CallId,
        content: [{ type: 'text', text: textContent }],
        isError: !!toolResult.message.isError,
      })

      events.push({
        seq: ctx.nextSeq++,
        time,
        type: 'tool/result',
        data: {
          turn,
          step,
          message: toolMessage,
          ...(toolResult.message.details !== undefined ? { meta: toolResult.message.details } : {}),
        },
      })
      return events
    }
  }

  if (rawEvent.type === 'subagent_spawn' || rawEvent.type === 'subagent_delegate') {
    const spawn = rawEvent as PiSubagentSpawnEvent
    const dispatchEvent: PiSubagentDispatchEvent = {
      dispatchCallId: spawn.dispatchCallId,
      subagentName: spawn.subagentName,
      task: spawn.task,
      childTools: spawn.childTools ?? [],
      ...(spawn.result !== undefined ? { result: spawn.result } : {}),
    }

    const foldedBlock: ToolCallBlock = foldSubagentRunToToolCallBlock(dispatchEvent)

    events.push({
      seq: ctx.nextSeq++,
      time,
      type: 'subagent/descriptor',
      ignorable: true,
      data: {
        dispatchCallId: spawn.dispatchCallId,
        subagentName: spawn.subagentName,
        task: spawn.task,
        block: foldedBlock,
      },
    })
    return events
  }

  if (rawEvent.type === 'agent_end' || rawEvent.type === 'turn_end') {
    const endEvent = rawEvent as PiAgentEndEvent
    const isError = endEvent.status === 'error' || endEvent.status === 'failed'
    const isAborted = endEvent.status === 'aborted'

    const reason = isError
      ? {
        kind: 'error' as const,
        error: {
          message: endEvent.error?.message ?? 'Agent execution error',
          code: endEvent.error?.code ?? 'UNKNOWN',
        },
      }
      : isAborted
        ? {
          kind: 'aborted' as const,
          reason: { kind: 'user' as const },
        }
        : { kind: 'completed' as const }

    if (ctx.currentStep > 0) {
      events.push({
        seq: ctx.nextSeq++,
        time,
        type: 'step/end',
        data: { turn: ctx.currentTurn, step: ctx.currentStep },
      })
    }

    events.push({
      seq: ctx.nextSeq++,
      time,
      type: 'turn/end',
      data: {
        turn: ctx.currentTurn,
        reason,
      },
    })
    return events
  }

  return events
}

/**
 * Ingests an array of Pi raw events into sequential DSH SessionEvents.
 */
export function streamPiEventsToDsh(
  events: PiSessionRawEvent[],
  ctx: TranslationContext = createTranslationContext(),
): DshSessionEvent[] {
  const result: DshSessionEvent[] = []
  for (const event of events) {
    const translated = translatePiEvent(event, ctx)
    if (translated.length > 0) {
      result.push(...translated)
    }
  }
  return result
}

/**
 * Parses a JSONL string stream of Pi events and returns canonical DSH SessionEvents.
 */
export function parsePiJsonlStream(
  jsonlContent: string,
  ctx: TranslationContext = createTranslationContext(),
): DshSessionEvent[] {
  const lines = jsonlContent.split('\n')
  const events: PiSessionRawEvent[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as PiSessionRawEvent
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
        events.push(parsed)
      }
    } catch {
      // Gracefully ignore corrupt or partial line chunks
    }
  }

  return streamPiEventsToDsh(events, ctx)
}
