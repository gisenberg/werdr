# Replacing wmux with werdr

This is the acceptance inventory for retiring wmux in favor of werdr.
It lists every workflow wmux users rely on, its werdr equivalent, and the evidence or work that remains.
Desktop parity with native herdr is tracked separately in [DESKTOP_PARITY.md](DESKTOP_PARITY.md).

Status reviewed on 2026-09-29.
A row is complete only when the behavior exists, has automated coverage, and is deployed.

## Blocking workflows

| ID | Workflow | wmux | werdr | Status |
| --- | --- | --- | --- | --- |
| B1 | Applications copy to the viewer's clipboard | OSC 52 with gesture gating and a pending copy action; `wmux-copy` | The owning runtime routes OSC 52 writes to the pane's controlling terminal stream; the browser writes directly when focused and otherwise offers an expiring pane-anchored copy action | Implemented; `terminal-osc52.spec.ts` and native routing tests; requires owner and companion deployment |
| B2 | Phone input | Esc/Tab/Ctrl/arrow/paste row, paste dialog, touch scrolling | Touch key row with ESC, TAB, sticky CTRL and ALT, arrows and PASTE through the native key encoder, a manual paste panel when clipboard reads are refused, and popup support; touch scrolling already existed | Implemented; `terminal-keys.spec.ts` and `popups.spec.ts`; real iOS and Android acceptance remains |
| B3 | Sessions survive upgrades | tmux panes outlive wmux restarts | Gateway restarts already preserve panes; Linux owners hand off to a new runtime under systemd notify supervision; Windows owners upgrade only when idle | In progress; see [MIGRATION_REMAINING.md](MIGRATION_REMAINING.md) |
| B5 | Agent and script orchestration | `wmuxctl`, pane helpers, wmux skill | Native `herdr` CLI plus the [werdr skill](skills/werdr/SKILL.md), which maps every wmuxctl command and helper | Implemented; the agent profile still installs the wmux skill until cutover |

## Other wmux workflows

| ID | Workflow | werdr status |
| --- | --- | --- |
| B4 | Inline images (Kitty graphics), `wmux-media` and the media shelf | Missing; the terminal stream does not carry graphics records to the browser |
| B4 | Screen streaming and Moonlight | Not part of werdr; these services already run independently of the wmux gateway and should move out of the wmux repository |
| B6 | Mobile chat view built from agent timelines, answering OpenCode questions in the browser | Missing |
| B6 | Native iOS/Android app (`wmux-mobile`) | Bound to the wmux API; replace with the installable werdr web app or port |
| B7 | Installable web app | Implemented: manifest, icons and standalone display (`pwa.spec.ts`) |
| B7 | Local input prediction and latency diagnostics | Missing; most useful for Windows panes over SSH |
| B7 | Rectangular (Alt-drag) selection | Missing |
| B7 | Automatic cleanup of agent-created workspaces | Not planned; close agent workspaces explicitly |

## Cutover

Cutover starts only after B1 through B3 are deployed and verified live.

1. Move or close the remaining wmux workspaces; wmux tmux panes cannot be adopted by herdr.
2. Run both gateways side by side for an agreed period, using werdr for new work.
3. Replace the wmux skill in the agent profile with the herdr and werdr skills, and uninstall wmux hooks in favor of `herdr integration install`.
4. Stop and disable `wmux.service`, remove the `wmux-mobile` runner, and archive the wmux helpers on `PATH`.
