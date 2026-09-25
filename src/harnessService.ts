/**
 * The per-repository harness service.
 *
 * One instance owns one workspace folder: its runtime child process, the
 * active chat session, the transcript reducer, and the repository's stored
 * history. Both chat surfaces — the sidebar view and the `@dsh` chat
 * participant — drive this service, so a conversation started in one continues
 * in the other and the repository always holds the result.
 *
 * A session is created lazily on the first prompt. Its DSH session id is the
 * extension's own identifier, which is what lets a reopened repository resume
 * the same conversation after a restart.
 */

import { randomUUID } from 'node:crypto'
import type { Disposable, WorkspaceFolder } from 'vscode'
import { readSettings, type DshSettings } from './config'
import { findNode, findTooOldNode, MIN_NODE, resolveLaunch } from './dsh/locate'
import {
  HarnessRuntime,
  probeRoute as probeLaunch,
  PROBE_SESSION_PREFIX,
  type LaunchSpec,
  type RuntimeState,
} from './dsh/runtime'
import {
  activityKey,
  buildTranscriptDigest,
  CONTINUATION_SEED_LIMIT,
  describeActivity,
  TranscriptReducer,
  type AgentActivity,
  type ChatItem,
  type TranscriptMutation,
} from './dsh/transcript'
import {
  ensureGitExcluded,
  ensureGitIgnored,
  pruneProbeArtifacts,
  hasHarnessData,
  moveDataDirectory,
  resolveLayout,
  writeRuntimePatch,
  type RepoDataLayout,
  type StorageLocation,
} from './dsh/workspace'
import type { PromptContentBlock, SessionEvent, Usage } from './dsh/wire'
import { log, reportError, trace } from './log'
import { SessionStore, type SessionSummary } from './sessionStore'
import { revealSlices } from './reveal'
import { quoteCommand } from './shell'

export interface SendImage {
  /** Canonical base64 bytes. */
  data: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  name?: string
}

export interface SendInput {
  /** Text the user wrote, shown verbatim in the transcript. */
  text: string
  /** Extra context prepended for the model but summarized in the transcript. */
  context?: string
  /** Short label for the context, shown as a chip. */
  contextLabel?: string
  images?: SendImage[]
}

export interface SessionSnapshot {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  items: ChatItem[]
  running: boolean
  /** True when the transcript came from the repository rather than this window. */
  restored: boolean
  /** Cumulative token use across the restored transcript. */
  usage: Usage
  /** What the agent is doing right now. */
  activity: AgentActivity
  /** One-line rendering of {@link activity}; empty when idle. */
  activityLabel: string
}

export type ServiceEvent =
  | { type: 'mutations'; sessionId: string; mutations: TranscriptMutation[] }
  | { type: 'activity'; sessionId: string; activity: AgentActivity; label: string }
  | { type: 'status'; sessionId: string; running: boolean }
  | { type: 'session'; session: SessionSnapshot }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'title'; sessionId: string; title: string }
  | { type: 'runtime'; state: RuntimeState; detail: string }

type Listener = (event: ServiceEvent) => void

/** Delay between cosmetic reveal slices, in milliseconds. */
const REVEAL_INTERVAL_MS = 24

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }

