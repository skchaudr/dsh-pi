import { stripVTControlCharacters } from 'node:util'
import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent'

/** A visible transcript/event publication, not a diagnostic log. */
export interface UiPublication {
  kind: 'notify' | 'status' | 'widget' | 'unsupported'
  text: string
  level: 'info' | 'warning' | 'error'
  key?: string
  clear?: boolean
  placement?: 'aboveEditor' | 'belowEditor'
}

type DecisionContent = {
  title: string
} & (
  | { kind: 'select'; options: string[] }
  | { kind: 'confirm'; message: string }
  | { kind: 'input'; placeholder?: string }
  | { kind: 'editor'; prefill?: string }
)

export type UiDecisionRequest = DecisionContent & { signal: AbortSignal }

export interface UiBridgeCallbacks {
  /** Must synchronously publish/enqueue user-visible text. Errors must not be swallowed. */
  publish(event: UiPublication): void
  /** Await an actual human decision; undefined means explicit cancellation, never approval.
   * Confirm returns boolean, select returns an exact offered option, input/editor return text.
   * Host must bind the exact live agent to DSH userQuestions.ask and honor signal.
   */
  decide?(request: UiDecisionRequest): Promise<string | boolean | undefined>
  /** Dynamic availability: false for delegated agents or absent question providers. */
  isInteractive?(): boolean
  /** Current operation signal, obtained per invocation (e.g. AsyncLocalStorage). */
  getSignal?(): AbortSignal | undefined
}

const TEXT_LIMIT = 16_384
function visibleText(text: string): string {
  const plain = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return plain.length <= TEXT_LIMIT ? plain : `${plain.slice(0, TEXT_LIMIT - 12)}\n[truncated]`
}

/** Adapt Pi 0.87 UI without constructing fake TUI objects or running component factories.
 * base supplies Pi's existing theme only; all other unsupported UI calls fail visibly.
 * Install ui on the runner and read hasUI dynamically; output alone is not dialog support.
 */
export function createUiBridge(base: ExtensionUIContext, callbacks: UiBridgeCallbacks): {
  ui: ExtensionUIContext
  readonly hasUI: boolean
} {
  const available = () => typeof callbacks.decide === 'function' && (callbacks.isInteractive?.() ?? true)
  const publish = (event: UiPublication) => callbacks.publish({
    ...event,
    text: visibleText(event.text),
    ...(event.key === undefined ? {} : { key: visibleText(event.key) }),
  })
  const failure = (message: string, abort = false): Error => {
    publish({ kind: 'unsupported', level: 'error', text: message })
    const error = new Error(message)
    if (abort) error.name = 'AbortError'
    return error
  }
  const unsupported = (method: string): never => {
    throw failure(`Pi UI ${method} is unsupported by the DSH text bridge.`)
  }

  async function decide(
    request: DecisionContent,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | boolean | undefined> {
    if (!available()) throw failure(`Pi UI ${request.kind} unavailable: no interactive decision callback.`)
    if (opts?.timeout !== undefined && (!Number.isFinite(opts.timeout) || opts.timeout < 0)) {
      throw failure(`Pi UI ${request.kind} has an invalid timeout.`)
    }
    const controller = new AbortController()
    const signals = [callbacks.getSignal?.(), opts?.signal].filter((signal): signal is AbortSignal => signal !== undefined)
    const abort = () => controller.abort()
    for (const signal of signals) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      if (controller.signal.aborted) throw failure(`Pi UI ${request.kind} cancelled.`, true)
      if (opts?.timeout !== undefined) timer = setTimeout(abort, opts.timeout)
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('cancelled'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      let answer: string | boolean | undefined
      try {
        answer = await Promise.race([
          callbacks.decide!({ ...request, signal: controller.signal }),
          cancelled,
        ])
      } catch {
        throw failure(
          controller.signal.aborted ? `Pi UI ${request.kind} cancelled.` : `Pi UI ${request.kind} decision callback failed.`,
          controller.signal.aborted,
        )
      }
      if (controller.signal.aborted) throw failure(`Pi UI ${request.kind} cancelled.`, true)
      const valid = answer === undefined || (request.kind === 'confirm'
        ? typeof answer === 'boolean'
        : typeof answer === 'string' && (request.kind !== 'select' || request.options!.includes(answer)))
      if (!valid) throw failure(`Pi UI ${request.kind} decision callback returned an invalid answer.`)
      return answer
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort)
      for (const signal of signals) signal.removeEventListener('abort', abort)
    }
  }

  const status = (key: string, text: string | undefined) => publish({
    kind: 'status', level: 'info', key, clear: text === undefined,
    text: text === undefined ? `[Pi status ${key} cleared]` : text,
  })
  const ui: ExtensionUIContext = {
    get theme() { return base.theme },
    onTerminalInput: () => unsupported('onTerminalInput'),
    setWorkingVisible: () => unsupported('setWorkingVisible'),
    setWorkingIndicator: () => unsupported('setWorkingIndicator'),
    setFooter: () => unsupported('setFooter'),
    setHeader: () => unsupported('setHeader'),
    pasteToEditor: () => unsupported('pasteToEditor'),
    setEditorText: () => unsupported('setEditorText'),
    getEditorText: () => unsupported('getEditorText'),
    addAutocompleteProvider: () => unsupported('addAutocompleteProvider'),
    setEditorComponent: () => unsupported('setEditorComponent'),
    getEditorComponent: () => unsupported('getEditorComponent'),
    getAllThemes: () => unsupported('getAllThemes'),
    getTheme: () => unsupported('getTheme'),
    getToolsExpanded: () => unsupported('getToolsExpanded'),
    setToolsExpanded: () => unsupported('setToolsExpanded'),
    notify: (text, level = 'info') => publish({ kind: 'notify', text, level }),
    setStatus: status,
    setWidget: (key, content, options) => publish({
      kind: 'widget', key, placement: options?.placement ?? 'aboveEditor',
      level: typeof content === 'function' ? 'warning' : 'info',
      clear: content === undefined,
      text: typeof content === 'function'
        ? `[Pi widget ${key}: DSH cannot render terminal components; extension must provide string[] text as a fallback.]`
        : content === undefined ? `[Pi widget ${key} cleared]` : content.join('\n'),
    }),
    setWorkingMessage: text => status('working', text),
    setTitle: text => status('title', text),
    setHiddenThinkingLabel: text => status('hidden-thinking-label', text),
    select: async (title, options, opts) => await decide({ kind: 'select', title, options: [...options] }, opts) as string | undefined,
    confirm: async (title, message, opts) => (await decide({ kind: 'confirm', title, message }, opts)) === true,
    input: async (title, placeholder, opts) => await decide({ kind: 'input', title, ...(placeholder === undefined ? {} : { placeholder }) }, opts) as string | undefined,
    editor: async (title, prefill) => await decide({ kind: 'editor', title, ...(prefill === undefined ? {} : { prefill }) }) as string | undefined,
    custom: async () => unsupported('custom'),
    setTheme: () => {
      const error = 'Pi UI setTheme is unsupported by the DSH text bridge.'
      publish({ kind: 'unsupported', level: 'warning', text: error })
      return { success: false, error }
    },
  }
  return { ui, get hasUI() { return available() } }
}
