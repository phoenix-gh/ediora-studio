#!/usr/bin/env bash
# codex-imagegen: generate images via Codex CLI's built-in image_gen tool
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/main.py" "$@"
