/**
 * Minimal client for the DeepSeek Harness SDK wire protocol.
 *
 * The runtime (`dsh --profile sdk`) speaks JSON-RPC 2.0 over stdio, one
 * `\n`-terminated frame per message: `initialize`, `session/prompt`, and
 * `shutdown` are the only requests, and the runtime pushes `session.event`,
 * `session.status`, `subagent.started`, and `subagent.finished`
 * notifications. This module owns framing and request bookkeeping only, so it
 * stays free of both the VS Code API and any DeepSeek Harness package.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcMessage = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification

/** A transport-level failure: the frame was not valid JSON-RPC 2.0. */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError'
}

/** A wire error response. `code` and `data` are preserved from the runtime. */
export class ResponseError extends Error {
  override readonly name = 'ResponseError'
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

/** The runtime process is gone; the caller must restart it to continue. */
export class TransportClosedError extends Error {
  override readonly name = 'TransportClosedError'
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderrTail: string,
  ) {
    super(message)
  }
}

export interface FrameSink {
  write(frame: string): void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout | undefined
  method: string
}

/**
 * Framing and request bookkeeping for one runtime connection. Callers attach
 * byte-stream handlers to {@link FrameSink} and feed every received line to
 * {@link LineTransport.accept}.
 */
export class LineTransport {
  readonly #pending = new Map<number, Pending>()
  readonly #notificationHandlers = new Set<(method: string, params: unknown) => void>()
  #nextId = 1
  #closed: Error | undefined

  constructor(private readonly sink: (frame: string) => void) {}

  /** Register a notification handler; returns an unsubscribe function. */
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.#notificationHandlers.add(handler)
    return () => {
      this.#notificationHandlers.delete(handler)
    }
  }

  /** Send a request and resolve with its result. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed)
    const id = this.#nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#pending.delete(id)
              reject(new Error(`request timed out after ${timeoutMs}ms: ${method}`))
            }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.sink(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
      } catch (error) {
        this.#settle(id, reject, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return
    this.sink(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n')
  }

  /**
   * Consume one received line. Malformed lines are reported to `onMalformed`
   * rather than thrown, matching the runtime's own tolerance.
   */
  accept(line: string, onMalformed?: (line: string, error: Error) => void): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage
    } catch (error) {
      onMalformed?.(trimmed, error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (typeof message !== 'object' || message === null) return
    const hasId = typeof (message as JsonRpcSuccess).id === 'number'
    const method = (message as JsonRpcNotification).method
    if (hasId && method === undefined) {
      const frame = message as JsonRpcSuccess | JsonRpcFailure
      const pending = this.#pending.get(frame.id)
      if (!pending) return
      this.#pending.delete(frame.id)
      if (pending.timer) clearTimeout(pending.timer)
      if ('error' in frame && frame.error) {
        pending.reject(new ResponseError(frame.error.message, frame.error.code, frame.error.data))
      } else {
        pending.resolve((frame as JsonRpcSuccess).result)
      }
      return
    }
    if (typeof method === 'string' && !hasId) {
      for (const handler of this.#notificationHandlers) {
        try {
          handler(method, (message as JsonRpcNotification).params)
        } catch {
          // A throwing observer must not break framing for the other observers.
        }
      }
      return
    }
    if (typeof method === 'string' && hasId) {
      // The runtime never calls back into this client; refuse politely.
      this.sink(
        JSON.stringify({
          jsonrpc: '2.0',
          id: (message as JsonRpcSuccess).id,
          error: { code: -32601, message: `unsupported method: ${method}` },
        }) + '\n',
      )
    }
  }

  /** Fail every pending request and refuse later sends. */
  close(reason: Error): void {
    this.#closed = reason
    for (const [id, pending] of [...this.#pending]) {
      this.#settle(id, pending.reject, reason)
    }
  }

  get closed(): boolean {
    return this.#closed !== undefined
  }

  #settle(id: number, settle: (error: Error) => void, error: Error): void {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    settle(error)
  }
}
