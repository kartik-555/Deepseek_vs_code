/**
 * Actions shared by the chat surfaces and the command palette.
 *
 * These are the operations that leave the chat: launching the full DSH web UI
 * for the repository, running a one-shot headless task in a terminal, revealing
 * the repository's session directory, and opening or diffing a file the agent
 * touched.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { commands, env, Position, Range, Selection, Uri, window, workspace } from 'vscode'
import type { HarnessService } from './harnessService'
import { append, log, output, reportError } from './log'
import type { ServiceRegistry } from './services'
import { resolveLayout, type StorageLocation } from './dsh/workspace'

interface LocationChoice {
  label: string
  description: string
  location: StorageLocation
}

/**
 * Move this repository's harness data, then switch the setting to match.
 *
 * Everything the agent produced moves with it: DSH session logs, key/value
 * storage, and the extension's transcripts, so a chat opened before the move
 * still opens after it.
 */
export async function changeStorageLocation(service: HarnessService): Promise<void> {
  const settings = service.settings
  const current = service.layout
  const choices: LocationChoice[] = [
    {
      label: '$(globe) Global per-repository store',
      description: `${resolveLayout({ workspaceRoot: service.folder.uri.fsPath, location: 'global', dataDir: settings.dataDir }).root} — nothing inside the repository`,
      location: 'global',
    },
    {
      label: '$(folder-library) Inside .git, outside the working tree',
      description: `${resolveLayout({ workspaceRoot: service.folder.uri.fsPath, location: 'gitdir', dataDir: settings.dataDir }).root} — never visible to Git, travels with the checkout folder`,
      location: 'gitdir',
    },
    {
      label: '$(file-directory) Inside the repository, Git-excluded',
      description: `${resolveLayout({ workspaceRoot: service.folder.uri.fsPath, location: 'repository', dataDir: settings.dataDir }).root} — visible in the file tree, ignored through .git/info/exclude`,
      location: 'repository',
    },
    {
      label: '$(edit) Custom path…',
      description: settings.storageLocation === 'custom' ? `currently ${current.root}` : 'type an absolute path, ~ or ${workspaceFolder} are expanded',
      location: 'custom',
    },
  ]

  const picked = await window.showQuickPick(choices, {
    title: `DeepSeek Harness: session storage for ${service.folder.name}`,
    placeHolder: `Currently: ${current.origin} — ${current.root}`,
    matchOnDescription: true,
  })
  if (!picked) return

  let dataDir: string | undefined
  if (picked.location === 'custom') {
    dataDir = await window.showInputBox({
      title: "Absolute path for this repository's DSH data",
      value: settings.storageLocation === 'custom' ? settings.dataDir : '${workspaceFolder}/.dsh',
      prompt: '`~` and `${workspaceFolder}` are expanded; a relative path resolves against the repository root.',
      ignoreFocusOut: true,
    })
    if (!dataDir || dataDir.trim().length === 0) return
  }

  const target = resolveLayout({
    workspaceRoot: service.folder.uri.fsPath,
    location: picked.location,
    dataDir: dataDir ?? settings.dataDir,
    userPatch: settings.userPatch,
    dshHome: settings.dshHome,
  })

  if (target.root === current.root) {
    await window.showInformationMessage(`DeepSeek Harness already stores this repository's data in ${target.root}.`)
    return
  }

  const confirmed = await window.showWarningMessage(
    `Move this repository's DSH data?

From: ${current.root}
To:   ${target.root}

Sessions, storage, and chat history move together. The runtime restarts afterwards.`,
    { modal: true },
    'Move',
  )
  if (confirmed !== 'Move') return

  const configuration = workspace.getConfiguration('dshVscode', service.folder.uri)
  await configuration.update('storageLocation', picked.location, true)
  if (dataDir !== undefined) await configuration.update('dataDir', dataDir, true)

  const result = await service.relocate(picked.location, dataDir)
  if (result.moved) {
    await window.showInformationMessage(
      `DeepSeek Harness: moved ${result.from} to ${result.to}. The runtime restarted on the new location.`,
    )
  } else {
    await window.showInformationMessage(
      `DeepSeek Harness now uses ${result.to}. ${result.reason ? `Existing data stayed at ${result.from} (${result.reason}).` : ''}`.trim(),
    )
  }
}

function terminalEnv(service: HarnessService): Record<string, string> {
  const settings = service.settings
  const env_: Record<string, string> = { DSH_PERMISSION_MODE: settings.permissionMode, FORCE_COLOR: '0' }
  if (settings.dshHome.length > 0) env_.DSH_HOME = settings.dshHome
  return env_
}

