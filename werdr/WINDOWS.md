# Windows and terminal compatibility

The first browser version uses herdr's existing terminal controller on each host.
It does not replace ConPTY or install wmux's Windows session agent.
The PowerShell SSH adapter uses the managed Windows runtime path when `WERDR_WINDOWS_HERDR_BIN` is configured.
A checksum-pinned standalone Windows build and supervised installation workflow are available below.

## Findings carried from wmux

The reference wmux commit is `5dd1affd1230479ac36519f77811dc64aeaaf80f`.
Links below pin the evidence so this document does not silently change with wmux master.

| Invariant | Existing evidence | Werdr boundary and validation |
| --- | --- | --- |
| UTF-8 can span output polls and resize boundaries. | [Windows agent regressions](https://github.com/gisenberg/wmux/blob/5dd1affd1230479ac36519f77811dc64aeaaf80f/test/windows-agent-failure.test.ts) | Accumulate complete JSON records as bytes; send decoded base64 as `Uint8Array`, not separately decoded text fragments. |
| Same-size reconnect must not trigger a resize repair. | [Windows agent regressions](https://github.com/gisenberg/wmux/blob/5dd1affd1230479ac36519f77811dc64aeaaf80f/test/windows-agent-failure.test.ts) | Avoid browser frame-to-resize feedback; characterize native herdr behavior on Windows before adding a patch. |
| Live repaints must not reset the terminal or duplicate viewport content into history. | [Checkpoint regressions](https://github.com/gisenberg/wmux/blob/5dd1affd1230479ac36519f77811dc64aeaaf80f/test/terminal-checkpoint.test.ts) | Respect authoritative herdr frames; never send RIS merely because `full` is true. |
| Default colors must remain semantic across restore and theme changes. | [Terminal checkpoint implementation](https://github.com/gisenberg/wmux/blob/5dd1affd1230479ac36519f77811dc64aeaaf80f/src/server/terminal-checkpoint.ts) | Keep native palette/checkpoint behavior in herdr and browser palette behavior in Ghostty; add Windows evidence before changing defaults. |
| Hidden cursor frames are not proof of lost input echo. | [Input prediction implementation](https://github.com/gisenberg/wmux/blob/5dd1affd1230479ac36519f77811dc64aeaaf80f/src/client/src/terminal-input-prediction.ts) | Prediction is not currently enabled in werdr; do not add it without authoritative echo tests. |
| Disconnect and process closure are different operations. | [Session backend contract](https://github.com/gisenberg/wmux/blob/5dd1affd1230479ac36519f77811dc64aeaaf80f/src/server/backends/backend.ts) | Gateway disconnect releases a controller; explicit pane closure asks herdr to terminate the pane. |

These findings are acceptance criteria, not a claim that wmux's backend implementation has been ported or that every invariant is already verified in herdr.
Herdr also has its own native Ghostty and portable-pty patches, which must be inspected before applying overlapping changes.

## Required Windows validation

Use a disposable herdr session on a trusted Windows SSH host and explicitly list its saved machine ID in `WERDR_WINDOWS_MACHINES`.
Verify PowerShell stdin forwarding for the long-lived JSON controller, terminal input including non-ASCII characters, resize while output is active, scroll behavior, reconnect at the same and different dimensions, and explicit takeover between two browsers.
Verify that gateway restart retains the shell process and that explicit closure terminates only the chosen pane.
Compare normal-screen and alternate-screen applications and confirm default colors, cursor placement, and hidden primary-screen content survive reconnect and resize.

Do not force-restart an existing Windows runtime to make a test pass.
If a regression requires a native fix, add a focused herdr test and patch with the upstream base, rationale, and removal condition recorded.

## Managed Windows server installation

Stage `werdr/install-windows-server.ps1` on a Windows host and run it in a visible wmux pane with `pwsh -NoLogo -NoProfile -File <staged-script>`.
The script installs the complete checksum-pinned Windows ZIP, including app-local ConPTY libraries, into `%LOCALAPPDATA%\werdr\herdr\<version>`.
It preserves other herdr installations and never replaces a running managed runtime with a different version.
The `Werdr Herdr Server` Scheduled Task owns the explicit `werdr` session independently of wmux's pane processes.
Where permitted, an S4U task starts at system boot; unprivileged accounts fall back to a task that starts at that user's logon.
Both modes restart failed servers and have no execution-time limit.
The task does not expose a new network listener: the browser gateway reaches the user-owned native IPC endpoint through authenticated SSH.

Set `WERDR_WINDOWS_MACHINES` to the saved herdr machine IDs and `WERDR_WINDOWS_HERDR_BIN` to `%LOCALAPPDATA%\werdr\herdr\<version>\herdr.exe` on the gateway.
The remote adapter expands environment variables as a path without interpreting shell expressions, so hosts with different Windows usernames share one deployment setting.
Use `werdr` as each remote catalog entry's explicit session.
Herdr's automatic `machine add` bootstrap still emits POSIX shell commands.
Werdr's **MANAGE HOSTS** Windows flow verifies the named runtime and writes its schema-versioned private `client/endpoints.json` catalog with an owner-only atomic update, preserving existing entries and refusing future schemas.
It persists the selected platform against the native endpoint identity, so new browser-managed hosts do not need the environment ID override.
The installer accepts `-Session` for isolated named sessions and keeps the default task name unchanged.
Background fleet metadata uses an SSH named-pipe relay; browser terminal attachments continue using the native controller CLI.
The installation script's success sentinel confirms an actual API snapshot, not only a running task.
