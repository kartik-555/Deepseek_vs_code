/**
 * Turning the harness session log into a chat transcript.
 *
 * The runtime streams durable log events, not deltas, and a committed
 * `assistant/message` already carries reasoning, text, and tool calls for one
 * step. This reducer folds that vocabulary into the flat item list both chat
 * surfaces render, and ignores every event the user should not see (system
 * prompts, injected runtime context, request headers).
 */

import type {
  AssistantMessageData,
  ContentBlock,
  SessionEvent,
  TitleData,
  ToolCallData,
  ToolResultData,
  TranscriptMessage,
  Usage,
  UserMessageData,
} from './wire'

export type ChatItem =
  | {
      id: string
      kind: 'user'
      at: number
      text: string
      images: number
      context: string
    }
  | {
      id: string
      kind: 'assistant'
      at: number
      turn: number
      step: number
      reasoning: string
      text: string
      usage?: Usage
    }
  | {
      id: string
      kind: 'tool'
      at: number
      callId: string
      name: string
      summary: string
      argsText: string
      status: 'running' | 'ok' | 'error'
      output: string
      outputTruncated: boolean
    }
  | {
      id: string
      kind: 'subagent'
      at: number
      childSessionId: string
      provider: string
      status: 'running' | 'ok' | 'error'
      summary: string
    }
  | {
      id: string
      kind: 'notice'
      at: number
      level: 'info' | 'warn' | 'error'
      text: string
    }

export type TranscriptMutation =
  | { op: 'append'; item: ChatItem }
  | { op: 'update'; id: string; patch: Record<string, unknown> }
  | { op: 'remove'; id: string }

export interface ReducerOptions {
  sessionId: string
  /** Include reasoning blocks; mirrors `dshVscode.showReasoning`. */
  showReasoning?: boolean
  /** Cap on stored tool output, in characters. */
  toolOutputLimit?: number
}

const DEFAULT_TOOL_OUTPUT_LIMIT = 24_000

/** Text of every `text` block, joined. */
export function blockText(blocks: readonly ContentBlock[] | undefined): string {
  if (!blocks) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}

export function blockReasoning(blocks: readonly ContentBlock[] | undefined): string {
  if (!blocks) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block && block.type === 'reasoning' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}

function countImages(blocks: readonly ContentBlock[] | undefined): number {
  if (!blocks) return 0
  return blocks.filter((block) => block?.type === 'image').length
}

/** Pull a short, tool-specific one-liner out of a tool call's JSON arguments. */
export function summarizeToolCall(name: string, rawArguments: string): string {
  let parsed: Record<string, unknown> | undefined
  try {
    const value = JSON.parse(rawArguments)
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    return rawArguments.slice(0, 200)
  }
  if (!parsed) return rawArguments.slice(0, 200)
  const stringField = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = parsed?.[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return undefined
  }
  const firstLine = (value: string, limit = 200): string => {
    const line = value.split('\n')[0] ?? ''
    return line.length > limit ? `${line.slice(0, limit)}…` : line
  }
  switch (name) {
    case 'bash':
    case 'pwsh':
    case 'shell':
      return firstLine(stringField('command', 'script') ?? '')
    case 'read':
    case 'write':
    case 'edit':
    case 'multi_edit':
      return stringField('file_path', 'path', 'filePath') ?? ''
    case 'glob':
      return stringField('pattern') ?? ''
    case 'grep':
      return [stringField('pattern'), stringField('path')].filter(Boolean).join('  in  ')
    case 'task':
    case 'subagent':
      return firstLine(stringField('description', 'prompt') ?? '')
    case 'todo_write':
      return summarizeTodos(parsed)
    default:
      break
  }
  const preferred = stringField('description', 'path', 'file_path', 'pattern', 'command', 'query', 'name', 'text')
  if (preferred) return firstLine(preferred)
  const serialized = JSON.stringify(parsed)
  return serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized
}

