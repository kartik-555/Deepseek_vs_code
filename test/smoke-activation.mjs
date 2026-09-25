/**
 * Activation smoke test.
 *
 * Loads the built extension bundle with a stubbed `vscode` module and drives
 * the parts of a real session that need no model call: activation, command
 * registration, the chat view's document and message protocol, and shutdown.
 * This is the check that catches a broken entry point, a missing contributed
 * command, or a webview contract regression, without a GUI or an API key.
 *
 * Run with `npm run test:smoke` after `npm run bundle`.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resolveHome = () => homedir()
const failures = []
const notes = []

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

// --- a minimal but honest VS Code API ---------------------------------------

class Disposable {
  constructor(callOnDispose) {
    this.callOnDispose = callOnDispose
  }
  dispose() {
    this.callOnDispose?.()
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set()
    this.event = (listener) => {
      this.listeners.add(listener)
      return new Disposable(() => this.listeners.delete(listener))
    }
  }
  fire(value) {
    for (const listener of [...this.listeners]) listener(value)
  }
  dispose() {
    this.listeners.clear()
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath
    this.scheme = 'file'
    this.path = fsPath
  }
  static file(fsPath) {
    return new Uri(fsPath)
  }
  static parse(value) {
    return new Uri(value)
  }
  static joinPath(base, ...segments) {
    return new Uri(join(base.fsPath, ...segments))
  }
  toString() {
    return `file://${this.fsPath}`
  }
  with(change) {
    return new Uri(change.path ?? this.fsPath)
  }
}

class Position {
  constructor(line, character) {
    this.line = line
    this.character = character
  }
}
class Range {
  constructor(start, end) {
    this.start = start
    this.end = end
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character
  }
}
class Selection extends Range {
  constructor(anchor, active) {
    super(anchor, active)
    this.anchor = anchor
    this.active = active
  }
}
class ThemeIcon {
  constructor(id) {
    this.id = id
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label
    this.collapsibleState = collapsibleState
  }
}
class MarkdownString {
  constructor(value = '') {
    this.value = value
  }
}

const registeredCommands = new Map()
const executedCommands = []
const registeredWebviewProviders = new Map()
const registeredTreeViews = []
const statusBarItems = []
const chatParticipants = []
const outputChannels = []
const watchers = []
const postedMessages = []
const informationMessages = []

const settings = {
  dshPath: '',
  dshCheckout: '',
  dshHome: '',
  dataDir: '.dsh',
  storageLocation: 'global',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: '',
  maxTokens: 0,
  permissionMode: 'workspace-write',
  autoStart: false, // never spawn a runtime in this test
  showReasoning: true,
  animateChunks: false,
  includeEditorContext: true,
  userPatch: 'dsh.patch.yml',
  extraArgs: [],
  'webUi.port': 3080,
  'webUi.trustedHosts': [],
  trace: false,
}

const workspaceDir = join(repoRoot, '.test', 'smoke-workspace')
rmSync(workspaceDir, { recursive: true, force: true })
mkdirSync(join(workspaceDir, '.git', 'info'), { recursive: true })
mkdirSync(join(workspaceDir, 'src'), { recursive: true })
writeFileSync(join(workspaceDir, 'src', 'extension.ts'), 'const answer = 42\n', 'utf8')
writeFileSync(join(workspaceDir, '.git', 'info', 'exclude'), '# pre-existing local excludes\n', 'utf8')

const workspaceFolder = {
  uri: Uri.file(workspaceDir),
  name: 'dsh-smoke',
  index: 0,
}

const fakeDocument = {
  uri: Uri.file(join(workspaceDir, 'src', 'extension.ts')),
  languageId: 'typescript',
  getText: (range) => (range ? 'const answer = 42\n' : 'const answer = 42\nconst other = 1\n'),
  lineCount: 2,
}

const fakeEditor = {
  document: fakeDocument,
  selection: new Selection(new Position(0, 0), new Position(0, 18)),
}

const vscode = {
  Disposable,
  EventEmitter,
  Uri,
  Position,
  Range,
  Selection,
  ThemeIcon,
  TreeItem,
  MarkdownString,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  env: {
    openExternal: async (uri) => {
      notes.push(`openExternal(${uri.fsPath ?? uri})`)
      return true
    },
    clipboard: { writeText: async () => undefined },
  },
  commands: {
    registerCommand(id, handler) {
      registeredCommands.set(id, handler)
      return new Disposable(() => registeredCommands.delete(id))
    },
    async executeCommand(id, ...args) {
      executedCommands.push({ id, args })
      const handler = registeredCommands.get(id)
      if (handler) return handler(...args)
      return undefined
    },
    async getCommands() {
      return [...registeredCommands.keys()]
    },
  },
  workspace: {
    workspaceFolders: [workspaceFolder],
    workspaceFile: undefined,
    textDocuments: [fakeDocument],
    getWorkspaceFolder: () => workspaceFolder,
    getConfiguration: () => ({
      get: (key, fallback) => (key in settings ? settings[key] : fallback),
      update: async () => undefined,
      has: (key) => key in settings,
      inspect: () => undefined,
    }),
    onDidChangeConfiguration: () => new Disposable(),
    createFileSystemWatcher: () => {
      const watcher = { onDidChange: () => new Disposable(), dispose: () => undefined }
      watchers.push(watcher)
      return watcher
    },
    fs: { writeFile: async () => undefined },
    openTextDocument: async (uri) => ({ uri, getText: () => '', lineCount: 1 }),
    applyEdit: async () => true,
  },
  window: {
    activeTextEditor: fakeEditor,
    visibleTextEditors: [fakeEditor],
    createOutputChannel(name) {
      const channel = {
        name,
        lines: [],
        appendLine: (line) => channel.lines.push(line),
        append: (line) => channel.lines.push(line),
        show: () => undefined,
        dispose: () => undefined,
        replace: () => undefined,
        clear: () => undefined,
      }
      outputChannels.push(channel)
      return channel
    },
    createStatusBarItem() {
      const item = {
        text: '',
        tooltip: '',
        command: '',
        name: '',
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }
      statusBarItems.push(item)
      return item
    },
    registerWebviewViewProvider(id, provider) {
      registeredWebviewProviders.set(id, provider)
      return new Disposable(() => registeredWebviewProviders.delete(id))
    },
    createTreeView(id, options) {
      registeredTreeViews.push({ id, options })
      return { dispose: () => undefined, reveal: async () => undefined }
    },
    async showInformationMessage(message, ...items) {
      informationMessages.push(message)
      return undefined
    },
    async showWarningMessage() {
      return undefined
    },
    async showErrorMessage() {
      return undefined
    },
    async showQuickPick() {
      return undefined
    },
    async showInputBox() {
      return undefined
    },
    async showOpenDialog() {
      return undefined
    },
    async showTextDocument() {
      return fakeEditor
    },
    createTerminal() {
      return { show: () => undefined, sendText: () => undefined, dispose: () => undefined }
    },
    onDidChangeActiveTextEditor: () => new Disposable(),
    onDidChangeTextEditorSelection: () => new Disposable(),
    withProgress: async (_options, task) => task({ report: () => undefined }),
  },
  chat: {
    createChatParticipant(id, handler) {
      const participant = { id, handler, iconPath: undefined, followupProvider: undefined, dispose: () => undefined }
      chatParticipants.push(participant)
      return participant
    },
  },
  languages: {
    registerCodeLensProvider: () => new Disposable(),
  },
}

// Route `require('vscode')` inside the bundle to the stub.
const moduleLoad = require('node:module')._load
require('node:module')._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscode
  return moduleLoad.call(this, request, parent, isMain)
}

// --- driving the extension --------------------------------------------------

const bundle = join(repoRoot, 'dist', 'extension.cjs')
check('the extension bundle exists', existsSync(bundle), bundle)

/** Let fire-and-forget async message handling finish. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

function resetCaptures() {
  registeredCommands.clear()
  registeredWebviewProviders.clear()
  registeredTreeViews.length = 0
  statusBarItems.length = 0
  chatParticipants.length = 0
  outputChannels.length = 0
  watchers.length = 0
  postedMessages.length = 0
  informationMessages.length = 0
  executedCommands.length = 0
}

/**
 * Load a fresh instance of the bundle, so each phase below starts from a clean
 * module state against the settings in effect at that moment.
 */
