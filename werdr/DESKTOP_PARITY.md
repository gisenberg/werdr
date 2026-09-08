# Herdr desktop parity

The goal is desktop parity with the native herdr experience, including behavior and visual hierarchy.
The reference is the native source and runtime pinned by `werdr/runtime.json`, including the multi-machine client.
A passing browser suite alone does not establish parity.
Each capability below needs native-reference evidence, implemented browser interaction, and verification of its actual behavior.

## Acceptance matrix

| Capability | Required browser behavior | Current evidence |
| --- | --- | --- |
| Fleet and session ownership | Host-scoped identity, independent reconnect, durable native processes, explicit takeover and closure | Initial selection restoration validates scoped URLs and saved IDs against the pinned native endpoint before attaching; generation-aware HTTP/WebSocket ordering prevents stale snapshots from reversing selection; existing fleet and controller tests; prolonged gateway-outage test verifies exhausted retries recover for every visible pane without page reload, forced takeover, or loss of native shell state |
| Desktop layout | Render native split tree simultaneously; preserve ratios; drag and keyboard resize; zoom, directional focus, swap, move, reorder | Implemented native split tree, independent controllers, drag and keyboard ratios, zoom, directional focus/resize/swap, pane moves and workspace/tab ordering; isolated browser tests exercise input, stable terminal DOM, phone fallback and gateway restart |
| Visual hierarchy | Native semantic palette, compact cell rhythm, borders and active pane cues, configurable sidebar sections and contextual hints | Partial: native semantic palette, configurable split/outer/shared borders with native label precedence, top/bottom desktop tabs, and independently scrolling workspace/agent sections with a draggable saved split; native agent row tokens, per-agent layouts and conditional styles are implemented; workspace row tokens and contextual hints remain |
| Themes | All native theme choices, custom semantic overrides, light/dark/system selection and live preview/cancel | Implemented palette extraction, preview/cancel, system switching and custom colors; package and browser tests cover these behaviors |
| Preferences | Durable user settings with device overrides, sidebar geometry/group state/sorting, status indicators, tab/border behavior, shortcuts and confirmations | Partial: settings store, appearance, font/device override, sidebar width/density and workspace/agent split, agent order, indicators, confirmations, pane borders/gaps/labels, tab placement and notification controls; host-scoped worktree grouping and durable collapse state are implemented; configurable native-style prefix and built-in action bindings now use a migrated version-eight store; custom shell and lifecycle bindings remain |
| Terminal interaction | Native copy mode and search, selection/copy, scrollback editing, links, mouse behavior and image paste | Partial: native scrollbars with stable one-column gutters, alternate-screen reclamation, keyboard and pointer scrolling, saved settings, and isolated metadata subscriptions; native full-scrollback copy/search with revision-checked character/line selections, word/paragraph motions, repeat search, clipboard feedback and scroll restoration; normal mouse selection copies on release or retains a range for explicit copy, supports native URL/path word selection, drag autoscroll and retained scrolling, and paints readable native selection colors through Ghostty; isolated browser tests cover Unicode, combining characters, wrapped matches, content changes, queued-operation cancellation, clipboard denial and phone controls; native host-editor invocation with full-history export, overlay focus restoration, reload, early-exit recovery and temporary-file cleanup; native plugin link activation and safe HTTP/HTTPS opening with revision/viewport checks, OSC targets, blocked-tab fallback and delayed non-link drag preservation; application mouse press/drag/release and wheel coordinates/modifiers follow native mode records; Kitty press/repeat/release/reset uses the native encoder, with browser checks for modifier changes and focus loss; native image paste and drop support advertises companion capabilities, bounds files to 16 MiB, preserves queued input and host bytes, cancels stale file reads, and uses native staging cleanup; complete keyboard layout/protocol coverage remains |
| Workspace navigation | Native workspace/tab/pane actions, pickers, keyboard navigation and context menus | Partial: create/rename/close plus searchable host-qualified workspace/tab/pane palette entries, keyboard result navigation, live removal and terminal focus restoration; unit tests verify duplicate-label identity and stale-target rejection, and browser tests cover desktop/phone switching without remounting the selected pane; workspace/tab/pane chrome context menus add rename, close, new tab, split and zoom with keyboard access, stale-target dismissal and attach-focus protection; pane menus also clear manual names and swap explicit native pane identities, with browser layout verification; native worktree-group navigation, selected-child retention, collapsed attention status, search reveal, durable collapse/expand, explicit group closure, and scoped create/open/delete checkout menus are implemented and tested; ordinary Git workspace menus now discover native repository context on demand, preserve keyboard focus during discovery, and open scoped worktree actions; configurable prefix navigation, indexed tabs/workspaces/agents and persistent resize mode are implemented; native navigation-mode controls and right-click-routing menu actions remain |
| Worktrees | Native list/create/open/remove flows with host and repository scope and native errors | Implemented native repository picker and create/open/remove; isolated Git browser test verifies branch and checkout identity, dirty removal rejection, explicit force, normal native checkout hooks, and repository retention |
| Agents | Start/prompt/rename, native ordering/views, detail/status metadata and attention navigation | Partial: basic actions and fleet list, native status priority with newest transitions first within each host, workspace/tab/title/cwd search and tooltips, and next/previous blocked-agent navigation in native snapshot order; native agent row tokens, per-agent layouts, metadata labels and first-match conditional styles are implemented; native custom views and custom-tab-label metadata are implemented in the candidate runtime; live runtime adoption remains |
| Notifications | Native attention/completion semantics, configurable delivery/delay/position/sound and clipboard feedback | Partial: durable fleet activity and desktop opt-in |
| Integrations | Native readiness list and explicit installation/uninstallation with results | Implemented all native targets, individual and recommended installs, uninstall confirmation and native results; isolated agent-config browser tests verify install/reinstall/uninstall, preservation of unrelated settings and native failures |
| Plugins | Native management, actions, logs and plugin pane lifecycle | Partial: native linking/unlinking, enable/disable, manifest inspection, selected-context actions, logs, and overlay/split/tab/zoomed panes; isolated native tests verify command outcomes, input, closure, focus restoration and gateway restart; GitHub installation now preserves the native manifest preview, explicit confirmation, ref/provenance, build results and failed-replacement rollback, with managed uninstall and bounded owner-scoped job history; popup surfaces remain |
| Host onboarding | Shared native catalog, explicit compatibility/install prompts and repair, no forced runtime replacement | Existing management tests; extend compatibility coverage |
| Runtime configuration | Explicit host-scoped shell/cwd/scrollback/worktree/resume settings and validated reload | Browser controls use the companion to preserve unrelated TOML, reject stale revisions, save atomically, and report native reload results; isolated POSIX tests verify new-pane cwd, invalid input, foreign-origin rejection, concurrent edits and save/reload partial outcomes; live Windows validation remains |
| Desktop ergonomics | Keyboard help, focus restoration, accessible forms, context menus, responsive fallback, no terminal remount during chrome changes | Partial: responsive console dialogs, native fallback focus after closure, command-palette readiness updates preserve search and keyboard focus, and a delayed split-response test verifies that later input in navigation keeps focus; contextual shortcut help and held-key protection are implemented and tested; remaining ergonomics still need verification |
| Delivery | Reviewed commits, verified remotes, pinned deployment, native panes preserved and live POSIX/Windows validation | Required for final result |

