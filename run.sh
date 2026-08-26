#!/usr/bin/env bash
# Local one-shot launcher. Runs the web app with real local Cloudflare bindings
# and launches a bundled, separately identified Tauri development app. The web
# app uses 7741 and the Worker inspector uses 9241 instead of default ports.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Try: corepack enable" >&2
  exit 1
fi

INSTALL_STAMP='node_modules/.pokedex-install-stamp'
if [ ! -d node_modules ] || [ ! -f "$INSTALL_STAMP" ] || [ pnpm-lock.yaml -nt "$INSTALL_STAMP" ]; then
  echo "// installing dependencies"
  pnpm install --frozen-lockfile
  touch "$INSTALL_STAMP"
fi

if [ ! -f apps/web/.dev.vars ]; then
  echo "// creating apps/web/.dev.vars with local-only secrets"
  mkdir -p apps/web
  cat > apps/web/.dev.vars <<'EOF'
SESSION_SECRET=pokedex-local-session-secret-not-for-production
SESSION_SECRET_PREV=
ENROLL_SECRET=pokedex-local-enrol
PUBLIC_ORIGIN=http://localhost:7741
EOF
fi

PORT=7741
INSPECTOR_PORT=9241
KILLABLE='^(node|workerd)$'
DEV_BUNDLE_ID='com.gordonbeeming.pokedex.scanner.dev'
DEV_APP="$PWD/apps/desktop/src-tauri/target/debug/bundle/macos/Pokédex Scanner Dev.app"
RUN_PID_FILE="$PWD/apps/web/.wrangler/pokedex-run.pid"

previous_run_pid=''
if [ -f "$RUN_PID_FILE" ]; then
  IFS= read -r previous_run_pid < "$RUN_PID_FILE" || true
fi
if
  [[ "$previous_run_pid" =~ ^[0-9]+$ ]] &&
    [ "$previous_run_pid" != "$$" ] &&
    kill -0 "$previous_run_pid" 2>/dev/null &&
    lsof -a -p "$previous_run_pid" -d cwd -Fn 2>/dev/null | grep -Fxq "n$PWD"
then
  echo "// stopping the previous Pokédex launcher (pid $previous_run_pid)" >&2
  kill -TERM "$previous_run_pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    ! kill -0 "$previous_run_pid" 2>/dev/null && break
    sleep 0.25
  done
  if kill -0 "$previous_run_pid" 2>/dev/null; then
    echo "// previous launcher did not stop; sending SIGKILL" >&2
    kill -KILL "$previous_run_pid" 2>/dev/null || true
    sleep 0.5
  fi
fi

stale_pids() {
  for port in "$PORT" "$INSPECTOR_PORT"; do
    lsof -ti tcp:"$port" 2>/dev/null || true
  done | sort -u | while read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$$" ] && continue
    command_name=$(basename "$(ps -p "$pid" -o comm= 2>/dev/null)" 2>/dev/null)
    printf '%s\n' "$command_name" | grep -Eq "$KILLABLE" && echo "$pid"
  done
}

if [ -n "$(stale_pids)" ]; then
  echo "// freeing Pokédex ports $PORT and $INSPECTOR_PORT" >&2
  while read -r pid; do
    [ -n "$pid" ] || continue
    echo "//   stopping pid $pid ($(ps -p "$pid" -o comm= 2>/dev/null || echo '?'))" >&2
    kill "$pid" 2>/dev/null || true
  done < <(stale_pids)

  for _ in $(seq 1 20); do
    [ -z "$(stale_pids)" ] && break
    sleep 0.25
  done

  if [ -n "$(stale_pids)" ]; then
    echo "// previous Pokédex processes did not stop; sending SIGKILL" >&2
    while read -r pid; do
      [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done < <(stale_pids)
    sleep 0.5
  fi
fi

for port in "$PORT" "$INSPECTOR_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "// port $port is still occupied by a process this script will not stop:" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
    exit 1
  fi
done

echo "// applying any pending D1 migrations locally"
pnpm --dir apps/web migrate:local

# Wrangler's local integration path expects the configured assets directory to
# exist. Keep an existing build and create it once on a fresh checkout.
if [ ! -d apps/web/dist/client ]; then
  echo "// building local web assets"
  pnpm --dir apps/web build
fi

echo ""
echo "// starting Pokédex on http://localhost:$PORT"
echo "// local enrolment secret: pokedex-local-enrol"
echo "// ctrl+c to stop"
echo ""

set -m
SELF_WORKERDS_BEFORE=$( (pgrep -x workerd 2>/dev/null || true) | sort | tr '\n' ' ')
mkdir -p "$(dirname "$RUN_PID_FILE")"
printf '%s\n' "$$" > "$RUN_PID_FILE"

stop_new_workerds() {
  local after
  after=$(pgrep -x workerd 2>/dev/null || true)
  for pid in $after; do
    case " $SELF_WORKERDS_BEFORE " in
      *" $pid "*) ;;
      *) kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
}

