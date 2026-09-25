/**
 * Shell quoting for the integrated terminal.
 *
 * Commands are composed as a single line handed to `Terminal.sendText`, so
 * every argument is quoted for the shell the platform's default terminal runs.
 */

/** Quote one argument for the shell. */
export function quoteArg(argument: string): string {
  if (process.platform === 'win32') return `"${argument.replace(/"/g, '""')}"`
  return `'${argument.replace(/'/g, `'\\''`)}'`
}

/** Join an argv into one shell-safe command line. */
export function quoteCommand(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}