## Verification

`web/test/selection-restore.spec.ts` verifies fresh links absent from cached metadata, missing and contradictory IDs, unknown hosts, scoped URLs with saved descendants, newer navigation during a delayed read, transient read failures, and an older initial WebSocket snapshot arriving after HTTP restoration.
Assertions cover selected IDs and the absence of unrelated terminal attachments.
Unit tests cover endpoint replacement, gateway generations, old-stream deltas, stop invalidation, and terminal replacement or empty-to-populated cache races.
`web/test/shortcuts.spec.ts` verifies native prefix commands, double-prefix forwarding in terminal and copy modes, held-key suppression, persistent resizing, indexed tab selection, IME bypass, editable-control isolation, remapping, preview cancellation, gateway restart, offline help, and delayed native layout responses.
A forced move-response race verifies destination selection after automatic native fallback, while explicit navigation round trips and newer commands supersede older focus replies.
The keyboard catalog is compared with native `KeysConfig` defaults, while mode tests cover modifiers, unknown suffixes, configured Escape prefixes, alias normalization, unsafe bindings, and repeats whose original press belongs to terminal input.
Existing Kitty, copy-mode, layout, context-menu, and reconnect tests remain characterization coverage for this browser-owned input layer.
Help keeps its heading and close control visible on desktop and phone layouts.
Native custom shell commands, navigate-mode controls, detach/reload/notification-target shortcuts, last-pane tracking, and complete keyboard-layout/protocol coverage remain outstanding.