async function activateFresh() {
  resetCaptures()
  delete require.cache[require.resolve(bundle)]
  const extension = require(bundle)
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(repoRoot),
    extensionPath: repoRoot,
    extension: { packageJSON: { version: '0.1.0' }, id: 'deepseek-harness.dsh-vscode' },
    workspaceState: workspaceState,
    globalState: {
      get: () => undefined,
      async update() {},
      keys: () => [],
      setKeysForSync: () => undefined,
    },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    storageUri: Uri.file(join(repoRoot, '.test', 'smoke-storage')),
    globalStorageUri: Uri.file(join(repoRoot, '.test', 'smoke-storage-global')),
    logUri: Uri.file(join(repoRoot, '.test')),
    environmentVariableCollection: {
      replace: () => undefined,
      append: () => undefined,
      prepend: () => undefined,
      clear: () => undefined,
    },
    extensionMode: 3,
    asAbsolutePath: (relative) => join(repoRoot, relative),
  }
  await extension.activate(context)
  return { extension, context }
}

/** Mount the chat webview the way VS Code does, and capture its messages. */
function mountWebview() {
  const provider = registeredWebviewProviders.get('dshVscode.chat')
  const webview = {
    options: {},
    cspSource: 'vscode-webview://smoke',
    html: '',
    posted: [],
    asWebviewUri: (uri) => Uri.parse(`vscode-webview://smoke/${uri.fsPath.split('/').pop()}`),
    postMessage: async (message) => {
      webview.posted.push(message)
      postedMessages.push(message)
      return true
    },
    onDidReceiveMessage: (handler) => {
      webview.handler = handler
      return new Disposable()
    },
  }
  const view = {
    webview,
    visible: true,
    show: () => undefined,
    onDidChangeVisibility: () => new Disposable(),
    onDidDispose: () => new Disposable(),
    title: '',
    description: undefined,
  }
  provider.resolveWebviewView(view, {}, {})
  return { provider, webview, view }
}

