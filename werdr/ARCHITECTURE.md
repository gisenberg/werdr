# Browser-client architecture

Werdr keeps herdr's runtime intact and adds a separate web package.
The initial fork base is `4b5e9bda239a0b6903889062d756424578e94691`.
Its multi-machine foundation is upstream PR #3670, merged as `9e9bc8a144667a6b7debfd4f0c7a31ff0e11493a`.

```mermaid
flowchart LR
  Browser[Browser controls and Ghostty WASM] <-->|Authenticated HTTP and WebSocket| Gateway[werdr Node gateway]
  Gateway -->|machine list| Catalog[herdr saved machine catalog]
  Gateway <-->|Native API events and terminal controller| Local[Local herdr runtime]
  Gateway <-->|SSH IPC forwarding and terminal controller| Remote[Remote herdr runtime]
  Local --> LocalPTY[Native PTYs and shells]
  Remote --> RemotePTY[Native PTYs and ConPTY]
```

## Ownership

Herdr owns process lifetime, runtime state, workspace/tab/pane identity, agent detection, the SSH catalog, and native terminal parsing.
The gateway authenticates browsers and routes bounded requests to explicit saved machines.
Gateway-only credential and token files remain separate from herdr runtime state.
Username/password or access-token login issues an opaque HttpOnly SameSite cookie; only password-authenticated sessions may rotate the durable access token.
Browser cookies last 90 days and survive gateway restarts through an atomic owner-only versioned store containing token hashes and bounded browser metadata.
Browser-session revocation removes persisted authority and closes the matching terminal controllers immediately while herdr retains the shells.
Token replacement or explicit access-token revocation invalidates token-authenticated sessions; their persisted token fingerprint also prevents resurrection if shutdown interrupts rotation.
The browser owns navigation selection, its viewport, mobile chrome, and display rendering.
`ShortcutMode` owns prefix, Navigate, and resize state, while `DesktopShortcuts` resolves configured commands before terminal keyboard encoding.
Bindings and prefix preferences live in the version-ten browser settings store, with migration and revision-checked saves.
`LastPane` records reconciled browser pane/terminal identity and resolves current ancestry when invoked.
It clears on host changes, lost gateway continuity, and native API connection replacement, including replacements whose offline delta was missed.
The gateway publishes a fresh `connectionGeneration` for each native connection attempt; this is a conservative connection boundary, not a native boot identifier.
`NavigatePreview` retains a stable host/workspace highlight independently from the active terminal.
Workspace commands capture this target before leaving the mode, while directional pane focus preserves the expected attachment transition.
The mobile switcher uses a pure section model and a retained DOM renderer, makes the background inert, and restores terminal or copy focus when hidden.
Command key ownership suppresses repeats across dialogs and selection changes without consuming releases that belong to terminal input.
Literal prefixes from copy mode use the same native encoder and image-paste ordering queue as ordinary terminal input.
Layout results do not import another native client's focus; explicit browser focus actions and context-matched creation results control browser selection.
Startup and authentication are browser presentation: `BootConsole` owns credential stages and fixed display geometry, while the retained wmux React artwork and desktop components provide the historical visuals.
Text profiles use one Ghostty terminal throughout login; graphical profiles use a DOM input with the same credential stages and matching desktop fields.
The gateway serves only explicitly provisioned private font and screenshot paths; redistributable artwork remains in the web build with its license provenance.
Machine ID plus pane ID identifies a browser target; pane IDs alone are not globally unique.

