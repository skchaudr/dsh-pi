import {
  createEventBus,
  ExtensionRunner,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  AgentToolResult,
  ExtensionActions,
  ExtensionContextActions,
  ExtensionEvent,
  ExtensionRuntime,
  LoadExtensionsResult,
  ProviderConfig,
  RegisteredTool,
  ResolvedCommand,
} from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'
import { persistWorkflowMessage } from './pi-workflows.js'
import { createUiBridge, type UiDecisionRequest, type UiPublication } from './ui-bridge.js'

export interface RuntimeBridge {
  reportError?(context: string): void
  sendMessage?(message: unknown, options?: unknown): void
  sendUserMessage?(content: unknown, options?: unknown): void
  appendEntry?(type: string, data: unknown): void
  setLabel?(entryId: string, label: string | undefined): void
  setModel?(model: unknown): boolean | Promise<boolean>
  registerProvider?(name: string, config: ProviderConfig): void
  unregisterProvider?(name: string): void
  shutdown?(): void
  abort?(): void
  compact?(options: unknown): void
  refreshTools?(): void
  getSystemPrompt?(): string
  getContextUsage?(): ReturnType<ExtensionContextActions['getContextUsage']>
  hasPendingMessages?(): boolean
  isIdle?(): boolean
  waitForIdle?(): Promise<void>
  /** DSH's current model selection, mapped into the Pi context. */
  getModel?(): { provider: string; id: string } | undefined
  /** Cached snapshot of DSH's model catalog for Pi inventory and alias resolution. */
  listModels?(): readonly { provider: string; id: string; name: string }[]
  /** Trigger an asynchronous refresh of the DSH catalog snapshot. */
  refreshModels?(): void
  /** Publish Pi UI text/status/widget output visibly into DSH. */
  publishUi?(event: UiPublication): void
  /** Await a real human decision through DSH user questions; undefined means cancellation. */
  requestDecision?(request: UiDecisionRequest): Promise<string | boolean | undefined>
}

export interface RuntimeOptions {
  cwd: string
  /** A durable Pi projection owned by the enclosing DSH session. */
  sessionManager?: SessionManager
  bridge?: RuntimeBridge
  projectTrusted?: boolean
  mode?: 'tui' | 'rpc' | 'json' | 'print'
  flags?: Record<string, boolean | string>
}

export interface ExecuteToolOptions {
  callId: string
  signal?: AbortSignal
  onUpdate?: (result: AgentToolResult<unknown>) => void
}

export interface PiToolExecutionResult extends AgentToolResult<unknown> {
  isError?: boolean
  /** Internal marker: let DSH materialize its canonical cancellation result. */
  aborted?: true
}

export interface CommandNotification {
  message: string
  type?: 'info' | 'warning' | 'error'
}

function unexpectedToolFailure(options: RuntimeOptions, name: string): PiToolExecutionResult {
  options.bridge?.reportError?.(`Pi tool "${name}" execution failed unexpectedly`)
  return {
    content: [{ type: 'text', text: 'Pi tool execution failed unexpectedly' }],
    details: {},
    isError: true,
  }
}

function abortedToolResult(): PiToolExecutionResult {
  return {
    content: [{ type: 'text', text: 'Tool execution aborted' }],
    details: {},
    isError: true,
    aborted: true,
  }
}

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
}

class UnsupportedCommandContextError extends Error {}

function unsupportedCommandContext(name: string): never {
  throw new UnsupportedCommandContextError(`Pi command context ${name} is unsupported by DSH`)
}

interface RuntimeLoad {
  result: LoadExtensionsResult
  runner: ExtensionRunner
  state: RuntimeState
}

interface RuntimeState {
  activeTools: Set<string>
  knownTools: Set<string>
  activeToolsExplicitlySet: boolean
  unavailableTools: Map<string, RegisteredTool['definition']>
  signalStore: AsyncLocalStorage<AbortSignal | undefined>
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  sessionManager: SessionManager
  sessionName?: string
}

