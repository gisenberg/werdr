#!/usr/bin/env bash
# Verify that a live handoff under a systemd user service keeps the service,
# its pane processes and the imported runtime alive after the exporter exits.
#
# Usage: werdr/test-systemd-handoff.sh <exporter-herdr> [<importer-herdr>]
#
# Runs an isolated transient unit with the production supervision policy.
# It never touches the production runtime, its configuration or its panes.
set -euo pipefail

exporter=$(realpath "${1:?usage: $0 <exporter-herdr> [<importer-herdr>]}")
importer=$(realpath "${2:-$1}")
unit="herdr-handoff-probe-$$"
# Unix socket paths are short; keep the isolated state directory near the root.
state=$(mktemp -d /tmp/hsp.XXXXXX)
mkdir -p "$state/config/herdr"
printf '[update]\nversion_check = false\nmanifest_check = false\n' > "$state/config/herdr/config.toml"

cleanup() {
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  rm -rf "$state"
}
trap cleanup EXIT

herdr() {
  env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    XDG_CONFIG_HOME="$state/config" XDG_STATE_HOME="$state/state" HERDR_CONFIG_PATH="$state/config/herdr/config.toml" \
    "$exporter" "$@"
}
show() { systemctl --user show "$unit" -p "$1" --value; }
fail() { echo "FAIL: $*" >&2; systemctl --user status "$unit" --no-pager >&2 || true; exit 1; }

systemd-run --user --quiet --unit="$unit" \
  -p Type=notify -p NotifyAccess=all -p KillMode=control-group -p Restart=always -p RestartSec=1 \
  -p TimeoutStartSec=30 \
  --setenv=XDG_CONFIG_HOME="$state/config" --setenv=XDG_STATE_HOME="$state/state" \
  --setenv=HERDR_CONFIG_PATH="$state/config/herdr/config.toml" --setenv=SHELL=/bin/bash \
  "$exporter" server

[[ $(show ActiveState) == active ]] || fail "service did not report readiness"
exporter_pid=$(show MainPID)
[[ $exporter_pid != 0 ]] || fail "service has no main process"

pane=$(herdr workspace create --label probe --cwd "$state" --no-focus | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
herdr pane run "$pane" 'echo "PROBE_SHELL=$$"; echo "NOTIFY=${NOTIFY_SOCKET:-unset}"' >/dev/null
herdr pane wait-output "$pane" --match PROBE_SHELL= --timeout 5000 >/dev/null
output=$(herdr pane read "$pane" --source recent)
shell_pid=$(grep -o 'PROBE_SHELL=[0-9]*' <<<"$output" | tail -1 | cut -d= -f2)
grep -q 'NOTIFY=unset' <<<"$output" || fail "pane shell inherited NOTIFY_SOCKET"
kill -0 "$shell_pid" || fail "probe shell is not running"

herdr server live-handoff --import-exe "$importer" --require-lossless >/dev/null

# The exporter exits after the importer reports ownership.
for _ in $(seq 50); do kill -0 "$exporter_pid" 2>/dev/null || break; sleep 0.1; done
kill -0 "$exporter_pid" 2>/dev/null && fail "exporter did not exit after handoff"
sleep 2

[[ $(show ActiveState) == active ]] || fail "service stopped after exporter exit"
[[ $(show NRestarts) == 0 ]] || fail "service restarted during handoff"
importer_pid=$(show MainPID)
[[ $importer_pid != "$exporter_pid" && $importer_pid != 0 ]] || fail "main process did not move to the importer"
kill -0 "$shell_pid" || fail "pane shell died during handoff"
herdr pane run "$pane" 'echo "AFTER_HANDOFF=$$"' >/dev/null
herdr pane wait-output "$pane" --match "AFTER_HANDOFF=$shell_pid" --timeout 5000 >/dev/null || fail "pane input failed after handoff"

echo "PASS: service active, main process $exporter_pid -> $importer_pid, shell $shell_pid retained, 0 restarts"
