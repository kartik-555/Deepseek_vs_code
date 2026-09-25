# DeepSeek Harness for VS Code

Run the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
coding agent inside VS Code, the way you run Copilot Chat — with one difference
that matters: **every conversation and session log is kept per repository**, in a
store you choose, by default *outside* the repository entirely so nothing ever
lands in your working tree or your commits.

The extension is a client. It does not bundle or reimplement the harness: it
launches the `dsh` you already have as `dsh --profile sdk` and drives it over the
harness SDK's JSON-RPC protocol, exactly as the official SDK clients do.

```
VS Code  ─┬─ sidebar chat  (webview)      ─┐
          ├─ @dsh in the Chat view          ├─ HarnessService ─ dsh --profile sdk
          ├─ session tree                   │   (one child per repo)   │
          └─ commands / status bar         ─┘                          │
                                                                       ▼
        $DSH_HOME/workspaces/<repository>-<hash>/    ← the store, per repository
          ├─ sessions/    DSH session logs (session.v4.jsonl.zstd)
          ├─ storages/    harness key/value state
          └─ vscode/      this extension's transcripts, patch, runtime log
```

## What you get

| Surface | Where | What it is for |
| --- | --- | --- |
| **Sidebar chat** | DeepSeek Harness icon in the activity bar | The primary panel: streaming transcript, reasoning, tool timeline with collapsible output, image paste, session list, token usage, and a click-to-change model selector |
| **`@dsh` chat participant** | VS Code's own Chat view | Ask the same repository agent without leaving the Chat view; `@dsh /explain`, `/fix`, `/test`, `/new`. Tool calls and the current activity appear as progress lines |
| **DSH web UI** | `DSH: Open the DSH Web UI for this Repository` | The full official web interface, sharing this repository's session root — the only surface that can *reopen* a past session |
| **One-shot tasks** | `DSH: Run a One-Shot Task in the Terminal` | `dsh --profile headless "…"` in a terminal, for scripted or unattended work |
| **Session tree** | Beside the chat | Everything ever asked in this repository, one click to reopen |
| **Chat participant in the LM API** | `@dsh` | Same agent, same session, native Copilot-style UX |

### Following along while the agent works

Both chat surfaces say what is happening, not just that something is. The strip
above the composer in the sidebar — and a progress line in the Chat view —
tracks the session log as it lands:

| During | The strip reads |
| --- | --- |
| The model is being asked | `Thinking (step 2)…` |
| A tool is running | `Running: ls -la`, `Reading: src/dsh/runtime.ts`, `Editing: src/ui/chatView.ts`, `Searching: selectModel`, `Searching files: **/*.ts` |
| A subagent was delegated to | `Waiting for a subagent…` |
| The answer is being written | `Writing the answer…` |
| Turn finished | *(strip disappears, elapsed time stops)* |

