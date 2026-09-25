/**
 * Typed access to this extension's settings.
 *
 * Every setting is read through the workspace configuration so a change takes
 * effect on the next runtime start without a reload.
 */

import { workspace, type WorkspaceFolder } from 'vscode'
import type { StorageLocation } from './dsh/workspace'

export interface DshSettings {
  dshPath: string
  dshCheckout: string
  dshNode: string
  dshHome: string
  dataDir: string
  storageLocation: StorageLocation
  provider: string
  model: string
  reasoningEffort: string
  maxTokens: number
  permissionMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  autoStart: boolean
  showReasoning: boolean
  animateChunks: boolean
  includeEditorContext: boolean
  userPatch: string
  extraArgs: string[]
  webUiPort: number
  webUiTrustedHosts: string[]
  trace: boolean
}

const SECTION = 'dshVscode'

const LOCATIONS: readonly StorageLocation[] = ['global', 'gitdir', 'repository', 'custom']

function readStorageLocation(value: string): StorageLocation {
  return (LOCATIONS as readonly string[]).includes(value) ? (value as StorageLocation) : 'global'
}

/** Where a repository's harness data can live, for prompts and quick picks. */
export const STORAGE_LOCATIONS = LOCATIONS

export function readSettings(folder?: WorkspaceFolder): DshSettings {
  const config = workspace.getConfiguration(SECTION, folder?.uri ?? null)
  const permissionMode = config.get<string>('permissionMode', 'workspace-write')
  return {
    dshPath: config.get<string>('dshPath', '').trim(),
    dshCheckout: config.get<string>('dshCheckout', '').trim(),
    dshNode: config.get<string>('dshNode', '').trim(),
    dshHome: config.get<string>('dshHome', '').trim(),
    dataDir: config.get<string>('dataDir', '.dsh').trim() || '.dsh',
    storageLocation: readStorageLocation(config.get<string>('storageLocation', 'global')),
    provider: config.get<string>('provider', 'deepseek-official').trim() || 'deepseek-official',
    model: config.get<string>('model', 'deepseek-flash').trim() || 'deepseek-flash',
    reasoningEffort: config.get<string>('reasoningEffort', '').trim(),
    maxTokens: Math.max(0, Math.floor(config.get<number>('maxTokens', 0))),
    permissionMode:
      permissionMode === 'read-only' || permissionMode === 'danger-full-access' ? permissionMode : 'workspace-write',
    autoStart: config.get<boolean>('autoStart', true),
    showReasoning: config.get<boolean>('showReasoning', true),
    animateChunks: config.get<boolean>('animateChunks', false),
    includeEditorContext: config.get<boolean>('includeEditorContext', true),
    userPatch: config.get<string>('userPatch', 'dsh.patch.yml').trim(),
    extraArgs: config.get<string[]>('extraArgs', []).filter((value) => typeof value === 'string' && value.length > 0),
    webUiPort: Math.max(1, Math.min(65535, Math.floor(config.get<number>('webUi.port', 3080)))),
    webUiTrustedHosts: config.get<string[]>('webUi.trustedHosts', []).filter((value) => typeof value === 'string' && value.length > 0),
    trace: config.get<boolean>('trace', false),
  }
}

/** True when any setting that requires a runtime restart has changed. */
export function requiresRuntimeRestart(event: { affectsConfiguration(section: string): boolean }): boolean {
  const keys = [
    'dshPath',
    'dshCheckout',
    'dshNode',
    'dshHome',
    'dataDir',
    'storageLocation',
    'provider',
    'model',
    'reasoningEffort',
    'maxTokens',
    'permissionMode',
    'userPatch',
    'extraArgs',
  ]
  return keys.some((key) => event.affectsConfiguration(`${SECTION}.${key}`))
}
