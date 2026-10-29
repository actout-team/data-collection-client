#!/bin/bash
set -eu

# Keep Finder-launched failures visible in Terminal.
finish() {
  status=$?
  if [[ $status -ne 0 && -t 0 ]]; then
    printf '\nPress Return to close. '
    read -r _ || true
  fi
}
trap finish EXIT

fail() {
  printf '\n%s\n' "$1" >&2
  exit 1
}

folder_help='Allow Terminal access in System Settings > Privacy & Security > Files and Folders, or move the extracted project to ~/Projects/ using Finder and reopen Install.command.'

# Do this before invoking Node or npm: the inherited directory may be stale.
project_dir="${BASH_SOURCE[0]%/*}"
[[ "$project_dir" != "${BASH_SOURCE[0]}" ]] || project_dir=.
cd -P -- "$project_dir" || fail "Cannot open the project folder. $folder_help"
[[ -r package.json && -r package-lock.json ]] || fail "Cannot read the project files. Extract the complete source ZIP first. $folder_help"

command -v node >/dev/null 2>&1 || fail 'Node.js 24 or newer is required. Install it from https://nodejs.org, reopen Terminal, and retry.'
node -e 'process.cwd()' 2>/dev/null || fail "Node cannot access the project folder. $folder_help"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail 'Node.js 24 or newer is required. Update Node, reopen Terminal, and retry.'
command -v npm >/dev/null 2>&1 || fail 'npm is missing. Reinstall Node.js with npm, reopen Terminal, and retry.'

printf 'Installing dependencies...\n'
npm ci || fail 'Dependency installation failed. Resolve the npm error above, then reopen Install.command. The app was not started.'
printf '\nStarting the client...\n'
npm start
