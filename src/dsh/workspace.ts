/**
 * Where a repository's harness state lives.
 *
 * A repository gets its own harness workspace, but it does not have to sit in
 * the repository's working tree. Four locations are supported, from least to
 * most visible:
 *
 * | Location | Directory | In `git status`? |
 * | --- | --- | --- |
 * | `global` (default) | `$DSH_HOME/workspaces/<repo>-<hash>` | never — outside the repository |
 * | `gitdir` | `<repo>/.git/dsh` | never — Git ignores everything under `.git/` |
 * | `repository` | `<repo>/.dsh` | never — added to `.git/info/exclude`, plus `/.dsh/.gitignore` |
 * | `custom` | any path | depends where you point it |
 *
 * All four are keyed by repository: one repository always resolves to one store,
 * and two repositories never share a store. Credentials, profiles, and the model
 * cache stay in `DSH_HOME` regardless.
 *
 * The session and storage roots are redirected by a generated Cordis patch
 * passed to every `dsh` launch, so the harness itself writes where the extension
 * tells it to.
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Where this repository's harness data is kept. */
export type StorageLocation = 'global' | 'gitdir' | 'repository' | 'custom'

/** Layout of a repository's harness data directory. */
export interface RepoDataLayout {
  /** Absolute path of the data directory itself. */
  root: string
  /** Which location rule produced `root`. */
  location: StorageLocation
  /** Redirected `session-persistence-jsonl` root. */
  sessions: string
  /** Redirected `storage-json` root. */
  storages: string
  /** Extension-owned chat history and generated files. */
  extension: string
  /** Generated patch passed to every runtime launch. */
  patchFile: string
  /** User-authored patch rows appended to the generated one. */
  userPatchFile: string
  /** Concatenated stderr and startup diagnostics. */
  logFile: string
  /** One-line description of where the data lives, for diagnostics and the UI. */
  origin: string
}

export interface LayoutRequest {
  workspaceRoot: string
  /** `dshVscode.storageLocation`. */
  location: StorageLocation
  /** `dshVscode.dataDir`: the path used by `repository` and `custom`. */
  dataDir: string
  /** `dshVscode.userPatch`: the extra-rows file, relative to the data root. */
  userPatch?: string
  /** `dshVscode.dshHome`, or `$DSH_HOME`; defaults to `~/.dsh`. */
  dshHome?: string
}

/** A YAML double-quoted scalar; JSON string escaping is valid YAML. */
function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

/** Expand `~`, `${workspaceFolder}`, and `${workspaceRoot}` in a user path. */
export function expandUserPath(value: string, workspaceRoot: string): string {
  let expanded = value.trim()
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = join(homedir(), expanded.slice(2))
  expanded = expanded.split('${workspaceFolder}').join(workspaceRoot)
  expanded = expanded.split('${workspaceRoot}').join(workspaceRoot)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspaceRoot, expanded)
}

/** Human-readable, filesystem-safe, collision-free name for a repository. */
export function repositorySlug(workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot)
  const base = basename(absolute) || 'workspace'
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace'
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}

/** The directory Git keeps for this repository, or `undefined` outside a repository. */
export function gitDirectoryOf(workspaceRoot: string): string | undefined {
  const dotGit = join(workspaceRoot, '.git')
  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) return dotGit
    if (stat.isFile()) {
      // A worktree or submodule: `.git` is a file holding `gitdir: <path>`.
      const contents = readFileSync(dotGit, 'utf8')
      const match = /^gitdir:\s*(.+)$/m.exec(contents)
      const target = match?.[1]?.trim()
      if (target) return isAbsolute(target) ? target : resolve(workspaceRoot, target)
    }
  } catch {
    // Not a repository, or unreadable.
  }
  return undefined
}

/** `$DSH_HOME`, resolved exactly as the harness resolves it: explicit, then env, then `~/.dsh`. */
export function resolveDshHome(explicit?: string): string {
  const configured = explicit?.trim()
  if (configured) return expandUserPath(configured, homedir())
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return expandUserPath(fromEnv, homedir())
  return join(homedir(), '.dsh')
}

/**
 * Resolve the data directory for a repository. Never throws: a location that
 * cannot be honoured (`gitdir` outside a repository) degrades to `global`, and
 * the returned `origin` states what actually happened so the caller can report
 * the difference.
 */