async function loadSelectedExtensions(paths: string[], cwd: string): Promise<LoadExtensionsResult> {
  const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const loader = await import(pathToFileURL(join(dirname(piEntry), 'core/extensions/loader.js')).href) as {
    loadExtensions(paths: string[], cwd: string, eventBus: ReturnType<typeof createEventBus>): Promise<LoadExtensionsResult>
  }
  return loader.loadExtensions(paths, cwd, createEventBus())
}

function modelRegistryFacade(bridge: RuntimeBridge): object {
  const providers = new Map<string, ProviderConfig>()
  const piModel = (entry: { provider: string; id: string; name: string }) => ({
    provider: entry.provider, id: entry.id, name: entry.name,
    api: 'dsh-adapter', baseUrl: '', envKey: undefined,
    contextWindow: 0, maxTokens: 0,
    input: ['text'], cost: { input: 0, output: 0, request: 0 },
    reasoning: true, supportedParameters: [],
  })
  return {
    getAll: () => (bridge.listModels?.() ?? []).map(piModel),
    getAvailable: () => (bridge.listModels?.() ?? []).map(piModel),
    find: (provider: string, id: string) => {
      const entry = (bridge.listModels?.() ?? []).find(model => model.provider === provider && model.id === id)
      return entry === undefined ? undefined : piModel(entry)
    },
    refresh: async () => { bridge.refreshModels?.() },
    hasConfiguredAuth: () => (bridge.listModels?.() ?? []).length > 0,
    getApiKeyAndHeaders: async () => ({ ok: false, error: 'No Pi model credentials are exposed by DSH' }),
    getProviderAuthStatus: () => ({ type: 'none' }),
    getProviderDisplayName: (name: string) => name,
    getApiKeyForProvider: async () => undefined,
    isUsingOAuth: () => false,
    registerProvider: (name: string, config: ProviderConfig) => {
      providers.set(name, config)
      bridge.registerProvider?.(name, config)
    },
    unregisterProvider: (name: string) => {
      providers.delete(name)
      bridge.unregisterProvider?.(name)
    },
    getRegisteredProviderConfig: (name: string) => providers.get(name),
    getRegisteredProviderIds: () => [...providers.keys()],
  }
}

function bindActions(
  runtime: ExtensionRuntime,
  options: RuntimeOptions,
  state: RuntimeState,
  getRunner: () => ExtensionRunner | undefined,
): { actions: ExtensionActions; context: ExtensionContextActions } {
  const bridge = options.bridge ?? {}
  const actions: ExtensionActions = {
    sendMessage: (message, delivery) => {
      // Pi semantics: sendMessage durably appends the custom entry before delivery.
      // Workflow messages dedupe by workflowMessageId; a duplicate is never re-enqueued.
      const custom = message as {
        customType: string
        content: Parameters<SessionManager['appendCustomMessageEntry']>[1]
        display: boolean
        details?: unknown
      }
      const persisted = persistWorkflowMessage(state.sessionManager, custom)
      if (persisted === undefined) state.sessionManager.appendCustomMessageEntry(custom.customType, custom.content, custom.display, custom.details)
      if (persisted?.duplicate !== true) bridge.sendMessage?.(message, delivery)
    },
    sendUserMessage: (content, delivery) => { bridge.sendUserMessage?.(content, delivery) },
    appendEntry: (type, data) => {
      state.sessionManager.appendCustomEntry(type, data)
      bridge.appendEntry?.(type, data)
    },
    setSessionName: (name) => {
      state.sessionName = name
      state.sessionManager.appendSessionInfo(name)
    },
    getSessionName: () => state.sessionName,
    setLabel: (entryId, label) => {
      state.sessionManager.appendLabelChange(entryId, label)
      bridge.setLabel?.(entryId, label)
    },
    getActiveTools: () => [...state.activeTools].filter(name => {
      const unavailable = state.unavailableTools.get(name)
      if (unavailable === undefined) return true
      const current = getRunner()?.getAllRegisteredTools().find(tool => tool.definition.name === name)
      return current?.definition !== unavailable
    }),
    getAllTools: () => (getRunner()?.getAllRegisteredTools() ?? []).map(({ definition, sourceInfo }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      ...(definition.promptGuidelines === undefined ? {} : { promptGuidelines: definition.promptGuidelines }),
      sourceInfo,
    })),
    setActiveTools: (names) => {
      const available = new Set((getRunner()?.getAllRegisteredTools() ?? []).map(tool => tool.definition.name))
      state.activeTools = new Set(names.filter(name => available.has(name)))
      state.activeToolsExplicitlySet = true
      bridge.refreshTools?.()
    },
    refreshTools: () => {
      const names = new Set((getRunner()?.getAllRegisteredTools() ?? []).map(tool => tool.definition.name))
      for (const name of names) {
        if (!state.knownTools.has(name)) state.activeTools.add(name)
      }
      state.knownTools = names
      bridge.refreshTools?.()
    },
    getCommands: () => (getRunner()?.getRegisteredCommands() ?? []).map(command => ({
      name: command.invocationName,
      description: command.description ?? '',
      source: 'extension' as const,
      sourceInfo: command.sourceInfo,
    })),
    setModel: async model => bridge.setModel === undefined ? false : bridge.setModel(model),
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: (level) => { state.thinkingLevel = level },
  }
  Object.assign(runtime, actions)
  return {
    actions,
    context: {
      getModel: () => bridge.getModel?.() as never,
      getScopedModels: () => [],
      isIdle: () => bridge.isIdle?.() ?? true,
      isProjectTrusted: () => options.projectTrusted ?? false,
      getSignal: () => state.signalStore.getStore(),
      abort: () => { bridge.abort?.() },
      hasPendingMessages: () => bridge.hasPendingMessages?.() ?? false,
      shutdown: () => { bridge.shutdown?.() },
      getContextUsage: () => bridge.getContextUsage?.(),
      compact: compactOptions => { bridge.compact?.(compactOptions) },
      getSystemPrompt: () => bridge.getSystemPrompt?.() ?? '',
      getSystemPromptOptions: () => ({ cwd: options.cwd }),
    },
  }
}

