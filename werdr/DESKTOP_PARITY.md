# Herdr desktop parity

The goal is desktop parity with the native herdr experience, including behavior and visual hierarchy.
The reference is the native source and runtime pinned by `werdr/runtime.json`, including the multi-machine client.
A passing browser suite alone does not establish parity.
Each capability below needs native-reference evidence, implemented browser interaction, and verification of its actual behavior.

## Acceptance matrix

| Capability | Required browser behavior | Current evidence |
| --- | --- | --- |
| Fleet and session ownership | Host-scoped identity, independent reconnect, durable native processes, explicit takeover and closure | Existing fleet and controller tests; prolonged gateway-outage test verifies exhausted retries recover for every visible pane without page reload, forced takeover, or loss of native shell state |
| Desktop layout | Render native split tree simultaneously; preserve ratios; drag and keyboard resize; zoom, directional focus, swap, move, reorder | Implemented native split tree, independent controllers, drag and keyboard ratios, zoom, directional focus/resize/swap, pane moves and workspace/tab ordering; isolated browser tests exercise input, stable terminal DOM, phone fallback and gateway restart |
| Visual hierarchy | Native semantic palette, compact cell rhythm, borders and active pane cues, configurable sidebar sections and contextual hints | Partial: native semantic palette and active pane borders; sidebar sections and contextual hints remain |
| Themes | All native theme choices, custom semantic overrides, light/dark/system selection and live preview/cancel | Implemented palette extraction, preview/cancel, system switching and custom colors; package and browser tests cover these behaviors |
| Preferences | Durable user settings with device overrides, sidebar geometry/group state/sorting, status indicators, tab/border behavior, shortcuts and confirmations | Partial: settings store, appearance, font/device override, sidebar width/density, agent order, indicators, confirmations and notification controls; shortcuts/group state/border controls remain |
| Terminal interaction | Native copy mode and search, selection/copy, scrollback editing, links, mouse behavior and image paste | Partial: native full-scrollback copy/search with revision-checked character/line selections, word/paragraph motions, repeat search, clipboard feedback and scroll restoration; isolated browser tests cover Unicode, combining characters, wrapped matches, content changes, queued-operation cancellation and phone controls; native host-editor invocation with full-history export, overlay focus restoration, reload, early-exit recovery and temporary-file cleanup; native plugin link activation and safe HTTP/HTTPS opening with revision/viewport checks, OSC targets, blocked-tab fallback and delayed non-link drag preservation; application mouse press/drag/release and wheel coordinates/modifiers follow native mode records; Kitty press/repeat/release/reset uses the native encoder, with browser checks for modifier changes and focus loss; normal-mode native mouse-copy behavior, complete keyboard layout/protocol coverage and image paste remain |
| Workspace navigation | Native workspace/tab/pane actions, pickers, keyboard navigation and context menus | Partial: create/rename/close plus searchable host-qualified workspace/tab/pane palette entries, keyboard result navigation, live removal and terminal focus restoration; unit tests verify duplicate-label identity and stale-target rejection, and browser tests cover desktop/phone switching without remounting the selected pane; workspace/tab/pane chrome context menus add rename, close, new tab, split and zoom with keyboard access, stale-target dismissal and attach-focus protection; native worktree-group and advanced pane menu actions remain |
| Worktrees | Native list/create/open/remove flows with host and repository scope and native errors | Implemented native repository picker and create/open/remove; isolated Git browser test verifies branch and checkout identity, dirty removal rejection, explicit force, normal native checkout hooks, and repository retention |
| Agents | Start/prompt/rename, native ordering/views, detail/status metadata and attention navigation | Partial: basic actions and fleet list |
| Notifications | Native attention/completion semantics, configurable delivery/delay/position/sound and clipboard feedback | Partial: durable fleet activity and desktop opt-in |
| Integrations | Native readiness list and explicit installation/uninstallation with results | Implemented all native targets, individual and recommended installs, uninstall confirmation and native results; isolated agent-config browser tests verify install/reinstall/uninstall, preservation of unrelated settings and native failures |
| Plugins | Native management, actions, logs and plugin pane lifecycle | Partial: native linking/unlinking, enable/disable, manifest inspection, selected-context actions, logs, and overlay/split/tab/zoomed panes; isolated native tests verify command outcomes, input, closure, focus restoration and gateway restart; popup surfaces and GitHub installation remain |
| Host onboarding | Shared native catalog, explicit compatibility/install prompts and repair, no forced runtime replacement | Existing management tests; extend compatibility coverage |
| Runtime configuration | Explicit host-scoped shell/cwd/scrollback/worktree/resume settings and validated reload | Browser controls use the companion to preserve unrelated TOML, reject stale revisions, save atomically, and report native reload results; isolated POSIX tests verify new-pane cwd, invalid input, foreign-origin rejection, concurrent edits and save/reload partial outcomes; live Windows validation remains |
| Desktop ergonomics | Keyboard help, focus restoration, accessible forms, context menus, responsive fallback, no terminal remount during chrome changes | Partial: responsive console dialogs, native fallback focus after closure, and command-palette readiness updates preserve search and keyboard focus; remaining ergonomics still need verification |
| Delivery | Reviewed commits, verified remotes, pinned deployment, native panes preserved and live POSIX/Windows validation | Required for final result |

## Verification

Use isolated native runtimes for destructive actions and never mutate user panes to make a test pass.
Compare desktop screenshots at fixed geometry against native layouts and theme tokens.
Exercise multiple panes, host changes, browser reconnect, gateway restart, keyboard and mouse interactions, and independent viewers.
Keep phone operation and the existing authentication/boot collection working while adding desktop behavior.
Exercise settings persistence, validation, concurrent edits, invalid/future stores, and preview cancellation.
Test native capability failures and remote isolation rather than masking unsupported operations as success.
Run the package check and relevant browser tests during editing, then the full archive deployment checks and live verification before completion.
Keep this matrix incomplete until each row has direct evidence.