export function resolveLayout(request: LayoutRequest): RepoDataLayout {
  const workspaceRoot = resolve(request.workspaceRoot)
  const dataDir = request.dataDir.trim().length > 0 ? request.dataDir.trim() : '.dsh'
  let location = request.location
  let root: string
  let origin: string

  switch (location) {
    case 'repository': {
      root = isAbsolute(dataDir) ? resolve(dataDir) : resolve(workspaceRoot, dataDir)
      origin = 'inside the repository working tree (Git-excluded)'
      break
    }
    case 'gitdir': {
      const gitDir = gitDirectoryOf(workspaceRoot)
      if (gitDir) {
        root = join(gitDir, 'dsh')
        origin = 'inside .git, outside the working tree'
      } else {
        location = 'global'
        root = join(resolveDshHome(request.dshHome), 'workspaces', repositorySlug(workspaceRoot))
        origin = 'no Git repository found: using the global per-repository store'
      }
      break
    }
    case 'custom': {
      root = expandUserPath(dataDir, workspaceRoot)
      origin = 'custom path'
      break
    }
    case 'global':
    default: {
      location = 'global'
      root = join(resolveDshHome(request.dshHome), 'workspaces', repositorySlug(workspaceRoot))
      origin = 'global per-repository store (outside the repository)'
      break
    }
  }

  const userPatch = request.userPatch?.trim() ?? ''
  return {
    root,
    location,
    sessions: join(root, 'sessions'),
    storages: join(root, 'storages'),
    extension: join(root, 'vscode'),
    patchFile: join(root, 'vscode', 'runtime.patch.yml'),
    userPatchFile: userPatch.length === 0 ? join(root, 'dsh.patch.yml') : expandUserPath(userPatch, root),
    logFile: join(root, 'vscode', 'runtime.log'),
    origin,
  }
}

