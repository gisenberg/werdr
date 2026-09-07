# Herdr desktop parity

The goal is desktop parity with the native herdr experience, including behavior and visual hierarchy.
The reference is the native source and runtime pinned by `werdr/runtime.json`, including the multi-machine client.
A passing browser suite alone does not establish parity.
Each capability below needs native-reference evidence, implemented browser interaction, and verification of its actual behavior.

## Acceptance matrix

| Capability | Required browser behavior | Current evidence |
| --- | --- | --- |
| Fleet and session ownership | Host-scoped identity, independent reconnect, durable native processes, explicit takeover and closure | Existing fleet and controller tests; retain through every change |
| Desktop layout | Render native split tree simultaneously; preserve ratios; drag and keyboard resize; zoom, directional focus, swap, move, reorder | Implemented native split tree, independent controllers, drag and keyboard ratios, zoom, directional focus/resize/swap, pane moves and workspace/tab ordering; isolated browser tests exercise input, stable terminal DOM, phone fallback and gateway restart |
| Visual hierarchy | Native semantic palette, compact cell rhythm, borders and active pane cues, configurable sidebar sections and contextual hints | Partial: native semantic palette and active pane borders; sidebar sections and contextual hints remain |
| Themes | All native theme choices, custom semantic overrides, light/dark/system selection and live preview/cancel | Implemented palette extraction, preview/cancel, system switching and custom colors; package and browser tests cover these behaviors |
| Preferences | Durable user settings with device overrides, sidebar geometry/group state/sorting, status indicators, tab/border behavior, shortcuts and confirmations | Partial: settings store, appearance, font/device override, sidebar width/density, agent order, indicators, confirmations and notification controls; shortcuts/group state/border controls remain |
| Terminal interaction | Native copy mode and search, selection/copy, scrollback editing, links, mouse behavior and image paste | Partial: basic controller input/scroll only |
| Workspace navigation | Native workspace/tab/pane actions, pickers, keyboard navigation and context menus | Partial: create/rename/close and limited palette |
| Worktrees | Native list/create/open/remove flows with host and repository scope and native errors | Missing |
| Agents | Start/prompt/rename, native ordering/views, detail/status metadata and attention navigation | Partial: basic actions and fleet list |
| Notifications | Native attention/completion semantics, configurable delivery/delay/position/sound and clipboard feedback | Partial: durable fleet activity and desktop opt-in |
| Integrations | Native readiness list and explicit installation/uninstallation with results | Missing |
| Plugins | Native management, actions, logs and plugin pane lifecycle | Missing |
| Host onboarding | Shared native catalog, explicit compatibility/install prompts and repair, no forced runtime replacement | Existing management tests; extend compatibility coverage |
| Runtime configuration | Explicit host-scoped shell/cwd/scrollback/worktree/resume settings and validated reload | Missing browser controls |
| Desktop ergonomics | Keyboard help, focus restoration, accessible forms, context menus, responsive fallback, no terminal remount during chrome changes | Partial |
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