async function finishLoad(result: LoadExtensionsResult, options: RuntimeOptions): Promise<RuntimeLoad> {
  if (result.errors.length > 0) {
    options.bridge?.reportError?.(`Failed to load ${result.errors.length} selected Pi extension(s)`)
    throw new Error('Failed to load selected Pi extensions')
  }
  const state: RuntimeState = {
    activeTools: new Set(),
    knownTools: new Set(),
    activeToolsExplicitlySet: false,
    unavailableTools: new Map(),
    signalStore: new AsyncLocalStorage<AbortSignal | undefined>(),
    thinkingLevel: 'off',
    sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd),
  }
  let runner: ExtensionRunner | undefined
  const bound = bindActions(result.runtime, options, state, () => runner)
  runner = new ExtensionRunner(
    result.extensions,
    result.runtime,
    options.cwd,
    state.sessionManager,
    modelRegistryFacade(options.bridge ?? {}) as never,
  )
  runner.bindCore(bound.actions, bound.context, {
    registerProvider: (name, config) => options.bridge?.registerProvider?.(name, config),
    unregisterProvider: name => options.bridge?.unregisterProvider?.(name),
  })
  runner.bindCommandContext({
    waitForIdle: async () => options.bridge?.waitForIdle === undefined
      ? unsupportedCommandContext('waitForIdle')
      : options.bridge.waitForIdle(),
    newSession: async () => unsupportedCommandContext('newSession'),
    fork: async () => unsupportedCommandContext('fork'),
    navigateTree: async () => unsupportedCommandContext('navigateTree'),
    switchSession: async () => unsupportedCommandContext('switchSession'),
    reload: async () => unsupportedCommandContext('reload'),
  })
  runner.onError(error => {
    options.bridge?.reportError?.(`Pi extension "${error.extensionPath}" handler "${error.event}" failed`)
  })
  // Pi 0.87 hasUI() only tests UI-object identity, never mode: install the text
  // bridge, then override hasUI with the bridge's honest interactive capability.
  const interactive = options.bridge?.requestDecision !== undefined
  const uiBridge = createUiBridge(runner.createContext().ui, {
    publish: event => { options.bridge?.publishUi?.(event) },
    ...(options.bridge?.requestDecision === undefined ? {} : {
      decide: (request: UiDecisionRequest) => options.bridge!.requestDecision!(request),
    }),
    getSignal: () => state.signalStore.getStore(),
  })
  runner.setUIContext(uiBridge.ui, options.mode ?? (interactive ? 'rpc' : 'print'))
  ;(runner as unknown as { hasUI: () => boolean }).hasUI = () => uiBridge.hasUI
  state.knownTools = new Set(runner.getAllRegisteredTools().map(tool => tool.definition.name))
  state.activeTools = new Set(state.knownTools)
  for (const [name, value] of Object.entries(options.flags ?? {})) runner.setFlagValue(name, value)
  return { result, runner, state }
}