function summarizeTodos(parsed: Record<string, unknown>): string {
  const todos = parsed.todos
  if (!Array.isArray(todos)) return ''
  const counts = { completed: 0, in_progress: 0, pending: 0 } as Record<string, number>
  for (const todo of todos) {
    const status = (todo as { status?: unknown })?.status
    if (typeof status === 'string' && status in counts) counts[status] = (counts[status] ?? 0) + 1
  }
  return `${todos.length} items · ${counts.completed} done · ${counts.in_progress} active · ${counts.pending} pending`
}

/**
 * Stateful fold of one session's event stream into transcript items. Both the
 * sidebar and the chat participant share it, so they agree on how a turn reads.
 */
export class TranscriptReducer {
  readonly #items: ChatItem[] = []
  readonly #toolItemByCallId = new Map<string, string>()
  readonly #pendingEchoes: { id: string; text: string }[] = []
  #title: string | undefined
  #echoCounter = 0

  constructor(private readonly options: ReducerOptions) {}

  get items(): readonly ChatItem[] {
    return this.#items
  }

  get title(): string | undefined {
    return this.#title
  }

  /** Replace the whole transcript, for reopening a stored session. */
  replaceAll(items: readonly ChatItem[]): void {
    this.#items.length = 0
    this.#items.push(...items)
    this.#toolItemByCallId.clear()
    for (const item of items) {
      if (item.kind === 'tool') this.#toolItemByCallId.set(item.callId, item.id)
    }
  }

  /** Seed the title of a reopened session before its next event arrives. */
  replaceTitle(title: string): void {
    this.#title = title
  }

  /**
   * Show the user's own message immediately, before the runtime echoes it back
   * through `agent/inbox/spliced`. The runtime's copy is dropped by
   * {@link #consumeEcho} so the transcript never shows a message twice.
   */
  echoUser(text: string, context: string, images: number): TranscriptMutation {
    const id = `local:${this.#echoCounter++}`
    const item: ChatItem = { id, kind: 'user', at: Date.now(), text, images, context }
    this.#items.push(item)
    this.#pendingEchoes.push({ id, text })
    return { op: 'append', item }
  }