Use isolated native runtimes for destructive actions and never mutate user panes to make a test pass.
Compare desktop screenshots at fixed geometry against native layouts and theme tokens.
Exercise multiple panes, host changes, browser reconnect, gateway restart, keyboard and mouse interactions, and independent viewers.
Keep phone operation and the existing authentication/boot collection working while adding desktop behavior.
Exercise settings persistence, validation, concurrent edits, invalid/future stores, and preview cancellation.
The sidebar split follows the native 50% default and 10%-90% bounds, with minimum section heights, keyboard adjustment, cancelled-drag recovery, conflict rollback, and a scrolling phone drawer.
`web/test/sidebar.spec.ts` verifies independent section scrolling, saved geometry across gateway restart, concurrent preference preservation, and stable terminal identity and input.
`web/test/pane-chrome.spec.ts` verifies shared and borderless splits, zoom, bottom tabs, saved preferences, phone fallback, and copy controls outside terminal pixels.
Copy-mode tests also verify that searches submitted during initial frame recovery resume correctly and that Escape cancels pending searches.
`web/test/mouse-selection.spec.ts` verifies native inclusive ranges, wide and combining glyphs, URL/path double-clicks, copy-on-select persistence, clipboard shortcuts and denial, delayed-read cancellation, and selection across native scrollback.
Dark and light pixel assertions check the painted selection background, while native-reference unit cases verify the contrasting foreground.
`web/test/image-paste.spec.ts` verifies maximum-size image bytes, native owner-only staging and cleanup, real clipboard paste without extra terminal keystrokes, file drops, unchanged text paste, unsupported clients, rejected files, and delayed-read cancellation.
The image-capable companion uses the existing native clipboard message and is tested against the pinned old runtime; it does not require a native runtime replacement.
`web/test/workspace-groups.spec.ts` verifies native repository groups, active-child retention, keyboard and pointer collapse/expand, search, gateway restart, concurrent settings, scoped worktree creation/opening/deletion, dirty-checkout protection, explicit group closure, retained unrelated terminals, and desktop/phone geometry.
Group closure preserves checkouts; deletion remains a separate native action.
The ordinary Git workspace case verifies native discovery without attached worktree metadata, an outside-Git menu, delayed results after menu replacement and closure, stable keyboard focus and terminal identity, desktop/phone menu bounds, and checkout creation from an unfocused workspace.
Repository discovery uses the existing host-scoped `worktree.list` API and does not require replacement of the native runtime.
The crowded-rail test also verifies that selection and drawer opening reveal the active worktree, while metadata refreshes preserve manual scrolling and terminal identity.
Unit cases cover native status priority, missing parents, native ordering, duplicate labels, and host/target/session isolation.
Agent row preferences use the native `sidebar.agents` field and rule format, including built-in fields, `$custom` metadata, canonical per-agent overrides, blank-line gaps, and explicit color/bold/dim settings.
The browser keeps these client presentation preferences in its version-eight store with migration, revision conflicts, bounded validation, and preview/cancel.
`web/test/agent-rows.spec.ts` verifies real native metadata updates, conditional styling, literal text rendering, missing-field omission, stable terminal and row identities, save conflicts, gateway restart, and desktop/phone geometry.
Unit cases compare native defaults and canonical agent vocabulary, ASCII case folding, full finite-number parsing, first-match rule precedence, and native fair column allocation with rightmost-field retention in narrow rows.
The candidate runtime from `953505e9` exposes optional tab `custom_label` metadata and an `agent_view` projection in `session.snapshot`.
`agent.view.get` returns the same definition and ordered public pane IDs, while explicit `agent.view.changed` subscriptions report definition changes without changing older set/clear response shapes or frozen terminal-client codecs.
The browser preserves native view membership and ordering within each host, applies search/status filters afterward, and follows ordinary focus and agent-status events for dynamic filters.
Single automatic tab labels are omitted only when the runtime explicitly identifies them; older runtimes retain the label and do not receive unsupported view subscriptions.
`web/test/agent-entries.spec.ts` verifies external native set/get/clear, source-guarded clearing, empty matches, status-dependent membership, dynamic current-workspace filtering, and ordinary older-runtime ordering.
The capability case starts an isolated candidate runtime through `WERDR_TERMINAL_CLIENT_BIN` or `WERDR_TEST_HERDR_BIN`.
Native runtime adoption and live use of this metadata remain outstanding.
Plugin selection context is read from the same revision-checked native range before actions become available.
`web/test/plugin-install.spec.ts` exercises real native Git checkouts, declined previews without build execution, explicit installation, action execution, failed replacement, managed uninstall with preserved user configuration, browser reload, session revocation, gateway restart, and independent-browser isolation.
The installer preserves interactive CLI behavior over POSIX and Windows SSH; isolated checks on both Windows hosts verify preview, decline, native build execution, Git provenance, and uninstall.
The MIT-licensed `web/test/fixtures/github-install` plugin provides fixed-output native actions for live installation checks from an exact published source commit.
`web/test/scrollbar.spec.ts` verifies native history offsets, thumb dragging, rapid keyboard input, screen transitions, initial geometry, settings migration and preview, gateway restart, phone layout, and optional-capability fallback.
The optional `PaneScrollInfo.alternate_screen_active` field requires the fork runtime from `9c2dd302` or newer.
Older endpoints remain usable without a guessed scrollbar gutter.
Native API and subscription tests verify atomic screen/scroll geometry and mode-change events even when history size is unchanged.
Scroll subscriptions are limited to attached panes, do not read terminal text or invalidate fleet snapshots, and cannot follow a reassigned host identity.
Native rollout and live verification for these new scrollbars remain outstanding.
The ordinary browser fixture uses the pinned runtime in `werdr/runtime.json` unless `WERDR_TEST_HERDR_BIN` explicitly selects another binary.
The three scrollbar capability tests instead start an isolated server from `WERDR_TERMINAL_CLIENT_BIN`, falling back to `WERDR_TEST_HERDR_BIN` when no companion override is configured.
The older-endpoint scrollbar test remains on the ordinary fixture.
This matrix verifies new runtime capabilities separately while retaining coverage of the deployed runtime's compatibility; it does not activate the candidate runtime on any live host.
Test native capability failures and remote isolation rather than masking unsupported operations as success.
Run the package check and relevant browser tests during editing, then the full archive deployment checks and live verification before completion.
Keep this matrix incomplete until each row has direct evidence.

