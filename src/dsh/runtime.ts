/**
 * One `dsh --profile sdk` child process per repository.
 *
 * The runtime is started lazily, kept alive across turns, and reaped on
 * disposal. The SDK protocol has no cancel request, so a stop is a process
 * restart: the runtime already persists each session as it goes, which is what
 * makes that safe.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactSecrets } from '../secrets'
import {
  LineTransport,
  ResponseError,
  TransportClosedError,
  type FrameSink,
} from './protocol'
import type {
  InitializeParams,
  InitializeResult,
  PromptContentBlock,
  SessionEventNotification,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './wire'

export interface LaunchSpec {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  origin: string
}

export interface RuntimeCallbacks {
  /** One session-log event, unfiltered. */
  onSessionEvent?(notification: SessionEventNotification): void
  /** Whole-agent running/idle transitions. */
  onSessionStatus?(notification: SessionStatusNotification): void
  onSubagentStarted?(notification: SubagentStartedNotification): void
  onSubagentFinished?(notification: SubagentFinishedNotification): void
  /** The child exited. `expected` is false for crashes and kills. */
  onExit?(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean; stderrTail: string }): void
  /** Diagnostic line, only when tracing is on. */
  onTrace?(line: string): void
  /** Fatal startup problem worth surfacing in the UI. */
  onDiagnostic?(message: string): void
}

export interface RuntimeOptions {
  launch: LaunchSpec
  initialize: InitializeParams
  callbacks?: RuntimeCallbacks
  /** Bound on the initialize handshake. */
  initializeTimeoutMs?: number
  /** Optional file that receives every stderr line. */
  logFile?: string
}

const STDERR_TAIL_LIMIT = 16_384
const LINE_LIMIT = 8 * 1024 * 1024

export type RuntimeState = 'idle' | 'starting' | 'ready' | 'stopped' | 'failed'

/**
 * Owns the connection to one runtime process. Instances are cheap; a workspace
 * folder keeps exactly one and restarts it on demand.
 */
export class HarnessRuntime {
  readonly #options: RuntimeOptions
  #child: ChildProcessWithoutNullStreams | undefined
  #transport: LineTransport | undefined
  #starting: Promise<InitializeResult> | undefined
  #stdoutBuffer = ''
  #stderrTail = ''
  #state: RuntimeState = 'idle'
  #intentionalStop = false
  #disposed = false
  #serverInfo: InitializeResult['serverInfo'] | undefined

  constructor(options: RuntimeOptions) {
    this.#options = options
  }

