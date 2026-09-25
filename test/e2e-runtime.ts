/**
 * End-to-end check of the harness layer against a real runtime.
 *
 * Run with `npm run test:e2e`. It launches the same `dsh --profile sdk` child
 * the extension launches, drives two prompts across a process restart, and
 * asserts three things the extension depends on:
 *
 * 1. the initialize handshake completes and names the SDK runtime;
 * 2. prompts produce committed events that the transcript reducer folds into
 *    user, assistant, and tool items;
 * 3. the two facts that shape how the extension continues a conversation:
 *    a session id from a previous runtime process is refused, and a fresh
 *    session carrying the transcript digest answers questions about the
 *    earlier turns.
 *
 * The third check is the one worth re-running after a harness upgrade: the SDK
 * protocol has no resume request, and the SDK server rejects a session id that
 * already exists on disk, so the extension continues conversations by digest.
 * If the harness ever exposes resume over the SDK wire, this test is where the
 * extension's continuation strategy should be reconsidered.
 *
 * Set DSH_E2E_BIN to test another runtime binary, and DSH_E2E_HOME to test
 * against a real harness home (default: a scratch home inside `.test/`).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { HarnessRuntime, probeRoute, PROBE_SESSION_PREFIX, ResponseError } from '../src/dsh/runtime'
import { TranscriptReducer, type ChatItem } from '../src/dsh/transcript'
import { buildTranscriptDigest } from '../src/dsh/transcript'
import { revealSlices } from '../src/reveal'
import { candidatesFor, formatContextWindow, parseSupportedModels, PROVIDER_CANDIDATES, routeKey } from '../src/models'
import { containsSecretLikeText, redactSecrets } from '../src/secrets'
import {
  ensureGitExcluded,
  pruneProbeArtifacts,
  ensureGitIgnored,
  hasHarnessData,
  moveDataDirectory,
  resolveDshHome,
  resolveLayout,
  writeRuntimePatch,
} from '../src/dsh/workspace'
import { quoteCommand } from '../src/shell'
import { existsSync } from 'node:fs'
import { findNode, findTooOldNode, MIN_NODE, resolveLaunch } from '../src/dsh/locate'
import type { SessionStatusNotification } from '../src/dsh/wire'

const repoRoot = resolve(import.meta.dirname, '..')
const scratch = join(repoRoot, '.test', 'e2e')
const workspace = join(scratch, 'workspace')
const dshHome = process.env.DSH_E2E_HOME ?? join(scratch, 'dsh-home')

const failures: string[] = []
const notes: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

/**
 * Isolated harness home for the checks.
 *
 * The credential file is *linked*, not copied, so no key material is written
 * into this workspace; where the OS refuses a symlink it is copied, and the
 * whole scratch tree is deleted at the end either way. Nothing else from the
 * real home is touched: sessions and storages are redirected by the repository
 * patch, so the scratch home only holds the borrowed credential.
 */
function prepareCredentials(): string {
  const credential = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(credential)) return 'no credential file found: prompt checks need a configured harness'
  const target = join(dshHome, '.credentials.yaml')
  try {
    symlinkSync(credential, target)
    return `credential borrowed by symlink from ${credential}`
  } catch {
    copyFileSync(credential, target)
    return `credential copied into the scratch home (symlink refused by the OS); deleted when the run ends`
  }
}

function prepare(): void {
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'sample.txt'), 'hello from the e2e workspace\n', 'utf8')
  if (!process.env.DSH_E2E_HOME) {
    mkdirSync(dshHome, { recursive: true })
    notes.push(prepareCredentials())
  } else {
    notes.push(`using DSH_E2E_HOME=${process.env.DSH_E2E_HOME}`)
  }
}

async function runTurn(
  runtime: HarnessRuntime,
  reducer: TranscriptReducer,
  sessionId: string,
  text: string,
): Promise<{ items: ChatItem[]; mutations: number }> {
  let mutations = 0
  let sawRunning = false
  let settled = false
  let resolveIdle: () => void = () => undefined
  const idle = new Promise<void>((resolvePromise) => {
    resolveIdle = resolvePromise
  })
  const timeout = setTimeout(() => {
    if (!settled) resolveIdle()
  }, 180_000)

  const previous = statusHandler
  statusHandler = (notification) => {
    previous?.(notification)
    if (notification.sessionId !== sessionId) return
    if (notification.status === 'running') sawRunning = true
    if (notification.status === 'idle' && sawRunning) {
      settled = true
      resolveIdle()
    }
  }

  const unsubscribe = eventTap
  eventTap = (sessionIdFromEvent, event) => {
    unsubscribe?.(sessionIdFromEvent, event)
    if (sessionIdFromEvent !== sessionId) return
    mutations += reducer.apply(event).length
  }

  await runtime.prompt(sessionId, [{ type: 'text', text }])
  await idle
  clearTimeout(timeout)
  eventTap = undefined
  statusHandler = previous
  return { items: [...reducer.items], mutations }
}

