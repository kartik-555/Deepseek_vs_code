/**
 * Extension entry point.
 *
 * Activation wires four things together: one harness service per workspace
 * folder, the sidebar chat webview, the session tree, and the `@dsh` chat
 * participant. Nothing starts a model process until the first prompt, unless
 * `dshVscode.autoStart` asks for a warm runtime at activation.
 */

import { commands, StatusBarAlignment, window, workspace, type ExtensionContext } from 'vscode'
import { registerCommands } from './commands'
import { readSettings, requiresRuntimeRestart } from './config'
import { log, output, reportError, disposeLog } from './log'
import { ServiceRegistry } from './services'
import { ChatView } from './ui/chatView'
import { registerParticipant } from './ui/participant'
import { SessionsView } from './ui/sessionsView'

export async function activate(context: ExtensionContext): Promise<void> {
  const started = Date.now()
  log(`activating DeepSeek Harness ${String(context.extension.packageJSON.version ?? 'unknown')}`)

  const registry = new ServiceRegistry(context.workspaceState)
  activeRegistry = registry
  const chatView = new ChatView(context.extensionUri, registry)
  const sessionsView = new SessionsView(registry)

  context.subscriptions.push(
    registry,
    chatView,
    sessionsView,
    registerParticipant(registry),
    window.registerWebviewViewProvider('dshVscode.chat', chatView, { webviewOptions: { retainContextWhenHidden: true } }),
    window.createTreeView('dshVscode.sessions', { treeDataProvider: sessionsView, showCollapseAll: false }),
    ...registerCommands(registry, chatView, sessionsView),
  )

  const status = window.createStatusBarItem(StatusBarAlignment.Right, 100)
  status.name = 'DeepSeek Harness'
  status.command = 'dshVscode.focusChat'
  status.text = '$(sparkle) DSH'
  status.tooltip = 'DeepSeek Harness — click to open the chat'
  status.show()
  context.subscriptions.push(status)

  const refreshStatus = (): void => {
    const service = registry.active
    if (!service) {
      status.text = '$(sparkle) DSH'
      status.tooltip = 'DeepSeek Harness — open a repository folder'
      return
    }
    const running = service.snapshot().running
    const state = service.runtimeState
    const badge = running ? '$(loading~spin)' : state === 'failed' ? '$(error)' : state === 'ready' ? '$(sparkle)' : '$(circle-outline)'
    status.text = `${badge} DSH`
    status.tooltip = `DeepSeek Harness — ${service.folder.name}\n${service.runtimeDetail}\nClick to open the chat`
  }

  const subscriptions: { dispose(): void }[] = []
  const bindStatus = (): void => {
    const service = registry.active
    subscriptions.forEach((subscription) => subscription.dispose())
    subscriptions.length = 0
    if (service) {
      subscriptions.push(service.onEvent(() => refreshStatus()))
      subscriptions.push(service.onEvent((event) => {
        if (event.type === 'sessions' || event.type === 'title') sessionsView.refresh()
      }))
    }
    refreshStatus()
  }
  context.subscriptions.push(registry.onDidChangeActive(() => bindStatus()))
  context.subscriptions.push({ dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) })

  try {
    await registry.initializeAll(readSettings().autoStart)
  } catch (error) {
    reportError('could not initialize the harness', error)
  }
  bindStatus()
  sessionsView.refresh()

  // Data written by an earlier version of the extension may still sit in a
  // repository working tree while the configured location now points
  // elsewhere. Offer the move once per repository.
  await offerLegacyStorageMove(context, registry, chatView)

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (requiresRuntimeRestart(event)) {
        void window
          .showInformationMessage(
            'DeepSeek Harness: that setting is applied by the runtime process. Restart it now?',
            'Restart Runtime',
            'Later',
          )
          .then((choice) => {
            if (choice === 'Restart Runtime') void commands.executeCommand('dshVscode.restartRuntime')
          })
      }
    }),
  )

  // A repository patch file is the documented extension point, so offer a
  // restart when the user edits it instead of making them discover the command.
  const patchWatcher = workspace.createFileSystemWatcher('**/{dsh.patch.yml,*.cordis.patch.yml}')
  patchWatcher.onDidChange((uri) => {
    log(`repository patch changed: ${uri.fsPath}`)
    void window
      .showInformationMessage(`DeepSeek Harness: ${uri.path.split('/').pop()} changed. Restart the runtime to apply it.`, 'Restart Runtime')
      .then((choice) => {
        if (choice === 'Restart Runtime') void commands.executeCommand('dshVscode.restartRuntime')
      })
  })
  context.subscriptions.push(patchWatcher)

  log(`activation complete in ${Date.now() - started}ms; folders: ${workspace.workspaceFolders?.length ?? 0}`)
  if ((workspace.workspaceFolders?.length ?? 0) === 0) {
    void window.showInformationMessage(
      'DeepSeek Harness: open a repository folder so sessions can be stored inside it.',
      'Open Folder',
    ).then((choice) => {
      if (choice === 'Open Folder') void commands.executeCommand('vscode.openFolder')
    })
  }
}

/**
 * Offer to move data that an earlier version left in the working tree.
 *
 * Asked at most once per repository, and never again once declined, so a user
 * who wants the in-repository layout is not nagged.
 */
async function offerLegacyStorageMove(
  context: ExtensionContext,
  registry: ServiceRegistry,
  chatView: ChatView,
): Promise<void> {
  for (const service of registry.list()) {
    const legacy = service.legacyRepositoryDataDir()
    if (!legacy) continue
    const key = `dshVscode.legacyStoragePrompted:${service.folder.uri.toString()}`
    if (context.workspaceState.get<boolean>(key)) continue
    await context.workspaceState.update(key, true)
    const choice = await window.showWarningMessage(
      `DeepSeek Harness: ${service.folder.name} still stores its DSH data inside the repository at ${legacy}. Move it out of the working tree?`,
      { modal: true },
      'Move It',
      'Keep It There',
    )
    if (choice === 'Move It') {
      // The move command shows the four destinations, moves the data, and
      // restarts the runtime on the new location.
      await commands.executeCommand('dshVscode.changeStorage')
      return
    }
    if (choice === 'Keep It There') {
      // Pin the setting so the layout matches the data that is already there.
      const configuration = workspace.getConfiguration('dshVscode', service.folder.uri)
      await configuration.update('storageLocation', 'repository', true)
      chatView.notice('info', 'Keeping this repository\'s DSH data in the repository; it stays excluded from Git.')
      return
    }
  }
}

/** Held so `deactivate` can stop the runtimes before this module unloads. */
let activeRegistry: ServiceRegistry | undefined

export async function deactivate(): Promise<void> {
  log('deactivating DeepSeek Harness')
  const registry = activeRegistry
  activeRegistry = undefined
  if (registry) {
    // Stops every `dsh` child and flushes the repository transcript first.
    await registry.dispose()
  }
  output().appendLine('')
  disposeLog()
}