/** Create the directory tree. Idempotent. */
export function ensureLayout(layout: RepoDataLayout): void {
  for (const dir of [layout.root, layout.sessions, layout.storages, layout.extension]) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Keep the whole data directory out of Git. A single `.gitignore` holding `*`
 * covers nested files, so the repository never sees session logs or history
 * unless the user removes this file on purpose.
 */
export function ensureGitIgnored(layout: RepoDataLayout): boolean {
  const ignoreFile = join(layout.root, '.gitignore')
  const desired = '# Generated by DeepSeek Harness for VS Code: keep repository sessions out of Git.\n*\n'
  try {
    mkdirSync(layout.root, { recursive: true })
    if (existsSync(ignoreFile)) {
      const current = readFileSync(ignoreFile, 'utf8')
      if (current.includes('*')) return false
      writeFileSync(ignoreFile, `${current.trimEnd()}\n*\n`, 'utf8')
      return true
    }
    writeFileSync(ignoreFile, desired, 'utf8')
    return true
  } catch {
    return false
  }
}

const EXCLUDE_MARKER = '# DeepSeek Harness for VS Code: session storage (local only, never committed)'

/**
 * Add the data directory to `.git/info/exclude`.
 *
 * That file lives inside `.git`, is never committed, and never shows up as a
 * change, so it protects the repository without editing a tracked
 * `.gitignore`. It matters when the data directory sits in the working tree:
 * the checkout stays clean even where the generated `.dsh/.gitignore` was
 * removed. Returns true when a rule was added.
 */
export function ensureGitExcluded(workspaceRoot: string, layout: RepoDataLayout): boolean {
  const gitDir = gitDirectoryOf(workspaceRoot)
  if (!gitDir) return false
  const relative = relativeTo(workspaceRoot, layout.root)
  if (!relative) return false
  const rule = `/${relative.replace(/\/+$/, '')}/`
  const excludeFile = join(gitDir, 'info', 'exclude')
  try {
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    if (existing.split('\n').some((line) => line.trim() === rule)) return false
    mkdirSync(dirname(excludeFile), { recursive: true })
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
    writeFileSync(excludeFile, `${existing}${separator}${EXCLUDE_MARKER}\n${rule}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** POSIX-style path of `target` relative to `base`, or `undefined` when outside it. */
export function relativeTo(base: string, target: string): string | undefined {
  const from = resolve(base).split(/[\\/]/).filter(Boolean)
  const to = resolve(target).split(/[\\/]/).filter(Boolean)
  if (to.length <= from.length) return undefined
  for (let index = 0; index < from.length; index += 1) {
    if (from[index] !== to[index]) return undefined
  }
  return to.slice(from.length).join('/')
}

export interface PatchOptions {
  /** Also redirect key/value storage; the web UI shares it when launched with the same patch. */
  redirectStorage?: boolean
}

/**
 * Write the generated patch and return its path. Rows from the repository user
 * patch are appended after the extension's own rows.
 */
export function writeRuntimePatch(layout: RepoDataLayout, options: PatchOptions = {}): string {
  ensureLayout(layout)
  const rows: string[] = [
    '# Generated by DeepSeek Harness for VS Code. Do not edit: it is rewritten on every launch.',
    `# Repository data directory: ${layout.root}`,
    `# Location: ${layout.origin}`,
    `# Anything in here is Git-ignored. Add extra rows in ${layout.userPatchFile}.`,
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${yamlScalar(layout.sessions)}`,
  ]
  if (options.redirectStorage !== false) {
    rows.push(
      '- id: storage-json',
      '  config:',
      `    root: ${yamlScalar(layout.storages)}`,
    )
  }
  rows.push('')
  let userRows = ''
  if (existsSync(layout.userPatchFile)) {
    try {
      userRows = readFileSync(layout.userPatchFile, 'utf8')
    } catch {
      userRows = ''
    }
  }
  if (userRows.trim().length > 0) {
    rows.push('# --- rows from the repository user patch ---', userRows.trimEnd(), '')
  }
  writeFileSync(layout.patchFile, rows.join('\n'), 'utf8')
  return layout.patchFile
}

export interface MoveResult {
  moved: boolean
  reason?: string
}

/**
 * Move a data directory to another location, preserving sessions and history.
 *
 * A rename is tried first: atomic and cheap on one filesystem. Across
 * filesystems the tree is copied first and removed only after the copy
 * succeeds. An existing destination is never overwritten.
 */
export function moveDataDirectory(from: string, to: string): MoveResult {
  if (resolve(from) === resolve(to)) return { moved: false, reason: 'already at that location' }
  if (!existsSync(from)) return { moved: false, reason: 'there is nothing to move yet' }
  if (existsSync(to)) return { moved: false, reason: `${to} already exists` }
  try {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    return { moved: true }
  } catch {
    // Different filesystem, or a rename the OS refused: copy, then delete.
  }
  try {
    cpSync(from, to, { recursive: true, errorOnExist: false, force: false })
    rmSync(from, { recursive: true, force: true })
    return { moved: true }
  } catch (error) {
    return { moved: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Remove the artifacts a route probe leaves behind.
 *
 * A probe that sends a minimal turn creates a session like any other, under
 * `<root>/sessions/<project>/<id>`, plus a projection-cache entry. Probe ids
 * carry a recognizable prefix, and this removes exactly those, so verifying a
 * model never accumulates junk sessions in the repository's store.
 *
 * Returns the number of removed entries.
 */
export function pruneProbeArtifacts(root: string, idPrefix: string): number {
  let removed = 0
  const sessionsRoot = join(root, 'sessions')
  if (existsSync(sessionsRoot)) {
    for (const project of safeReadDir(sessionsRoot)) {
      const projectDir = join(sessionsRoot, project)
      for (const entry of safeReadDir(projectDir)) {
        if (!entry.startsWith(idPrefix)) continue
        try {
          rmSync(join(projectDir, entry), { recursive: true, force: true })
          removed += 1
        } catch {
          // A probe artifact that cannot be removed is harmless.
        }
      }
    }
  }
  const cacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
  if (existsSync(cacheRoot)) {
    for (const entry of safeReadDir(cacheRoot)) {
      if (!entry.startsWith(idPrefix)) continue
      try {
        rmSync(join(cacheRoot, entry), { force: true })
        removed += 1
      } catch {
        // Same: best effort.
      }
    }
  }
  return removed
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** True when a directory holds harness data worth keeping. */
export function hasHarnessData(path: string): boolean {
  return existsSync(join(path, 'sessions')) || existsSync(join(path, 'vscode')) || existsSync(join(path, 'storages'))
}
