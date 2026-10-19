#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1 || ! node -e "if (process.versions.node.split('.')[0] !== '24') process.exit(1)"; then
  printf '%s\n' 'O PromoBridge precisa do Node.js 24 LTS. Instale em https://nodejs.org.' >&2
  exit 1
fi
if [ ! -d node_modules ]; then npm ci --include=dev --no-audit --no-fund; fi
if [ ! -f apps/web/dist/index.html ] || [ ! -f dist/worker/apps/worker/src/index.js ]; then npm run build; fi
exec npm start