  #consumeEcho(text: string): boolean {
    const index = this.#pendingEchoes.findIndex((entry) => entry.text === text)
    if (index < 0) return false
    this.#pendingEchoes.splice(index, 1)
    return true
  }

  /** Apply one raw event; returns the mutations a view must render. */
  apply(event: SessionEvent): TranscriptMutation[] {
    switch (event.type) {
      case 'session/title':
        return this.#applyTitle(event)
      case 'agent/inbox/spliced':
        return this.#applyInbox(event)
      case 'user/message':
        return this.#applyUserMessage(event)
      case 'assistant/message':
        return this.#applyAssistantMessage(event)
      case 'tool/call':
        return this.#applyToolCall(event)
      case 'tool/result':
        return this.#applyToolResult(event)
      case 'turn/end':
        return this.#applyTurnEnd(event)
      default:
        return []
    }
  }

  /** Record a subagent outcome; the participants own their own child sessions. */
  applySubagentFinished(info: {
    childSessionId: string
    provider: string
    status: 'ok' | 'error'
    lastAssistantMessage?: ContentBlock[]
  }): TranscriptMutation[] {
    const id = `subagent:${info.childSessionId}`
    const existing = this.#items.findIndex((item) => item.id === id)
    const summary = blockText(info.lastAssistantMessage).slice(0, 600)
    if (existing >= 0) {
      const item = this.#items[existing] as Extract<ChatItem, { kind: 'subagent' }>
      item.status = info.status
      item.summary = summary || item.summary
      return [{ op: 'update', id, patch: { status: item.status, summary: item.summary } }]
    }
    const item: ChatItem = {
      id,
      kind: 'subagent',
      at: Date.now(),
      childSessionId: info.childSessionId,
      provider: info.provider,
      status: info.status,
      summary,
    }
    this.#items.push(item)
    return [{ op: 'append', item }]
  }

  /** Add an extension-generated notice, so the transcript explains a stop or failure. */
  notice(level: 'info' | 'warn' | 'error', text: string): TranscriptMutation {
    const item: ChatItem = { id: `notice:${Date.now()}:${this.#items.length}`, kind: 'notice', at: Date.now(), level, text }
    this.#items.push(item)
    return { op: 'append', item }
  }

  #applyTitle(event: SessionEvent): TranscriptMutation[] {
    const data = event.data as TitleData | undefined
    if (data && typeof data.title === 'string') this.#title = data.title
    return []
  }

  #applyInbox(event: SessionEvent): TranscriptMutation[] {
    const data = event.data as { inserted?: TranscriptMessage[] } | undefined
    const mutations: TranscriptMutation[] = []
    for (const message of data?.inserted ?? []) {
      if (message?.role !== 'user') continue
      if (message.source?.kind !== undefined && message.source.kind !== 'user') continue
      if (this.#consumeEcho(blockText(message.content))) continue
      mutations.push(this.#appendUser(message, event.time))
    }
    return mutations
  }

  #applyUserMessage(event: SessionEvent): TranscriptMutation[] {
    const message = event.data as UserMessageData | undefined
    if (!message || message.role !== 'user') return []
    if (message.source?.kind !== undefined && message.source.kind !== 'user') return []
    if (this.#items.some((item) => item.kind === 'user' && item.id === message.id)) return []
    if (this.#consumeEcho(blockText(message.content))) return []
    return [this.#appendUser(message, event.time)]
  }

  #appendUser(message: TranscriptMessage, at: number): TranscriptMutation {
    const item: ChatItem = {
      id: message.id,
      kind: 'user',
      at,
      text: blockText(message.content),
      images: countImages(message.content),
      context: '',
    }
    this.#items.push(item)
    return { op: 'append', item }
  }

  #applyAssistantMessage(event: SessionEvent): TranscriptMutation[] {
    const data = event.data as AssistantMessageData | undefined
    const message = data?.message
    if (!message) return []
    const reasoning = this.options.showReasoning === false ? '' : blockReasoning(message.content)
    const text = blockText(message.content)
    // A step that only issues tool calls has no assistant text; the tool card
    // already carries the visible action, so do not add an empty bubble.
    if (text.trim().length === 0 && reasoning.trim().length === 0) return []
    const item: ChatItem = {
      id: message.id,
      kind: 'assistant',
      at: event.time,
      turn: data?.turn ?? 0,
      step: data?.step ?? 0,
      reasoning,
      text,
      ...(data?.usage ? { usage: data.usage as Usage } : {}),
    }
    this.#items.push(item)
    return [{ op: 'append', item }]
  }

  #applyToolCall(event: SessionEvent): TranscriptMutation[] {
    const data = event.data as ToolCallData | undefined
    if (!data?.callId) return []
    const id = `tool:${data.callId}`
    const existing = this.#items.findIndex((item) => item.id === id)
    const item: ChatItem = {
      id,
      kind: 'tool',
      at: event.time,
      callId: data.callId,
      name: data.name ?? 'tool',
      summary: summarizeToolCall(data.name ?? 'tool', data.arguments ?? '{}'),
      argsText: data.arguments ?? '',
      status: 'running',
      output: '',
      outputTruncated: false,
    }
    this.#toolItemByCallId.set(data.callId, id)
    if (existing >= 0) {
      this.#items[existing] = item
      return [{ op: 'update', id, patch: { ...item } }]
    }
    this.#items.push(item)
    return [{ op: 'append', item }]
  }

  #applyToolResult(event: SessionEvent): TranscriptMutation[] {
    const data = event.data as ToolResultData | undefined
    const message = data?.message
    if (!message) return []
    const callId = message.toolCallId ?? (message.source as { callId?: string } | undefined)?.callId
    if (!callId) return []
    const limit = this.options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT
    const raw = blockText(message.content)
    const truncated = raw.length > limit
    const output = truncated ? `${raw.slice(0, limit)}\n… (${raw.length - limit} more characters)` : raw
    const status: 'ok' | 'error' = (message as { isError?: boolean }).isError ? 'error' : 'ok'
    const id = this.#toolItemByCallId.get(callId) ?? `tool:${callId}`
    const index = this.#items.findIndex((item) => item.id === id)
    if (index < 0) {
      // A result whose call event predates this transcript (for example after a
      // reopen) still deserves a card.
      const item: ChatItem = {
        id,
        kind: 'tool',
        at: event.time,
        callId,
        name: 'tool',
        summary: '',
        argsText: '',
        status,
        output,
        outputTruncated: truncated,
      }
      this.#items.push(item)
      return [{ op: 'append', item }]
    }
    const item = this.#items[index] as Extract<ChatItem, { kind: 'tool' }>
    item.status = status
    item.output = output
    item.outputTruncated = truncated
    return [{ op: 'update', id, patch: { status, output, outputTruncated: truncated } }]
  }

  #applyTurnEnd(event: SessionEvent): TranscriptMutation[] {
    const data = event.data as { reason?: { kind?: string; [key: string]: unknown } } | undefined
    const kind = data?.reason?.kind ?? 'completed'
    if (kind === 'completed') return []
    const detail = describeEndReason(kind, data?.reason)
    return [this.notice(kind === 'aborted' ? 'warn' : 'error', detail)]
  }

  /** Mark every still-running tool card as interrupted, for a killed runtime. */
  failRunningTools(message: string): TranscriptMutation[] {
    const mutations: TranscriptMutation[] = []
    for (const item of this.#items) {
      if (item.kind === 'tool' && item.status === 'running') {
        item.status = 'error'
        item.output = item.output || message
        mutations.push({ op: 'update', id: item.id, patch: { status: 'error', output: item.output } })
      }
    }
    return mutations
  }
}