/** Boot the DSH web app for this repository in a terminal, then open it in VS Code. */
export async function openWebUi(service: HarnessService): Promise<void> {
  const settings = service.settings
  const port = settings.webUiPort
  const launch = service.webUiLaunch(port, settings.webUiTrustedHosts)
  const terminal = window.createTerminal({
    name: `DSH Web UI · ${service.folder.name}`,
    cwd: service.folder.uri,
    env: terminalEnv(service),
    iconPath: undefined,
  })
  terminal.show(true)
  terminal.sendText(launch.command, true)
  const url = `http://127.0.0.1:${port}`
  log(`starting the DSH web UI for ${service.folder.uri.fsPath} at ${url}`)
  const choice = await window.showInformationMessage(
    `DeepSeek Harness web UI is starting at ${url}. Sessions are shared with this repository.`,
    'Open in VS Code',
    'Open in Browser',
  )
  if (choice === 'Open in VS Code') {
    try {
      await commands.executeCommand('simpleBrowser.show', url)
    } catch (error) {
      reportError('the built-in simple browser is unavailable', error)
      await env.openExternal(Uri.parse(url))
    }
  } else if (choice === 'Open in Browser') {
    await env.openExternal(Uri.parse(url))
  }
}

/** Run a one-shot task through the headless profile in a terminal. */
export async function runHeadlessTask(service: HarnessService, task?: string): Promise<void> {
  const prompt =
    task ??
    (await window.showInputBox({
      title: 'Run a one-shot DSH task',
      prompt: 'The task runs in this repository and prints its final answer in the terminal.',
      placeHolder: 'run the test suite and summarize the failures',
      ignoreFocusOut: true,
    }))
  if (!prompt || prompt.trim().length === 0) return
  const launch = service.headlessLaunch(prompt)
  const terminal = window.createTerminal({
    name: `DSH task · ${service.folder.name}`,
    cwd: service.folder.uri,
    env: terminalEnv(service),
  })
  terminal.show(true)
  terminal.sendText(launch.command, true)
}

/** Reveal the repository's harness data directory in the OS file manager. */
export async function revealDataDir(service: HarnessService): Promise<void> {
  const uri = Uri.file(service.dataDir)
  if (!existsSync(service.dataDir)) {
    await window.showWarningMessage(
      `The repository session directory does not exist yet: ${service.dataDir}. Send a message first.`,
    )
    return
  }
  await commands.executeCommand('revealFileInOS', uri)
}

/** Open the output channel and append a state summary. */
export async function showDiagnostics(registry: ServiceRegistry): Promise<void> {
  const services = registry.list()
  append('')
  append('=== DeepSeek Harness diagnostics ===')
  append(`workspace folders: ${workspace.workspaceFolders?.length ?? 0}`)
  append(`active editor: ${window.activeTextEditor?.document.uri.fsPath ?? 'none'}`)
  append('credentials: the harness owns them (named refs in $DSH_HOME/.credentials.yaml or the environment); this extension stores no key')
  if (services.length === 0) {
    append('no harness service is running: open a repository folder')
  }
  for (const service of services) {
    append('')
    append(`--- ${service.folder.name} ---`)
    append(service.describe())
    append(`runtime log: ${service.layout.logFile}`)
  }
  append('=== end diagnostics ===')
  output().show(true)
}

/** Open a path the agent mentioned, resolved against the repository root. */
export async function openPath(service: HarnessService, path: string, options: { line?: number } = {}): Promise<void> {
  if (!path || path.trim().length === 0) {
    await window.showWarningMessage('That tool call does not name a file.')
    return
  }
  const absolute = isAbsolute(path) ? path : resolve(service.folder.uri.fsPath, path)
  const uri = Uri.file(absolute)
  if (!existsSync(absolute)) {
    const create = await window.showWarningMessage(`File not found: ${path}`, 'Create it')
    if (create !== 'Create it') return
    await workspace.fs.writeFile(uri, new Uint8Array())
  }
  const document = await workspace.openTextDocument(uri)
  const editor = await window.showTextDocument(document, { preview: true })
  if (options.line && options.line > 0) {
    const position = new Position(Math.max(0, options.line - 1), 0)
    editor.selection = new Selection(position, position)
    editor.revealRange(new Range(position, position))
  }
}

/**
 * Best-effort diff for a file the agent edited. VS Code's Git extension owns
 * the diff view; when the file is not a tracked change the command fails, so
 * fall back to opening it.
 */
export async function diffPath(service: HarnessService, path: string): Promise<void> {
  const absolute = isAbsolute(path) ? path : resolve(service.folder.uri.fsPath, path)
  if (!existsSync(absolute)) {
    await openPath(service, path)
    return
  }
  const uri = Uri.file(absolute)
  try {
    await commands.executeCommand('git.openChange', uri)
  } catch (error) {
    log(`git.openChange failed for ${absolute}: ${error instanceof Error ? error.message : String(error)}`)
    try {
      await commands.executeCommand('vscode.diff', uri, uri, `${path} (no Git change found)`)
    } catch {
      await openPath(service, path)
    }
  }
}
