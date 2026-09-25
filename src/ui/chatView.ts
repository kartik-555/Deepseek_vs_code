/**
 * The sidebar chat view.
 *
 * One webview hosts the primary chat surface. It renders whatever the
 * repository's {@link HarnessService} reports and forwards user intent back,
 * so the view holds no state of its own beyond the DOM.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  commands,
  Uri,
  window,
  workspace,
  type Disposable,
  type Webview,
  type WebviewView,
  type WebviewViewProvider,
  type WebviewViewResolveContext,
} from 'vscode'
import { diffPath, openPath, openWebUi, revealDataDir, showDiagnostics } from '../actions'
import { activeEditorContext, pickFileContext, selectionContext } from '../editorContext'
import type { HarnessService, ServiceEvent, SessionSnapshot, SendImage } from '../harnessService'
import { log, reportError } from '../log'
import { selectModel } from '../modelPicker'
import { displayNameFor, formatContextWindow } from '../models'
import type { ServiceRegistry } from '../services'

interface InboundMessage {
  type: string
  payload?: unknown
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }

function emptySnapshot(): SessionSnapshot {
  return {
    id: 'no-folder',
    title: 'Open a repository folder',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: [],
    running: false,
    restored: false,
    usage: EMPTY_USAGE,
    activity: { kind: 'idle' },
    activityLabel: '',
  }
}

export class ChatView implements WebviewViewProvider, Disposable {
  readonly #extensionUri: Uri
  readonly #registry: ServiceRegistry
  #view: WebviewView | undefined
  #serviceSubscription: Disposable | undefined
  #activeSubscription: Disposable | undefined
  #ready = false
  #storageNoticeShown = false

  constructor(extensionUri: Uri, registry: ServiceRegistry) {
    this.#extensionUri = extensionUri
    this.#registry = registry
    this.#activeSubscription = registry.onDidChangeActive(() => {
      void this.#bindActive()
      this.#postBootstrap()
    })
  }

  resolveWebviewView(view: WebviewView, _context: WebviewViewResolveContext): void {
    this.#view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.#extensionUri, 'media')],
    }
    view.webview.html = this.#render(view.webview)
    view.webview.onDidReceiveMessage((message: InboundMessage) => {
      void this.#handle(message).catch((error: unknown) => reportError('the chat view could not handle that action', error))
    })
    view.onDidChangeVisibility(() => {
      if (view.visible && this.#ready) this.#postBootstrap()
    })
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#serviceSubscription?.dispose()
      this.#serviceSubscription = undefined
    })
    void this.#bindActive()
  }

  /** Public entry point for commands that pre-fill the composer. */
  insertText(text: string): void {
    if (!this.#ready) {
      this.#pendingInsert = text
      return
    }
    void this.#view?.webview.postMessage({ type: 'insertText', payload: { text } })
  }

  /** Show a transient message inside the view. */
  notice(level: 'info' | 'warn' | 'error', text: string): void {
    void this.#view?.webview.postMessage({ type: 'notice', payload: { level, text } })
  }

  /** Attach context to the composer, as the attach button inside the view does. */
  attachContext(label: string, detail: string): void {
    void this.#view?.webview.postMessage({ type: 'context', payload: { label, detail } })
  }

  #pendingInsert: string | undefined

  async #bindActive(): Promise<void> {
    const service = this.#registry.active
    this.#serviceSubscription?.dispose()
    this.#serviceSubscription = undefined
    if (!service) return
    this.#serviceSubscription = service.onEvent((event) => this.#forward(event))
  }

  #forward(event: ServiceEvent): void {
    const view = this.#view
    if (!view || !this.#ready) return
    switch (event.type) {
      case 'mutations':
        void view.webview.postMessage({ type: 'mutations', payload: { sessionId: event.sessionId, mutations: event.mutations } })
        return
      case 'status':
        void view.webview.postMessage({ type: 'status', payload: { sessionId: event.sessionId, running: event.running } })
        return
      case 'activity':
        void view.webview.postMessage({
          type: 'activity',
          payload: {
            sessionId: event.sessionId,
            label: event.label,
            kind: event.activity.kind,
            toolName: event.activity.kind === 'tool' ? event.activity.name : '',
          },
        })
        return
      case 'session':
        void view.webview.postMessage({ type: 'session', payload: { session: event.session } })
        return
      case 'sessions':
        void view.webview.postMessage({ type: 'sessions', payload: { sessions: event.sessions } })
        return
      case 'title':
        void view.webview.postMessage({ type: 'title', payload: { sessionId: event.sessionId, title: event.title } })
        // The session list carries titles too, so refresh it for the panel.
        void view.webview.postMessage({ type: 'sessions', payload: { sessions: this.#registry.active?.sessions ?? [] } })
        return
      case 'runtime':
        void view.webview.postMessage({ type: 'runtime', payload: { state: event.state, detail: event.detail } })
        return
      default:
        return
    }
  }

  #postBootstrap(): void {
    const view = this.#view
    if (!view || !this.#ready) return
    const service = this.#registry.active
    const folders = workspace.workspaceFolders ?? []
    void view.webview.postMessage({
      type: 'bootstrap',
      payload: {
        folderName: service?.folder.name ?? (folders.length === 0 ? 'no repository open' : 'unavailable'),
        folderPath: service?.folder.uri.fsPath ?? '',
        dataDir: service?.dataDir ?? '',
        storageLocation: service?.layout.location ?? 'global',
        storageOrigin: service?.layout.origin ?? '',
        multiRoot: folders.length > 1,
        runtime: {
          state: service?.runtimeState ?? 'idle',
          detail: service?.runtimeDetail ?? 'not started',
        },
        settings: {
          showReasoning: service?.settings.showReasoning ?? true,
          animateChunks: service?.settings.animateChunks ?? false,
          model: service?.settings.model ?? '',
          provider: service?.settings.provider ?? '',
          reasoningEffort: service?.settings.reasoningEffort ?? '',
          permissionMode: service?.settings.permissionMode ?? 'workspace-write',
        },
        resolvedRoute: describeRoute(service),
        sessions: service?.sessions ?? [],
        activity: service?.snapshot().activityLabel ?? '',
        session: service?.snapshot() ?? emptySnapshot(),
      },
    })
    // A repository-located store is the one layout a user can stumble into
    // without asking for it, so say where it is and how to move it.
    if (!this.#storageNoticeShown && service && service.layout.location === 'repository') {
      this.#storageNoticeShown = true
      this.notice(
        'info',
        `Sessions are stored in ${service.dataDir} and excluded from Git. Run "DSH: Change Session Storage Location" to move them out of the repository.`,
      )
    }

    const pending = this.#pendingInsert
    if (pending) {
      this.#pendingInsert = undefined
      this.insertText(pending)
    }
  }

  async #handle(message: InboundMessage): Promise<void> {
    const service = this.#registry.active
    switch (message.type) {
      case 'ready':
        this.#ready = true
        this.#postBootstrap()
        return
      case 'selectFolder': {
        const options = this.#registry.labels()
        if (options.length === 0) return
        const picked = await window.showQuickPick(options, {
          title: 'DeepSeek Harness: choose the repository for this chat',
          placeHolder: 'Sessions are stored inside the repository you pick',
        })
        if (!picked) return
        await this.#registry.use(picked.folder, { autoStart: true })
        await this.#bindActive()
        this.#postBootstrap()
        return
      }
      default:
        break
    }

    if (!service) {
      this.notice('warn', 'Open a repository folder before chatting with the harness.')
      return
    }

    switch (message.type) {
      case 'submit': {
        const payload = (message.payload ?? {}) as { text?: string; contextLabel?: string; images?: SendImage[] }
        await service.send({
          text: payload.text ?? '',
          ...(payload.contextLabel ? { contextLabel: payload.contextLabel } : {}),
          ...(payload.images && payload.images.length > 0 ? { images: payload.images } : {}),
        })
        return
      }
      case 'selectModel':
        // The picker writes the settings, restarts the runtime to validate the
        // route, and this re-post reflects whatever the runtime accepted.
        await selectModel(service, () => this.#postBootstrap())
        this.#postBootstrap()
        return
      case 'stop':
        await service.stop()
        return
      case 'newSession':
        await service.newSession()
        return
      case 'openSession': {
        const id = (message.payload as { id?: string } | undefined)?.id
        if (!id) return
        await service.openSession(id)
        return
      }
      case 'deleteSession': {
        const id = (message.payload as { id?: string } | undefined)?.id
        if (!id) return
        const summary = service.sessions.find((entry) => entry.id === id)
        const confirmed = await window.showWarningMessage(
          `Delete the DSH session "${summary?.title ?? id}" from this repository?`,
          { modal: true },
          'Delete',
        )
        if (confirmed !== 'Delete') return
        await service.deleteSession(id)
        return
      }
      case 'refreshSessions':
        await this.#view?.webview.postMessage({ type: 'sessions', payload: { sessions: service.sessions } })
        return
      case 'attachSelection': {
        const chunk = selectionContext() ?? activeEditorContext()
        if (!chunk) {
          this.notice('info', 'No active editor to take context from.')
          return
        }
        await this.#view?.webview.postMessage({ type: 'context', payload: { label: chunk.label, detail: chunk.text } })
        return
      }
      case 'pickFiles': {
        const chunks = await pickFileContext()
        if (chunks.length === 0) return
        await this.#view?.webview.postMessage({
          type: 'context',
          payload: {
            label: chunks.map((chunk) => chunk.label).join(', '),
            detail: chunks.map((chunk) => chunk.text).join('\n\n'),
          },
        })
        return
      }
      case 'openFile': {
        const path = (message.payload as { path?: string } | undefined)?.path
        if (path) await openPath(service, path)
        return
      }
      case 'openDiff': {
        const path = (message.payload as { path?: string } | undefined)?.path
        if (path) await diffPath(service, path)
        return
      }
      case 'revealDataDir':
        await revealDataDir(service)
        return
      case 'openWebUi':
        await openWebUi(service)
        return
      case 'restartRuntime':
        await service.restart()
        this.notice('info', 'The harness runtime was restarted.')
        return
      case 'showLogs':
        await showDiagnostics(this.#registry)
        return
      default:
        log(`chat view: ignoring unknown message type ${message.type}`)
    }
  }

  #render(webview: Webview): string {
    const media = Uri.joinPath(this.#extensionUri, 'media')
    const nonce = randomBytes(16).toString('base64')
    const body = this.#readAsset('chat.html')
    const styleUri = webview.asWebviewUri(Uri.joinPath(media, 'chat.css'))
    const scriptUri = webview.asWebviewUri(Uri.joinPath(media, 'chat.js'))
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>DeepSeek Harness</title>
  </head>
  <body>
${body}
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`
  }

  #readAsset(name: string): string {
    try {
      return readFileSync(join(this.#extensionUri.fsPath, 'media', name), 'utf8')
    } catch (error) {
      reportError(`could not read media/${name}`, error)
      return `<div id="app"><main id="transcript"></main><footer id="composer"><textarea id="composer-input"></textarea></footer></div>`
    }
  }

  dispose(): void {
    this.#serviceSubscription?.dispose()
    this.#activeSubscription?.dispose()
  }
}

/** One-line description of the route the runtime reported, for the model tooltip. */
function describeRoute(service: HarnessService | undefined): string {
  const route = service?.resolvedRoute
  if (!route) return ''
  const parts = [`runtime route: ${displayNameFor(route.provider, route.model)} (${route.model})`]
  if (route.reasoningEffort) parts.push(`effort ${route.reasoningEffort}`)
  const context = formatContextWindow(route.contextWindow)
  if (context) parts.push(`context ${context}`)
  if (route.maxTokens) parts.push(`output cap ${route.maxTokens}`)
  return parts.join(' · ')
}

/** Reveal the chat view in the sidebar. */
export async function focusChat(): Promise<void> {
  await commands.executeCommand('dshVscode.chat.focus')
}
