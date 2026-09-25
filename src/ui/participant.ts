/**
 * The `@dsh` chat participant.
 *
 * This is the native Chat-view surface, so the harness answers in the same
 * place Copilot does. It drives the same repository service as the sidebar
 * view: one DSH session per repository conversation, one transcript saved in
 * the repository, two places to type.
 *
 * The SDK protocol reports a committed assistant message per step rather than
 * token deltas, so the participant streams on step boundaries: progress while a
 * tool runs, markdown when a message or a tool result lands.
 */

import {
  chat,
  window,
  type CancellationToken,
  type ChatContext,
  type ChatRequest,
  type ChatResponseStream,
  type ChatResult,
  type Disposable,
} from 'vscode'
import { participantContext } from '../editorContext'
import type { ChatItem, TranscriptMutation } from '../dsh/transcript'
import { log } from '../log'
import type { ServiceRegistry } from '../services'

/** Commands the participant contributes, mapped to prompt prefixes. */
const COMMAND_PREFIX: Record<string, string> = {
  explain: 'Explain the following, referring to the repository context. Be concise and concrete about what the code does.',
  fix: 'Find and fix the problem described below, editing files as needed, then summarize the change.',
  test: 'Work on the testing request below: add or update tests and run them when possible.',
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function renderToolLine(item: Extract<ChatItem, { kind: 'tool' }>): string {
  const glyph = item.status === 'running' ? '…' : item.status === 'ok' ? '✓' : '✗'
  const detail = item.summary ? ` \`${truncate(item.summary.replace(/\n/g, ' '), 160)}\`` : ''
  return `${glyph} **${item.name}**${detail}`
}

export function registerParticipant(registry: ServiceRegistry): Disposable {
  const participant = chat.createChatParticipant('dsh-vscode.agent', (request, context, stream, token) =>
    handleRequest(registry, request, context, stream, token),
  )

  participant.followupProvider = {
    provideFollowups(): { prompt: string; label: string }[] {
      return [
        { prompt: 'Summarize what changed and why', label: 'Summarize the change' },
        { prompt: 'Run the repository test suite and report the failures', label: 'Run the tests' },
        { prompt: 'Review the diff for problems', label: 'Review the diff' },
      ]
    },
  }

  return participant
}

async function handleRequest(
  registry: ServiceRegistry,
  request: ChatRequest,
  _context: ChatContext,
  stream: ChatResponseStream,
  token: CancellationToken,
): Promise<ChatResult> {
  const service = registry.resolveTargetFolder(window.activeTextEditor?.document.uri)
  if (!service) {
    stream.markdown('Open a repository folder first: the harness stores every session inside the repository it works on.')
    return {}
  }

  if (request.command === 'new') {
    await service.newSession()
    stream.markdown(`Started a new DSH session for **${service.folder.name}**. Ask your next question in this thread.`)
    return {}
  }

  const prefix = request.command ? COMMAND_PREFIX[request.command] : undefined
  const prompt = request.prompt.trim()
  if (prompt.length === 0 && !prefix) {
    stream.markdown('What should I do in this repository?')
    return {}
  }

  const context = participantContext(request.references, service.settings.includeEditorContext)
  const text = prefix ? `${prefix}\n\n${prompt}`.trim() : prompt

  const sessionId = service.snapshot().id
  log(`participant turn on session ${sessionId}: ${truncate(prompt, 120).replace(/\n/g, ' ')}`)

  let finished = false
  let resolveTurn: () => void = () => undefined
  const turnDone = new Promise<void>((resolve) => {
    resolveTurn = resolve
  })
  const rendered = new Map<string, string>()

  let lastActivity = ''
  const subscription = service.onEvent((event) => {
    if (event.type === 'activity') {
      if (event.sessionId === sessionId && event.label && event.label !== lastActivity) {
        lastActivity = event.label
        stream.progress(event.label)
      }
      return
    }
    if (event.type === 'status') {
      if (event.sessionId === sessionId && !event.running && !finished) {
        finished = true
        resolveTurn()
      }
      return
    }
    if (event.type !== 'mutations' || event.sessionId !== sessionId) return
    for (const mutation of event.mutations) renderMutation(stream, rendered, mutation)
  })

  const cancellation = token.onCancellationRequested(() => {
    void service.stop().finally(() => {
      if (!finished) {
        finished = true
        stream.markdown('\n\n_Stopped._\n')
        resolveTurn()
      }
    })
  })

  try {
    await service.send({
      text,
      ...(context ? { context: context.text, contextLabel: context.label } : {}),
    })
    // The turn ends on the session's idle status; the guard keeps a lost
    // notification from hanging the chat request forever.
    await Promise.race([
      turnDone,
      new Promise<void>((resolve) => setTimeout(resolve, 30 * 60 * 1000)),
    ])
  } catch (error) {
    stream.markdown(`\n\nThe turn failed: ${error instanceof Error ? error.message : String(error)}`)
    log(`participant turn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    subscription.dispose()
    cancellation.dispose()
  }

  stream.button({ command: 'dshVscode.focusChat', title: 'Open the full DSH chat' })
  return {
    metadata: {
      sessionId,
      repository: service.folder.uri.fsPath,
    },
  }
}

function renderMutation(
  stream: ChatResponseStream,
  rendered: Map<string, string>,
  mutation: TranscriptMutation,
): void {
  switch (mutation.op) {
    case 'append':
      renderItem(stream, rendered, mutation.item)
      return
    case 'update': {
      const previous = rendered.get(mutation.id)
      const next = JSON.stringify(mutation.patch)
      if (previous === next) return
      rendered.set(mutation.id, next)
      const patch = mutation.patch as Partial<Extract<ChatItem, { kind: 'tool' }>>
      if (patch.status) {
        const name = typeof patch.name === 'string' ? patch.name : 'tool'
        const summary = typeof patch.summary === 'string' ? patch.summary : ''
        const glyph = patch.status === 'running' ? '…' : patch.status === 'ok' ? '✓' : '✗'
        stream.markdown(`\n${glyph} **${name}**${summary ? ` \`${truncate(summary.replace(/\n/g, ' '), 160)}\`` : ''}\n`)
        if (patch.status === 'error' && typeof patch.output === 'string' && patch.output.trim().length > 0) {
          stream.markdown(`\n\`\`\`text\n${truncate(patch.output, 2000)}\n\`\`\`\n`)
        }
      }
      return
    }
    case 'remove':
      rendered.delete(mutation.id)
      return
    default:
      return
  }
}

