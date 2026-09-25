/**
 * The subset of the DeepSeek Harness wire vocabulary this extension reads.
 *
 * The runtime sends every session-log event verbatim, so only the shapes the
 * chat surface renders are modelled here; unknown event types are ignored
 * rather than rejected, which keeps the extension working as the harness adds
 * events.
 */

/** One non-image content block of a model or tool message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; [key: string]: unknown }
  | { type: string; [key: string]: unknown }

/** Origin of a transcript message. */
export interface MessageSource {
  kind: string
  [key: string]: unknown
}

export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | string
  content: ContentBlock[]
  source?: MessageSource
  toolCallId?: string
}

/** One JSON-RPC `session.event` payload. */
export interface SessionEventNotification {
  sessionId: string
  event: SessionEvent
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data?: unknown
  surfaceOp?: 'append' | 'replace' | 'remove' | string
  sourceEventSeqs?: number[]
}

/** One JSON-RPC `session.status` payload. */
export interface SessionStatusNotification {
  sessionId: string
  status: 'idle' | 'running'
}

export interface SubagentStartedNotification {
  parentSessionId: string
  childSessionId: string
}

export interface SubagentFinishedNotification {
  provider: string
  agentId: string
  parentSessionId: string
  childSessionId: string
  status: 'ok' | 'error'
  stopReason: string
  lastAssistantMessage?: ContentBlock[]
}

export interface InitializeParams {
  cwd: string
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface InitializeResult {
  serverInfo: { name: string; version: string }
}

/** Inline raster input accepted by `session/prompt`. */
export interface EncodedImageBlock {
  type: 'image'
  data: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

export type PromptContentBlock = ContentBlock | EncodedImageBlock

/** Payload of the `bash` tool call and its result, as far as the UI needs it. */
export interface ToolCallData {
  turn: number
  step: number
  callId: string
  name: string
  arguments: string
}

export interface ToolResultData {
  turn: number
  step: number
  message: TranscriptMessage
}

export interface AssistantMessageData {
  turn: number
  step: number
  message: TranscriptMessage
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

export interface UserMessageData extends TranscriptMessage {
  source?: MessageSource
}

export interface TitleData {
  title: string
  source?: { kind: string }
}

/** Token use reported for one assistant message. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}
