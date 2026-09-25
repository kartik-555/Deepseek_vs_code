/**
 * One {@link HarnessService} per workspace folder.
 *
 * VS Code gives a window a set of folders; the harness gives each folder its
 * own repository-local workspace. This registry keeps that mapping, tracks
 * which folder the chat surfaces point at, and disposes every runtime on
 * shutdown. The active folder is remembered in workspace state, so reloading a
 * window returns to the same repository chat.
 */

import { basename } from 'node:path'
import { EventEmitter, workspace, window, type Disposable, type Memento, type WorkspaceFolder } from 'vscode'
import { HarnessService } from './harnessService'
import { log, reportError } from './log'

const ACTIVE_FOLDER_KEY = 'dshVscode.activeFolder'

export class ServiceRegistry implements Disposable {
  readonly #services = new Map<string, HarnessService>()
  readonly #changeEmitter = new EventEmitter<HarnessService>()
  #activeKey: string | undefined

  /** Raised when the active folder changes, so views can re-render. */
  readonly onDidChangeActive = this.#changeEmitter.event

  constructor(private readonly state: Memento) {}

  get active(): HarnessService | undefined {
    const key = this.#activeKey
    if (key) {
      const service = this.#services.get(key)
      if (service) return service
    }
    const first = this.#services.values().next().value as HarnessService | undefined
    if (first) {
      this.#activeKey = first.folder.uri.toString()
      return first
    }
    return undefined
  }

  list(): HarnessService[] {
    return [...this.#services.values()]
  }

  get count(): number {
    return this.#services.size
  }

  /** Resolve the folder a command should act on: the file's, the editor's, else the chat's. */
  resolveTargetFolder(uri?: { fsPath: string }): HarnessService | undefined {
    const folders = workspace.workspaceFolders ?? []
    if (uri) {
      const match = folders.find(
        (folder) => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}/`),
      )
      if (match) return this.#services.get(match.uri.toString())
    }
    const editorFolder = window.activeTextEditor ? workspace.getWorkspaceFolder(window.activeTextEditor.document.uri) : undefined
    if (editorFolder) {
      const service = this.#services.get(editorFolder.uri.toString())
      if (service) return service
    }
    return this.active
  }

  /** Create and start the services for every folder in this window. */
  async initializeAll(autoStart: boolean): Promise<void> {
    const folders = workspace.workspaceFolders ?? []
    if (folders.length === 0) {
      log('no workspace folder is open: open a repository folder to give the harness somewhere to store its sessions')
      return
    }
    const remembered = this.state.get<string>(ACTIVE_FOLDER_KEY)
    for (const folder of folders) {
      this.#services.set(folder.uri.toString(), new HarnessService(folder))
    }
    const initial =
      (remembered ? this.#services.get(remembered) : undefined) ?? this.#services.get(folders[0]!.uri.toString())
    if (initial) this.#activeKey = initial.folder.uri.toString()

    await Promise.all(
      this.list().map((service) =>
        service.initialize(autoStart && service === initial).catch((error: unknown) => {
          reportError(`could not initialize the harness for ${service.folder.name}`, error)
        }),
      ),
    )
    if (initial) this.#changeEmitter.fire(initial)
  }

  /** Point the chat surfaces at a folder, creating its service on demand. */
  async use(folder: WorkspaceFolder | undefined, options: { autoStart?: boolean } = {}): Promise<HarnessService | undefined> {
    if (!folder) return this.active
    const key = folder.uri.toString()
    let service = this.#services.get(key)
    if (!service) {
      service = new HarnessService(folder)
      this.#services.set(key, service)
      await service.initialize(options.autoStart ?? false)
    }
    if (this.#activeKey !== key) {
      this.#activeKey = key
      void this.state.update(ACTIVE_FOLDER_KEY, key)
      this.#changeEmitter.fire(service)
    }
    return service
  }

  /** Folder list for a quick pick, when more than one repository is open. */
  labels(): { label: string; description: string; folder: WorkspaceFolder }[] {
    return this.list().map((service) => ({
      label: basename(service.folder.uri.fsPath) || service.folder.name,
      description: service.folder.uri.fsPath,
      folder: service.folder,
    }))
  }

  async dispose(): Promise<void> {
    const services = this.list()
    this.#services.clear()
    this.#changeEmitter.dispose()
    await Promise.all(
      services.map((service) =>
        service.dispose().catch((error: unknown) => {
          reportError(`could not stop the runtime for ${service.folder.name}`, error)
        }),
      ),
    )
  }
}
