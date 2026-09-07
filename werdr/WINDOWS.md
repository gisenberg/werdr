# Windows and terminal compatibility

The first browser version uses herdr's existing terminal controller on each host.
It does not replace ConPTY or install wmux's Windows session agent.
The PowerShell SSH adapter is implemented and its command encoding is unit-tested, but live Windows and remote SSH validation are still required.

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
