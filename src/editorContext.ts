/**
 * Turning VS Code state into prompt context.
 *
 * The agent runs in the repository root and can read files itself, so context
 * is deliberately small: the active file and selection, files the user
 * explicitly references, and nothing else. Every read is bounded, because
 * context is prepended to the prompt rather than stored as an attachment.
 */

import { readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import {
  Uri,
  workspace,
  window,
  type ChatPromptReference,
  type Location,
  type Position,
  type Range,
  type TextDocument,
} from 'vscode'

/** Total context budget handed to the model in one prompt. */
const CONTEXT_BUDGET = 48_000
const SINGLE_FILE_LIMIT = 16_000
const SELECTION_LIMIT = 8_000

/** Runtime check for a VS Code `Uri`; the public API exposes no `isUri`. */
function isUri(value: unknown): value is Uri {
  return value instanceof Uri
}

export interface ContextChunk {
  /** Short chip label, such as `src/agent.ts:12-40`. */
  label: string
  /** Text inserted into the prompt. */
  text: string
}

function relativePath(uri: Uri): string {
  const folder = workspace.getWorkspaceFolder(uri)
  return folder ? relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath
}

function lineRange(range: Range): string {
  const start = range.start.line + 1
  const end = range.end.line + 1
  return start === end ? `${start}` : `${start}-${end}`
}

function trimTo(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/** The active editor's file, language, and selection. */
export function activeEditorContext(): ContextChunk | undefined {
  const editor = window.activeTextEditor
  if (!editor) return undefined
  const document = editor.document
  const path = relativePath(document.uri)
  const lines: string[] = [
    `Active file: ${path}`,
    `Language: ${document.languageId}`,
  ]
  if (!editor.selection.isEmpty) {
    const selected = document.getText(editor.selection)
    const { text, truncated } = trimTo(selected, SELECTION_LIMIT)
    lines.push(
      `Selected lines ${lineRange(editor.selection)}:`,
      '```' + document.languageId,
      text,
      '```',
    )
    if (truncated) lines.push('(selection truncated)')
    return { label: `${path}:${lineRange(editor.selection)}`, text: lines.join('\n') }
  }
  const cursor = editor.selection.active
  lines.push(`Cursor is at line ${cursor.line + 1}, column ${cursor.character + 1}.`)
  return { label: path, text: lines.join('\n') }
}

/** Read one file as a fenced context block, honouring the budget. */
export function fileContext(uri: Uri, budget = SINGLE_FILE_LIMIT): ContextChunk | undefined {
  try {
    const stat = statSync(uri.fsPath)
    if (!stat.isFile()) return undefined
    const raw = readFileSync(uri.fsPath, 'utf8')
    const { text, truncated } = trimTo(raw, Math.min(budget, SINGLE_FILE_LIMIT))
    const label = relativePath(uri)
    const language = label.includes('.') ? (label.split('.').pop() ?? '') : ''
    return {
      label,
      text: [`File: ${label}`, '```' + language, text, truncated ? '… (truncated)' : '', '```'].filter(Boolean).join('\n'),
    }
  } catch {
    return undefined
  }
}

function documentContext(document: TextDocument, range?: Range): ContextChunk | undefined {
  const path = relativePath(document.uri)
  if (!range || range.isEmpty) return fileContext(document.uri)
  const text = document.getText(range)
  const { text: bounded, truncated } = trimTo(text, SELECTION_LIMIT)
  return {
    label: `${path}:${lineRange(range)}`,
    text: [`File: ${path} (lines ${lineRange(range)})`, '```' + document.languageId, bounded, truncated ? '… (truncated)' : '', '```']
      .filter(Boolean)
      .join('\n'),
  }
}

/** Convert chat-participant references (`#file`, `#selection`, pasted text) into context. */
export function referenceContext(references: readonly ChatPromptReference[] | undefined): ContextChunk[] {
  if (!references || references.length === 0) return []
  const chunks: ContextChunk[] = []
  let budget = CONTEXT_BUDGET
  for (const reference of references) {
    const value: unknown = reference.value
    if (budget <= 0) break
    if (isUri(value)) {
      const chunk = fileContext(value, budget)
      if (chunk) {
        chunks.push(chunk)
        budget -= chunk.text.length
      }
      continue
    }
    if (Array.isArray(value)) {
      for (const entry of value as unknown[]) {
        if (budget <= 0) break
        const chunk = locationContext(entry, budget)
        if (chunk) {
          chunks.push(chunk)
          budget -= chunk.text.length
        }
      }
      continue
    }
    const chunk = locationContext(value, budget)
    if (chunk) {
      chunks.push(chunk)
      budget -= chunk.text.length
      continue
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const { text } = trimTo(value, Math.min(budget, SELECTION_LIMIT))
      const label = reference.id || 'context'
      chunks.push({ label, text: `Context from ${label}:\n${text}` })
      budget -= text.length
    }
  }
  return chunks
}

function locationContext(value: unknown, budget: number): ContextChunk | undefined {
  if (!value || typeof value !== 'object') return undefined
  const location = value as Partial<Location>
  const uri: Uri | undefined = location.uri
  if (!isUri(uri)) return undefined
  const document = workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString())
  if (document) {
    const chunk = documentContext(document, location.range)
    if (chunk && chunk.text.length <= budget) return chunk
  }
  return fileContext(uri, budget)
}

/** Join chunks into one prompt prefix. */
export function renderContext(chunks: readonly ContextChunk[]): { text: string; label: string } | undefined {
  const usable = chunks.filter((chunk) => chunk.text.trim().length > 0)
  if (usable.length === 0) return undefined
  const text = [
    'Context from the editor:',
    ...usable.map((chunk) => chunk.text),
  ].join('\n\n')
  return { text, label: usable.map((chunk) => chunk.label).join(', ') }
}

/** Note the cursor position for a participant turn, when nothing else applies. */
export function participantContext(references: readonly ChatPromptReference[] | undefined, includeActiveEditor: boolean): { text: string; label: string } | undefined {
  const chunks = referenceContext(references)
  if (chunks.length === 0 && includeActiveEditor) {
    const active = activeEditorContext()
    if (active) chunks.push(active)
  }
  return renderContext(chunks)
}

/** Highlighted selection as prompt context, for the chat view's attach button. */
export function selectionContext(): ContextChunk | undefined {
  const editor = window.activeTextEditor
  if (!editor) return undefined
  return documentContext(editor.document, editor.selection.isEmpty ? undefined : editor.selection)
}

/** Prompt the user for files and read them as context. */
export async function pickFileContext(): Promise<ContextChunk[]> {
  const picked = await window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Attach to DSH chat',
    defaultUri: workspace.workspaceFolders?.[0]?.uri,
  })
  if (!picked || picked.length === 0) return []
  const chunks: ContextChunk[] = []
  let budget = CONTEXT_BUDGET
  for (const uri of picked) {
    if (budget <= 0) break
    const chunk = fileContext(uri, budget)
    if (chunk) {
      chunks.push(chunk)
      budget -= chunk.text.length
    }
  }
  return chunks
}

/** Display helper shared by the chat surfaces. */
export function positionLabel(position: Position): string {
  return `${position.line + 1}:${position.character + 1}`
}
