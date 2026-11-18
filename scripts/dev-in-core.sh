#!/usr/bin/env bash
# process-compose owns this attachment and the Pi terminal it creates.
set -euo pipefail
if [[ ! -t 0 || ! -t 1 ]]; then
  echo 'dev needs an interactive terminal for hc attach' >&2
  exit 1
fi

# Use the development shell's tools even if Core started with a different PATH.
# Only forward PATH, not credentials or synthetic HC_TERMINAL_* values.
terminal=$(hc run --json --bg --no-notify --cwd "$PWD" -- "$(command -v env)" "PATH=$PATH" bun run dev |
  node -e 'const r = JSON.parse(require("node:fs").readFileSync(0)); if (!/^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(r.address)) process.exit(1); console.log(r.address)')
cleanup() {
  # On detach/stop, end our program; retain its finished terminal for inspection.
  hc kill "$terminal" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT
echo "dev: attaching to Herdr terminal $terminal" >&2
hc attach "$terminal" <&0 &
wait "$!"
