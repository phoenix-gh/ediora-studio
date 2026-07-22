#!/usr/bin/env bash
set -euo pipefail

docker compose config -q
curl --fail --silent --show-error http://localhost:8000/health >/dev/null
curl --fail --silent --show-error http://localhost:3000 >/dev/null
echo "Self-hosted services are reachable."