function describeEndReason(kind: string, reason: { [key: string]: unknown } | undefined): string {
  switch (kind) {
    case 'aborted':
      return 'The turn was interrupted.'
    case 'error': {
      const error = reason?.error as { message?: string } | string | undefined
      const message = typeof error === 'string' ? error : error?.message
      return message ? `The turn failed: ${message}` : 'The turn failed.'
    }
    case 'max-steps':
      return 'The turn stopped after reaching its step limit.'
    default:
      return `The turn ended: ${kind}${reason ? ` (${JSON.stringify(reason).slice(0, 300)})` : ''}`
  }
}

/** Character budget for the continuation digest handed to a fresh runtime. */
export const CONTINUATION_SEED_LIMIT = 12_000

/**
 * A bounded, chronological digest of a transcript: user turns in full, the
 * assistant's conclusions, and a one-line record per tool call. Newest turns
 * are kept when the budget runs out, and the omission is stated so the model
 * does not assume the conversation started where the digest does.
 */
export function buildTranscriptDigest(items: readonly ChatItem[], limit: number): string {
  const lines: string[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        lines.push(`User: ${item.text.trim().slice(0, 1200)}`)
        break
      case 'assistant': {
        const text = item.text.trim()
        if (text.length > 0) lines.push(`Assistant: ${text.slice(0, 2000)}`)
        break
      }
      case 'tool':
        lines.push(
          `Tool ${item.name}: ${item.summary.replace(/\s+/g, ' ').slice(0, 160)} -> ${item.status}`,
        )
        break
      case 'subagent':
        lines.push(`Subagent (${item.provider}): ${item.status} ${item.summary.replace(/\s+/g, ' ').slice(0, 200)}`)
        break
      case 'notice':
        break
      default:
        break
    }
  }
  if (lines.length === 0) return ''
  const kept: string[] = []
  let budget = limit
  let omitted = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (line.length > budget) {
      omitted = index + 1
      break
    }
    kept.unshift(line)
    budget -= line.length
  }
  if (kept.length === 0) kept.push(lines[lines.length - 1]!.slice(0, limit))
  const header = omitted > 0 ? `(${omitted} earlier entries omitted from this summary)\n` : ''
  return `${header}${kept.join('\n')}`
}
