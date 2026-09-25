#!/usr/bin/env bash
# Build, verify, package, and install the DeepSeek Harness extension for VS Code.
#
#   ./scripts/install.sh              # typecheck, checks, package, install
#   ./scripts/install.sh --no-verify  # skip the smoke and runtime checks
#   ./scripts/install.sh --package-only
#
# The installed extension is a normal local extension: uninstall it with
# `code --uninstall-extension deepseek-harness.dsh-vscode`.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

verify=1
package_only=0
for argument in "$@"; do
  case "$argument" in
    --no-verify) verify=0 ;;
    --package-only) package_only=1 ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $argument" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n==> %s\n' "$1"; }

if [[ ! -d node_modules ]]; then
  step "installing build dependencies"
  npm install --no-audit --no-fund
fi

step "typechecking"
npx tsc --noEmit

step "bundling"
node esbuild.mjs --production

if [[ $verify -eq 1 ]]; then
  step "activating the bundle against a stubbed VS Code API"
  node test/smoke-activation.mjs
  step "driving the webview protocol in a DOM"
  node test/smoke-webview.mjs
  step "checking runtime discovery and the pure helpers"
  DSH_E2E_OFFLINE=1 node build/test-e2e.mjs
fi

step "packaging the VSIX"
npx vsce package --no-dependencies --allow-missing-repository

vsix="$here/$(cd "$here" && ls -t ./*.vsix | head -1 | sed 's|^\./||')"
echo "built $vsix"

if [[ $package_only -eq 1 ]]; then
  exit 0
fi

if ! command -v code >/dev/null 2>&1; then
  cat <<EOF

The 'code' command is not on PATH, so the extension was not installed.
Install it manually:
  code --install-extension "$vsix"
or in VS Code: Extensions view -> "..." menu -> Install from VSIX...
EOF
  exit 0
fi

step "installing into VS Code"
code --install-extension "$vsix" --force

cat <<EOF

Installed. Reload VS Code (Command Palette -> "Developer: Reload Window"),
open a repository folder, and press Ctrl+Alt+D.
Run "DSH: Show Diagnostics" if the runtime does not start.
EOF
