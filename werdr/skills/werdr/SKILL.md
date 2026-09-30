---
name: werdr
description: "Use when orchestrating visible or durable work through werdr, the browser client for herdr: starting workspaces or panes on saved machines, sending input, reading or waiting for output, starting agents, posting notifications, copying to the viewer's clipboard, or handing the user a browser link. Replaces the retired wmux skill and wmuxctl."
---

# werdr

## Purpose

werdr is a browser client for herdr.
herdr owns sessions, machines, panes, agents, and processes, and exposes them through the native `herdr` CLI.
werdr adds the browser surface, so anything created through the CLI appears in the browser immediately.
Use werdr when work should run visibly on a specific private-network machine, span machines, or remain attached to a durable pane the user can watch.
Prefer direct local tools or SSH for quick invisible checks.

Install the upstream `herdr` skill alongside this one for the complete CLI reference, or read <https://herdr.dev/agent-guide.md>.
This skill covers the werdr-specific parts and the migration from wmux.

## Targets

Commands act on the local runtime by default.
Add `--machine <label-or-id>` before the command to act on a saved machine:

```bash
herdr machine list --json
herdr --machine win-ci workspace list
```

Inside a herdr pane, `herdr pane current` identifies the current pane, and `HERDR_PANE_ID`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID` hold its identities.
Every command prints one JSON object with a `result` field.

## Common tasks

Create a visible workspace and run a command in its first pane:

```bash
pane=$(herdr workspace create --label "Build check" --cwd /srv/project --no-focus | jq -r .result.root_pane.pane_id)
herdr pane run "$pane" 'cargo test'
herdr pane wait-output "$pane" --regex 'test result:' --timeout 600000
herdr pane read "$pane" --source recent --lines 200
```

Start an agent and give it work:

```bash
herdr agent start reviewer --kind codex --pane "$pane"
herdr agent prompt reviewer "$(cat /tmp/task.md)" --wait --timeout 1800000
```

Notify the browser, including desktop notifications when the viewer enabled them:

```bash
herdr notification show "Build finished" --body "All tests passed"
```

Close finished work explicitly; closing a workspace terminates its processes:

```bash
herdr workspace close "$workspace_id"
```

## Clipboard

Applications copy to the browser viewer's clipboard with OSC 52.
werdr delivers the write to the browser controlling that pane and offers an explicit copy action when the browser requires a click.

```bash
printf '\033]52;c;%s\a' "$(printf '%s' "$text" | base64 -w0)"
```

Requests are limited to 1 MiB of text.

## Browser links

Hand the user a direct link by combining the gateway URL with native identities.
Use `machine=local` for the gateway's own host, or the saved machine ID from `herdr machine list --json`:

```text
https://<gateway-host>:3480/?machine=local&workspace=<workspace_id>&tab=<tab_id>&pane=<pane_id>
```

Links may omit descendants; a workspace-only link opens that workspace's active tab and pane.
The browser validates every coordinate against the live runtime before attaching.

## Migrating from wmux

| wmux | herdr / werdr |
| --- | --- |
| `wmuxctl machines` | `herdr machine list --json` |
| `wmuxctl bootstrap` | `herdr api snapshot` |
| `wmuxctl open <machine> --title T` | `herdr --machine <machine> workspace create --label T` |
| `wmuxctl tabs` | `herdr tab list` |
| `wmuxctl tab-open`, `tab-title`, `tab-close` | `herdr tab create`, `tab rename`, `tab close` |
| `wmuxctl send <pane> --line L` | `herdr pane send-text <pane> "L"$'\n'` or `herdr pane run <pane> L` |
| `wmuxctl run` | `herdr workspace create` followed by `herdr pane run` |
| `wmuxctl output <pane>` | `herdr pane read <pane> --source recent` |
| `wmuxctl wait <pane> --pattern P` | `herdr pane wait-output <pane> --regex P` |
| `wmuxctl delegate`, `tui` | `herdr agent start` then `herdr agent prompt --wait` |
| `wmuxctl ps <windows-machine>` | `herdr --machine <windows-machine> pane run <pane> '<PowerShell>'` |
| `wmuxctl finish --close`, `cleanup` | `herdr notification show`, then `herdr workspace close` |
| `wmux-title` | `herdr workspace rename`, `tab rename`, or `pane rename` |
| `wmux-notify` | `herdr notification show` |
| `wmux-agent-event` | `herdr pane report-agent` |
| `wmux-run` metadata | `herdr pane report-metadata` or `herdr workspace report-metadata` |
| `wmux-copy` | OSC 52, shown above |
| `wmux-hooks install <agent>` | `herdr integration install <agent>` |
| `wmux-doctor` | `herdr status` |

wmux-only features without a herdr equivalent: `wmux-media` inline images and the media shelf, screen streaming, and the automatic 24-hour cleanup of agent workspaces.
Close agent-created workspaces explicitly when their work is finished.