## Native runtime rollout gate

Scrollbar screen-mode metadata, native agent-view projections, and custom-tab-label metadata require a new server runtime; updating the terminal companion alone cannot provide them.

A passive endpoint metadata reader cannot safely bypass this rollout gate on the current production runtimes.
Their `surface_interest` support prevents surface activation but still permits default-workspace creation during attachment and geometry repair during disconnection.
The candidate now advertises a separate `passive_metadata` capability after eliminating these attachment and teardown side effects, and `herdr api projection [--watch]` requires that capability before connecting.
The reader exposes native ordering and custom-label facts without fabricating a view definition; the public snapshot and view API remain authoritative.
This capability is not deployed to production runtimes, and browser integration of this reader is not enabled.
Keep the optional-capability fallback until the owning runtime advertises the field.
A gateway restart and a native runtime replacement have different process-lifetime consequences.

The current native live handoff is not evidence of a lossless upgrade.
`src/server/handoff.rs` limits exported history to 8 KiB per pane, and `PaneRuntime::handoff_history_ansi()` omits alternate-screen history.
The headless lifecycle also omits this history for panes with persisted agent sessions.
The handoff implementation transfers Unix file descriptors and does not provide a Windows ConPTY transfer path.
Service supervision must preserve both the imported runtime and existing shell processes when the exporting runtime exits; moving only the new runtime outside a service control group is insufficient.

Do not replace these checks with a pane-count check followed by `server.stop`.
The existing stop method has no atomic idle condition, so a concurrent native client can create a pane between observation and shutdown.
An idle-only upgrade needs a separately advertised server operation that rejects new creation while committing shutdown, with compatibility rejection on older runtimes.
Before adopting a live transfer, verify process identity, workspace/tab/pane identity, complete retained history, primary and alternate screens, pending output, input, and supervisor recovery in an isolated service instance.
Until those conditions are established on each target platform, native rollout remains outstanding even when isolated feature tests pass.