function renderItem(stream: ChatResponseStream, rendered: Map<string, string>, item: ChatItem): void {
  switch (item.kind) {
    case 'user':
      rendered.set(item.id, 'user')
      return
    case 'assistant': {
      rendered.set(item.id, 'assistant')
      if (item.reasoning.trim().length > 0) {
        stream.markdown(`\n**Reasoning**\n\n${quoteBlock(truncate(item.reasoning, 4000))}\n\n`)
      }
      if (item.text.trim().length > 0) {
        stream.markdown(`${item.text.trim()}\n\n`)
      }
      return
    }
    case 'tool':
      rendered.set(item.id, JSON.stringify({ status: item.status }))
      if (item.status === 'running') {
        stream.progress(`${item.name}: ${truncate(item.summary || 'running', 120)}`)
        return
      }
      stream.markdown(`\n${renderToolLine(item)}\n`)
      if (item.status === 'error' && item.output.trim().length > 0) {
        stream.markdown(`\n\`\`\`text\n${truncate(item.output, 2000)}\n\`\`\`\n`)
      }
      return
    case 'subagent':
      rendered.set(item.id, 'subagent')
      stream.markdown(`\n↳ subagent ${item.status}: ${truncate(item.summary || item.childSessionId, 300)}\n`)
      return
    case 'notice':
      rendered.set(item.id, 'notice')
      stream.markdown(`\n> ${item.level === 'error' ? '**Error:** ' : item.level === 'warn' ? '**Warning:** ' : ''}${item.text}\n`)
      return
    default:
      return
  }
}