function addUsage(total: Usage, delta: Usage | undefined): Usage {
  if (!delta) return total
  return {
    inputTokens: total.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: total.outputTokens + (delta.outputTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (delta.cacheReadTokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (delta.cacheWriteTokens ?? 0),
    totalTokens: total.totalTokens + (delta.totalTokens ?? 0),
  }
}

function deriveTitle(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 60)}…` : line || 'New session'
}

interface ActiveSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  restored: boolean
}

export class HarnessService implements Disposable {
  readonly #folder: WorkspaceFolder
  readonly #store: SessionStore
  readonly #listeners = new Set<Listener>()
  #settings: DshSettings
  #layout: RepoDataLayout
  #reducer: TranscriptReducer
  #runtime: HarnessRuntime | undefined
  #session: ActiveSession
  #running = new Set<string>()
  #usage = new Map<string, Usage>()
  #saveTimer: NodeJS.Timeout | undefined
  #disposed = false
  #lastRuntimeDetail = 'not started'
  /**
   * Counting of runtime processes. A conversation may only reuse its DSH
   * session id inside one process generation, because the SDK server refuses a
   * session id that already exists on disk and the protocol exposes no resume
   * request.
   */
  #generation = 0
  /** DSH session id per conversation, tagged with the generation that created it. */
  #liveSessions = new Map<string, { id: string; generation: number }>()
  /** Conversations whose earlier turns must be handed to a fresh runtime. */
  #needsSeed = new Set<string>()
  /** Pending cosmetic reveal timers, keyed by assistant item id. */
  #reveals = new Map<string, NodeJS.Timeout>()
  /** Last published activity, so only real changes reach the views. */
  #activityKey = 'idle'
  /** What the runtime reported for the last request on the active session. */
  #resolvedRoute: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number; contextWindow?: number } | undefined

  constructor(folder: WorkspaceFolder) {
    this.#folder = folder
    this.#settings = readSettings(folder)
    this.#layout = this.#resolveLayout()
    this.#store = new SessionStore(this.#layout)
    const sessionId = randomUUID()
    this.#reducer = this.#createReducer(sessionId)
    this.#session = {
      id: sessionId,
      title: 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      restored: false,
    }
  }

  get folder(): WorkspaceFolder {
    return this.#folder
  }

  get settings(): DshSettings {
    return this.#settings
  }

  get layout(): RepoDataLayout {
    return this.#layout
  }

  get dataDir(): string {
    return this.#layout.root
  }

  get runtimeState(): RuntimeState {
    return this.#runtime?.state ?? 'idle'
  }

  get runtimeDetail(): string {
    return this.#lastRuntimeDetail
  }

  get sessions(): SessionSummary[] {
    return this.#store.list()
  }

  /** Snapshot for a UI that just mounted. */
  snapshot(): SessionSnapshot {
    return {
      id: this.#session.id,
      title: this.#session.title,
      createdAt: this.#session.createdAt,
      updatedAt: this.#session.updatedAt,
      items: [...this.#reducer.items],
      running: this.#running.has(this.#session.id),
      restored: this.#session.restored,
      usage: this.#usage.get(this.#session.id) ?? EMPTY_USAGE,
      activity: this.#reducer.activity,
      activityLabel: describeActivity(this.#reducer.activity),
    }
  }

  onEvent(listener: Listener): Disposable {
    this.#listeners.add(listener)
    return { dispose: () => this.#listeners.delete(listener) }
  }

  async initialize(autoStart: boolean): Promise<void> {
    const stored = this.#store.list()
    if (stored.length > 0 && stored[0]) {
      await this.openSession(stored[0].id)
    } else {
      this.#emit({ type: 'sessions', sessions: [] })
      this.#emit({ type: 'session', session: this.snapshot() })
    }
    if (autoStart) {
      try {
        await this.ensureRuntime()
      } catch (error) {
        // The runtime reports its own failure; activation still completes so
        // the user can fix settings and retry from the chat view.
        reportError('could not start the harness runtime', error)
      }
    }
  }

  /** Start (or restart) the runtime and return it. */
  async ensureRuntime(): Promise<HarnessRuntime> {
    if (this.#disposed) throw new Error('the service has been disposed')
    if (this.#runtime && (this.#runtime.state === 'ready' || this.#runtime.state === 'starting')) return this.#runtime
    this.#settings = readSettings(this.#folder)
    this.#layout = this.#resolveLayout()
    const launch = this.#launchSpec()
    const runtime = new HarnessRuntime({
      launch,
      initialize: {
        cwd: this.#folder.uri.fsPath,
        provider: this.#settings.provider,
        model: this.#settings.model,
        ...(this.#settings.reasoningEffort.length > 0 ? { reasoningEffort: this.#settings.reasoningEffort } : {}),
        ...(this.#settings.maxTokens > 0 ? { maxTokens: this.#settings.maxTokens } : {}),
      },
      callbacks: {
        onSessionEvent: (notification) => this.#onSessionEvent(notification.sessionId, notification.event),
        onSessionStatus: (notification) => this.#onSessionStatus(notification.sessionId, notification.status),
        onSubagentStarted: (notification) => {
          if (notification.parentSessionId !== this.#session.id) return
          const mutations = this.#reducer.applySubagentStarted({ childSessionId: notification.childSessionId })
          this.#afterMutations(mutations)
          this.#publishActivity()
        },
        onSubagentFinished: (notification) => {
          if (notification.parentSessionId !== this.#session.id) return
          const mutations = this.#reducer.applySubagentFinished({
            childSessionId: notification.childSessionId,
            provider: notification.provider,
            status: notification.status,
            ...(notification.lastAssistantMessage ? { lastAssistantMessage: notification.lastAssistantMessage } : {}),
          })
          this.#afterMutations(mutations)
          this.#publishActivity()
        },
        onExit: (info) => {
          if (info.expected) return
          const detail = info.stderrTail.trim().slice(-1200)
          this.#lastRuntimeDetail = `exited with code ${info.code ?? 'null'}${detail ? `: ${detail}` : ''}`
          log(`runtime exited unexpectedly (code ${info.code}, signal ${info.signal})\n${detail}`)
          this.#clearActivity()
          this.#running.clear()
          const mutations = this.#reducer.failRunningTools(
            `The runtime exited before this tool finished (exit code ${info.code ?? 'null'}).`,
          )
          mutations.push(this.#reducer.notice('error', `The DeepSeek Harness runtime exited unexpectedly. Run "DSH: Show Diagnostics" for the log.`))
          this.#afterMutations(mutations)
          this.#emit({ type: 'status', sessionId: this.#session.id, running: false })
          this.#emit({ type: 'runtime', state: 'failed', detail: this.#lastRuntimeDetail })
          void this.#saveNow()
        },
        onDiagnostic: (message) => log(`runtime: ${message}`),
        onTrace: (line) => trace(this.#settings.trace, line),
      },
      logFile: this.#layout.logFile,
    })
    this.#runtime = runtime
    this.#generation += 1
    this.#emit({ type: 'runtime', state: 'starting', detail: launch.origin })
    const result = await runtime.start()
    this.#lastRuntimeDetail = `${launch.origin} · ${result.serverInfo.name} ${result.serverInfo.version}`
    log(`runtime ready: ${this.#lastRuntimeDetail} (pid ${runtime.pid ?? 'unknown'}, cwd ${launch.cwd})`)
    this.#emit({ type: 'runtime', state: 'ready', detail: this.#lastRuntimeDetail })
    return runtime
  }

  /** Resolve the data directory and keep its Git protections up to date. */
  #resolveLayout(): RepoDataLayout {
    const layout = resolveLayout({
      workspaceRoot: this.#folder.uri.fsPath,
      location: this.#settings.storageLocation,
      dataDir: this.#settings.dataDir,
      userPatch: this.#settings.userPatch,
      dshHome: this.#settings.dshHome,
    })
    if (layout.location === 'repository') {
      ensureGitIgnored(layout)
      ensureGitExcluded(this.#folder.uri.fsPath, layout)
    }
    return layout
  }

  /**
   * Data left in the working tree by an earlier version, which the default
   * `global` location no longer uses. The caller offers to move it.
   */
  legacyRepositoryDataDir(): string | undefined {
    if (this.#settings.storageLocation === 'repository') return undefined
    const candidate = resolveLayout({
      workspaceRoot: this.#folder.uri.fsPath,
      location: 'repository',
      dataDir: this.#settings.dataDir,
      userPatch: this.#settings.userPatch,
      dshHome: this.#settings.dshHome,
    })
    if (candidate.root === this.#layout.root) return undefined
    return hasHarnessData(candidate.root) ? candidate.root : undefined
  }

  /**
   * Move this repository's data to another storage location and switch to it.
   * The runtime is stopped first; existing sessions and history move with it.
   */
  async relocate(
    location: StorageLocation,
    dataDir?: string,
  ): Promise<{ moved: boolean; reason?: string; from: string; to: string; location: StorageLocation }> {
    const settings = readSettings(this.#folder)
    const target = resolveLayout({
      workspaceRoot: this.#folder.uri.fsPath,
      location,
      dataDir: dataDir ?? settings.dataDir,
      userPatch: settings.userPatch,
      dshHome: settings.dshHome,
    })
    const from = this.#layout.root
    await this.#saveNow()
    const runtime = this.#runtime
    this.#runtime = undefined
    if (runtime) await runtime.dispose()
    this.#cancelReveals()
    this.#running.clear()

    const result = moveDataDirectory(from, target.root)
    this.#settings = { ...settings, storageLocation: location, ...(dataDir === undefined ? {} : { dataDir }) }
    this.#liveSessions.clear()
    this.#needsSeed.clear()
    this.#layout = this.#resolveLayout()
    log(
      `storage for ${this.#folder.name}: ${from} -> ${this.#layout.root} (${result.moved ? 'moved' : result.reason ?? 'not moved'})`,
    )
    this.#emit({ type: 'runtime', state: 'idle', detail: `${this.#layout.origin}: ${this.#layout.root}` })
    this.#emit({ type: 'session', session: this.snapshot() })
    await this.ensureRuntime()
    return { ...result, from, to: this.#layout.root, location: this.#layout.location }
  }

  /**
   * The launch command for a probe: same runtime, same repository patch, so a
   * probed route is validated under exactly the conditions a real turn uses.
   */
  launchSpec(): LaunchSpec {
    return this.#launchSpec()
  }

  /**
   * Route the runtime actually resolved, read from the session's own
   * `request/header` and `request/context` events. `undefined` until a turn has
   * run, and never guessed from settings.
   */
  get resolvedRoute(): { provider: string; model: string; reasoningEffort?: string; maxTokens?: number; contextWindow?: number } | undefined {
    return this.#resolvedRoute
  }

  #launchSpec(): LaunchSpec {
    const settings = this.#settings
    const probe = resolveLaunch({
      workspaceRoot: this.#folder.uri.fsPath,
      dshPath: settings.dshPath,
      dshCheckout: settings.dshCheckout,
      dshNode: settings.dshNode,
    })
    const patchFile = writeRuntimePatch(this.#layout)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_PERMISSION_MODE: settings.permissionMode,
      FORCE_COLOR: '0',
    }
    if (settings.dshHome.length > 0) env.DSH_HOME = settings.dshHome
    return {
      file: probe.file,
      args: [...probe.args, '--profile', 'sdk', '--patch', patchFile, ...settings.extraArgs],
      cwd: this.#folder.uri.fsPath,
      env,
      origin: probe.origin,
    }
  }

  #createReducer(sessionId: string): TranscriptReducer {
    return new TranscriptReducer({
      sessionId,
      showReasoning: this.#settings.showReasoning,
    })
  }

  /**
   * Shell command that boots a `dsh` profile against this repository's patch,
   * for the terminal surfaces (web UI, one-shot tasks).
   *
   * Launcher flags must precede app arguments, so every caller passes only the
   * profile's own arguments.
   */
  profileCommand(profile: string, appArgs: readonly string[] = []): string {
    const settings = this.#settings
    const probe = resolveLaunch({
      workspaceRoot: this.#folder.uri.fsPath,
      dshPath: settings.dshPath,
      dshCheckout: settings.dshCheckout,
      dshNode: settings.dshNode,
    })
    const patchFile = writeRuntimePatch(this.#layout)
    return quoteCommand([probe.file, ...probe.args, '--profile', profile, '--patch', patchFile, ...settings.extraArgs, ...appArgs])
  }

  /** The full DSH web UI, sharing this repository's session root. */
  webUiLaunch(port: number, trustedHosts: readonly string[] = []): { command: string; port: number } {
    const appArgs = ['--no-open', '--port', String(port)]
    for (const host of trustedHosts) appArgs.push('--trusted-host', host)
    return { command: this.profileCommand('web', appArgs), port }
  }

  /** A one-shot headless task in this repository. */
  headlessLaunch(task: string): { command: string } {
    return { command: this.profileCommand('headless', [task]) }
  }

  /**
   * The DSH session id to prompt on for the active conversation.
   *
   * A conversation keeps its id while one runtime process serves it, so the
   * repository's session logs line up with the chat list. Once the process is
   * replaced the id can no longer be reused (the SDK server rejects an id whose
   * session already exists on disk), so a conversation that has already
   * produced items continues on a fresh id and receives
   * {@link #continuationSeed} with its next prompt.
   */
  #ensureLiveSession(): string {
    const conversationId = this.#session.id
    const existing = this.#liveSessions.get(conversationId)
    if (existing && existing.generation === this.#generation) return existing.id

    const stored = this.#store.load(conversationId)
    const alreadyMaterialized = existing !== undefined || (stored?.items.length ?? 0) > 0
    const id = alreadyMaterialized ? randomUUID() : conversationId
    this.#liveSessions.set(conversationId, { id, generation: this.#generation })
    if (alreadyMaterialized) this.#needsSeed.add(conversationId)
    log(`conversation ${conversationId} continues on DSH session ${id} (generation ${this.#generation})`)
    return id
  }

  /**
   * The one-shot context that carries a conversation across a runtime restart.
   *
   * It is a bounded digest of the stored transcript rather than the transcript
   * itself: enough for the model to continue coherently without paying for the
   * whole history on every restart. Returns `undefined` when this generation
   * already received it or the conversation is empty.
   */
  #continuationSeed(): string | undefined {
    if (!this.#needsSeed.delete(this.#session.id)) return undefined
    const digest = buildTranscriptDigest(this.#reducer.items, CONTINUATION_SEED_LIMIT)
    if (!digest) return undefined
    return [
      'The earlier turns of this conversation were recorded before this runtime started.',
      `They are stored in this repository (conversation ${this.#session.id}); use the repository files if you need full detail.`,
      'Continue from this summary and do not repeat completed work.',
      '',
      digest,
    ].join('\n')
  }

  /** Start a fresh DSH session for this repository. */
  async newSession(): Promise<SessionSnapshot> {
    await this.#saveNow()
    this.#cancelReveals()
    this.#clearActivity()
    const id = randomUUID()
    this.#reducer = this.#createReducer(id)
    this.#session = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), restored: false }
    this.#running.delete(id)
    this.#emit({ type: 'session', session: this.snapshot() })
    return this.snapshot()
  }

  /** Load a stored session and, when its id matches, continue it. */
  async openSession(id: string): Promise<SessionSnapshot> {
    await this.#saveNow()
    this.#cancelReveals()
    this.#clearActivity()
    const stored = this.#store.load(id)
    const existing = this.#store.list().find((entry) => entry.id === id)
    if (!stored && !existing) {
      throw new Error(`no session named ${id} in this repository`)
    }
    this.#reducer = this.#createReducer(id)
    if (stored) {
      this.#reducer.replaceAll(stored.items)
      this.#reducer.replaceTitle(stored.title)
    }
    this.#session = {
      id,
      title: stored?.title ?? existing?.title ?? 'Session',
      createdAt: stored?.createdAt ?? existing?.createdAt ?? Date.now(),
      updatedAt: stored?.updatedAt ?? existing?.updatedAt ?? Date.now(),
      restored: true,
    }
    this.#usage.set(id, computeUsage(stored?.items ?? []))
    this.#emit({ type: 'session', session: this.snapshot() })
    return this.snapshot()
  }

  async deleteSession(id: string): Promise<void> {
    this.#store.delete(id)
    this.#usage.delete(id)
    this.#emit({ type: 'sessions', sessions: this.#store.list() })
    if (id === this.#session.id) await this.newSession()
  }

  /**
   * Send one user turn. The runtime queues prompts, so a second send while a
   * turn is running steers the running turn instead of failing.
   */
  async send(input: SendInput): Promise<void> {
    const text = input.text
    const images = input.images ?? []
    if (text.trim().length === 0 && images.length === 0) return

    const sessionId = this.#session.id
    if (this.#session.title === 'New session' && text.trim().length > 0) {
      this.#session.title = deriveTitle(text)
      this.#emit({ type: 'title', sessionId, title: this.#session.title })
    }

    const contextLabel = input.contextLabel ?? (input.context ? 'editor context' : '')
    const displayText = text.trim().length > 0 ? text : `[${images.length} image${images.length === 1 ? '' : 's'}]`
    const mutations = [this.#reducer.echoUser(displayText, contextLabel, images.length)]
    this.#afterMutations(mutations)

    const blocks: PromptContentBlock[] = []
    const seed = this.#continuationSeed()
    if (seed) {
      blocks.push({ type: 'text', text: `${seed}\n\n---\n\n` })
      this.#afterMutations([
        this.#reducer.notice('info', 'Continued from the session saved in this repository: the earlier turns were handed to a fresh runtime.'),
      ])
    }
    if (input.context && input.context.trim().length > 0) {
      blocks.push({ type: 'text', text: `${input.context.trim()}\n\n---\n\n` })
    }
    if (text.trim().length > 0) blocks.push({ type: 'text', text })
    for (const image of images) {
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType })
    }

    try {
      const runtime = await this.ensureRuntime()
      const liveSessionId = this.#ensureLiveSession()
      const messageId = await runtime.prompt(liveSessionId, blocks)
      log(`queued prompt on DSH session ${liveSessionId} for conversation ${sessionId} (message ${messageId || 'unknown'})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = this.#reducer.notice('error', `The prompt could not be delivered: ${message}`)
      this.#afterMutations([failure])
      this.#emit({ type: 'status', sessionId, running: false })
      reportError('the prompt could not be delivered', error)
      return
    }
    this.#running.add(sessionId)
    this.#emit({ type: 'status', sessionId, running: true })
    void this.#saveNow()
  }

  /** Stop the running turn by restarting the runtime. */
  async stop(): Promise<void> {
    if (!this.#runtime) return
    const sessionId = this.#session.id
    await this.#runtime.interrupt('stopped by the user')
    this.#cancelReveals()
    this.#running.clear()
    this.#clearActivity()
    const mutations = this.#reducer.failRunningTools('The turn was stopped before this tool finished.')
    mutations.push(this.#reducer.notice('warn', 'Stopped. The session is saved in this repository; send another message to continue it.'))
    this.#afterMutations(mutations)
    this.#emit({ type: 'status', sessionId, running: false })
    this.#emit({ type: 'runtime', state: 'idle', detail: this.#lastRuntimeDetail })
    await this.#saveNow()
  }

  /** Recreate the runtime child, for example after credentials changed. */
  async restart(): Promise<void> {
    if (this.#runtime) {
      await this.#runtime.dispose()
      this.#runtime = undefined
    }
    this.#running.clear()
    this.#clearActivity()
    this.#emit({ type: 'status', sessionId: this.#session.id, running: false })
    await this.ensureRuntime()
  }

  /** Summary line for diagnostics and the status bar tooltip. */
  describe(): string {
    const node = findNode(this.#settings.dshNode)
    const tooOld = findTooOldNode()
    const nodeLine = node
      ? `${node.version} (${node.file})`
      : tooOld
        ? `none satisfying >=${MIN_NODE.join('.')}; found ${tooOld.version} (${tooOld.file})`
        : `extension host runtime (${process.execPath})`
    return [
      `repository: ${this.#folder.uri.fsPath}`,
      `data directory: ${this.#layout.root} (${this.#layout.location}: ${this.#layout.origin})`,
      `runtime: ${this.#lastRuntimeDetail}`,
      `state: ${this.runtimeState}`,
      `provider/model: ${this.#settings.provider}/${this.#settings.model}`,
      `permission mode: ${this.#settings.permissionMode}`,
      `DSH_HOME: ${this.#settings.dshHome || process.env.DSH_HOME || '~/.dsh'}`,
      `node: ${nodeLine}`,
      `sessions stored: ${this.sessions.length}`,
      `current session: ${this.#session.id}`,
      this.#resolvedRoute
        ? `resolved route: ${this.#resolvedRoute.provider}/${this.#resolvedRoute.model}` +
          `${this.#resolvedRoute.reasoningEffort ? ` · effort ${this.#resolvedRoute.reasoningEffort}` : ''}` +
          `${this.#resolvedRoute.maxTokens ? ` · cap ${this.#resolvedRoute.maxTokens}` : ''}` +
          `${this.#resolvedRoute.contextWindow ? ` · context ${this.#resolvedRoute.contextWindow}` : ''}`
        : 'resolved route: not reported yet (no turn has run)',
      'credentials: resolved by the harness from $DSH_HOME/.credentials.yaml or the environment; this extension stores no key',
    ].join('\n')
  }

  #onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (sessionId !== this.#session.id) return
    this.#trackRoute(event)
    const mutations = this.#reducer.apply(event)
    this.#publishActivity()
    if (event.type === 'session/title') {
      const title = this.#reducer.title
      if (title && title !== this.#session.title) {
        this.#session.title = title
        this.#emit({ type: 'title', sessionId, title })
      }
    }
    if (mutations.length > 0) this.#afterMutations(mutations)
  }

  /** Emit the activity line when it actually changed. */
  #publishActivity(): void {
    const activity = this.#reducer.activity
    const key = activityKey(activity)
    if (key === this.#activityKey) return
    this.#activityKey = key
    this.#emit({ type: 'activity', sessionId: this.#session.id, activity, label: describeActivity(activity) })
  }

  /** Clear the activity line after a stop, an exit, or a session switch. */
  #clearActivity(): void {
    this.#reducer.resetActivity()
    this.#publishActivity()
  }

  /** Fold the runtime's own request description into {@link resolvedRoute}. */
  #trackRoute(event: SessionEvent): void {
    if (event.type === 'request/header') {
      const header = (event.data as { header?: { config?: Record<string, unknown> } } | undefined)?.header
      const config = header?.config
      if (!config) return
      const provider = typeof config.provider === 'string' ? config.provider : this.#settings.provider
      const model = typeof config.model === 'string' ? config.model : this.#settings.model
      const reasoningEffort = typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined
      const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : undefined
      this.#resolvedRoute = {
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(this.#resolvedRoute?.contextWindow ? { contextWindow: this.#resolvedRoute.contextWindow } : {}),
      }
      return
    }
    if (event.type === 'request/context') {
      const data = event.data as { contextWindow?: unknown } | undefined
      const contextWindow = typeof data?.contextWindow === 'number' ? data.contextWindow : undefined
      if (!contextWindow) return
      this.#resolvedRoute = {
        provider: this.#resolvedRoute?.provider ?? this.#settings.provider,
        model: this.#resolvedRoute?.model ?? this.#settings.model,
        ...(this.#resolvedRoute?.reasoningEffort ? { reasoningEffort: this.#resolvedRoute.reasoningEffort } : {}),
        ...(this.#resolvedRoute?.maxTokens ? { maxTokens: this.#resolvedRoute.maxTokens } : {}),
        contextWindow,
      }
    }
  }

  /**
   * Ask the runtime whether it can serve a route, by sending one minimal turn.
   *
   * The handshake alone is not enough: it accepts any model id and only checks
   * that an adapter exists for the provider, so a route can initialize cleanly
   * and still fail its first request. The probe therefore runs a real turn with
   * a 64-token output cap, and its session artifacts are removed afterwards.
   */
  async probeRoute(route: {
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<{ ok: boolean; detail: string }> {
    return probeLaunch(
      this.#launchSpec(),
      {
        cwd: this.#folder.uri.fsPath,
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort && route.reasoningEffort.length > 0 ? { reasoningEffort: route.reasoningEffort } : {}),
        ...(this.#settings.maxTokens > 0 ? { maxTokens: this.#settings.maxTokens } : {}),
      },
      { mode: 'turn', probeMaxTokens: 64, turnTimeoutMs: 120_000 },
    ).finally(() => {
      // A probe turn is a real session; remove the artifacts it left behind so
      // verifying a model never litters the repository's store.
      const removed = pruneProbeArtifacts(this.#layout.root, PROBE_SESSION_PREFIX)
      if (removed > 0) log(`removed ${removed} probe artifact(s) from ${this.#layout.root}`)
    })
  }

  #onSessionStatus(sessionId: string, status: 'idle' | 'running'): void {
    if (sessionId !== this.#session.id) {
      if (status === 'idle') this.#running.delete(sessionId)
      return
    }
    if (status === 'running') {
      this.#running.add(sessionId)
      this.#emit({ type: 'status', sessionId, running: true })
      return
    }
    this.#running.delete(sessionId)
    this.#emit({ type: 'status', sessionId, running: false })
    // Idle is the durable boundary: persist immediately so a crash cannot lose
    // a finished turn.
    void this.#saveNow()
  }

  #afterMutations(mutations: readonly TranscriptMutation[]): void {
    const added = mutations.filter((mutation) => mutation.op === 'append').map((mutation) => (mutation as { item: ChatItem }).item)
    for (const item of added) {
      if (item.kind === 'assistant' && item.usage) {
        this.#usage.set(this.#session.id, addUsage(this.#usage.get(this.#session.id) ?? EMPTY_USAGE, item.usage))
      }
    }
    this.#session.updatedAt = Date.now()
    this.#emit({ type: 'mutations', sessionId: this.#session.id, mutations: [...mutations] })
    for (const item of added) {
      if (item.kind === 'assistant') this.#revealProgressively(item)
    }
    this.#scheduleSave()
  }

  /**
   * Optional cosmetic reveal of a committed answer.
   *
   * The SDK wire delivers a message only after its step commits, so there are
   * no live deltas to forward. When `dshVscode.animateChunks` is on, the host
   * (not the webview) walks the finished text out in slices, so the persisted
   * transcript and the chat participant always hold the complete message and
   * only the sidebar rendering is animated.
   */
  #revealProgressively(item: Extract<ChatItem, { kind: 'assistant' }>): void {
    if (!this.#settings.animateChunks) return
    const slices = revealSlices(item.text)
    if (slices.length === 0) return
    const sessionId = this.#session.id
    let index = 0
    const tick = (): void => {
      this.#reveals.delete(item.id)
      if (this.#disposed || sessionId !== this.#session.id) return
      const text = slices[index]
      if (text === undefined) return
      this.#emit({ type: 'mutations', sessionId, mutations: [{ op: 'update', id: item.id, patch: { text } }] })
      index += 1
      if (index < slices.length) this.#reveals.set(item.id, setTimeout(tick, REVEAL_INTERVAL_MS))
    }
    this.#reveals.set(item.id, setTimeout(tick, REVEAL_INTERVAL_MS))
  }

  /** Drop pending reveal timers; the real text is already in the reducer. */
  #cancelReveals(): void {
    for (const timer of this.#reveals.values()) clearTimeout(timer)
    this.#reveals.clear()
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined
      void this.#saveNow()
    }, 800)
  }

  async #saveNow(): Promise<void> {
    if (this.#disposed) return
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = undefined
    }
    const items = [...this.#reducer.items]
    if (items.length === 0) return
    try {
      const summary = this.#store.save({
        version: 1,
        id: this.#session.id,
        title: this.#session.title,
        createdAt: this.#session.createdAt,
        updatedAt: this.#session.updatedAt,
        workspaceRoot: this.#folder.uri.fsPath,
        items,
      })
      log(`saved session ${summary.id} (${summary.itemCount} items) to ${this.#layout.extension}`)
      this.#emit({ type: 'sessions', sessions: this.#store.list() })
    } catch (error) {
      reportError('could not save the session', error)
    }
  }

  #emit(event: ServiceEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        log(`listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#cancelReveals()
    await this.#saveNow()
    this.#disposed = true
    this.#listeners.clear()
    const runtime = this.#runtime
    this.#runtime = undefined
    if (runtime) await runtime.dispose()
  }
}

function computeUsage(items: readonly ChatItem[]): Usage {
  let usage = EMPTY_USAGE
  for (const item of items) {
    if (item.kind === 'assistant' && item.usage) usage = addUsage(usage, item.usage)
  }
  return usage
}
