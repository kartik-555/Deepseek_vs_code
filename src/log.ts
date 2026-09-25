/**
 * The extension's single output channel.
 *
 * Everything the runtime prints, every protocol frame when tracing is on, and
 * every lifecycle decision lands here, so "DSH: Show Diagnostics" is always the
 * one place to look when the agent misbehaves.
 */

import { window, type OutputChannel } from 'vscode'
import { redactSecrets } from './secrets'

let channel: OutputChannel | undefined

export function output(): OutputChannel {
  channel ??= window.createOutputChannel('DeepSeek Harness')
  return channel
}

export function log(message: string): void {
  output().appendLine(`[${new Date().toISOString()}] ${redactSecrets(message)}`)
}

export function trace(enabled: boolean, message: string): void {
  if (!enabled) return
  output().appendLine(`[trace ${new Date().toISOString()}] ${redactSecrets(message)}`)
}

/** Append to the channel without a timestamp, redacted. Diagnostics use this. */
export function append(line: string): void {
  output().appendLine(redactSecrets(line))
}

/** Report a failure to the channel and to the user. */
export function reportError(context: string, error: unknown): void {
  const message = redactSecrets(error instanceof Error ? error.message : String(error))
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : ''
  log(`ERROR ${context}: ${message}${stack}`)
  void window.showErrorMessage(`DeepSeek Harness: ${context} — ${message}`, 'Show Diagnostics').then((choice) => {
    if (choice === 'Show Diagnostics') output().show()
  })
}

export function disposeLog(): void {
  channel?.dispose()
  channel = undefined
}