Below it, every tool becomes a card: a spinner while it runs, a check or a cross
when it lands, its arguments and output collapsible, and **Open**/**Diff**
buttons for the files it touched. The line is derived from committed events
only, so a step that issues tool calls never claims to be "writing the answer",
and nothing is shown that the runtime did not report.

## Quick start (if `dsh` already works on this machine)

```sh
git clone <this repo> && cd Deepseek_vs_code
./scripts/install.sh          # typecheck, bundle, verify, package, install
# reload VS Code, open a repository, press Ctrl+Alt+D
```

## Full setup guide

Follow this end to end on a machine that has never run DeepSeek Harness. Each
step says how to check it worked, so a failure is caught where it happens rather
than in the chat panel.

### Step 1 — Node.js 22.19 or newer

The harness declares `"node": "^22.19.0 || >=24.0.0"`. Check what you have:

```sh
node --version        # want v22.19.0 or newer, or v24+
```

If it is older, install a supported runtime with your version manager:

```sh
# fnm
fnm install 22 && fnm use 22

# nvm
nvm install 22 && nvm use 22
```

The extension looks for a suitable Node on `PATH`, then `$DSH_NODE`, then
`$FNM_MULTISHELL_PATH/bin`, then `$NVM_BIN`, and only then falls back to the
extension host's own runtime — which can be too old. `DSH: Show Diagnostics`
prints which one it chose, and pins it with `dshVscode.dshNode` if you need to.

### Step 2 — Install DeepSeek Harness

Pick one. The extension works with all three; only the launch command differs.

**A. Nothing installed (npx).** The extension can run the published package
directly, and this is also the quickest way to try the harness on its own:

```sh
npx -y @deepseek-ai/dsh web
```

**B. Global npm install.** Best when you want `dsh` available everywhere:

```sh
npm install -g @deepseek-ai/dsh
dsh --version
```

**C. From source.** This is the newest code (the tree runs ahead of the
published release):

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web --no-open     # confirms the build boots; Ctrl+C when it prints its URL
```

The extension auto-detects a checkout beside the workspace, in
`~/Documents/PRO`, `~/src`, `~/code`, or `~/projects`, and launches it as
`node <checkout>/apps/cli/lib/bin.js`. You can also point at it explicitly with
`dshVscode.dshCheckout`.

### Step 3 — Give the harness a model credential

The extension never handles credentials; it launches the harness, and the
harness resolves its own. Configure it once, in the harness's own UI:

```sh
npx -y @deepseek-ai/dsh web      # or: dsh web
```

That opens `http://127.0.0.1:3080`. Then:

1. Open **Settings → Models**.
2. In the **DeepSeek** card, paste your API key and save.

   Keys are **write-only**: the page gets back a redacted descriptor, never the
   literal secret, which is stored in `$DSH_HOME/.credentials.yaml` (`~/.dsh`,
   mode `0600`). Your settings file keeps only a credential *reference*.

3. For a third-party provider, choose **Add model provider**, pick a shipped id
   (`anthropic`, `openai`, `moonshotai` for Kimi, `zai` for GLM), and paste its
   key. For a relay, a company gateway, or a self-hosted server, use the
   **Custom model API** form: provider id, base URL, API protocol
   (`openai-completions`, `openai-responses`, or `anthropic-messages`),
   credential, and at least one model. **Fetch available models** can ask an
   endpoint what it serves.

**Alternative: environment variables.** The harness resolves named refs from the
environment too, so an exported key works without touching the credential file:

```sh
export DEEPSEEK_API_KEY=...        # the built-in DeepSeek route
export GOOGLE_API_KEY=...          # a pi-ai google route
```

Export it in the shell that starts VS Code (or put it in `$DSH_HOME/.env`).
The extension passes the parent environment to the runtime unchanged and never
reads or writes these values itself.

**Check the credential works, before involving the editor:**

```sh
npx -y @deepseek-ai/dsh --profile headless "reply with the single word: ready"
```

A one-word answer means the runtime, the model route, and the credential are all
good. Errors here are harness errors, and fixing them here is much easier than
reading them out of a chat panel.

### Step 4 — Install the extension

```sh
cd Deepseek_vs_code            # the repository root, where package.json lives
npm install
npm run package                # typecheck, bundle, verify, build the VSIX
code --install-extension "$PWD/dsh-vscode-0.1.0.vsix"
```

The VSIX is written to the **repository root**, next to `package.json` — not
into `scripts/`, `dist/`, or `media/`. Installing with a relative path works only
from that directory, so `"$PWD/…"` is the form that always works; the VSIX is
Git-ignored and never committed.

Or `./scripts/install.sh`, which runs every check first and skips them with
`--no-verify`. In VS Code: **Extensions → ⋯ → Install from VSIX…** does the same
job, and `--install-extension` may need `--force` to replace an older build.

Reload the window afterwards: **Developer: Reload Window**. To hack on the
extension itself, open this folder in VS Code and press `F5` instead.

### Step 5 — Point the extension at your runtime

It resolves `dsh` in this order, and uses the first that works:

| Order | Source | Setting |
| --- | --- | --- |
| 1 | An explicit path or script | `dshVscode.dshPath` |
| 2 | `$DSH_BIN` | environment |
| 3 | `dsh` on `PATH` | — |
| 4 | A source checkout run through Node | `dshVscode.dshCheckout`, `$DSH_CHECKOUT`, or auto-detection |
| 5 | `npx -y @deepseek-ai/dsh@latest` | downloads on first launch |

Nothing to configure if you installed the harness globally or built a checkout
next to this project. Otherwise set one:

```jsonc
// .vscode/settings.json (workspace) or User settings
{
  "dshVscode.dshCheckout": "/home/me/src/deepseek-harness",
  "dshVscode.dshNode": "/home/me/.local/share/fnm/node-versions/v22.19.0/installation/bin/node"
}
```

### Step 6 — Open a repository and chat

1. Open a repository folder in VS Code. On activation the extension starts one
   runtime for the window and stores this repository's data — by default in
   `~/.dsh/workspaces/<repository>-<hash>/`, so your working tree stays clean.
2. Click the **DeepSeek Harness** icon in the activity bar, press `Ctrl+Alt+D`
   (`Cmd+Alt+D`), or run **`DSH: Focus Chat`**.
3. Confirm the status bar shows `$(sparkle) DSH` — that is a completed handshake
   with the runtime. `$(error)` means startup failed: run
   **`DSH: Show Diagnostics`**, which prints the resolved `dsh`, the Node
   version, the store path, the model route, and the runtime's stderr tail.
4. Ask something small: *"What is in this repository? One paragraph."* The
   transcript shows the answer, and each tool the agent used as a collapsible
   card.
5. `git status` should show no new harness files. If it does,
   `dshVscode.storageLocation` is `repository` — see
   [Where a repository's workspace lives](#where-a-repositorys-workspace-lives).

### Step 7 — Pick the model, and optionally the effort

Click the model name above the composer (or run **`DSH: Select Model`**, or use
the chip button in the panel title bar). See
[Choosing a model](#choosing-a-model).

## Choosing a model

Open the picker by clicking the model name above the composer, running
**`DSH: Select Model`**, or using the chip button in the panel title bar. The
picker offers, in this order:

| Row | What it is |
| --- | --- |
| **Running now** | The route the *live runtime* reported on this session's last request, with its effort, output cap, and context window. Read from the session's own `request/header` event, never guessed from settings. |
| **Suggested models** | The shipped catalog for the current provider route, each marked with what has been verified on this machine. |
| **Enter a model id…** | Anything the catalog does not list. A restart only proves the provider route resolved, so an unknown id surfaces on the first request — or immediately through **Verify suggested models…**. |
| **Change provider route…** | `deepseek-official`, a pi-ai profile name such as `anthropic`, `openai`, `moonshotai`, or `zai`, or a custom gateway id. |
| **Change reasoning effort…** | `minimal`/`low`/`medium`/`high`/`max`, or *model default* to send none. |
| **Verify suggested models…** | Sends one minimal request per suggestion — 64 output tokens, *"reply with the single word: ok"* — and reports what the runtime did. It costs a few hundred input tokens per model, and its sessions are deleted afterwards. |
| **Reported by the provider** | Any model id the provider itself named when it refused a route, offered back as a row. |

Three honest limits, because the SDK wire has no "list models" request:

- **The suggested list is a starting point, not the truth.** It mirrors the
  harness's default DeepSeek catalog, and selecting from it proves nothing on
  its own.
- **The setup handshake does not validate a model id.** This is measured, not
  assumed: `initialize` accepts `definitely-not-a-model` and only checks that an
  adapter exists for the provider. So "verified" in the picker means something
  stronger — *this machine sent a real request on that route and the turn
  completed*, with the token cap above. The test suite pins both halves.
- **A refusal still teaches the picker.** DeepSeek answers an unknown model with
  `The supported API model names are deepseek-flash, deepseek-v4-pro, but you
  passed …`; the extension reads model ids out of that message and offers them
  as rows marked *reported by the provider*. Third-party catalogs you build in
  **Settings → Models** stay in the harness, so type those ids — they are
  checked the same way.

Selecting a route writes the setting and restarts the runtime, which validates
the provider route (not the model id). Rows and messages keep the three states
apart: **verified** (a real request completed), **accepted** (the runtime
restarted on it), **refused** (with the adapter's reason). If a route is refused,
the extension offers **Revert to previous model**, so a bad id cannot leave you
with a dead panel.

The equivalent settings, if you prefer files:

```jsonc
{
  "dshVscode.provider": "deepseek-official",
  "dshVscode.model": "deepseek-v4-pro",
  "dshVscode.reasoningEffort": "high",   // "" keeps the model default
  "dshVscode.maxTokens": 0               // 0 keeps the model default
}
```

## Credentials and key safety

**This extension has no API-key setting, and it never asks for, stores,
transmits, or embeds a key.** There is no key in the source, in the bundle, in
the generated patch, or in any file it writes.

The only places the words appear are the arithmetic that counts tokens
(`inputTokens`, `maxTokens`), the credential *names* in prose and tooltips, and
`src/secrets.ts`, which exists to redact them. Grep for a key-shaped value
rather than a word:

```sh
grep -rnE "sk-[A-Za-z0-9]{12}|AIza[0-9A-Za-z_-]{20}|DEEPSEEK_API_KEY\s*=\s*[^ ]" src/ media/ package.json
```

On this tree that prints exactly one line: a comment in `src/secrets.ts` naming
the assignment pattern it redacts. No key-shaped value exists anywhere in the
extension.

Where keys actually live — the harness owns all of it:

| Source | Path / name | Written by |
| --- | --- | --- |
| Credential store | `$DSH_HOME/.credentials.yaml` (default `~/.dsh`, mode `0600`) | the harness (web UI **Settings → Models**); keys are write-only there |
| Harness env file | `$DSH_HOME/.env` | you |
| Project/user `.env` fallbacks | your repository or home | you |
| Environment variables | the named refs, e.g. `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY` | you |

Harness settings and profile patches keep only the *reference* (an
`apiKeyEnv` name), never the secret. This extension contributes nothing to that
chain: it passes the parent environment through, plus `DSH_HOME` and
`DSH_PERMISSION_MODE`, and otherwise stays out of the way.

What the extension does to avoid leaking one by accident:

- **Redaction on every write.** Each line the extension writes — the output
  channel, `<store>/vscode/runtime.log`, and traced protocol frames — passes
  through pattern redaction that covers `sk-…` and `sk-ant-…` keys, Google
  `AIza…` keys, GitHub tokens, Slack tokens, `Bearer`/`Basic` headers,
  `authorization`/`api-key` fields, `*_API_KEY=…` assignments, and PEM private
  key bodies. Runtime stderr is redacted *before* it is retained, written, or
  shown, because an upstream error body can echo a credential.
- **Best-effort, not a guarantee.** A secret in an unknown shape can still get
  through. Do not paste keys into a prompt, and read the output channel before
  sharing it.

Treat the session store as sensitive in its own right: transcripts are plain
JSON and record what you asked and what the agent did. Nothing is committed by
the extension — and in `repository` mode it additionally writes
`.git/info/exclude`, which is local, never committed, and never shows as a
change.

The runtime checks follow the same rule: they use an isolated harness home under
`.test/`, **borrow the credential file by symlink instead of copying it**, and
delete the whole scratch tree when the run ends (`DSH_E2E_KEEP=1` keeps it).

## Where a repository's workspace lives

Data is always keyed by repository: two repositories never share a store, and
the same repository always resolves to the same one. What you choose is *where*
that store sits. `dshVscode.storageLocation` has four values:

| `storageLocation` | Directory | In `git status`? | Notes |
| --- | --- | --- | --- |
| `global` — **default** | `$DSH_HOME/workspaces/<repository>-<hash>` | never, it is outside the repository | Nothing is added to the checkout. The store is keyed by the repository's absolute path, so renaming or moving the folder starts a fresh store and the old one stays in `~/.dsh/workspaces` for you to delete |
| `gitdir` | `<repository>/.git/dsh` | never — Git ignores everything under `.git/` | Stays with the checkout folder, invisible to Git, not copied by `git clone` |
| `repository` | `<repository>/.dsh` | never — the extension adds it to `.git/info/exclude` **and** writes `.dsh/.gitignore` | Visible in the file tree; handy if you want to inspect or zip the sessions |
| `custom` | the path in `dshVscode.dataDir` | depends where you point it | `~`, `${workspaceFolder}`, and absolute paths are supported |

### Switching location, and moving what you already have

Run **`DSH: Change Session Storage Location`**. It shows the four destinations
with the exact resolved path for this repository, and on confirmation it

1. stops the runtime,
2. **moves** the existing data — DSH session logs, key/value storage, and your
   chat transcripts move together, so a conversation you opened before the move
   still opens after it,
3. writes the setting, and
4. restarts the runtime on the new location.

Moving is a rename when the destination is on the same filesystem, and a
copy-then-delete otherwise. An existing destination is never overwritten: you
get the reason instead.

If an earlier version of the extension left a `.dsh/` folder inside a
repository, activation offers once to move it out; declining pins
`storageLocation` to `repository` for that folder so the layout matches the data
that is already there.

### What is stored, and what stays in `DSH_HOME`

```text
<store>/
├─ sessions/     DSH session logs, grouped by project (session.v4.jsonl.zstd)
├─ storages/     harness key/value state (session projection cache)
├─ dsh.patch.yml optional: your own composition rows
└─ vscode/       this extension's own state
   ├─ index.json             session summaries
   ├─ sessions/<id>.json     full transcripts (plain JSON, easy to read)
   ├─ runtime.patch.yml      generated on every launch; do not edit
   └─ runtime.log            runtime stderr and startup failures
```

Credentials (`.credentials.yaml`), profiles, and the model cache stay in
`DSH_HOME` (`~/.dsh`) in every mode, so a key is configured once per machine and
never copied into a repository by this extension. Attachments live in
`$DSH_HOME/attachments` for the same reason: they are content-addressed and
shared across repositories.

To add harness composition of your own — MCP servers, extra plugins, a different
compaction policy — write rows in `<store>/dsh.patch.yml`. The extension appends
them after its own rows and offers to restart the runtime when you save.

## Sessions, stopping, and continuing

The SDK protocol exposes `initialize`, `session/prompt`, and `shutdown` — there is
no resume, cancel, or approval request on that wire (the harness's ACP surface
lists `session/load` as unsupported too). This extension is built around that
reality rather than pretending otherwise:

- **Stopping** a turn restarts the runtime process, because the wire has no cancel.
  Everything committed so far is already durable in `.dsh/sessions`.
- **Continuing** after a restart works: the conversation keeps its identity in the
  repository, and the next prompt carries a bounded digest of the earlier turns
  (user messages, assistant conclusions, one line per tool call, most recent
  turns prioritised) so the model carries on coherently. The transcript shows a
  notice when this happens.
- **Reopening** a stored session in the sidebar restores its full transcript and
  continues it the same way.
- **True resume** — reattaching to a session's live agent — belongs to the DSH web
  UI, which is why `DSH: Open the DSH Web UI for this Repository` is one click
  away and pointed at the same `.dsh/sessions` directory.

## Permissions

The agent runs sandboxed, controlled by `dshVscode.permissionMode`:

| Mode | Effect |
| --- | --- |
| `read-only` | Reads and analyses only; writes are refused |
| `workspace-write` (default) | Writes inside the repository; anything outside fails closed |
| `danger-full-access` | No sandbox, no approvals — the agent can run anything as you |

The SDK protocol cannot deliver an approval prompt to the extension, so an
escalation that needs one **fails closed** in `read-only` and `workspace-write`
mode: the tool returns a failure and the agent adapts. Choose
`danger-full-access` only when you accept that trade.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `dshVscode.dshPath` | `""` | Executable or entry script for `dsh` |
| `dshVscode.dshCheckout` | `""` | A harness source checkout to run through Node |
| `dshVscode.dshNode` | `""` | Node.js binary to use for a checkout |
| `dshVscode.dshHome` | `""` | `DSH_HOME`; empty inherits `~/.dsh` |
| `dshVscode.storageLocation` | `global` | `global`, `gitdir`, `repository`, or `custom` |
| `dshVscode.dataDir` | `.dsh` | The path used by `repository` and `custom` (relative to the repo, or absolute; `~`/`${workspaceFolder}` expand) |
| `dshVscode.provider` | `deepseek-official` | Provider route |
| `dshVscode.model` | `deepseek-flash` | Model |
| `dshVscode.reasoningEffort` | `""` | `minimal`…`max`; empty keeps the model default |
| `dshVscode.maxTokens` | `0` | Output cap; 0 keeps the model default |
| `dshVscode.permissionMode` | `workspace-write` | Sandbox mode |
| `dshVscode.autoStart` | `true` | Warm the runtime at activation |
| `dshVscode.showReasoning` | `true` | Render reasoning blocks |
| `dshVscode.animateChunks` | `false` | Reveal answers progressively in the sidebar (cosmetic; the transcript still stores the full text) |
| `dshVscode.includeEditorContext` | `true` | Send the active file/selection with a prompt |
| `dshVscode.userPatch` | `dsh.patch.yml` | Your composition rows, read from the data directory |
| `dshVscode.extraArgs` | `[]` | Extra `dsh` launch arguments |
| `dshVscode.webUi.port` | `3080` | Port for the web UI command |
| `dshVscode.webUi.trustedHosts` | `[]` | Extra `--trusted-host` authorities |
| `dshVscode.trace` | `false` | Log every protocol frame to the output channel |

The setting descriptions are also the reference for the four storage locations
and what each one means for Git.

## Commands

| Command | What it does |
| --- | --- |
| `DSH: Focus Chat` | Reveal the sidebar chat (`Ctrl+Alt+D`) |
| `DSH: New Session` | Start a fresh conversation in this repository |
| `DSH: Stop the Running Turn` | Restart the runtime, marking the turn stopped |
| `DSH: Restart the Harness Runtime` | Pick up settings, credentials, or a patch edit |
| `DSH: Attach Selection to DSH Chat` | Add the current selection as context |
| `DSH: Open the DSH Web UI for this Repository` | Launch the official web UI on this repo's sessions |
| `DSH: Run a One-Shot Task in the Terminal` | `dsh --profile headless "…"` in a terminal |
| `DSH: Select Model` | Pick a provider, model, and reasoning effort, with live verification |
| `DSH: Change Session Storage Location` | Move this repository's data (and switch where it lives) |
| `DSH: Reveal the Repository Session Directory` | Open the store in the file manager |
| `DSH: Show Diagnostics` | Output channel with runtime, node, and path state |

## How it is built

```text
src/
  dsh/protocol.ts     JSON-RPC framing and request bookkeeping (no VS Code imports)
  dsh/runtime.ts      one `dsh --profile sdk` child: handshake, prompts, teardown
  dsh/transcript.ts   session-log events -> chat items, plus the continuation digest
  dsh/workspace.ts    storage locations, Git exclusion, moving data, the generated patch
  dsh/locate.ts       runtime and Node.js discovery
  dsh/wire.ts         the wire vocabulary this extension reads
  harnessService.ts   one service per repository: runtime + reducer + history
  services.ts         the per-window registry of services
  sessionStore.ts     atomic repository-local transcript storage
  editorContext.ts    VS Code state -> bounded prompt context
  actions.ts          web UI, terminals, diffs, diagnostics
  ui/chatView.ts      the sidebar webview host and message protocol
  ui/participant.ts   the @dsh chat participant
  ui/sessionsView.ts  the session tree
  commands.ts         command registration
  extension.ts        activation and wiring
media/                the webview (chat.html, chat.css, chat.js) and icons
docs/webview-protocol.md   the host <-> webview contract
```

Nothing in `src/dsh/` imports `vscode`, so the harness layer is exercised
directly by the runtime checks in `test/`.

## Verification

```sh
npm run typecheck      # strict TypeScript, no emit
npm run test:smoke     # activates the real bundle against a stubbed VS Code API
npm run test:webview   # boots the real webview in a DOM and drives the protocol
npm run test:e2e       # drives the real dsh runtime: handshake, tool call, sessions
DSH_E2E_OFFLINE=1 npm run test:e2e   # discovery and pure-helper checks, no model calls
```

`test:smoke` covers activation, every contributed command, the rendered webview
document and its CSP, the bootstrap payload, editor context, the model picker's
message path, both storage locations, and shutdown. The offline suite also
asserts that credential-shaped strings are redacted and that ordinary text is
left alone.
`test:webview` loads `media/chat.*` in jsdom and asserts what a user would see
for bootstrap, mutations, updates, removal, escaping, run state, the live
activity line, the composer, and every button. The offline suite folds a whole
synthetic turn through the reducer and checks the activity line at each point;
the runtime check asserts it named a real tool during a real turn and cleared at
the end. Together they cover both ends of the host <-> webview contract without a GUI.

`test:e2e` spends a few hundred tokens: it asks the agent to list a directory and
then checks that the transcript, the tool card, the workspace, and the
repository-local session log all came out right. It also pins the protocol facts the design depends on: a session id from a
previous runtime is refused, a digest lets a fresh session answer about earlier
turns, the `initialize` handshake accepts an unknown model id (which is why the
picker verifies with a real request), an unknown model is refused with a message
naming the supported ones, and a probe leaves no sessions behind. Re-run it after
upgrading the harness.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `could not launch the DeepSeek Harness runtime` | Run `DSH: Show Diagnostics`. Set `dshVscode.dshPath` or `dshVscode.dshCheckout` explicitly. |
| `could not start` / route validation failed | Check `dshVscode.provider`/`model` against your credentials; an unsupported `reasoningEffort` is rejected at startup by design. |
| Node too old | Install Node 22.19+ and set `dshVscode.dshNode`, or pick a runtime that does not need a checkout. |
| A tool says the action was refused | Sandbox policy. Widen `dshVscode.permissionMode`, understanding the trade. |
| A model fails on the first request | Run `DSH: Select Model` → **Verify suggested models…**, which sends a 64-token probe per model and prints the adapter's own reason (including the model names the provider does accept). The picker offers to revert. |
| The model picker shows only two models | That is the harness's default DeepSeek catalog. Add providers and models in the DSH web UI (**Settings → Models**), then type the model id here, or press **Verify suggested models…** and use what the provider reports. |
| `could not start` after changing model | The runtime validates the exact route at startup by design. Revert with the prompt, or set `dshVscode.model` back. |
| Prompts fail though the panel works | The credential, not the extension: verify with `npx -y @deepseek-ai/dsh --profile headless "say ready"`. |
| The runtime exits unexpectedly | `.dsh/vscode/runtime.log` and `DSH: Show Diagnostics` hold the stderr tail. |
| Sessions disappeared | The store is keyed by repository path: check you opened the same folder. `DSH: Show Diagnostics` prints the exact store path, and `DSH: Reveal the Repository Session Directory` opens it. |
| Files appear in my repository | `dshVscode.storageLocation` is `repository` (or `custom` pointing inside). Run `DSH: Change Session Storage Location` and pick `global`; the data moves. |

## Known limitations

- **No live token streaming.** The SDK wire commits a message per model step, so a
  response appears when that step commits; the UI shows live tool activity and an
  elapsed timer meanwhile, and `dshVscode.animateChunks` can reveal a finished
  answer progressively. The official web UI is the surface for true token-level
  streaming. The activity line is likewise per step: it can say `Thinking (step
  3)…` but not what the model is thinking about.
- **No in-editor approval prompts.** Approvals fail closed (see Permissions).
- **No mid-turn cancel at the protocol level.** Stop is a runtime restart.
- **Continuation is a digest, not replay.** Very long conversations lose old
  detail when carried across a restart; the full transcript stays in the
  repository.

## License

MIT. DeepSeek Harness itself is MIT-licensed by DeepSeek AI; this extension is an
independent client and is not affiliated with DeepSeek AI.
