/**
 * Locating a runnable DeepSeek Harness runtime.
 *
 * The extension never bundles the harness. It launches whatever `dsh` the
 * machine already has, preferring, in order:
 *
 * 1. `dshVscode.dshPath`
 * 2. `$DSH_BIN`
 * 3. a `dsh` executable on `PATH`
 * 4. a source checkout (`node <checkout>/apps/cli/lib/bin.js`), from
 *    `dshVscode.dshCheckout`, `$DSH_CHECKOUT`, or a filesystem probe
 * 5. `npx -y @deepseek-ai/dsh`, which downloads the published package
 */

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

/** The minimum Node.js version the harness supports. */
export const MIN_NODE = [22, 19, 0] as const

export interface LaunchCommand {
  /** Executable to spawn. */
  file: string
  /** Arguments that select the runtime, before profile flags. */
  args: string[]
  /** Human-readable description of how the runtime was found. */
  origin: string
  /** Directory an `npx` fallback resolves the package from. */
  npxCwd?: string
}

export interface LaunchRequest {
  workspaceRoot: string
  /** `dshVscode.dshPath`, empty when unset. */
  dshPath: string
  /** `dshVscode.dshCheckout`, empty when unset. */
  dshCheckout: string
  /** `dshVscode.dshNode`, empty to auto-detect. */
  dshNode?: string
  /** `$PATH` used for the executable probe. */
  pathEnv?: string
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate)
    if (!stat.isFile()) return false
    // Bit 0o111 anywhere in the mode marks an executable on POSIX; on Windows
    // the shebang/extension check below is what matters.
    return process.platform === 'win32' || (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Find `dsh` on `PATH`, honouring Windows executable suffixes. */
export function findOnPath(name: string, pathEnv = process.env.PATH ?? ''): string | undefined {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/** Parse `v22.19.0` into comparable numbers. */
export function parseNodeVersion(text: string): [number, number, number] | undefined {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function atLeast(version: readonly [number, number, number], minimum: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = version[i] ?? 0
    const b = minimum[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

interface NodeProbe {
  file: string
  version: string
}

let probed = false
let cachedNode: NodeProbe | undefined
let cachedTooOld: NodeProbe | undefined

function probeNode(file: string): NodeProbe | undefined {
  try {
    const version = execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
    return parseNodeVersion(version) ? { file, version } : undefined
  } catch {
    return undefined
  }
}

/**
 * Pick a Node.js binary that satisfies the harness engine range. The extension
 * host's own runtime is the last resort, because Electron's bundled Node can
 * lag the harness requirement.
 */
export function findNode(preferred?: string): NodeProbe | undefined {
  // An explicit setting always wins, and is validated before it is trusted.
  const explicit = preferred?.trim()
  if (explicit) {
    const probe = probeNode(explicit)
    const parsed = probe ? parseNodeVersion(probe.version) : undefined
    if (probe && parsed && atLeast(parsed, MIN_NODE)) return probe
  }
  if (probed) return cachedNode
  probed = true
  const candidates: string[] = []
  const onPath = findOnPath('node')
  if (onPath) candidates.push(onPath)
  if (process.env.DSH_NODE) candidates.push(process.env.DSH_NODE)
  if (process.env.FNM_MULTISHELL_PATH) candidates.push(join(process.env.FNM_MULTISHELL_PATH, 'bin', 'node'))
  if (process.env.NVM_BIN) candidates.push(join(process.env.NVM_BIN, 'node'))
  candidates.push(process.execPath)

  for (const candidate of candidates) {
    const probe = probeNode(candidate)
    if (!probe) continue
    const parsed = parseNodeVersion(probe.version)
    if (parsed && atLeast(parsed, MIN_NODE)) {
      cachedNode = probe
      return cachedNode
    }
    cachedTooOld ??= probe
  }
  return undefined
}

/** The first runtime found that is too old, for diagnostics. */
export function findTooOldNode(): NodeProbe | undefined {
  if (!probed) findNode()
  return cachedTooOld
}

/** Candidate checkout directories, most specific first. */
export function checkoutCandidates(workspaceRoot: string): string[] {
  const home = homedir()
  const parent = resolve(workspaceRoot, '..')
  const names = ['deepseek-harness', 'DeepSeek-Harness', 'dsh']
  const bases = [parent, workspaceRoot, join(home, 'Documents', 'PRO'), home, join(home, 'src'), join(home, 'code'), join(home, 'projects')]
  const candidates: string[] = []
  for (const base of bases) {
    for (const name of names) {
      const candidate = join(base, name)
      if (!candidates.includes(candidate)) candidates.push(candidate)
    }
  }
  return candidates
}

/** True when `dir` looks like a built DeepSeek Harness checkout. */
export function checkoutEntry(dir: string): string | undefined {
  const entry = join(dir, 'apps', 'cli', 'lib', 'bin.js')
  return existsSync(entry) ? entry : undefined
}

/**
 * Resolve the runtime launch command. Never throws: when nothing is found it
 * returns the `npx` fallback so the failure surfaces as a concrete process
 * error the user can act on.
 */
export function resolveLaunch(request: LaunchRequest): LaunchCommand {
  const node = findNode(request.dshNode)
  const nodeFile = node?.file ?? process.execPath
  const nodeNote = node ? ` (${node.version})` : ' (extension host runtime)'

  const explicit = request.dshPath.trim()
  if (explicit.length > 0) {
    const resolved = explicit.includes('/') || explicit.includes('\\') ? resolve(explicit) : findOnPath(explicit) ?? explicit
    if (resolved.endsWith('.js') || resolved.endsWith('.mjs') || resolved.endsWith('.cjs')) {
      return { file: nodeFile, args: [resolved], origin: `dshVscode.dshPath script${nodeNote}` }
    }
    return { file: resolved, args: [], origin: 'dshVscode.dshPath' }
  }

  const envBin = process.env.DSH_BIN?.trim()
  if (envBin) {
    const resolved = envBin.includes('/') || envBin.includes('\\') ? resolve(envBin) : findOnPath(envBin) ?? envBin
    if (resolved.endsWith('.js') || resolved.endsWith('.mjs') || resolved.endsWith('.cjs')) {
      return { file: nodeFile, args: [resolved], origin: `$DSH_BIN script${nodeNote}` }
    }
    return { file: resolved, args: [], origin: '$DSH_BIN' }
  }

  const onPath = findOnPath('dsh')
  if (onPath) return { file: onPath, args: [], origin: 'dsh on PATH' }

  const configuredCheckout = request.dshCheckout.trim()
  const checkouts = configuredCheckout.length > 0
    ? [resolve(configuredCheckout)]
    : [
        ...(process.env.DSH_CHECKOUT ? [resolve(process.env.DSH_CHECKOUT)] : []),
        ...checkoutCandidates(request.workspaceRoot),
      ]
  for (const dir of checkouts) {
    const entry = checkoutEntry(dir)
    if (entry) {
      return { file: nodeFile, args: [entry], origin: `checkout at ${dir}${nodeNote}` }
    }
  }

  const npx = findOnPath('npx')
  return {
    file: npx ?? (process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    args: ['-y', '@deepseek-ai/dsh@latest'],
    origin: 'npx @deepseek-ai/dsh (not installed locally)',
    npxCwd: request.workspaceRoot,
  }
}

/** Absolute path without relying on `path.resolve` for display purposes. */
export function displayPath(path: string): string {
  const home = homedir()
  if (!isAbsolute(path)) return path
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}
