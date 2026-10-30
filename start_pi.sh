#!/usr/bin/env bash
set -euo pipefail
arena_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$arena_dir"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install -r requirements-lan.txt
exec .venv/bin/python lan_server.py --port "${ARENA_PORT:-8765}"