The gateway launches `herdr terminal session control` with a pinned machine snapshot.
It forwards complete NDJSON records and leaves base64 terminal bytes intact until the browser passes them to Ghostty.
The fork's terminal client additionally forwards the existing native mouse and keyboard mode messages as optional `terminal.mouse` and `terminal.keyboard` records.
A separately built companion can provide those records while the checksum-pinned native runtime continues owning existing panes.
The same companion provides `config runtime read|write` for host runtime settings, using the existing companion executable overrides.
Writes accept bounded JSON on stdin, validate the native configuration, preserve unrelated TOML, compare the source revision under an interprocess lock, and replace the file atomically.
The response distinguishes a saved configuration from the running server's `server.reload_config` result.
These settings are shared by sessions using that host configuration file.
Set `WERDR_TERMINAL_CLIENT_BIN` for local controllers, `WERDR_POSIX_TERMINAL_CLIENT_BIN` for POSIX SSH controllers, or `WERDR_WINDOWS_TERMINAL_CLIENT_BIN` for Windows SSH controllers.
These administrator-only executable overrides apply solely to terminal controller processes; API, catalog, setup, and runtime commands retain their existing pinned executable.
Omitting an override preserves the existing controller executable and its supported records.
After `just build`, run `WERDR_TERMINAL_CLIENT_BIN="$PWD/target/release/herdr" npm --prefix web run test:e2e -- terminal-client.spec.ts` to verify the companion against an isolated pinned runtime through the authenticated gateway.
The `native-keyboard.spec.ts`, `native-mouse.spec.ts`, and `runtime-settings.spec.ts` browser specifications use the same companion override.
Do not replace a live runtime binary to enable client-only capabilities.
Browser disconnection releases the controller rather than closing the pane.
Takeover is an explicit action and is never part of automatic reconnect.
Herdr's rendered frames are authoritative; a `full` frame is not permission to reset a live terminal or replay a raw PTY tail.
Browser copy mode uses native content revisions, scrollback coordinates, word/paragraph motions, search, and selection reads.
It brackets native viewport text and scroll geometry with content checks and compares that text with Ghostty's rendered graphemes before establishing selection coordinates.
Only the active copy pane and explicit link clicks perform these checks, and queued operations are canceled when copy mode closes or the terminal disconnects.
The browser owns selection highlights and restores the entry scroll offset when copy mode exits normally.
Normal mouse selection uses the same native content revisions and buffer coordinates, including selections extended beyond the viewport.
The browser applies the native copy-on-select preference, word rules for URLs and quoted paths, and explicit copy shortcuts for retained ranges.
Ghostty paints the selected cells with the native contrasting foreground and background; clipboard text and plugin selection context still come from the native selection API.
Mouse-reporting applications retain their gestures, and Ghostty's automatic click-copy handler cannot issue a second clipboard write.
Scrollback editing focuses the explicitly selected native pane and invokes the host-configured editor through the native API.
The runtime owns the full-history export, private temporary file, editor process, overlay restoration and cleanup.
The browser selects an unambiguous new editor pane and follows native focus restoration after closure until the next user interaction.
Pending pane selection checks authoritative native existence so an editor that exits before its first snapshot cannot trap the browser behind an attachment shield.
Graphical editors open on the host and may leave no browser terminal.
Control/Command clicks use the same rendered/native viewport comparison before a host-scoped `pane.link.activate` request.
The gateway focuses the explicit pane and supplies both the content revision and scroll offset so native plugin handlers receive the clicked pane context.
Unhandled HTTP/HTTPS links open in a separate browser tab with no opener or referrer; blocked tabs leave a semantic link action.
Unhandled non-web links and non-link clicks fall back to ordinary terminal selection without invoking Ghostty's automatic URL opener.
Pending click gestures retain only their press, latest motion and release, and cancel on terminal changes, navigation, keyboard input, disconnection or timeout.

`Fleet` owns independent metadata connections, bounded handshake concurrency, reconnect backoff, and ordered browser deltas.
It subscribes before taking native snapshots, reconciles changes during bootstrap, subscribes to per-pane agent status, and takes a ten-second health snapshot.
Local metadata uses the existing Unix socket; POSIX SSH forwards that socket to an owner-only temporary directory.
Windows SSH multiplexes bounded channels to the existing named pipe through a PowerShell/C# IPC client.
Neither path adds a TCP listener or a second session runtime.
Agent status transitions create bounded, atomically persisted notification history; bootstrap does not announce existing work.
Notifications cover observed transitions while the gateway is running, rather than reconstructing events missed during downtime.
Each gateway fleet instance has a generation ID, with ordered revisions inside that generation.
HTTP snapshots and WebSocket snapshots share one browser ordering authority, and socket deltas remain tied to their accepted generation.
Older snapshots cannot undo a newer projection; a restart may begin at a lower revision, while ambiguous generation changes reconnect before adoption.
The browser resynchronizes after gaps or reconnects and reconciles the snapshot before recovering terminal attachments.
Initial URL or saved selection restoration uses a scoped tuple and a fresh `session.snapshot` through the connected, pinned native endpoint.
It keeps the terminal surface inert until cached metadata agrees on the requested scope and terminal identity, revalidating while metadata catches up.
Missing targets, offline hosts, and endpoint replacement remain explicit, while newer navigation or a command supersedes the pending read.
Host identity is pinned across in-flight operations, and disabling/removing a host retires metadata and terminal clients without terminating native sessions.