const workspaceState = {
  store: new Map(),
  get(key) {
    return this.store.get(key)
  },
  async update(key, value) {
    this.store.set(key, value)
  },
  keys: () => [...this.store.keys()],
}

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const contributed = (manifest.contributes.commands ?? []).map((entry) => entry.command)

// --- phase 1: the default, out-of-repository location -----------------------

console.log('\nphase 1: default storage location')
const phase1 = await activateFresh()
check('activate resolves', true)
check('activation registered disposables', phase1.context.subscriptions.length > 0, `${phase1.context.subscriptions.length}`)

const missing = contributed.filter((id) => !registeredCommands.has(id))
check('every contributed command is registered', missing.length === 0, missing.join(', '))
check(
  'the chat webview provider is registered',
  registeredWebviewProviders.has('dshVscode.chat'),
  [...registeredWebviewProviders.keys()].join(', '),
)
check('the session tree is registered', registeredTreeViews.some((view) => view.id === 'dshVscode.sessions'))
check('the @dsh chat participant is registered', chatParticipants.length === 1, `${chatParticipants.length}`)
check(
  'the status bar item is visible',
  statusBarItems.length === 1 && statusBarItems[0].text.includes('DSH'),
  JSON.stringify(statusBarItems.map((i) => i.text)),
)

const { webview } = mountWebview()
check('the webview document was rendered', webview.html.length > 1000, `${webview.html.length} chars`)
check('the document carries a content security policy', webview.html.includes('Content-Security-Policy'))
check(
  'the CSP allows only the nonce-bearing script',
  /script-src 'nonce-[A-Za-z0-9+/=]+'/.test(webview.html),
  webview.html.match(/script-src[^;]*/)?.[0] ?? 'missing',
)
check('the document inlines the webview body', webview.html.includes('id="composer-input"'))
check('the document links the chat stylesheet', webview.html.includes('chat.css'))
check('the document links the chat script', webview.html.includes('chat.js'))

await webview.handler({ type: 'ready' })
await settle()
const bootstrap = webview.posted.find((message) => message.type === 'bootstrap')
check('ready produces a bootstrap message', bootstrap !== undefined)
check(
  'bootstrap names the repository',
  bootstrap?.payload?.folderName === 'dsh-smoke',
  JSON.stringify(bootstrap?.payload?.folderName),
)
check(
  'the default store is outside the repository',
  typeof bootstrap?.payload?.dataDir === 'string' &&
    !bootstrap.payload.dataDir.startsWith(workspaceDir) &&
    bootstrap.payload.dataDir.startsWith(join(resolveHome(), '.dsh', 'workspaces')),
  bootstrap?.payload?.dataDir,
)
check(
  'bootstrap reports the storage location and its meaning',
  bootstrap?.payload?.storageLocation === 'global' && typeof bootstrap?.payload?.storageOrigin === 'string',
  `${bootstrap?.payload?.storageLocation} / ${bootstrap?.payload?.storageOrigin}`,
)
check('bootstrap reports the model route', bootstrap?.payload?.settings?.model === 'deepseek-flash', bootstrap?.payload?.settings?.model)
check('bootstrap carries a session snapshot', typeof bootstrap?.payload?.session?.id === 'string', JSON.stringify(bootstrap?.payload?.session?.id))
check(
  'no harness directory is created in the working tree',
  !existsSync(join(workspaceDir, '.dsh')),
  join(workspaceDir, '.dsh'),
)
check(
  'the repository .git/info/exclude is left alone',
  !readFileSync(join(workspaceDir, '.git', 'info', 'exclude'), 'utf8').includes('.dsh'),
)

