#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v op >/dev/null 2>&1; then
  echo "1Password CLI is required to load the local Pokédex MCP token." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is not installed or is not on PATH." >&2
  exit 1
fi

exec op run --env-file=.codex/mcp.env.tpl -- codex "$@"