  get state(): RuntimeState {
    return this.#state
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  get serverInfo(): InitializeResult['serverInfo'] | undefined {
    return this.#serverInfo
  }

  /** Bounded stderr history, newest last. */
  get stderrTail(): string {
    return this.#stderrTail
  }

  /**
   * Start the process and complete the handshake. Concurrent callers share one
   * in-flight start; a failed start is retried by the next caller.
   */
  async start(): Promise<InitializeResult> {
    if (this.#disposed) throw new Error('harness runtime has been disposed')
    if (this.#starting) return this.#starting
    this.#state = 'starting'
    this.#intentionalStop = false
    const starting = this.#spawnAndInitialize()
    this.#starting = starting
    try {
      return await starting
    } catch (error) {
      // Drop the failed attempt so a later call can try again with a fresh process.
      if (this.#starting === starting) this.#starting = undefined
      this.#state = 'failed'
      throw error
    }
  }

  /** Queue one prompt. Resolves with the durable message id. */
  async prompt(sessionId: string, contentBlocks: PromptContentBlock[], timeoutMs = 60_000): Promise<string> {
    await this.start()
    const transport = this.#transport
    if (!transport) throw new Error('harness runtime is not connected')
    const result = (await transport.request('session/prompt', { sessionId, contentBlocks }, timeoutMs)) as {
      messageId?: unknown
    }
    return typeof result?.messageId === 'string' ? result.messageId : ''
  }

  /**
   * Stop the current process. The SDK protocol offers no cancel, and a session
   * log is durable up to the last committed event, so interruption is a
   * restart rather than a wire request.
   */
  async interrupt(reason = 'interrupted by the user'): Promise<void> {
    const child = this.#child
    if (!child) return
    this.#intentionalStop = true
    this.#options.callbacks?.onDiagnostic?.(`runtime ${reason}; restarting on the next prompt`)
    child.kill('SIGTERM')
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolvePromise()
      }, 4000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
    this.#reset()
    this.#state = 'idle'
  }

  /** Graceful shutdown, then disposal. Idempotent. */
  async stop(): Promise<void> {
    const transport = this.#transport
    const child = this.#child
    if (transport && child && !transport.closed) {
      this.#intentionalStop = true
      try {
        await transport.request('shutdown', undefined, 1500)
      } catch {
        // Fall through to the kill ladder.
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolvePromise()
        }, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolvePromise()
        })
      })
    }
    this.#reset()
    this.#state = 'stopped'
  }

  /** Stop and refuse later use. */
  async dispose(): Promise<void> {
    await this.stop()
    this.#disposed = true
  }

  #reset(): void {
    this.#transport?.close(new Error('harness runtime was reset'))
    this.#transport = undefined
    this.#child = undefined
    this.#starting = undefined
    this.#stdoutBuffer = ''
  }

  async #spawnAndInitialize(): Promise<InitializeResult> {
    const { launch, callbacks, initializeTimeoutMs = 20_000, logFile } = this.#options
    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams

    this.#child = child
    this.#stderrTail = ''
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true })
        appendFileSync(logFile, `\n=== ${new Date().toISOString()} launch: ${launch.file} ${launch.args.join(' ')} (${launch.origin}) cwd=${launch.cwd} ===\n`)
      } catch {
        // Logging is best-effort.
      }
    }

    const sink: FrameSink = {
      write: (frame) => {
        callbacks?.onTrace?.(`--> ${frame.trimEnd()}`)
        child.stdin.write(frame)
      },
    }
    const transport = new LineTransport((frame) => sink.write(frame))
    this.#transport = transport
    transport.onNotification((method, params) => this.#dispatch(method, params))

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.#stdoutBuffer += chunk
      if (this.#stdoutBuffer.length > LINE_LIMIT) {
        callbacks?.onDiagnostic?.('runtime emitted an oversized frame; resetting the read buffer')
        this.#stdoutBuffer = ''
        return
      }
      let index = this.#stdoutBuffer.indexOf('\n')
      while (index >= 0) {
        const line = this.#stdoutBuffer.slice(0, index)
        this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1)
        callbacks?.onTrace?.(`<-- ${line}`)
        transport.accept(line, (bad, error) => {
          callbacks?.onTrace?.(`<-- unparseable frame (${error.message}): ${bad.slice(0, 400)}`)
        })
        index = this.#stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // A provider error body can echo a credential; redact before this text is
      // retained, written to disk, or shown.
      const safe = redactSecrets(chunk)
      this.#stderrTail = (this.#stderrTail + safe).slice(-STDERR_TAIL_LIMIT)
      if (logFile) {
        try {
          appendFileSync(logFile, safe)
        } catch {
          // Logging is best-effort.
        }
      }
      for (const line of safe.split('\n')) {
        if (line.trim().length > 0) callbacks?.onTrace?.(`[stderr] ${line}`)
      }
    })

    child.once('error', (error) => {
      const failure = new TransportClosedError(
        `could not launch the DeepSeek Harness runtime (${launch.origin}): ${error.message}`,
        null,
        null,
        this.#stderrTail,
      )
      transport.close(failure)
      callbacks?.onDiagnostic?.(failure.message)
    })

    child.once('exit', (code, signal) => {
      const expected = this.#intentionalStop || this.#disposed
      const stderrTail = this.#stderrTail
      this.#reset()
      this.#state = expected ? 'stopped' : 'failed'
      if (!expected) {
        transport.close(
          new TransportClosedError(
            `the DeepSeek Harness runtime exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`,
            code,
            signal,
            stderrTail,
          ),
        )
      }
      callbacks?.onExit?.({ code, signal, expected, stderrTail })
    })

    const handshake = (await transport.request('initialize', this.#options.initialize, initializeTimeoutMs)) as InitializeResult
    if (!handshake || typeof handshake !== 'object' || !handshake.serverInfo) {
      throw new Error('the runtime returned an unexpected initialize result')
    }
    this.#serverInfo = handshake.serverInfo
    this.#state = 'ready'
    return handshake
  }

  #dispatch(method: string, params: unknown): void {
    const callbacks = this.#options.callbacks
    switch (method) {
      case 'session.event':
        callbacks?.onSessionEvent?.(params as SessionEventNotification)
        return
      case 'session.status':
        callbacks?.onSessionStatus?.(params as SessionStatusNotification)
        return
      case 'subagent.started':
        callbacks?.onSubagentStarted?.(params as SubagentStartedNotification)
        return
      case 'subagent.finished':
        callbacks?.onSubagentFinished?.(params as SubagentFinishedNotification)
        return
      default:
        callbacks?.onTrace?.(`<-- unknown notification: ${method}`)
    }
  }
}

