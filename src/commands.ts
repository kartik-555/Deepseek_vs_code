/**
 * Command registration.
 *
 * The chat view and the chat participant own the conversation; these commands
 * are the entry points a user reaches from the palette, an editor context menu,
 * or the session tree.
 */

import { commands, Uri, window, type Disposable } from 'vscode'
import { changeStorageLocation, openWebUi, revealDataDir, runHeadlessTask, showDiagnostics } from './actions'
import { selectionContext } from './editorContext'
import type { HarnessService } from './harnessService'
import { log, reportError } from './log'
import type { ServiceRegistry } from './services'
import { selectModel } from './modelPicker'
import { focusChat, type ChatView } from './ui/chatView'
import type { SessionsView, SessionNode } from './ui/sessionsView'

type Handler = (...args: never[]) => unknown

function register(command: string, handler: (...args: unknown[]) => unknown): Disposable {
  return commands.registerCommand(command, handler as Handler)
}

export function registerCommands(registry: ServiceRegistry, chatView: ChatView, sessionsView: SessionsView): Disposable[] {
  const withService = async (
    label: string,
    action: (service: HarnessService) => unknown,
    uri?: Uri,
  ): Promise<void> => {
    const service = registry.resolveTargetFolder(uri)
    if (!service) {
      const choice = await window.showWarningMessage(
        'DeepSeek Harness: open a repository folder to store the session.',
        'Open Folder',
      )
      if (choice === 'Open Folder') await commands.executeCommand('vscode.openFolder')
      return
    }
    try {
      await action(service)
    } catch (error) {
      reportError(label, error)
    }
  }

  return [
    register('dshVscode.focusChat', async () => {
      await focusChat()
    }),

    register('dshVscode.newSession', async () => {
      await focusChat()
      await withService('could not start a new session', (service) => service.newSession())
      sessionsView.refresh()
    }),

    register('dshVscode.stop', async () => {
      await withService('could not stop the turn', (service) => service.stop())
    }),

    register('dshVscode.restartRuntime', async () => {
      await withService('could not restart the runtime', (service) => service.restart())
      chatView.notice('info', 'The harness runtime was restarted.')
    }),

    register('dshVscode.attachSelection', async () => {
      const chunk = selectionContext()
      if (!chunk) {
        void window.showInformationMessage('DeepSeek Harness: open a file to attach its selection.')
        return
      }
      await focusChat()
      chatView.attachContext(chunk.label, chunk.text)
    }),

    register('dshVscode.openWebUi', async () => {
      await withService('could not start the DSH web UI', (service) => openWebUi(service))
    }),

    register('dshVscode.runTaskInTerminal', async () => {
      await withService('could not start the one-shot task', (service) => runHeadlessTask(service))
    }),

    register('dshVscode.selectModel', async () => {
      await withService('could not change the model', async (service) => {
        const changed = await selectModel(service)
        if (changed) chatView.notice('info', `Model set to ${service.settings.provider}/${service.settings.model}.`)
      })
    }),

    register('dshVscode.changeStorage', async () => {
      await withService('could not change the session storage location', (service) => changeStorageLocation(service))
      sessionsView.refresh()
    }),

    register('dshVscode.revealDataDir', async () => {
      await withService('could not reveal the session directory', (service) => revealDataDir(service))
    }),

    register('dshVscode.showLogs', async () => {
      await showDiagnostics(registry)
    }),

    register('dshVscode.openSession', async (...args: unknown[]) => {
      const [first, second] = args
      const service = isService(first) ? first : registry.resolveTargetFolder(undefined)
      const id = typeof first === 'string' ? first : typeof second === 'string' ? second : undefined
      if (!service || !id) return
      await focusChat()
      await service.openSession(id)
      sessionsView.refresh()
    }),

    register('dshVscode.deleteSession', async (...args: unknown[]) => {
      const node = args[0] as SessionNode | undefined
      if (!node || node.kind !== 'session') return
      const confirmed = await window.showWarningMessage(
        `Delete the DSH session "${node.summary.title}" from this repository?`,
        { modal: true },
        'Delete',
      )
      if (confirmed !== 'Delete') return
      log(`deleting session ${node.summary.id} for ${node.service.folder.name}`)
      await node.service.deleteSession(node.summary.id)
      sessionsView.refresh()
    }),

    register('dshVscode.refreshSessions', async () => {
      sessionsView.refresh()
    }),
  ]
}

function isService(value: unknown): value is HarnessService {
  return typeof value === 'object' && value !== null && 'folder' in value && 'snapshot' in value
}
