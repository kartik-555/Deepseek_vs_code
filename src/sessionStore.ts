/**
 * Repository-local chat history.
 *
 * The harness already persists its own session logs under
 * `<dataDir>/sessions`. This store keeps the extension's presentation layer —
 * the folded transcript, its title, and its timestamps — beside them, so
 * reopening a repository reopens the conversation that belongs to it.
 *
 * Layout:
 *
 * ```text
 * <dataDir>/vscode/index.json          session summaries, newest first
 * <dataDir>/vscode/sessions/<id>.json  one full transcript
 * ```
 *
 * Writes are atomic (temp file + rename); a torn transcript can never replace a
 * good one.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ChatItem } from './dsh/transcript'
import type { RepoDataLayout } from './dsh/workspace'

export interface StoredSession {
  version: 1
  id: string
  title: string
  createdAt: number
  updatedAt: number
  workspaceRoot: string
  items: ChatItem[]
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  itemCount: number
}

const INDEX_VERSION = 1

interface IndexFile {
  version: number
  sessions: SessionSummary[]
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

export class SessionStore {
  readonly #sessionsDir: string
  readonly #indexFile: string
  #index: SessionSummary[] | undefined

  constructor(private readonly layout: RepoDataLayout) {
    this.#sessionsDir = join(layout.extension, 'sessions')
    this.#indexFile = join(layout.extension, 'index.json')
  }

  list(): SessionSummary[] {
    this.#index ??= this.#readIndex()
    return [...this.#index].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Load a transcript, or `undefined` when it is missing or unreadable. */
  load(id: string): StoredSession | undefined {
    const file = this.#fileFor(id)
    if (!existsSync(file)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredSession
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  save(session: StoredSession): SessionSummary {
    mkdirSync(this.#sessionsDir, { recursive: true })
    const file = this.#fileFor(session.id)
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(session), 'utf8')
    renameSync(temporary, file)

    const summary: SessionSummary = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      itemCount: session.items.length,
    }
    const index = this.list().filter((entry) => entry.id !== session.id)
    index.push(summary)
    this.#writeIndex(index)
    return summary
  }

  delete(id: string): void {
    const file = this.#fileFor(id)
    try {
      rmSync(file, { force: true })
    } catch {
      // Ignore: the transcript may already be gone.
    }
    this.#writeIndex(this.list().filter((entry) => entry.id !== id))
  }

  #fileFor(id: string): string {
    return join(this.#sessionsDir, `${safeId(id)}.json`)
  }

  #readIndex(): SessionSummary[] {
    if (existsSync(this.#indexFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.#indexFile, 'utf8')) as IndexFile
        if (parsed && Array.isArray(parsed.sessions)) {
          return parsed.sessions.filter((entry) => typeof entry?.id === 'string')
        }
      } catch {
        // Fall through to a rebuild.
      }
    }
    return this.#rebuildIndex()
  }

  /** Recover summaries from transcripts, for a deleted or corrupt index. */
  #rebuildIndex(): SessionSummary[] {
    if (!existsSync(this.#sessionsDir)) return []
    const summaries: SessionSummary[] = []
    for (const entry of readdirSync(this.#sessionsDir)) {
      if (!entry.endsWith('.json')) continue
      const id = basename(entry, '.json')
      const session = this.load(id)
      if (!session) continue
      summaries.push({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        itemCount: session.items.length,
      })
    }
    this.#writeIndex(summaries)
    return summaries
  }

  #writeIndex(summaries: SessionSummary[]): void {
    mkdirSync(this.layout.extension, { recursive: true })
    const payload: IndexFile = { version: INDEX_VERSION, sessions: summaries }
    const temporary = `${this.#indexFile}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(temporary, this.#indexFile)
    } catch {
      // A failed index write must not break the turn; the next save retries.
    }
    this.#index = summaries
  }
}