webview.posted.length = 0
await webview.handler({ type: 'attachSelection' })
await settle()
const contextMessage = webview.posted.find((message) => message.type === 'context')
check('attaching a selection returns editor context', contextMessage !== undefined)
check(
  'the attached context names the file and lines',
  typeof contextMessage?.payload?.label === 'string' && contextMessage.payload.label.includes('extension.ts:1'),
  contextMessage?.payload?.label,
)
check(
  'the attached context contains the selected text',
  typeof contextMessage?.payload?.detail === 'string' && contextMessage.payload.detail.includes('const answer = 42'),
  contextMessage?.payload?.detail?.slice(0, 80),
)

// The picker needs a user choice; a dismissed picker must still leave the view
// consistent, so the host re-sends the bootstrap unchanged.
webview.posted.length = 0
await webview.handler({ type: 'selectModel' })
await settle()
check(
  'a dismissed model picker re-reports the current route',
  webview.posted.some((message) => message.type === 'bootstrap'),
  JSON.stringify(webview.posted.map((message) => message.type)),
)

// Key safety, end to end through the shipped bundle: make the handler fail with
// a credential-shaped message and confirm the output channel redacted it.
const plantedKey = 'sk-abcdefghijklmnopqrstuvwxyz012345'
const linesBefore = outputChannels[0].lines.length
await webview.handler({ type: 'openSession', payload: { id: plantedKey } })
await settle()
const written = outputChannels[0].lines.slice(linesBefore).join('\n')
check(
  'a credential-shaped failure is logged redacted',
  written.includes('redacted') && !written.includes(plantedKey),
  written.slice(0, 220) || 'nothing was logged',
)
check('the redacted line still says what failed', /could not handle that action/.test(written), written.slice(0, 160))

webview.posted.length = 0
await webview.handler({ type: 'unknown-message-type' })
await settle()
check('an unknown webview message is ignored', webview.posted.length === 0)

const treeView = registeredTreeViews.find((entry) => entry.id === 'dshVscode.sessions')
check('the session tree renders without a runtime', Array.isArray(treeView.options.treeDataProvider.getChildren()))

await phase1.extension.deactivate()
check('deactivate resolves', true)

// --- phase 2: the opt-in, in-repository location ----------------------------

console.log('\nphase 2: repository storage location')
settings.storageLocation = 'repository'
const phase2 = await activateFresh()
const repositoryWebview = mountWebview()
await repositoryWebview.webview.handler({ type: 'ready' })
await settle()
const repositoryBootstrap = repositoryWebview.webview.posted.find((message) => message.type === 'bootstrap')
check(
  'the repository store resolves inside the working tree',
  repositoryBootstrap?.payload?.dataDir === join(workspaceDir, '.dsh'),
  repositoryBootstrap?.payload?.dataDir,
)
check(
  'bootstrap reports the repository location',
  repositoryBootstrap?.payload?.storageLocation === 'repository',
  repositoryBootstrap?.payload?.storageLocation,
)
check(
  'a .gitignore is generated beside the session data',
  existsSync(join(workspaceDir, '.dsh', '.gitignore')) &&
    readFileSync(join(workspaceDir, '.dsh', '.gitignore'), 'utf8').includes('*'),
)
check(
  'the working-tree store is added to .git/info/exclude',
  readFileSync(join(workspaceDir, '.git', 'info', 'exclude'), 'utf8').includes('/.dsh/'),
  readFileSync(join(workspaceDir, '.git', 'info', 'exclude'), 'utf8'),
)
const notice = repositoryWebview.webview.posted.find((message) => message.type === 'notice')
check(
  'the in-repository layout is announced in the view',
  typeof notice?.payload?.text === 'string' && notice.payload.text.includes('excluded from Git'),
  JSON.stringify(notice?.payload?.text),
)
check('every contributed command is still registered', contributed.every((id) => registeredCommands.has(id)))

await phase2.extension.deactivate()
settings.storageLocation = 'global'

rmSync(workspaceDir, { recursive: true, force: true })

const diagnostics = outputChannels[0]
notes.push(`output channel lines: ${diagnostics?.lines.length ?? 0}`)
notes.push(`commands registered: ${registeredCommands.size}/${contributed.length}`)
notes.push(`executed during activation: ${executedCommands.map((entry) => entry.id).join(', ') || 'none'}`)

console.log('')
for (const note of notes) console.log(`note: ${note}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('\nall checks passed')
