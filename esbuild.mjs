import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')
const production = process.argv.includes('--production') || !watch

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  mainFields: ['module', 'main'],
  external: ['vscode'],
  sourcemap: !production,
  logLevel: 'info',
}

/**
 * Two builds: the extension entry point VS Code loads (shipped), and a Node
 * entry point for the runtime checks in `test/` that exercise the same harness
 * layer the extension uses (kept out of the VSIX).
 */
const targets = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.cjs',
    minify: production,
    banner: { js: '/* DeepSeek Harness for VS Code - generated bundle, see src/ */' },
  },
  {
    ...shared,
    // The check uses top-level await, so it ships as ESM even though the
    // extension itself must be CommonJS for VS Code's loader.
    entryPoints: ['test/e2e-runtime.ts'],
    outfile: 'build/test-e2e.mjs',
    format: 'esm',
    minify: false,
    banner: { js: '/* DeepSeek Harness runtime check - generated from test/e2e-runtime.ts */' },
  },
]

if (watch) {
  for (const target of targets) {
    const ctx = await context(target)
    await ctx.watch()
  }
  console.log('[esbuild] watching src/ and test/')
} else {
  for (const target of targets) {
    await build(target)
  }
}
