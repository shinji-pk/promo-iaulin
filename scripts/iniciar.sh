#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi
if [ ! -f apps/web/dist/index.html ]; then npm run build; fi
exec npm start