Workspace grouping consumes native `WorkspaceInfo.worktree` repository membership, without inferring groups from display labels or checkout paths.
Groups keep the native parent-first ordering, retain the selected child when collapsed, and aggregate collapsed status using native attention priority.
Search can reveal matching hidden children without changing the saved collapse preference.
Selecting a workspace reveals its row within the desktop workspace section or phone drawer, while ordinary metadata updates preserve manual scrolling.
Collapse state is browser chrome stored in version-eight preferences, keyed by machine ID, SSH target, named session, and repository key.
Navigation saves preserve other preferences through revision checks and recover the authoritative state after a conflict.
Contextual worktree actions retain the clicked workspace and host even when another pane is active.
Group closure passes the native explicit `close_group` flag after the configured confirmation and retains the Git checkouts; deleting a linked checkout uses the separate native worktree-removal flow.

`MachineManagement` serializes browser catalog edits and setup jobs while retaining the last valid catalog during temporary failures.
POSIX onboarding delegates compatibility and installation decisions to the upstream interactive CLI.
Windows onboarding stages the fork's checksum-pinned installer only after explicit consent and never forcibly replaces a running runtime.
Platform hints are separate from the native catalog and only apply while ID, target, and named session match.
Setup logs and input are bounded, jobs are scoped to their browser-session owner, and session revocation cancels their work.
The browser action adapter exposes an explicit native-method allowlist instead of a general RPC proxy.
GitHub plugin installation uses the selected host's native CLI in an interactive PTY, preserving its manifest/command preview, confirmation, Git checkout provenance, replacement checks, and build failures.
The gateway accepts only an owner/repository/subdirectory source and optional Git ref, never a shell command or automatic confirmation flag.
Installer jobs retain their pinned host and browser-session owner, bound concurrency, input, output, and duration, and stop on revocation or gateway shutdown.
Closing the dialog leaves a running job available in the same browser session's history; a finished command can represent a declined installation, so the UI retains the native outcome text and exit code.
Managed uninstall delegates checkout removal to the native CLI and preserves its separate plugin configuration and state.

## Why a fork

Shared history permits normal upstream merges and focused integration of open PRs.
Browser-specific files live under `web/`; fork documentation and maintenance helpers live under `werdr/` plus `WERDR.md`.
Upstream source and release files need no initial modifications.
Future native fixes should be small independent commits with characterization tests and removal conditions.

Herdr plugins package executable workflows, hooks, and panes.
A plugin may eventually launch the gateway, but it does not replace the browser-client transport or runtime extension boundary.
Avoid duplicating wmux's session-agent processes, persistence stores, or host inventory inside werdr.

## Two Ghostty implementations

Herdr's native `vendor/libghostty-vt` parses process output and participates in runtime rendering.
The browser uses wmux's patched `ghostty-web` package, pinned under `web/vendor/ghostty-web-pr169`.
Their revisions and patch sets are independent.
Preserve herdr's native patch ledger and the browser package's provenance separately.

Browser image paste and file drops use bounded binary messages on the authenticated terminal socket.
Clipboard shortcuts retain the browser paste default but suppress Ghostty's host-clipboard key signal, which would otherwise prefix image paths and text with a stray Ctrl+V byte.
The terminal companion advertises its image size limit before the browser enables transfer, and older companions retain ordinary input with explicit unsupported-image feedback.
The gateway identifies PNG/JPEG/GIF/WebP/BMP signatures, limits each image to the native 16 MiB bound, and permits at most two pending image pipe writes.
Keystrokes remain ordered behind the image with a separate 64 KiB queue.
The companion maps the image command to the existing native `ClipboardImage::DirectTerminal` message without accepting a caller-supplied path or target.
The owning runtime stages the bytes on its own host, applies its existing paste-mode behavior, and removes staged files when that controller disconnects.
Browser file reads are cancelled after attachment, pane, or focus changes, so an asynchronous read cannot paste into a replacement target.
No new native wire variant, remote listener, filesystem-upload endpoint, or server replacement is required.