cleanup() {
  local status=$?
  trap - INT TERM EXIT
  echo ""
  echo "// shutting down Pokédex"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "tell application id \"$DEV_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  fi
  if [ -n "${TAURI_PID:-}" ]; then
    kill -TERM "-${TAURI_PID}" 2>/dev/null || true
  fi
  if [ -n "${WEB_PID:-}" ]; then
    kill -TERM "-${WEB_PID}" 2>/dev/null || true
  fi
  if [ -n "${TAURI_PID:-}" ] || [ -n "${WEB_PID:-}" ]; then
    sleep 1
  fi
  if [ -n "${TAURI_PID:-}" ]; then
    kill -KILL "-${TAURI_PID}" 2>/dev/null || true
  fi
  if [ -n "${WEB_PID:-}" ]; then
    kill -KILL "-${WEB_PID}" 2>/dev/null || true
  fi
  stop_new_workerds
  local recorded_pid=''
  if [ -f "$RUN_PID_FILE" ]; then
    IFS= read -r recorded_pid < "$RUN_PID_FILE" || true
  fi
  if [ "$recorded_pid" = "$$" ]; then
    rm -f "$RUN_PID_FILE"
  fi
  exit "$status"
}
trap cleanup INT TERM EXIT

WEB_READY=0
for web_attempt in 1 2; do
  pnpm --dir apps/web dev &
  WEB_PID=$!

  for attempt in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/live" >/dev/null 2>&1; then
      WEB_READY=1
      break
    fi
    ! kill -0 "$WEB_PID" 2>/dev/null && break
    sleep 0.25
  done
  [ "$WEB_READY" -eq 1 ] && break

  echo "// Pokédex web startup attempt $web_attempt failed" >&2
  if kill -0 "$WEB_PID" 2>/dev/null; then
    kill -TERM "-$WEB_PID" 2>/dev/null || kill -TERM "$WEB_PID" 2>/dev/null || true
    sleep 0.5
  fi
  set +e
  wait "$WEB_PID" 2>/dev/null
  set -e
  stop_new_workerds
  WEB_PID=''
  sleep 0.5
done

if [ "$WEB_READY" -ne 1 ]; then
  echo "// Pokédex did not become ready at http://localhost:$PORT after 2 attempts" >&2
  exit 1
fi

if [ "${POKEDEX_SKIP_ART_SEED:-0}" != "1" ]; then
  echo "// checking local TCGdex art"
  set +e
  node apps/web/scripts/seed-local-art.mjs "http://127.0.0.1:$PORT"
  ART_SEED_STATUS=$?
  set -e
  if [ "$ART_SEED_STATUS" -eq 130 ]; then
    exit 130
  fi
  if [ "$ART_SEED_STATUS" -ne 0 ]; then
    echo "// local art seeding failed; Pokédex will keep running without missing art" >&2
  fi
fi

if [ "${POKEDEX_SKIP_DESKTOP:-0}" = "1" ]; then
  wait "$WEB_PID"
  exit $?
fi

if command -v osascript >/dev/null 2>&1; then
  osascript -e "tell application id \"$DEV_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
fi

echo "// building the isolated Pokédex Scanner Dev app"
POKEDEX_DEV_CLOUD_BASE_URL="http://localhost:$PORT" \
  pnpm --dir apps/desktop tauri build --debug --bundles app \
  --config src-tauri/tauri.dev.conf.json
if [ ! -d "$DEV_APP" ]; then
  echo "// Pokédex Scanner Dev bundle was not created at $DEV_APP" >&2
  exit 1
fi

echo "// signing the development app so macOS can bind camera permission to its bundle ID"
codesign --force --sign - --identifier "$DEV_BUNDLE_ID" "$DEV_APP"

echo "// starting Pokédex Scanner Dev"
open -n -W "$DEV_APP" &
TAURI_PID=$!

while kill -0 "$WEB_PID" 2>/dev/null && kill -0 "$TAURI_PID" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$WEB_PID" 2>/dev/null; then
  echo "// Pokédex web app stopped" >&2
  wait "$WEB_PID"
else
  echo "// Pokédex Scanner stopped" >&2
  wait "$TAURI_PID"
fi