/** Prefix that marks a session created only to verify a model route. */
export const PROBE_SESSION_PREFIX = 'dsh-probe-'

export interface ProbeOptions {
  /**
   * `turn` (the default) — send one minimal prompt and require the turn to
   * complete.
   * `handshake` — only start a runtime and complete `initialize`.
   *
   * `turn` is the honest check for a *model*: the handshake accepts any model id
   * and only validates that an adapter exists for the provider, so a route can
   * pass `initialize` and still fail on its first request. A probe turn is
   * capped to a few output tokens to keep the cost negligible.
   */
  mode?: 'handshake' | 'turn'
  /** Output cap for a probe turn. Defaults to 64 tokens. */
  probeMaxTokens?: number
  /** Bound on the probe turn. Defaults to 120 seconds. */
  turnTimeoutMs?: number
}

/**
 * Ask a runtime whether it can serve a route, and say exactly what was proven.
 *
 * The detail string always names the level that was reached, so a caller can
 * never present a handshake as an answered request.
 */
export async function probeRoute(
  launch: LaunchSpec,
  initialize: InitializeParams,
  options: ProbeOptions = {},
): Promise<{ ok: boolean; detail: string }> {
  const mode = options.mode ?? 'turn'
  const probeMaxTokens = options.probeMaxTokens ?? 64
  const sessionId = `${PROBE_SESSION_PREFIX}${randomUUID()}`
  let turnReason: string | undefined
  let turnError: string | undefined
  let sawAssistant = false
  let markIdle: (() => void) | undefined

  const runtime = new HarnessRuntime({
    launch,
    initialize: mode === 'turn' ? { ...initialize, maxTokens: probeMaxTokens } : initialize,
    initializeTimeoutMs: 25_000,
    callbacks: {
      onSessionEvent: (notification) => {
        if (notification.sessionId !== sessionId) return
        const event = notification.event
        if (event.type === 'assistant/message') sawAssistant = true
        if (event.type === 'turn/end') {
          const reason = (event.data as { reason?: { kind?: string; error?: unknown } } | undefined)?.reason
          turnReason = reason?.kind
          if (reason?.kind === 'error') turnError = JSON.stringify(reason.error ?? reason).slice(0, 400)
        }
      },
      onSessionStatus: (notification) => {
        if (notification.sessionId === sessionId && notification.status === 'idle') markIdle?.()
      },
    },
  })

  try {
    const result = await runtime.start()
    if (mode === 'handshake') {
      return { ok: true, detail: `provider route accepted by ${result.serverInfo.name} ${result.serverInfo.version}` }
    }

    const idle = new Promise<void>((resolve) => {
      markIdle = resolve
    })
    await runtime.prompt(sessionId, [{ type: 'text', text: 'Reply with the single word: ok' }], 30_000)
    const completed = await Promise.race([
      idle.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), options.turnTimeoutMs ?? 120_000)),
    ])
    if (!completed) return { ok: false, detail: 'the model did not answer within the probe timeout' }
    if (turnReason === 'completed' && !turnError) {
      return {
        ok: true,
        detail: `answered a ${probeMaxTokens}-token probe request${sawAssistant ? '' : ' (no assistant text)'}`,
      }
    }
    return {
      ok: false,
      detail: turnError ?? `the probe turn ended with ${turnReason ?? 'no turn/end event'}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      detail: mode === 'turn' ? `could not start a probe turn: ${message}` : `initialize failed: ${message}`,
    }
  } finally {
    await runtime.dispose()
  }
}

export { ResponseError, TransportClosedError }
