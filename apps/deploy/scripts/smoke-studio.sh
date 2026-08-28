#!/usr/bin/env bash
# Studio's dev server, pointed at the smoke BFF rather than the default 7001.
#
# Port 7443 rather than 7000 so this cannot collide with another agent's Studio
# on the same box; `strictPort` in the vite config means a collision would fail
# loudly rather than silently landing on a neighbour's server.
set -euo pipefail
cd "$(dirname "$0")/../../.."

export MAESTRO_BFF_ORIGIN="http://127.0.0.1:7442"
export MAESTRO_STUDIO_HOST=127.0.0.1

exec pnpm --filter @maestro/studio exec vite --port 7443 --strictPort
