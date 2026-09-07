# werdr

werdr is a browser client for herdr, maintained as a thin fork of [herdrdev/herdr](https://github.com/herdrdev/herdr).
Herdr owns the sessions, machines, agents, and native terminal processes.
Werdr adds browser access, console-style navigation, wmux's patched Ghostty renderer, and portable retro boot screens.

The upstream Rust tree and README are retained so future herdr merges remain straightforward.
Start here for the web application; the root README describes upstream herdr.

## Run the first web version

Use Node.js 22.12 or newer and a herdr build with `terminal session control` and multi-machine support.
PR [#3670](https://github.com/herdrdev/herdr/pull/3670) is already included in this fork.
The web gateway does not install, upgrade, or restart remote herdr servers.

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
To enable username/password login, set `WERDR_CREDENTIALS_FILE` to an owner-only JSON file outside the checkout containing `username` and `passwordHash`.
The hash format is wmux-compatible `scrypt$<32 hex salt characters>$<64 hex hash characters>`; plaintext passwords are never stored.
A private copy of an existing wmux `auth.json` can be used as this file.
When configured, the selected boot console prompts for a username, then a password after Enter, and also offers token login.
Authentication stays in that machine's console through retries and access granted; password and token characters are not echoed into the console.
After password login, **ACCESS TOKEN** lets you generate a replacement token for another browser.
Generation atomically updates `WERDR_TOKEN_FILE`, invalidates the old token, and revokes sessions and terminal sockets authenticated with it.
Password-authenticated sessions remain signed in, and token-authenticated sessions cannot generate tokens.

Use the workspace `[+]` control to launch a shell.
On phones, `[H] HOSTS` opens the navigation drawer.
The C64 font is bundled; provision the other two faces privately using the [font setup](werdr/BOOT_FONTS.md) to match wmux.

For an existing herdr installation, set `WERDR_HERDR_BIN` to its executable and omit the trial configuration override.
Build the Rust binary using upstream's documented toolchain when the pinned Linux fixture is unsuitable.

## Current behavior

- Native host, workspace, tab, and pane navigation.
- Workspace/tab creation, pane splitting and closure, and explicit terminal takeover.
- Live terminal input, resize, and scroll through herdr's controller stream.
- Desktop and phone layouts with a collapsed mobile host drawer.
- Full-screen Commodore 64, Apple IIe, and IBM PC AT startup sequences using wmux's original embedded fonts when provisioned, randomly chosen each page load without consecutive repeats when browser storage is available.
- Startup has no visible settings or prompts; any key or click dismisses it, and reduced-motion preferences shorten it.
- Authenticated REST and WebSocket access with logout revocation.

The browser displays one selected pane at a time, including on desktop.
Metadata is refreshed for the selected host every five seconds.
Simultaneous split surfaces, event-driven fleet metadata, browser settings persistence, full wmux media/clipboard integration, and the complete historical boot-artwork collection are not implemented.
This is a working first version, not feature parity with wmux.

## Configuration and operations

| Variable | Meaning |
| --- | --- |
| `WERDR_HERDR_BIN` | Local executable, default `herdr`. |
| `WERDR_SOCKET_PATH` | Explicit local API socket override. |
| `WERDR_SESSION` | Local named session. |
| `WERDR_HOST` | Private IP literal, default `127.0.0.1`. |
| `WERDR_ALLOWED_HOSTS` | Comma-separated exact DNS names or IP literals accepted in addition to the bind address, without ports or wildcards. |
| `WERDR_PORT` | Gateway port, default `3480`. |
| `WERDR_BOOT_FONT_DIR` | Optional private directory containing `Apple_2.woff2` and `IBM_CGA.woff2`; see [font provisioning](werdr/BOOT_FONTS.md). |
| `WERDR_CREDENTIALS_FILE` | Optional owner-only credential JSON path; explicit missing or invalid files prevent startup. |
| `WERDR_TOKEN_FILE` | Token path, default `.auth-token` under `web/`. |
| `WERDR_WINDOWS_MACHINES` | Comma-separated saved machine IDs requiring the experimental PowerShell SSH adapter. |

Add and manage remote machines using `herdr machine` commands.
Werdr reads that existing catalog; OpenSSH owns credentials and host-key verification.
POSIX shells are the default remote adapter.
Windows must be explicitly selected by saved machine ID because herdr's catalog has no operating-system field.
Real remote SSH and Windows validation remain outstanding; see [Windows and terminal compatibility](werdr/WINDOWS.md).

Only loopback and private-network IPs may be bound.
Set `WERDR_ALLOWED_HOSTS` to explicitly allow the service's short hostname and full Tailscale DNS name while keeping `WERDR_HOST` on its private IP.
The browser Origin must match the requested host and port, even when both aliases are individually allowed.
The gateway does not yet support a separate reverse-proxy or HTTPS origin.
Access tokens never go into URLs or local storage.
Login attempts are limited by the actual peer IP, and password verification concurrency is bounded.
Browser sessions are held in gateway memory and expire after 12 hours.
Restarting the gateway requires signing in again and releases terminal controllers; herdr continues owning the running shells.
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
