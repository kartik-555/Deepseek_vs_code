# DSH chat webview contract

The sidebar chat view is one webview with a strict host <-> webview message
protocol. This file is the contract: the host implementation
(`src/ui/chatView.ts`) and the webview assets (`media/chat.html`,
`media/chat.css`, `media/chat.js`) must both follow it exactly.

## Files and document shell

The host renders a document with a Content-Security-Policy that allows only the
extension's own resources plus a per-load nonce:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src {{cspSource}} data:; style-src {{cspSource}} 'unsafe-inline'; font-src {{cspSource}}; script-src 'nonce-{{nonce}}';" />
    <link rel="stylesheet" href="{{styleUri}}" />
    <title>DeepSeek Harness</title>
  </head>
  <body>
    <!-- contents of media/chat.html -->
    <script nonce="{{nonce}}" src="{{scriptUri}}"></script>
  </body>
</html>
```

`media/chat.html` therefore holds only the body markup, with no `<html>`,
`<head>`, `<script>`, or `<link>` element. `media/chat.js` must not import
anything, must not fetch anything, and must call `acquireVsCodeApi()` exactly
once at load time. No inline event handler attributes (`onclick=`) are
allowed; the CSP forbids them.

## Required DOM contract

`media/chat.html` must contain these ids, because the host styles and the
webview script both address them:

| Id | Element | Purpose |
| --- | --- | --- |
| `app` | `div` | root grid: header, session list, transcript, composer |
| `header` | `header` | folder name, session title, runtime badge, action buttons |
| `folder-name` | `span` | active repository display name |
| `session-title` | `span` | current session title |
| `runtime-badge` | `button` | runtime state; click opens diagnostics |
| `btn-sessions` | `button` | toggles the session list |
| `btn-new-session` | `button` | starts a new session |
| `btn-web-ui` | `button` | opens the DSH web UI for this repository |
| `session-panel` | `section` | session list container, toggled with `hidden` |
| `session-list` | `ul` | one `li` per session, each with an open and a delete button |
| `transcript` | `main` | the scrolling transcript |
| `empty-state` | `div` | shown when the transcript has no items |
| `composer` | `footer` | input area |
| `composer-input` | `textarea` | the prompt box |
| `btn-send` | `button` | send |
| `btn-stop` | `button` | stop the running turn |
| `btn-attach` | `button` | attach the current editor selection |
| `btn-files` | `button` | pick files to mention |
| `context-chips` | `div` | chips for attached context |
| `usage` | `span` | token usage summary |
| `toast` | `div` | transient error/info messages, `hidden` by default |

The composer must keep `composer-input` focused on `insertText` and after a
session switch, must send on `Enter` (and insert a newline on
`Shift+Enter`), and must paste images from the clipboard as base64.

## Host -> webview messages

Every message is `{ type: string, payload?: unknown }` posted with
`webview.postMessage`.

### `bootstrap`

Sent once after the webview signals `ready`.

```ts
{
  type: 'bootstrap'
  payload: {
    folderName: string        // display name of the repository
    folderPath: string        // absolute path
    dataDir: string           // absolute path of this repository's store
    storageLocation: 'global' | 'gitdir' | 'repository' | 'custom'
    storageOrigin: string     // one-line description of where the store is
    multiRoot: boolean        // true when the window has several folders
    runtime: { state: 'idle' | 'starting' | 'ready' | 'stopped' | 'failed'; detail: string }
    settings: {
      showReasoning: boolean
      animateChunks: boolean
      model: string
      provider: string
      permissionMode: string
    }
    sessions: SessionSummary[]
    activity: string          // current activity line, '' when idle
    session: SessionSnapshot  // the active session, already resumed
  }
}
```

### `session`

The active session changed (new, opened, or switched repository). Replace the
whole transcript.

```ts
{ type: 'session'; payload: { session: SessionSnapshot } }
```

### `mutations`

Append, update, or remove transcript items on the active session.

```ts
{ type: 'mutations'; payload: { sessionId: string; mutations: TranscriptMutation[] } }
```

### `status`

A turn started or finished.

```ts
{ type: 'status'; payload: { sessionId: string; running: boolean } }
```

### `activity`

What the agent is doing right now, derived by the host from the session log: a
step began (*Thinking*), a tool call is running (*Running: ls -la*, *Reading:
src/a.ts*, *Editing: …*, *Searching: …*, *Delegating to a subagent…*), or an
answer is being written. It is sent only when the line actually changes, and it
is `idle` (empty label) when nothing is running. Render it as the working
strip's text; keep a plain *Working* fallback for an idle-but-running moment.

```ts
{ type: 'activity'; payload: { sessionId: string; label: string; kind: 'idle' | 'thinking' | 'tool' | 'responding' | 'delegating'; toolName: string } }
```

### `sessions`

The stored session list changed.

```ts
{ type: 'sessions'; payload: { sessions: SessionSummary[] } }
```

### `title`

The runtime derived a title for the active session.

```ts
{ type: 'title'; payload: { sessionId: string; title: string } }
```

### `runtime`

Runtime lifecycle changed. Render it in `runtime-badge`.

```ts
{ type: 'runtime'; payload: { state: RuntimeState; detail: string } }
```

### `context`

Answer to `attachSelection` / `pickFiles`: text the host wants appended to the
composer.

```ts
{ type: 'context'; payload: { label: string; detail: string } }
```

The webview appends `detail` to the composer text (separated by a blank line
when the composer is not empty) and shows `label` as a chip.

### `insertText`

Same as `context`, for host-initiated text such as a command that pre-fills a
prompt.

### `notice`

A transient message for the `toast` element.

```ts
{ type: 'notice'; payload: { level: 'info' | 'warn' | 'error'; text: string } }
```

## Webview -> host messages

### `ready`

Sent once, after the script installs its message listener.

### `submit`

```ts
{ type: 'submit'; payload: { text: string; contextLabel?: string; images?: { data: string; mimeType: string; name?: string }[] } }
```

The webview clears the composer, then keeps the optimistic user bubble the host
echoes back through `mutations`.

### `stop`, `newSession`, `refreshSessions`, `revealDataDir`, `openWebUi`, `restartRuntime`, `showLogs`, `selectFolder`

No payload. The implementation also posts two messages that reach the host
through the same handlers as the buttons above:

| Message | Sent by |
| --- | --- |
| `attachSelection` | the composer's attach button (`btn-attach`) |
| `pickFiles` | the composer's file button (`btn-files`) |

### `openSession` / `deleteSession`

```ts
{ type: 'openSession'; payload: { id: string } }
{ type: 'deleteSession'; payload: { id: string } }
```

### `openFile` / `openDiff`

```ts
{ type: 'openFile'; payload: { path: string } }
{ type: 'openDiff'; payload: { path: string } }
```

`openDiff` is offered on a tool card whose name is `write`, `edit`, or
`multi_edit`; it asks the host to diff the file against Git.

## Shared data shapes

These mirror `src/dsh/transcript.ts` and `src/harnessService.ts`.

```ts
type Usage = {
  inputTokens: number; outputTokens: number; cacheReadTokens: number
  cacheWriteTokens: number; totalTokens: number
}