function readFileSyncText(path: string): string {
  return readFileSync(path, 'utf8')
}

let eventTap: ((sessionId: string, event: import('../src/dsh/wire').SessionEvent) => void) | undefined
let statusHandler: ((notification: SessionStatusNotification) => void) | undefined

function buildRuntime(launchOrigin: string): {
  runtime: HarnessRuntime
  reducer: TranscriptReducer
  storeRoot: string
  launch: import('../src/dsh/runtime').LaunchSpec
} {
  // Use the shipped default location, so the real runtime is exercised against
  // the layout users get: sessions outside the repository working tree.
  const layout = resolveLayout({
    workspaceRoot: workspace,
    location: 'global',
    dataDir: '.dsh',
    userPatch: 'dsh.patch.yml',
    dshHome,
  })
  const patchFile = writeRuntimePatch(layout)
  const probe = resolveLaunch({ workspaceRoot: repoRoot, dshPath: process.env.DSH_E2E_BIN ?? '', dshCheckout: '' })
  const launch = {
    file: probe.file,
    args: [...probe.args, '--profile', 'sdk', '--patch', patchFile],
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'workspace-write',
      FORCE_COLOR: '0',
    },
    origin: launchOrigin,
  }
  const reducer = new TranscriptReducer({ sessionId: 'placeholder', showReasoning: true })
  const runtime = new HarnessRuntime({
    launch,
    initialize: { cwd: workspace, provider: 'deepseek-official', model: 'deepseek-flash' },
    callbacks: {
      onSessionEvent: (notification) => eventTap?.(notification.sessionId, notification.event),
      onSessionStatus: (notification) => statusHandler?.(notification),
      onDiagnostic: (message) => console.log(`  [runtime] ${message}`),
      onExit: (info) => {
        if (!info.expected) console.log(`  [runtime exit] code=${info.code} signal=${info.signal} ${info.stderrTail.slice(-500)}`)
      },
    },
    logFile: join(layout.extension, 'e2e.log'),
  })
  return { runtime, reducer, storeRoot: layout.root, launch }
}

