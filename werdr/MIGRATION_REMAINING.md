# Remaining migration actions and feature gaps

Status reviewed on 2026-09-29 against `feat/wmux-parity`, which builds on `master` at `26648068`.
The targets are browser parity with native herdr desktop, tracked in [DESKTOP_PARITY.md](DESKTOP_PARITY.md), and replacing wmux, tracked in [WMUX_REPLACEMENT.md](WMUX_REPLACEMENT.md).
Implemented, tested in isolation, deployed, and verified live are separate completion states.

## Current baseline

| Component | State |
| --- | --- |
| Integration | The browser desktop and upstream runtime integration merged to `master` as `26648068` |
| Deployed gateway, companions and owners | `91dcee6f` on the Linux gateway host and both Windows hosts; owners were replaced with authorization to end werdr sessions |
| Pending source | OSC 52 forwarding, the touch key row, the installable web app, native status indicator defaults, systemd supervision handover and exact terminal-state live handoff |

## Completed since the previous review

- Custom notification sounds, native right-click routing, same-runtime last-pane retention and contextual mode hints (former F1 through F4).
- Owning-runtime adoption of alternate-screen scrollbars, agent views and tab labels, workspace Git metadata, semantic notifications, configured commands, popups, Windows resize recovery and atomic idle stop (former M4), with live checks recorded in the parity matrix.

## Runtime upgrades without ending sessions

Linux owners now hand every pane to a new runtime without ending a session:

- The exporter captures each pane's exact terminal state after pausing its reader and applying already queued events.
  Captured state covers both screens, full history, saved cursors, modes, charset state and unfinished escape sequences, together with herdr's per-pane terminal trackers and pending replies.
  Output still in the kernel buffer reaches the importer through the transferred PTY.
- Records are tagged with a codec identity derived from the vendored libghostty commit, its patch set and herdr's terminal-state schema.
  An importer restores them only when the identity matches exactly, because the libghostty snapshot format carries no binary-compatibility guarantee.
- `herdr server live-handoff --require-lossless` refuses before ownership moves when a pane cannot be captured exactly, retains file-backed images, or the importer lacks the codec.
  The running server must advertise `lossless_handoff`, because an older server would ignore the flag.
- Under systemd, the runtime reports readiness through `sd_notify` and hides the notify socket from pane processes.
  After commit, the importer claims the service main process and waits on a notify barrier before the exporter exits.
  This requires `Type=notify` and `NotifyAccess=all`.
- `werdr/test-systemd-handoff.sh` verifies the full sequence under a transient unit with the production kill and restart policy.

Windows owners cannot move ConPTY sessions between processes.
They upgrade only when idle through the atomic `server stop-if-idle` operation, and a busy owner keeps its task and sessions unchanged.

### Remaining upgrade work

- [ ] Deploy the notify-supervised Linux unit and a lossless-capable owner.
  The currently deployed owner has neither, so this one transition ends werdr sessions; every later upgrade can preserve them.
- [ ] Verify a live lossless upgrade on the production Linux host with real agent panes.
- [ ] Exercise the Windows idle-only upgrade on both hosts, including the busy refusal.
- [ ] Decide how to upgrade when the vendored libghostty changes: a lossless handoff refuses, and history replay remains available only by explicitly omitting `--require-lossless`.
- [ ] Carry file-backed Kitty images, or document that such panes must be upgraded without `--require-lossless`.

## Feature gaps

| Gap | Remaining work |
| --- | --- |
| Kitty graphics in browser panes | Forward image placements through the terminal stream and render them in the browser |
| Pane controller cap | A surface retains at most 16 pane controllers; native herdr has no such limit |
| Mobile agent views | A chat-style agent timeline and in-browser answers to agent questions, if still wanted after cutover |

## Verification gaps

These items need evidence and may reveal further implementation work.

- [ ] Keyboard layouts and IME composition on Windows and macOS; Linux X11 covers US, German, French, dead keys and one CJK input method.
- [ ] Successful installation and recovery on incompatible or partially installed endpoints; refusal paths are verified.
- [ ] Native-reference screenshot comparison across modes, palettes and narrow layouts.
- [ ] Configured commands on production owners, update-event delivery, OS desktop notifications and the custom-audio matrix.
- [ ] The touch key row and OSC 52 copy action on real iOS and Android devices.

Record the source commit, deployed revision, platform, test or live evidence and remaining limitations for every completed item in the parity matrix.