type ChatItem =
  | { id: string; kind: 'user'; at: number; text: string; images: number; context: string }
  | { id: string; kind: 'assistant'; at: number; turn: number; step: number
      reasoning: string; text: string; usage?: Usage }
  | { id: string; kind: 'tool'; at: number; callId: string; name: string; summary: string
      argsText: string; status: 'running' | 'ok' | 'error'; output: string
      outputTruncated: boolean }
  | { id: string; kind: 'subagent'; at: number; childSessionId: string; provider: string
      status: 'running' | 'ok' | 'error'; summary: string }
  | { id: string; kind: 'notice'; at: number; level: 'info' | 'warn' | 'error'; text: string }

type TranscriptMutation =
  | { op: 'append'; item: ChatItem }
  | { op: 'update'; id: string; patch: Record<string, unknown> }  // shallow merge into the item
  | { op: 'remove'; id: string }

type SessionSnapshot = {
  id: string; title: string; createdAt: number; updatedAt: number
  items: ChatItem[]; running: boolean; restored: boolean; usage: Usage
}

type SessionSummary = {
  id: string; title: string; createdAt: number; updatedAt: number; itemCount: number
}
```

## Rendering requirements

- Escape every piece of model or file text before inserting it into HTML. The
  only HTML the webview generates itself is its own layout and the minimal
  markdown subset below.
- Markdown: fenced code blocks, inline code, bold, italic, strikethrough,
  links (rendered with `target="_blank"` and `rel="noreferrer"`), ATX headings,
  unordered and ordered lists, blockquotes, horizontal rules, and tables.
  Everything else stays literal text.
- Code blocks get a language label and a copy button; the copy button uses
  `navigator.clipboard.writeText` and falls back to a temporary textarea.
- Tool cards: one line with a state glyph (`running` spinner, `ok` check,
  `error` cross), the tool name, and `summary`; the arguments and the output
  live in collapsible sections and start collapsed unless the tool failed.
  Show a **Diff** button for `write`, `edit`, and `multi_edit` cards that have a
  file path in their arguments, and an **Open** button for those paths too.
- Reasoning blocks render in a collapsed `<details class="reasoning">` when
  `settings.showReasoning` is true, and not at all when it is false.
- While a turn runs, the transcript shows a working indicator with an elapsed
  timer, the composer's send button is replaced by **Stop**, and `Escape`
  triggers `stop`.
- `animateChunks` is a host-side concern; the webview only needs to render
  whatever it receives.
- Use only VS Code theme variables (`--vscode-*`) for colour, so the view
  matches the user's theme in light, dark, and high-contrast.
- The transcript must stay scrolled to the bottom while the user has not
  scrolled away, and must offer a "jump to latest" affordance when they have.
- Sessions in the panel list show the title, a relative timestamp, and the item
  count; the active session is marked as current.

## Implementation notes

These are additions the shipped implementation makes on top of the tables
above; they are part of the contract because the host and the webview must
agree on them.

- **Additional DOM ids** beyond the required table: `runtime-label`,
  `meta-line`, `model-label`, `permission-label`, `btn-refresh-sessions`,
  `btn-close-sessions`, `btn-diagnostics`, `btn-restart-runtime`,
  `btn-select-folder` (posted when `multiRoot` is true or no folder is open),
  `working`, `working-text`, `working-elapsed`, and `jump-latest`.
- **Animation.** With `animateChunks` on, the host reveals a finished answer by
  sending `update` mutations that replace an assistant item's `text` with
  progressively longer prefixes, ending with the complete text. The webview
  needs no special handling: it re-renders that item, and the stored transcript
  and the chat participant always hold the full message.
- **Item markup.** Each item is an `<article class="item item-<kind>" data-id="…">`;
  tool cards add `tool-running` / `tool-ok` / `tool-error`. Tests and future
  styling should key off those names.
- **Tool output** is visually truncated at 4000 characters (or when the host
  sets `outputTruncated`) behind a "Show all" control; an `update` mutation
  preserves the user's expanded state and any open `<details>`.
- **Usage.** Each assistant item's `usage` renders as `1.2k in · 340 out · 300
  cached`; the composer's `usage` element shows `SessionSnapshot.usage` and is
  hidden while it is zero.