async function main(): Promise<void> {
  console.log('DeepSeek Harness — runtime end-to-end check')
  notes.length = 0
  prepare()

  // --- part 0: locating a runtime (no model calls) ------------------------
  console.log('\npart 0: runtime discovery')
  const node = findNode()
  check(
    `a Node.js runtime satisfying >=${MIN_NODE.join('.')} is found`,
    node !== undefined,
    node ? node.version : `found only ${findTooOldNode()?.version ?? 'nothing'} — the extension would fall back to the extension host runtime`,
  )
  const launch = resolveLaunch({
    workspaceRoot: repoRoot,
    dshPath: process.env.DSH_E2E_BIN ?? '',
    dshCheckout: '',
  })
  notes.push(`launch origin: ${launch.origin}`)
  check('the launch command resolves to an existing entry point', existsSync(launch.file), launch.file)
  check(
    'the launch command selects the sdk profile through the launcher',
    launch.args.some((argument) => argument.endsWith('bin.js')) || !launch.args.some((argument) => argument.includes('@deepseek-ai')),
    launch.args.join(' '),
  )

  // --- part 0b: the pure helpers, no runtime involved --------------------
  const sampleItems: ChatItem[] = [
    { id: 'u1', kind: 'user', at: 1, text: 'store the number 4271', images: 0, context: '' },
    { id: 't1', kind: 'tool', at: 2, callId: 'c1', name: 'bash', summary: 'ls -la', argsText: '{}', status: 'ok', output: '', outputTruncated: false },
    { id: 'a1', kind: 'assistant', at: 3, turn: 1, step: 1, reasoning: 'ok', text: 'stored 4271' },
    { id: 'n1', kind: 'notice', at: 4, level: 'warn', text: 'ignored by the digest' },
  ]
  const digest = buildTranscriptDigest(sampleItems, 12_000)
  check('the digest carries user and assistant turns', digest.includes('store the number 4271') && digest.includes('stored 4271'), digest)
  check('the digest summarizes tools in one line', digest.includes('Tool bash: ls -la -> ok'), digest)
  check('the digest omits extension notices', !digest.includes('ignored by the digest'), digest)
  const tight = buildTranscriptDigest(sampleItems, 60)
  check('a tight digest budget keeps the newest turn and says what it dropped', tight.includes('omitted'), tight)
  check('a tight digest budget stays within its limit', tight.length < 400, `${tight.length} chars`)

  // The web-UI and one-shot commands use the same launcher shape: launcher
  // flags first, then the profile's own arguments, every part shell-quoted.
  const layout = resolveLayout({ workspaceRoot: workspace, dataDir: '.dsh', userPatch: 'dsh.patch.yml' })
  const webCommand = quoteCommand([
    launch.file,
    ...launch.args,
    '--profile',
    'web',
    '--patch',
    layout.patchFile,
    '--no-open',
    '--port',
    '3080',
  ])
  check(
    'profile flags precede app arguments in a terminal command',
    webCommand.indexOf('--profile') < webCommand.indexOf('--no-open') && webCommand.indexOf('--patch') < webCommand.indexOf('--port'),
    webCommand,
  )
  check('every argument with a path is shell-quoted', !/ --patch [^'"]/.test(webCommand), webCommand)
  check(
    'a path containing a space survives quoting',
    quoteCommand(['/tmp/a b/dsh', '--profile', 'web']).startsWith("'/tmp/a b/dsh'"),
    quoteCommand(['/tmp/a b/dsh', '--profile', 'web']),
  )

  // --- part 0c: storage locations (no runtime, no model calls) ------------
  // The point of these checks is the promise that a repository keeps its own
  // workspace without the files landing in the working tree or in Git.
  const home = resolveDshHome()
  const globalLayout = resolveLayout({ workspaceRoot: workspace, location: 'global', dataDir: '.dsh' })
  check(
    'the default location keeps data outside the repository',
    !globalLayout.root.startsWith(workspace) && globalLayout.root.startsWith(home),
    globalLayout.root,
  )
  check(
    'the global location is keyed per repository and stable',
    globalLayout.root === resolveLayout({ workspaceRoot: workspace, location: 'global', dataDir: '.dsh' }).root &&
      /\/workspaces\/workspace-[0-9a-f]{8}$/.test(globalLayout.root),
    globalLayout.root,
  )
  check(
    'two repositories never share a global store',
    resolveLayout({ workspaceRoot: join(scratch, 'other-repo'), location: 'global', dataDir: '.dsh' }).root !==
      globalLayout.root,
  )

  // A separate scratch repository for the working-tree layout checks, so the
  // runtime workspace below stays untouched and can prove it stays clean.
  const layoutWorkspace = join(scratch, 'layout-workspace')
  mkdirSync(join(layoutWorkspace, 'src'), { recursive: true })
  const repoLayout = resolveLayout({ workspaceRoot: layoutWorkspace, location: 'repository', dataDir: '.dsh' })
  check(
    'the repository location resolves inside the working tree',
    repoLayout.root === join(layoutWorkspace, '.dsh'),
    repoLayout.root,
  )
  const customLayout = resolveLayout({
    workspaceRoot: layoutWorkspace,
    location: 'custom',
    dataDir: '${workspaceFolder}/.store ~',
  })
  check(
    'a custom path expands ${workspaceFolder} and ~',
    customLayout.root.startsWith(layoutWorkspace) && customLayout.root.includes('.store'),
    customLayout.root,
  )

  // `gitdir` needs a Git repository; the scratch repository has none yet.
  const degraded = resolveLayout({ workspaceRoot: layoutWorkspace, location: 'gitdir', dataDir: '.dsh' })
  check(
    'a gitdir location without Git degrades to the global store instead of failing',
    degraded.location === 'global',
    `${degraded.location}: ${degraded.root}`,
  )

  // Give the scratch repository a Git directory and check both protections.
  mkdirSync(join(layoutWorkspace, '.git', 'info'), { recursive: true })
  writeFileSync(join(layoutWorkspace, '.git', 'info', 'exclude'), '# existing local excludes\n', 'utf8')
  const gitLayout = resolveLayout({ workspaceRoot: layoutWorkspace, location: 'gitdir', dataDir: '.dsh' })
  check(
    'a gitdir location resolves under .git',
    gitLayout.root === join(layoutWorkspace, '.git', 'dsh'),
    gitLayout.root,
  )
  check('the Git directory itself is inside the repository', gitLayout.root.startsWith(join(layoutWorkspace, '.git')))

  const repositoryLayout = resolveLayout({ workspaceRoot: layoutWorkspace, location: 'repository', dataDir: '.dsh' })
  check('the working-tree store gets a generated .gitignore', ensureGitIgnored(repositoryLayout))
  check(
    'the generated .gitignore ignores everything beside it',
    readFileSyncText(join(repositoryLayout.root, '.gitignore')).includes('*'),
  )
  check('the working-tree store is added to .git/info/exclude', ensureGitExcluded(layoutWorkspace, repositoryLayout))
  const exclude = readFileSyncText(join(layoutWorkspace, '.git', 'info', 'exclude'))
  check('the exclusion rule is repository-relative', exclude.includes('\n/.dsh/'), JSON.stringify(exclude))
  check('the pre-existing exclude content is preserved', exclude.includes('# existing local excludes'), JSON.stringify(exclude))
  check('adding the rule twice is a no-op', ensureGitExcluded(layoutWorkspace, repositoryLayout) === false)
  check(
    'a global layout never touches .git/info/exclude',
    ensureGitExcluded(layoutWorkspace, resolveLayout({ workspaceRoot: layoutWorkspace, location: 'global', dataDir: '.dsh' })) === false,
  )

  // Moving data between locations must carry sessions and history.
  const fromDir = join(scratch, 'move-from')
  const toDir = join(scratch, 'move-to')
  mkdirSync(join(fromDir, 'sessions'), { recursive: true })
  writeFileSync(join(fromDir, 'sessions', 'x.jsonl'), 'log', 'utf8')
  mkdirSync(join(fromDir, 'vscode', 'sessions'), { recursive: true })
  writeFileSync(join(fromDir, 'vscode', 'index.json'), '{}', 'utf8')
  check('harness data is detected before a move', hasHarnessData(fromDir))
  const moved = moveDataDirectory(fromDir, toDir)
  check('the move reports success', moved.moved, moved.reason ?? '')
  check('the moved tree keeps its sessions', existsSync(join(toDir, 'sessions', 'x.jsonl')))
  check('the moved tree keeps its transcripts', existsSync(join(toDir, 'vscode', 'index.json')))
  check('the old location is gone after the move', !existsSync(fromDir))
  check('moving onto an existing directory is refused', moveDataDirectory(fromDir, toDir).moved === false)
  check('moving nothing is refused', moveDataDirectory(join(scratch, 'nope'), join(scratch, 'nope2')).moved === false)

  // --- part 0d: the model catalog and secret redaction --------------------
  const deepseek = candidatesFor('deepseek-official')
  check('the DeepSeek catalog is offered', deepseek.length >= 2, `${deepseek.length} models`)
  check('the catalog carries the default model', deepseek.some((model) => model.id === 'deepseek-flash'), JSON.stringify(deepseek.map((m) => m.id)))
  check('the catalog carries context windows', deepseek.every((model) => (model.contextWindow ?? 0) > 0))
  check('an unknown provider has no guessed models', candidatesFor('some-unknown-route').length === 0)
  check('provider suggestions include the bundled route', PROVIDER_CANDIDATES.some((provider) => provider.id === 'deepseek-official'))
  check('context windows render compactly', formatContextWindow(1_000_000) === '1M' && formatContextWindow(256_000) === '256k')
  check('route keys differ per effort', routeKey('deepseek-official', 'deepseek-flash', 'high') !== routeKey('deepseek-official', 'deepseek-flash', ''))

  const realRefusal =
    '{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed definitely-not-a-model.","code":"INVALID_REQUEST","status":400}'
  const reported = parseSupportedModels(realRefusal)
  check(
    'a provider refusal yields its real model catalog',
    reported.includes('deepseek-flash') && reported.includes('deepseek-v4-pro') && !reported.includes('you'),
    JSON.stringify(reported),
  )
  check('an unrelated message yields no catalog', parseSupportedModels('network timeout').length === 0)
  check(
    'other phrasings are understood',
    parseSupportedModels('Available models: gpt-4o-mini, claude-3-5-sonnet').length === 2,
    JSON.stringify(parseSupportedModels('Available models: gpt-4o-mini, claude-3-5-sonnet')),
  )

  const secretCases: [string, string][] = [
    ['DEEPSEEK_API_KEY=abcdef1234567890', 'ref assignment'],
    ['"GOOGLE_API_KEY": "AIzaSyA1234567890abcdefghijklmnop"', 'json ref assignment'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz012345', 'openai-style key'],
    ['AIzaSyA1234567890abcdefghijklmnopqrs', 'google-style key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github token'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'bearer token'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', 'private key body'],
  ]
  for (const [sample, label] of secretCases) {
    const redacted = redactSecrets(sample)
    check(`redacts a ${label}`, !containsSecretLikeText(redacted) && redacted.includes('redacted'), redacted.slice(0, 120))
  }
  const ordinary = 'The loader mounts bundles, then applies patches from /home/dev/repo/.dsh.'
  check('leaves ordinary text untouched', redactSecrets(ordinary) === ordinary, redactSecrets(ordinary))
  check('redaction is idempotent', redactSecrets(redactSecrets('sk-abcdefghijklmnopqrstuvwxyz')) === redactSecrets('sk-abcdefghijklmnopqrstuvwxyz'))

  check('short answers are revealed whole, not animated', revealSlices('done').length === 0)
  const plan = revealSlices('x'.repeat(1000))
  check('a long answer is revealed in bounded steps', plan.length > 2 && plan.length <= 48, `${plan.length} steps`)
  check('the reveal plan is monotonic and ends complete', plan[plan.length - 1] === 'x'.repeat(1000) && plan.every((slice, index) => index === 0 || slice.length >= (plan[index - 1]?.length ?? 0)))

  if (process.env.DSH_E2E_OFFLINE === '1') {
    console.log('\nDSH_E2E_OFFLINE=1: stopping after discovery and helper checks')
    report()
    return
  }

  // --- part 1: handshake, tool call, and answer on a fresh session ---------
  console.log('\npart 1: fresh session')
  const first = buildRuntime('first launch')
  const handshake = await first.runtime.start()
  check('initialize returns the SDK runtime identity', handshake.serverInfo.name === 'deepseek-harness-sdk-runtime', JSON.stringify(handshake))
  const sessionId = 'e2e-session'
  const turn1 = await runTurn(
    first.runtime,
    first.reducer,
    sessionId,
    'Use the bash tool to run `ls` in this workspace, then reply with exactly this sentence: stored 4271',
  )
  const kinds = turn1.items.map((item) => item.kind)
  check('the transcript contains the user turn', kinds.includes('user'))
  check('the transcript contains an assistant answer', kinds.includes('assistant'))
  check('the transcript contains a tool card', kinds.includes('tool'), kinds.join(','))
  const tool = turn1.items.find((item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool')
  check('the tool card completed successfully', tool?.status === 'ok', tool?.status ?? 'missing')
  check('the tool card captured output', (tool?.output ?? '').length > 0)
  check('the tool card used the active workspace', (tool?.output ?? '').includes('sample.txt') || (tool?.output ?? '').includes('total'), tool?.output?.slice(0, 120))
  const assistant = [...turn1.items].reverse().find((item): item is Extract<ChatItem, { kind: 'assistant' }> => item.kind === 'assistant')
  check('the answer names the stored value', (assistant?.text ?? '').includes('4271'), assistant?.text)
  check(
    'the session log landed in this repository\'s own store, outside the working tree',
    existsSync(join(first.storeRoot, 'sessions')) && !first.storeRoot.startsWith(workspace),
    first.storeRoot,
  )
  check(
    'the store is keyed by the repository it belongs to',
    first.storeRoot.includes('workspace-') && first.storeRoot.startsWith(join(dshHome, 'workspaces')),
    first.storeRoot,
  )
  check(
    'no DSH directory is created in the repository working tree',
    !existsSync(join(workspace, '.dsh')),
    join(workspace, '.dsh'),
  )
  writeFileSync(join(scratch, 'transcript-part1.json'), JSON.stringify(turn1.items, null, 2), 'utf8')

  // --- part 2: a persisted session id is refused by a new process ----------
  console.log('\npart 2: a persisted session id cannot be reused')
  await first.runtime.stop()
  const second = buildRuntime('second launch')
  const reuseReducer = new TranscriptReducer({ sessionId, showReasoning: true })
  let refused = false
  let refusal = ''
  try {
    await runTurn(second.runtime, reuseReducer, sessionId, 'Ignored: this prompt must not be accepted.')
  } catch (error) {
    refused = true
    refusal = error instanceof ResponseError || error instanceof Error ? error.message : String(error)
  }
  check('reusing a session id from a previous runtime is refused', refused, refusal || 'the runtime accepted the reused id')
  check('the refusal names the existing session', refusal.includes('already exists'), refusal)

  // --- part 3: the digest carries the conversation across a restart --------
  console.log('\npart 3: continuation digest on a fresh session id')
  const liveDigest = buildTranscriptDigest(turn1.items, 12_000)
  check('the digest records the stored value', liveDigest.includes('4271'), liveDigest.slice(0, 200))
  const continuationId = 'e2e-session-continued'
  const continuedReducer = new TranscriptReducer({ sessionId: continuationId, showReasoning: true })
  const seeded = `The earlier turns of this conversation were recorded before this runtime started. Continue from this summary.\n\n${liveDigest}`
  const turn3 = await runTurn(
    second.runtime,
    continuedReducer,
    continuationId,
    `${seeded}\n\n---\n\nWhat number did I ask you to store? Reply with just the digits.`,
  )
  const continuedAnswer = [...turn3.items].reverse().find((item): item is Extract<ChatItem, { kind: 'assistant' }> => item.kind === 'assistant')
  check('the digest lets a fresh session answer about earlier turns', (continuedAnswer?.text ?? '').includes('4271'), continuedAnswer?.text?.slice(0, 200))
  writeFileSync(join(scratch, 'transcript-part3.json'), JSON.stringify(turn3.items, null, 2), 'utf8')

  // --- part 4: a different session id stays isolated ----------------------
  console.log('\npart 4: session isolation')
  const isolatedReducer = new TranscriptReducer({ sessionId: 'e2e-session-2', showReasoning: true })
  const turn4 = await runTurn(second.runtime, isolatedReducer, 'e2e-session-2', 'Say exactly: fresh session')
  const freshAnswer = [...turn4.items].reverse().find((item): item is Extract<ChatItem, { kind: 'assistant' }> => item.kind === 'assistant')
  check('a new session id starts without the other session history', !(freshAnswer?.text ?? '').includes('4271'), freshAnswer?.text?.slice(0, 200))

  // --- part 5: how the model picker verifies a route ----------------------
  console.log('\npart 5: route verification (one 64-token request per route)')
  // The handshake alone accepts any model id, which is exactly why the picker
  // verifies with a real (tiny) turn instead.
  const handshakeOnly = await probeRoute(
    second.launch,
    { cwd: workspace, provider: 'deepseek-official', model: 'definitely-not-a-model' },
    { mode: 'handshake' },
  )
  check(
    'the handshake alone does not prove a model exists',
    handshakeOnly.ok,
    'if this ever fails, initialize started validating model ids and the probe can be cheapened',
  )

  const accepted = await probeRoute(second.launch, {
    cwd: workspace,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  check('a model route is verified by answering a real request', accepted.ok, accepted.detail)
  check('the probe says what it actually proved', /probe request/.test(accepted.detail), accepted.detail)
  const refusedRoute = await probeRoute(second.launch, {
    cwd: workspace,
    provider: 'deepseek-official',
    model: 'definitely-not-a-model',
  })
  check('an unknown model is refused rather than assumed', !refusedRoute.ok, refusedRoute.detail)
  check(
    'the refusal names the model or the route',
    /model|route|unknown|unsupported|not found|invalid/i.test(refusedRoute.detail),
    refusedRoute.detail.slice(0, 240),
  )
  notes.push(`refusal detail: ${refusedRoute.detail.slice(0, 220)}`)
  check(
    'the real refusal teaches the picker the provider catalog',
    parseSupportedModels(refusedRoute.detail).includes('deepseek-flash'),
    JSON.stringify(parseSupportedModels(refusedRoute.detail)),
  )
  const probeLeftovers = pruneProbeArtifacts(second.storeRoot, PROBE_SESSION_PREFIX)
  check(
    'probe turns leave no sessions behind once pruned',
    pruneProbeArtifacts(second.storeRoot, PROBE_SESSION_PREFIX) === 0,
    `${probeLeftovers} removed on the first sweep`,
  )

  await second.runtime.dispose()
  report()
}

function report(): void {
  if (process.env.DSH_E2E_KEEP !== '1') {
    // Leave nothing behind: the scratch home holds a borrowed credential.
    rmSync(scratch, { recursive: true, force: true })
  } else {
    console.log(`\nkept ${scratch} (DSH_E2E_KEEP=1)`)
  }
  console.log('')
  for (const note of notes) console.log(`note: ${note}`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
    return
  }
  console.log('\nall checks passed')
}

await main()