export class PiExtensionRuntime {
  private started = false
  private startQueue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly load: RuntimeLoad,
    private readonly options: RuntimeOptions,
  ) {}

  static async fromPaths(paths: string[], options: RuntimeOptions): Promise<PiExtensionRuntime> {
    const result = await loadSelectedExtensions(paths, options.cwd)
    return new PiExtensionRuntime(await finishLoad(result, options), options)
  }

  tools(): RegisteredTool['definition'][] {
    return this.load.runner.getAllRegisteredTools().map(tool => tool.definition)
  }

  commands(): ResolvedCommand[] {
    return this.load.runner.getRegisteredCommands()
  }

  flags(): Map<string, boolean | string> {
    return this.load.runner.getFlagValues()
  }

  activeToolNames(): string[] {
    return this.load.runner.getActiveTools()
  }

  requestedActiveToolNames(): string[] {
    return [...this.load.state.activeTools]
  }

  markToolUnavailable(name: string, definition: RegisteredTool['definition']): void {
    this.load.state.unavailableTools.set(name, definition)
  }

  clearToolUnavailable(name: string): void {
    this.load.state.unavailableTools.delete(name)
  }

  sessionName(): string | undefined {
    return this.load.state.sessionName
  }

  /** Pi's session-transition contract: re-starting a started runtime with a non-startup reason emits session_shutdown first. */
  async start(reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork' = 'startup'): Promise<void> {
    const queued = this.startQueue.then(async () => {
      if (this.started) {
        if (reason === 'startup') return
        await this.load.runner.emit({ type: 'session_shutdown', reason })
      }
      this.load.state.activeToolsExplicitlySet = false
      await this.load.runner.emit({ type: 'session_start', reason })
      await this.load.runner.emitResourcesDiscover(this.options.cwd, reason === 'reload' ? 'reload' : 'startup')
      if (!this.load.state.activeToolsExplicitlySet) {
        this.load.state.activeTools = new Set(this.tools().map(tool => tool.name))
      }
      this.started = true
      this.options.bridge?.refreshTools?.()
    })
    this.startQueue = queued.catch(() => undefined)
    return queued
  }

  async emit(event: ExtensionEvent, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.load.state.signalStore.run(signal, async () => {
        if (event.type === 'tool_call') return this.load.runner.emitToolCall(event)
        if (event.type === 'tool_result') return this.load.runner.emitToolResult(event)
        if (event.type === 'context' || event.type === 'context_with_system') return this.load.runner.emitContext(event.messages)
        if (event.type === 'before_provider_request') return this.load.runner.emitBeforeProviderRequest(event.payload)
        if (event.type === 'before_provider_headers') return this.load.runner.emitBeforeProviderHeaders(event.headers)
        if (event.type === 'before_agent_start') {
          return this.load.runner.emitBeforeAgentStart(event.prompt, event.images, event.systemPromptOptions)
        }
        if (event.type === 'message_end') return this.load.runner.emitMessageEnd(event)
        if (event.type === 'cache_warming_decision') return this.load.runner.emitCacheWarmingDecision(event)
        if (event.type === 'turn_end' || event.type === 'agent_before_settle') {
          return this.load.runner.emitBoundary(event, async () => ({
            contextEntries: [],
            contextMessages: [],
            llmMessages: [],
            pendingMessages: [],
            canContinue: false,
          }))
        }
        if (event.type === 'user_bash') return this.load.runner.emitUserBash(event)
        if (event.type === 'input') {
          return this.load.runner.emitInput(event.text, event.images, event.source, event.streamingBehavior)
        }
        if (event.type === 'project_trust' || event.type === 'resources_discover') return undefined
        return this.load.runner.emit(event)
      })
    } finally {
      this.options.bridge?.refreshTools?.()
    }
  }

  async executeTool(name: string, rawArgs: unknown, options: ExecuteToolOptions): Promise<PiToolExecutionResult> {
    return this.load.state.signalStore.run(options.signal, async () => {
      const registered = this.load.runner.getAllRegisteredTools().find(tool => tool.definition.name === name)
      if (registered === undefined) throw new Error(`Unknown Pi tool: ${name}`)
      const definition = registered.definition
      let input: Record<string, unknown>
      let decision: { block?: boolean; reason?: string } | undefined
      try {
        const prepared = definition.prepareArguments?.(rawArgs) ?? rawArgs
        if (!Value.Check(definition.parameters, prepared)) throw new TypeError(`Invalid arguments for Pi tool: ${name}`)
        input = prepared as Record<string, unknown>
        decision = await this.load.runner.emitToolCall({
          type: 'tool_call', toolCallId: options.callId, toolName: name, input,
        })
      } catch (error) {
        return isAbortFailure(error, options.signal) ? abortedToolResult() : unexpectedToolFailure(this.options, name)
      }
      if (decision?.block === true) throw new Error(decision.reason ?? `Pi extension blocked tool: ${name}`)
      await this.load.runner.emit({
        type: 'tool_execution_start', toolCallId: options.callId, toolName: name, args: input,
      })
      let result: PiToolExecutionResult
      let updates = Promise.resolve<unknown>(undefined)
      try {
        result = await definition.execute(options.callId, input, options.signal, partial => {
          options.onUpdate?.(partial)
          updates = updates.then(() => this.load.runner.emit({
            type: 'tool_execution_update', toolCallId: options.callId, toolName: name, args: input, partialResult: partial,
          }))
        }, this.load.runner.createContext()) as PiToolExecutionResult
      } catch (error) {
        result = isAbortFailure(error, options.signal) ? abortedToolResult() : unexpectedToolFailure(this.options, name)
      }
      await updates
      const intercepted = await this.load.runner.emitToolResult({
        type: 'tool_result', toolCallId: options.callId, toolName: name, input,
        content: result.content, details: result.details, isError: result.isError ?? false,
      })
      const finalResult = intercepted === undefined ? result : { ...result, ...intercepted }
      await this.load.runner.emit({
        type: 'tool_execution_end', toolCallId: options.callId, toolName: name,
        result: finalResult, isError: finalResult.isError ?? false,
      })
      this.options.bridge?.refreshTools?.()
      return finalResult
    })
  }

  async executeCommand(name: string, args: string, signal?: AbortSignal): Promise<CommandNotification[]> {
    return this.load.state.signalStore.run(signal, async () => {
      const command = this.load.runner.getCommand(name)
      if (command === undefined) throw new Error(`Unknown Pi command: ${name}`)
      try {
        const notifications: CommandNotification[] = []
        const context = this.load.runner.createCommandContext()
        const ui = new Proxy(context.ui, {
          get(target, property, receiver) {
            if (property !== 'notify') return Reflect.get(target, property, receiver) as unknown
            return (message: string, type?: CommandNotification['type']) => {
              notifications.push({ message, ...(type === undefined ? {} : { type }) })
            }
          },
        })
        Object.defineProperty(context, 'ui', { value: ui })
        await command.handler(args, context)
        return notifications
      } catch (error) {
        if (error instanceof UnsupportedCommandContextError || isAbortFailure(error, signal)) throw error
        this.options.bridge?.reportError?.(`Pi command "${name}" execution failed unexpectedly`)
        throw new Error('Pi command execution failed unexpectedly')
      }
    })
  }

  async shutdown(): Promise<void> {
    if (this.started) await this.load.runner.emit({ type: 'session_shutdown', reason: 'quit' })
    this.load.runner.invalidate('Pi extension runtime disposed by DSH')
    this.started = false
  }
}
