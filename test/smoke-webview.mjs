/**
 * Webview contract check.
 *
 * Boots `media/chat.html` + `media/chat.js` in a real DOM (jsdom) with a stubbed
 * `acquireVsCodeApi`, then drives the host side of the protocol exactly as
 * `src/ui/chatView.ts` does and asserts what the user would see. This is the
 * front-end counterpart to `smoke-activation.mjs`: together they cover both ends
 * of `docs/webview-protocol.md` without a GUI.
 *
 * Run with `npm run test:webview` after `npm run bundle`.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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

const body = readFileSync(join(repoRoot, 'media', 'chat.html'), 'utf8')
const script = readFileSync(join(repoRoot, 'media', 'chat.js'), 'utf8')
const style = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8')

const dom = new JSDOM(`<!doctype html><html><head><style>${style}</style></head><body>${body}</body></html>`, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://localhost/',
})

const { window } = dom
const posted = []

// Minimal webview API, matching what the host sends and receives.
window.acquireVsCodeApi = () => ({
  postMessage: (message) => {
    posted.push(message)
    return true
  },
  getState: () => undefined,
  setState: () => undefined,
})
window.navigator.clipboard = { writeText: async () => undefined }
window.matchMedia ??= () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })

window.eval(script)

const document = window.document
const $ = (id) => document.getElementById(id)
const text = (id) => $(id)?.textContent ?? ''
const send = (type, payload) => {
  window.dispatchEvent(new window.MessageEvent('message', { data: { type, payload } }))
}

// The webview installs its listener and posts `ready` once the document is
// parsed, exactly as it does in VS Code.
await new Promise((resolve) => {
  if (document.readyState !== 'loading') {
    resolve()
    return
  }
  window.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
  window.setTimeout(resolve, 1000)
})

// --- the webview announces itself -------------------------------------------

check('the webview posts ready on load', posted.some((message) => message.type === 'ready'), JSON.stringify(posted.map((m) => m.type)))
check('the composer is empty and send is disabled at rest', $('btn-send').disabled === true)
check('the stop button is hidden at rest', $('btn-stop').hidden === true)

// --- bootstrap --------------------------------------------------------------

const NOW = Date.now()
const usage = { inputTokens: 7050, outputTokens: 59, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7109 }

send('bootstrap', {
  folderName: 'deepseek-harness',
  folderPath: '/home/dev/deepseek-harness',
  dataDir: '/home/dev/deepseek-harness/.dsh',
  multiRoot: true,
  runtime: { state: 'ready', detail: 'checkout at /home/dev/deepseek-harness' },
  settings: {
    showReasoning: true,
    animateChunks: false,
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    reasoningEffort: 'high',
    permissionMode: 'workspace-write',
  },
  resolvedRoute: 'runtime route: DeepSeek-V41-Flash (deepseek-flash) · effort high · context 1M',
  sessions: [
    { id: 's-1', title: 'Fix the loader', createdAt: NOW - 90_000, updatedAt: NOW - 5_000, itemCount: 12 },
    { id: 's-2', title: 'Explain boot order', createdAt: NOW - 900_000, updatedAt: NOW - 800_000, itemCount: 4 },
  ],
  session: { id: 's-1', title: 'Fix the loader', createdAt: NOW - 90_000, updatedAt: NOW - 5_000, items: [], running: false, restored: true, usage },
})

check('the repository name is shown', text('folder-name').includes('deepseek-harness'), text('folder-name'))
check('the session title is shown', text('session-title').includes('Fix the loader'), text('session-title'))
check('the runtime badge reports readiness', text('runtime-badge').toLowerCase().includes('ready'), text('runtime-badge'))
check('the model route is shown', text('model-label').includes('deepseek-flash'), text('model-label'))
check('the reasoning effort is shown beside the model', text('model-label').includes('high'), text('model-label'))
check(
  'the model label reports what the runtime resolved',
  $('model-label').title.includes('runtime route') && $('model-label').title.includes('context 1M'),
  $('model-label').title,
)
posted.length = 0
$('model-label').click()
check('clicking the model opens the model picker', posted.some((message) => message.type === 'selectModel'), JSON.stringify(posted.map((m) => m.type)))
check('the permission mode is shown', text('permission-label').includes('workspace-write'), text('permission-label'))
check('the empty state is visible for an empty transcript', $('empty-state').hidden === false)
check('bootstrap usage is rendered', text('usage').replace(/[^0-9]/g, '').length > 0, text('usage'))

$('btn-sessions').click()
const sessionItems = [...$('session-list').querySelectorAll('li')]
check('the session panel lists every stored session', sessionItems.length === 2, `${sessionItems.length}`)
check('session rows carry their title', $('session-list').textContent.includes('Explain boot order'))
check('the active session is marked', $('session-list').textContent.includes('Fix the loader'))

// --- transcript mutations ---------------------------------------------------

send('mutations', {
  sessionId: 's-1',
  mutations: [
    { op: 'append', item: { id: 'u1', kind: 'user', at: NOW, text: 'Why does boot need **two** passes?', images: 0, context: 'src/boot.ts:12-40' } },
    {
      op: 'append',
      item: {
        id: 'a1',
        kind: 'assistant',
        at: NOW,
        turn: 1,
        step: 1,
        reasoning: 'The loader mounts bundles before applying patches.',
        text: 'Because the loader needs the bundle list before it can `apply` patches:\n\n- bundles first\n- then patches\n\n```ts\nawait loader.mount(bundles)\n```',
        usage,
      },
    },
    {
      op: 'append',
      item: { id: 't1', kind: 'tool', at: NOW, callId: 'call-1', name: 'bash', summary: 'ls -la', argsText: '{"command":"ls -la"}', status: 'running', output: '', outputTruncated: false },
    },
  ],
})

const transcript = $('transcript')
check('the user turn is rendered', transcript.textContent.includes('Why does boot need'))
check('the user context chip is rendered', transcript.textContent.includes('src/boot.ts:12-40'), transcript.textContent.slice(0, 200))
check('markdown bold is rendered as an element', transcript.querySelector('strong') !== null)
check('markdown code fences are rendered as blocks', transcript.querySelector('pre code, pre') !== null)
check('markdown lists are rendered', transcript.querySelector('ul li') !== null)
check('reasoning is rendered in a collapsed block', transcript.querySelector('details') !== null)
check('the tool card shows the command', transcript.textContent.includes('ls -la'))
check('a running tool card is marked as running', transcript.querySelector('.item-tool.tool-running') !== null)
check('the empty state is hidden once items exist', $('empty-state').hidden === true)

// A tool result updates the existing card rather than adding a second one.
const before = transcript.querySelectorAll('[data-id]').length
let peakItems = before
send('mutations', {
  sessionId: 's-1',
  mutations: [
    {
      op: 'update',
      id: 't1',
      patch: { status: 'ok', output: 'total 16\ndrwxr-xr-x  4 dev dev 4096 .\n-rw-r--r--  1 dev dev  246 package.json', outputTruncated: false },
    },
  ],
})
const after = transcript.querySelectorAll('[data-id]').length
peakItems = Math.max(peakItems, after)
check('a tool result updates its card instead of appending', after === before, `${before} -> ${after}`)
check('the tool output is rendered', transcript.textContent.includes('package.json'))
check('the completed tool card reports success', transcript.querySelector('.item-tool.tool-ok') !== null)

// Escaping: model text must never become markup.
send('mutations', {
  sessionId: 's-1',
  mutations: [
    { op: 'append', item: { id: 'u2', kind: 'user', at: NOW, text: '<img src=x onerror="window.__pwned=1">', images: 0, context: '' } },
    { op: 'append', item: { id: 'n1', kind: 'notice', at: NOW, level: 'error', text: 'Runtime exited: <script>window.__pwned=2</script>' } },
  ],
})
check('model text is escaped rather than parsed', window.__pwned === undefined)
check('the escaped text is still visible to the user', transcript.textContent.includes('<img src=x'))

// Removal.
send('mutations', { sessionId: 's-1', mutations: [{ op: 'remove', id: 'u2' }] })
check('a removed item disappears', !transcript.textContent.includes('<img src=x'))

// --- run state --------------------------------------------------------------

send('status', { sessionId: 's-1', running: true })
check('the stop button replaces send while running', $('btn-stop').hidden === false && $('btn-send').hidden === true)
check('the working indicator appears while running', $('working').hidden === false)
send('status', { sessionId: 's-1', running: false })
check('the send button returns when idle', $('btn-stop').hidden === true && $('btn-send').hidden === false)

// --- composer ---------------------------------------------------------------

const input = $('composer-input')
input.value = 'Run `npm test` and fix what fails'
input.dispatchEvent(new window.Event('input', { bubbles: true }))
check('typing enables send', $('btn-send').disabled === false)
$('btn-send').click()
const submit = posted.filter((message) => message.type === 'submit').pop()
check('send posts the prompt', submit?.payload?.text === 'Run `npm test` and fix what fails', JSON.stringify(submit?.payload))
check('the composer clears after sending', input.value === '')

posted.length = 0
$('btn-files').click()
check('the files button asks the host for context', posted.some((message) => message.type === 'pickFiles'))
posted.length = 0
$('btn-attach').click()
check('the attach button asks the host for the selection', posted.some((message) => message.type === 'attachSelection'))
posted.length = 0
$('btn-web-ui').click()
check('the web UI button asks the host to launch it', posted.some((message) => message.type === 'openWebUi'))
posted.length = 0
$('runtime-badge').click()
check('the runtime badge opens diagnostics', posted.some((message) => message.type === 'showLogs'))

// Host-provided context lands in the composer.
send('context', { label: 'src/dsh/runtime.ts:40-60', detail: 'File: src/dsh/runtime.ts\n```ts\nconst x = 1\n```' })
check('host context is attached to the composer', input.value.includes('src/dsh/runtime.ts') || $('context-chips').textContent.includes('src/dsh/runtime.ts'), JSON.stringify(input.value.slice(0, 120)))

// Session switching and deletion ask the host.
posted.length = 0
$('btn-new-session').click()
check('the new session button asks the host', posted.some((message) => message.type === 'newSession'))

send('sessions', { sessions: [{ id: 's-3', title: 'Brand new', createdAt: NOW, updatedAt: NOW, itemCount: 0 }] })
$('btn-sessions').click()
check('the session list follows host updates', $('session-list').textContent.includes('Brand new'), $('session-list').textContent)

send('session', {
  session: { id: 's-3', title: 'Brand new', createdAt: NOW, updatedAt: NOW, items: [], running: false, restored: false, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } },
})
check('switching sessions clears the transcript', !$('transcript').textContent.includes('Why does boot need'), $('transcript').textContent.slice(0, 120))
check('the new session title is shown', text('session-title').includes('Brand new'), text('session-title'))

// Notices surface in the toast.
send('notice', { level: 'warn', text: 'The harness runtime exited unexpectedly.' })
check('a host notice reaches the toast', text('toast').includes('exited unexpectedly'), text('toast'))

// A model change arrives as a fresh bootstrap, so the label follows the host.
send('bootstrap', {
  folderName: 'deepseek-harness',
  folderPath: '/home/dev/deepseek-harness',
  dataDir: '/home/dev/.dsh/workspaces/deepseek-harness-1a2b3c4d',
  storageLocation: 'global',
  storageOrigin: 'global per-repository store (outside the repository)',
  multiRoot: false,
  runtime: { state: 'ready', detail: 'restarted' },
  settings: {
    showReasoning: true,
    animateChunks: false,
    model: 'deepseek-v4-pro',
    provider: 'deepseek-official',
    reasoningEffort: '',
    permissionMode: 'workspace-write',
  },
  resolvedRoute: '',
  sessions: [],
  session: { id: 's-9', title: 'Model switch', createdAt: NOW, updatedAt: NOW, items: [], running: false, restored: false, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } },
})
check('a model change updates the label', text('model-label').includes('deepseek-v4-pro'), text('model-label'))
check('a cleared effort disappears from the label', !text('model-label').includes('effort high'), text('model-label'))

notes.push(`items rendered at peak: ${peakItems}`)
notes.push(`messages posted by the webview: ${[...new Set(posted.map((m) => m.type))].join(', ')}`)

console.log('')
for (const note of notes) console.log(`note: ${note}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('\nall checks passed')
