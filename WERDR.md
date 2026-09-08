# werdr

werdr is a browser client for herdr, maintained as a thin fork of [herdrdev/herdr](https://github.com/herdrdev/herdr).
Herdr owns the sessions, machines, agents, and native terminal processes.
Werdr adds browser access, console-style navigation, wmux's patched Ghostty renderer, and portable retro boot screens.

The upstream Rust tree and README are retained so future herdr merges remain straightforward.
Start here for the web application; the root README describes upstream herdr.

## Run the first web version

Use Node.js 22.12 or newer and a herdr build with `terminal session control` and multi-machine support.
PR [#3670](https://github.com/herdrdev/herdr/pull/3670) is already included in this fork.
Background connections never install or restart a remote server.
Use **MANAGE HOSTS** to add a host or explicitly run compatibility setup and answer native installation prompts.

For a Linux x64 trial, fetch the checksum-pinned official preview used by the integration tests:

```sh
node werdr/fetch-runtime.mjs
```

Start an isolated herdr server in one terminal:

```sh
XDG_CONFIG_HOME="$PWD/.local/trial-config" SHELL=/bin/bash .local/bin/herdr server
```

Start the gateway from another terminal at the repository root:

```sh
cd web
npm ci
npm run build
XDG_CONFIG_HOME="$PWD/../.local/trial-config" WERDR_HERDR_BIN="$PWD/../.local/bin/herdr" npm start
```

Open `http://127.0.0.1:3480` and enter the access token from `web/.auth-token`.
The gateway creates that ignored, owner-only file on first start.
For TLS, configure `WERDR_CERT_FILE` and `WERDR_KEY_FILE` and open the matching `https://` hostname instead.
TLS listeners reject plaintext origins; the private bind and exact Host/Origin boundary remain enforced.
To enable username/password login, set `WERDR_CREDENTIALS_FILE` to an owner-only JSON file outside the checkout containing `username` and `passwordHash`.
The hash format is wmux-compatible `scrypt$<32 hex salt characters>$<64 hex hash characters>`; plaintext passwords are never stored.
A private copy of an existing wmux `auth.json` can be used as this file.
When configured, the selected boot console prompts for a username, then a password after Enter, and also offers token login.
Text profiles authenticate in the same fixed-grid Ghostty terminal as boot; the six graphical profiles use their matching desktop login windows.
Both keep the selected display geometry through username, password, retries, and access granted.
It stays in that machine's console through retries and access granted; password and token characters are not echoed into the console.
After password login, **ACCESS TOKEN** lets you generate a replacement token for another browser.
Generation atomically updates `WERDR_TOKEN_FILE`, invalidates the old token, and revokes sessions and terminal sockets authenticated with it.
Password-authenticated sessions remain signed in, and token-authenticated sessions cannot generate tokens.

Use the workspace `[+]` control to launch a shell.
On phones, `[W] SWITCH` opens the full-screen host, agent, workspace, and tab switcher.
`[H] HOSTS` opens the searchable navigation drawer.

The C64 font and redistributable artwork are bundled; provision the other faces and Workbench screenshot privately using the [asset setup](werdr/BOOT_FONTS.md) to match wmux.

For an existing herdr installation, set `WERDR_HERDR_BIN` to its executable and omit the trial configuration override.
Build the Rust binary using upstream's documented toolchain when the pinned Linux fixture is unsuitable.

## Keyboard controls

The default command prefix is `Ctrl+B`.
Press and release it, then press a command key: `v` splits right, `-` splits down, `c` creates a tab, `1` through `9` selects a tab, and `?` opens keyboard help.
Press the prefix twice to send a literal prefix key to the pane, including from copy mode.
`Ctrl/Cmd+K` opens the command palette, while `Ctrl/Cmd+D` and `Ctrl/Cmd+Shift+D` retain the direct split shortcuts.

Prefix followed by `w` enters Navigate mode.
Up/Down previews workspaces without switching the active terminal; Enter confirms, and bare `1` through `9` selects a numbered workspace.
Desktop preview wraps through visible groups; phone preview clamps and includes expanded groups.
`h/j/k/l` and Left/Right move between panes while retaining the workspace preview; Tab/Shift+Tab cycles panes and exits Navigate.
Escape or the configured prefix cancels, returning to Copy mode when it is still active.
Workspace rename, close, creation source, and worktree commands use the highlighted workspace; tab and pane commands use the active terminal context.
On phones, the switcher supports touch selection, isolated scrolling, and menu actions without removing the terminal.

Prefix followed by `r` enters resize mode.
Use `h/j/k/l` or arrows to resize repeatedly, then press Enter, Escape, or the configured resize binding to finish.
Prefix followed by `[` opens native scrollback copy mode; its existing search and movement keys stay active outside a prefix command.

Open **SETTINGS**, expand **KEYBINDINGS**, and edit the prefix or individual actions.
Bindings use native syntax such as `prefix+shift+n`, `ctrl+alt+n`, or `super+k`; `super` means Command on macOS or the Windows key.
Separate alternatives with commas, use `comma` or `plus` for literal punctuation, and leave an action empty to disable its bindings.
Indexed tab, workspace, and agent actions use a `1..9` range.
Changes preview until saved, persist across browsers, and restore after gateway restarts.
Navigate bindings form a separate scope and may use bare letters without intercepting terminal typing.
Validation rejects conflicting bindings within a scope, reserved navigation keys, and reserved copy/paste gestures.
Browser and OS shortcuts may not reach the page; configure a prefix alternative for those keys.

Help shows the saved bindings and whether each action is available in the selected context.
Editable controls, dialogs, IME composition, clipboard access, and held command keys retain their own input scope.
Unrelated pane, attachment, or host changes cancel an armed command.
Navigate preserves its own directional pane focus through the expected terminal attachment.
Native fallback after a move still follows the moved pane, while a newer navigation or command prevents an older response from changing selection.
The browser binding catalog covers its supported built-in actions; native custom shell bindings, detach/reload/notification-target bindings, and last-pane tracking remain outside this catalog.
## Current behavior

**SETTINGS** provides native herdr palettes, custom semantic colors, live preview/cancel, system light/dark switching, terminal fonts, sidebar density/width, agent ordering, close confirmations, and notification options.
Preferences are stored at the gateway with revision checks to prevent one browser overwriting another browser's edits.
An optional device font-size override stays in that browser.
Theme and font changes update the mounted terminal without releasing its controller.


- Fleet-wide host, workspace, and agent navigation with search, attention filters, connection health, and independent background reconnects.
- Native host add/setup, rename, enable, disable, and removal through **MANAGE HOSTS**.
- Durable attention/completion activity with pane links and optional desktop notifications.
- Workspace, tab, pane, and agent rename; agent start and prompt actions through `Ctrl/Cmd+K`.
- Shareable host/workspace/tab/pane URLs and selection restored after reload.
  URL coordinates form one request and do not inherit unrelated saved tab or pane IDs.
  Restoration validates the requested scope with the native host and keeps terminal input blocked until fleet metadata agrees.
  Missing or offline targets remain explicit; choosing a host or workspace cancels restoration.
- Workspace/tab creation, pane splitting and closure, and explicit terminal takeover.
- Live terminal input, resize, and scroll through herdr's controller stream.
- Desktop and phone layouts with a collapsed mobile host drawer.
- All 36 wmux startup profiles, including six graphical desktops, Amiga Workbench/Guru recovery, Spectrum tape borders, original fonts and artwork, and synthesized POST/floppy sounds.
  A profile is randomly chosen each page load without consecutive repeats when browser storage is available.
- Startup has no visible settings or prompts; any key or click dismisses it, and reduced-motion preferences shorten it.
- Authenticated REST and WebSocket access with logout revocation.

Desktop displays the native split tree with independent controllers for visible panes; phones display the selected pane.
Metadata stays connected for every enabled saved host through native event subscriptions, with a ten-second reconciliation heartbeat.
A surface retains up to 16 pane controllers, with explicit capacity feedback and zoom access for larger layouts.
Full wmux media/clipboard integration remains outside the current browser implementation.
The remaining native desktop work is tracked in [the parity acceptance matrix](werdr/DESKTOP_PARITY.md).
This is a working first version, not feature parity with wmux.

## Configuration and operations

| Variable | Meaning |
| --- | --- |
| `WERDR_HERDR_BIN` | Local executable, default `herdr`. |
| `WERDR_SOCKET_PATH` | Explicit local API socket override. |
| `WERDR_SESSION` | Local named session. |
| `WERDR_CERT_FILE` / `WERDR_KEY_FILE` | Configure both PEM paths to enable HTTPS and secure cookies; certificate changes reload every 60 seconds without restarting the gateway. |
| `WERDR_HOST` | Private IP literal, default `127.0.0.1`. |
| `WERDR_ALLOWED_HOSTS` | Comma-separated exact DNS names or IP literals accepted in addition to the bind address, without ports or wildcards. |
| `WERDR_PORT` | Gateway port, default `3480`. |
| `WERDR_BOOT_ASSET_DIR` | Private directory containing the Workbench GIF; never bundled in the public fork. |
| `WERDR_BOOT_FONT_DIR` | Optional private directory containing the 17 ZX Origins WOFF2 files; see [font provisioning](werdr/BOOT_FONTS.md). |
| `WERDR_CREDENTIALS_FILE` | Optional owner-only credential JSON path; explicit missing or invalid files prevent startup. |
| `WERDR_TOKEN_FILE` | Token path, default `.auth-token` under `web/`. |
| `WERDR_WINDOWS_HERDR_BIN` | Optional Windows executable path; remote environment variables such as `%LOCALAPPDATA%` are expanded without shell evaluation. |
| `WERDR_SETTINGS_FILE` | Owner-only versioned browser preferences, default `browser-settings.json` beside the access token. |
| `WERDR_NOTIFICATION_FILE` | Owner-only versioned activity history, default `fleet-notifications.json` beside the access token. |
| `WERDR_MACHINE_PLATFORM_FILE` | Owner-only platform hints pinned to native host ID, target, and session, default `machine-platforms.json` beside the access token. |
| `WERDR_WINDOWS_MACHINES` | Comma-separated saved machine IDs requiring the experimental PowerShell SSH adapter. |

Add and manage remote machines in **MANAGE HOSTS** or using `herdr machine` commands.
Both use the same native catalog; this is explicit registration, without LAN scanning or heartbeat discovery.
Stable private LAN aliases are supported alongside Tailscale names, and may be preferable on the same network.
OpenSSH owns credentials and host-key verification on the gateway; establish trusted key-based login before browser onboarding.
New browser targets must resolve exclusively to private addresses.
Choose Linux/macOS or Windows explicitly during setup.
POSIX setup runs native `herdr machine add` in a temporary interactive console and forwards its compatibility/install prompts.
Windows setup checks the existing named runtime, asks before installing the pinned release and supervised task, and saves the validated endpoint in the native catalog.
Setup jobs belong to the initiating browser session; revoking that session cancels its active setup.
Closing the setup dialog leaves a running job available to reopen; **CANCEL SETUP** cancels it explicitly.
Disable or remove disconnects browser access without deleting remote workspaces or stopping their processes.
See [Windows and terminal compatibility](werdr/WINDOWS.md) for the managed installation and remaining terminal acceptance criteria.

Only loopback and private-network IPs may be bound.
Set `WERDR_ALLOWED_HOSTS` to explicitly allow the service's short hostname and full Tailscale DNS name while keeping `WERDR_HOST` on its private IP.
The browser Origin must match the requested host and port, even when both aliases are individually allowed.
The gateway supports direct HTTPS with the configured certificate and key; it does not support a separate reverse-proxy origin.
Access tokens never go into URLs or local storage.
Login attempts are limited by the actual peer IP, and password verification concurrency is bounded.
Browser login issues a random HttpOnly SameSite cookie valid for 90 days, with Secure set under HTTPS.
Only a SHA-256 hash is persisted in the schema-versioned, owner-only `browser-sessions.json` beside the access-token file; `WERDR_SESSION_FILE` overrides that location.
Atomic serialized writes preserve revocations across restarts; invalid or future stores stop startup rather than resurrecting credentials from a backup.
The SESSIONS panel lists signed-in browsers and lets the owner revoke one browser or all other browsers immediately, including their open terminal sockets.
REVOKE ACCESS TOKEN invalidates the shared sign-in token and browsers issued from it; password-authenticated browsers stay signed in.
Browser cookies survive reloads, browser restarts, and gateway deployments until expiry, revocation, or explicit sign-out.
Restarting the gateway releases terminal controllers; herdr continues owning the running shells.
Closing a pane explicitly terminates its process.

## Development and upstream updates

```sh
cd web
npm run check
npm run test:e2e
```

Browser tests start isolated herdr and gateway processes and clean up their temporary workspaces.
They default to `.local/bin/herdr`; set `WERDR_TEST_HERDR_BIN` to test a locally built binary.
Install Chromium with `npx playwright install chromium` if it is not already available.
The checksum-pinned fixture tests an official upstream preview rather than compiling the current Rust checkout.
Run upstream `just check` as well when modifying the runtime or integrating new upstream runtime changes.

See [architecture](werdr/ARCHITECTURE.md), [upstream workflow](werdr/UPSTREAM.md), and [third-party notices](web/THIRD_PARTY_NOTICES.md).

## Desktop pane layouts

The browser renders the native split tree with simultaneous terminals on desktop.
Drag a divider or focus it and use the arrow keys to change its native saved ratio.
The command palette includes zoom, directional focus, resize and swap, pane moves to tabs or workspaces, and tab/workspace ordering.
Chrome updates and focus changes retain existing terminal elements and controller connections.
On phones, only the selected pane is visible and hidden panes retain their last terminal size.
Layout exports sent to browsers include only geometry and public identities, excluding native commands and environment variables.

## Native worktrees

Open **Worktrees** from the command palette to list, create, open, or remove a worktree on the selected host.
The current pane directory is suggested, and an explicit repository path can be entered.
Branch, base ref, checkout path, and workspace label are passed to herdr; blank optional fields use native defaults.
Repository trust explicitly overrides Git ownership checks for that operation and does not suppress Git hooks.
Removal uses the native workspace-scoped worktree operation, requires confirmation, and preserves dirty checkouts unless force is explicitly selected.
Closed worktrees can be opened before removal.

## Agent integrations

Open **Manage host integrations** in Settings, or use the command palette, to inspect native agent availability and hook installation state on the selected host.
Install, update, reinstall, and uninstall use herdr's native integration API and display its results.
**Install recommended** selects outdated integrations and available agents whose integration is not installed, matching the native desktop rule.
Closing the panel stops any remaining unstarted batch actions.

## Native plugins

Open **Manage host plugins** in Settings or **Plugins** in the command palette for the selected host.
Link a trusted directory already present on that host, inspect its manifest and commands, enable or disable it, or unlink its registration while retaining its files and running panes.
Actions receive the selected pane's native workspace, tab, cwd, worktree, and agent context, along with any browser terminal selection.
Browser mutations are serialized per host so another browser action cannot interrupt the focus-and-invoke sequence, and every step remains pinned to the same host connection.
Command logs retain native running, succeeded, and failed outcomes, exit codes, stdout, and stderr; filter by plugin and choose the native log limit from 10 through 200 entries.
Plugin panes support native overlay, split, tab, and zoomed placements, input, focus, and explicit closure.
An overlay's exit restores the native focused pane while retaining the underlying browser terminals.
Native popup surfaces and GitHub plugin installation are still pending in the browser, as tracked in the [desktop parity matrix](werdr/DESKTOP_PARITY.md).
