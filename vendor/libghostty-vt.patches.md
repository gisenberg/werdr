# libghostty-vt local patches

This file tracks intentional local changes applied on top of the vendored
`libghostty-vt` source. Remove a patch only when the vendored source commit
contains the upstream behavior and the listed verification still passes.

## 0001 default lib-vt panes to grapheme clustering

status: active

patch: `vendor/patches/libghostty-vt/0001-default-grapheme-cluster-mode.patch`

herdr issue: https://github.com/herdrdev/herdr/issues/243

upstream discussion: not opened; libghostty-vt currently exposes current mode mutation but no C API for configuring terminal default modes

upstream pr: not opened

vendored base: `c5a21edfcbc2d5b46540ad91b7980aca31f5f1f3`

local files:

- `vendor/libghostty-vt/src/terminal/c/terminal.zig`

reason: Herdr renders terminal cells directly and requires DEC private mode
2027 to store flags, ZWJ emoji, and other multi-codepoint grapheme clusters in
one cell. This patch makes clustering active for new terminals and keeps it as
the reset default so RIS (`ESC c`) does not disable it.

remove when: libghostty-vt exposes a C API for setting default mode 2027, or
upstream makes grapheme clustering the lib-vt default, and the reset-survival
regression passes without this patch.

verification:

```sh
cargo nextest run --locked grapheme_cluster_mode_is_default_and_survives_full_reset
cargo nextest run --locked grapheme_cluster_mode_renders_flag_emoji_in_single_wide_cell
cargo nextest run --locked grapheme_cluster_mode_renders_zwj_family_in_single_wide_cell
```

## 0002 expose modifyOtherKeys mode through terminal data

status: active

patch: `vendor/patches/libghostty-vt/0002-expose-modify-other-keys-mode.patch`

herdr issue: none; fixes the performance regression exposed by
https://github.com/herdrdev/herdr/pull/2303

upstream discussion: not opened

upstream pr: not opened

vendored base: `c5a21edfcbc2d5b46540ad91b7980aca31f5f1f3`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/terminal.h`
- `vendor/libghostty-vt/src/terminal/c/terminal.zig`

reason: Herdr must know whether xterm modifyOtherKeys mode 2 is active to
request printable key releases from the outer terminal. The formatter API can
recover this fact only by formatting the active screen and scrollback. A typed
terminal-data query exposes the authoritative scalar without formatting or
allocation.

remove when: the vendored source exposes an equivalent scalar query for
modifyOtherKeys mode 2 and Herdr can use it without this patch.

verification:

```sh
cargo nextest run --locked modify_other_keys_query_tracks_mode_two
cargo nextest run --locked host_report_all_supplies_printable_releases_for_event_type_only_panes
python3 -m unittest scripts.test_vendor_libghostty_vt scripts.test_ui_hot_path_architecture
```

## 0003 export explicit screens without switching terminal state

status: active

patch: `vendor/patches/libghostty-vt/0003-export-explicit-screen-vt.patch`

herdr issue: none; browser desktop-parity runtime handoff work in the werdr fork

upstream discussion: not opened

upstream pr: not opened

vendored base: `c5a21edfcbc2d5b46540ad91b7980aca31f5f1f3`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/formatter.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/formatter.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`

reason: The C formatter API exposes only the active screen.
Handoff needs to read retained primary history while an application owns the alternate screen without switching or mutating the live terminal.
The new one-shot formatter reads the explicitly selected screen and exports its VT content and existing ScreenFormatter extras.
It rejects an uninitialized alternate screen instead of creating one, validates raw screen identifiers, and clears output parameters on failure.
It does not claim to serialize global modes, saved cursors, or parser continuation.

remove when: the vendored C API exposes equivalent read-only explicit-screen VT formatting and the preservation and reconstruction tests pass through that API.

verification:

```sh
cargo nextest run --locked explicit_screen_export
python3 -m unittest scripts.test_vendor_libghostty_vt
```

Rust bindings are generated with rust-bindgen 0.72.1 from the C headers.
The generator may need the host compiler's include path through its normal Clang arguments.

```sh
bindgen vendor/libghostty-vt/include/ghostty/vt.h --allowlist-function 'ghostty_.*' --allowlist-type 'Ghostty.*' --allowlist-var 'GHOSTTY_.*' --with-derive-default --output src/ghostty/bindings.rs -- -Ivendor/libghostty-vt/include
```

## 0004 preserve pending single character shifts in VT exports

status: active

patch: `vendor/patches/libghostty-vt/0004-preserve-pending-charset-shift.patch`

herdr issue: none; browser desktop-parity terminal restoration work in the werdr fork

upstream discussion: not opened

upstream pr: not opened

vendored base: `c5a21edfcbc2d5b46540ad91b7980aca31f5f1f3`

local files:

- `vendor/libghostty-vt/src/terminal/formatter.zig`

reason: ScreenFormatter exports character-set designations and locking invocations but omits a pending SS2 or SS3.
Restoring such an export changes the next printed character, for example turning a British-character-set pound sign into a hash.
Emit the pending single shift after screen content, without consuming the live source state.
This does not constitute complete terminal-state serialization.

remove when: upstream ScreenFormatter retains pending single shifts and the primary/alternate-screen restoration regression passes without this patch.

verification:

```sh
just test-one explicit_screen_export
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```
