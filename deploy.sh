#!/usr/bin/env bash
# Deploys org-mcp on the machine it runs on: pull, build, verify, restart.
# Run it on the Pi, or remotely: ssh pi 'cd ~/org-mcp && ./deploy.sh'
set -euo pipefail

APP_NAME=org-mcp
cd "$(dirname "$0")"

# `ssh host './deploy.sh'` runs a non-interactive shell, which returns early from
# ~/.bashrc before nvm's setup — leaving node, npm, and pm2 (a global npm package)
# off PATH. Load nvm here so the script works the same however it's invoked.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +eu
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  set -eu
fi

for cmd in node npm pm2; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "'$cmd' is not on PATH in a non-interactive shell." >&2
    echo "Check where it lives with: ssh <host> 'bash -lc \"command -v $cmd\"'" >&2
    echo "then add that directory to PATH at the top of this script." >&2
    exit 1
  fi
done

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy: uncommitted changes in $(pwd)." >&2
  echo "Commit, stash, or discard them first ('git status' to see what's there)." >&2
  exit 1
fi

echo "==> Pulling"
git pull --ff-only

echo "==> Installing dependencies"
npm ci

echo "==> Building"
npm run build

echo "==> Testing"
npm test

if ! pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "pm2 has no process named '$APP_NAME'. Start it once by hand (see the README's" >&2
  echo "'Running under pm2' section) so it picks up the Access env vars, then re-run this." >&2
  exit 1
fi

echo "==> Restarting $APP_NAME"
# No --update-env: the CF_ACCESS_* vars live in the environment pm2 started with, and
# refreshing from this shell's (empty) environment would silently disable Access auth.
pm2 restart "$APP_NAME"

echo "==> Deployed $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
