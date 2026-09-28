# libghostty-vt local patches

This file tracks intentional local changes applied on top of the vendored `libghostty-vt` source.
Remove a patch only when the vendored source commit contains the upstream behavior and the listed verification still passes.

## 0012 exact empty-storage graphics policy restoration

status: active, private restore prerequisite; retained graphics and partial APC remain excluded

patch: `vendor/patches/libghostty-vt/0012-snapshot-graphics-policy.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/snapshot.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/terminal.zig`

reason: The binary codec omits per-screen graphics limits, media permissions, temporary directories, PNG/source forwarding and APC recognition/limits.
Restoring current environment defaults is not policy preservation, even when image storage is empty.
Expose a frozen sized V1 policy record with borrowed reads and transactional application to a matching graphics-empty, APC-inactive terminal.
Directory slices share one terminal-owned backing buffer, including paths inherited by newly created alternate screens.
Application copies borrowed input before releasing old storage and rebinds supplied destination callbacks without copying source contexts.
Unknown flags, incompatible features/screens, invalid lengths, missing required callbacks and allocation failures reject before mutation.
This API does not preserve retained graphics or repair partial-APC replay timing.

remove when: upstream preserves equivalent exact policy with matching ownership and atomicity guarantees, and the policy restoration and future-input tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=snapshot graphics policy' --summary all
zig build test-lib-vt -Demit-lib-vt=true '-Dvt-features=-kitty-graphics' '-Dtest-filter=snapshot graphics policy' --summary all
just test-one graphics_policy
just test-one pane_state_draft
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

The Zig commands run inside `vendor/libghostty-vt`.
Rust bindings are generated with `just libghostty-bindings`.

## 0011 snapshot graphics and glyph exclusions

status: active, private restore prerequisite; not runtime handoff eligibility

patch: `vendor/patches/libghostty-vt/0011-snapshot-graphics-exclusions.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/snapshot.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/snapshot.zig`

reason: Native snapshots omit images, placements, in-progress loading, automatic IDs and glyph registrations.
Continuation replay also occurs before caller APC recognition policy is restored, so even ignored partial APC can change behavior.
Expose an allocation-free read-only query over both existing screens and the APC handler so the private pane draft can reject these exclusions before encoding.
Zero flags do not establish full eligibility: empty-storage graphics policy, other protocol state and external I/O ownership still require preservation.

remove when: upstream exposes an equivalent conservative query or faithfully preserves these states, and the native and Rust graphics exclusion regressions pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=snapshot graphics exclusions' --summary all
just test-one snapshot_graphics_exclusions
just test-one pane_state_draft
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

The Zig command runs inside `vendor/libghostty-vt`.
Rust bindings are generated with `just libghostty-bindings`.

## 0010 explicit-screen tracked references

status: active, restore prerequisite; not wired into runtime handoff

patch: `vendor/patches/libghostty-vt/0010-explicit-screen-tracked-reference.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/terminal.h`
- `vendor/libghostty-vt/src/terminal/c/terminal.zig`
- `vendor/libghostty-vt/src/terminal/c/grid_ref_tracked.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/lib_vt.zig`

reason: Restoring the Windows recent-output observer requires its owning screen and full-screen coordinate, including when the primary screen is inactive.
Expose read-only screen/coordinate capture and explicit-screen tracking without initializing or activating a screen.
Reuse existing allocation, registration, rollback and retained decode-budget ownership.

remove when: upstream exposes equivalent non-mutating observer capture and explicit-screen tracking, and inactive-screen restoration and transactional rejection tests pass without this patch.

verification: Full `just check` passed, including 3,973 Rust tests, maintenance patch validation and Windows cross-target lint.
The five Rust tracked-row snapshot tests passed as part of that run.
The native `zig build test-lib-vt -Demit-lib-vt=true -Dtest-filter='tracked observer snapshot'` build passed 71 tests across two artifacts, including support tests.
Native Windows pending-refresh continuation validation remains a separate gate.

## 0009 snapshot allocation budget and page allocator policy

status: active, restore prerequisite; not wired into runtime handoff

patch: `vendor/patches/libghostty-vt/0009-snapshot-page-allocator-policy.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/snapshot.h`
- `vendor/libghostty-vt/src/terminal/c/snapshot.zig`
- `vendor/libghostty-vt/src/terminal/c/grid_ref_tracked.zig`
- `vendor/libghostty-vt/src/terminal/c/terminal.zig`
- `vendor/libghostty-vt/src/terminal/snapshot/budget.zig`
- `vendor/libghostty-vt/src/terminal/snapshot/main.zig`
- `vendor/libghostty-vt/src/terminal/PageList.zig`
- `vendor/libghostty-vt/src/terminal/Screen.zig`
- `vendor/libghostty-vt/src/terminal/ScreenSet.zig`
- `vendor/libghostty-vt/src/terminal/Terminal.zig`
- `vendor/libghostty-vt/src/terminal/snapshot/screen.zig`
- `vendor/libghostty-vt/src/terminal/snapshot/snapshot.zig`
- `vendor/libghostty-vt/src/terminal/snapshot/terminal.zig`

reason: Snapshot decoding needs an explicit OS-backed page allocator so a budget can cover initial pools, replacement screens, history and continuation growth without changing ordinary terminal allocations.
The policy is retained by lazy screen creation and page-list clones.
A reference-counted budget wraps heap and OS page allocators with shared live-storage accounting until FINISH.
Decoder, terminal, and detached tracked-reference lifetimes retain the adapters independently; enforcement ends after successful FINISH while accounting remains valid for later frees.
Encoded input, fixed wrappers and allocator/OS bookkeeping are outside the storage budget.

remove when: upstream exposes an equivalent aggregate snapshot storage budget covering heap, page pools, continuation and history with safe decoder/terminal ownership, and bounded restore tests pass without this patch.

verification: Snapshot-policy characterization passed in `zig build test-lib-vt -Demit-lib-vt=true -Dtest-filter='snapshot page allocator policy'`.
`just test-one binary_snapshot` and `just maintenance-test` passed.
Full `just check`, including 3,943 Rust tests, maintenance checks and Windows cross-target lint, passed.
All eleven Rust binary snapshot tests passed on native Windows, including history, concurrent independent budgets and moving a restored terminal between threads.
Budget/lifecycle characterization passed on Linux and native Windows with `-Dtest-filter='snapshot budget'` (77 tests across two artifacts).
Coverage includes partial history failure, abandoned incremental restore, both decoder/terminal destruction orders, detached tracked references, and failure injection at each underlying allocation.
This is a storage budget, not a complete hostile-input validation or runtime preservation contract.

## 0002 expose modifyOtherKeys mode through terminal data

status: active

patch: `vendor/patches/libghostty-vt/0002-expose-modify-other-keys-mode.patch`

herdr issue: none; fixes the performance regression exposed by
https://github.com/herdrdev/herdr/pull/2303

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/terminal.h`
- `vendor/libghostty-vt/src/terminal/c/terminal.zig`

reason: Herdr must know whether xterm modifyOtherKeys mode 2 is active to
request printable key releases from the outer terminal. The formatter API can
recover this fact only by formatting the active screen and scrollback. A typed
terminal-data query exposes the authoritative scalar without formatting or
allocation. The local query uses value 41; upstream now owns the previous
local value 33 for VT processing errors.

remove when: the vendored source exposes an equivalent scalar query for
modifyOtherKeys mode 2 and Herdr can use it without this patch.

verification:

```sh
just test-one modify_other_keys
just test-one host_report_all_supplies_printable_releases_for_event_type_only_panes
just maintenance-test
just ui-hot-path-architecture-test
```

The former grapheme-default patch is replaced by upstream's public
`GHOSTTY_TERMINAL_OPT_MODE_DEFAULT` API. Herdr configures mode 2027 through that
API and tests that RIS restores it after a child disables it. The Wuffs C-only
mirror fix from Ghostty PR 13789 is also included in this vendored base.

## 0004 fix hosted Wuffs builds

status: active

patch: `vendor/patches/libghostty-vt/0004-fix-hosted-wuffs-builds.patch`

herdr issue: none; preserves Windows cross-compilation and non-SIMD hosted builds

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/pkg/wuffs/build.zig`
- `vendor/libghostty-vt/pkg/wuffs/src/main.zig`

reason: Wuffs now needs MSVC libc headers when targeting Windows. Zig's
`--libc` configuration reaches C compilation, but the translate-c dependency
requires its own explicit configuration. Forward the same file so cross-builds
can use an actual Windows SDK instead of changing the target ABI or skipping
compilation. Native builds without a libc override are unchanged.

The no-libc Wuffs module also exports hidden weak calloc/free stubs. On hosted
Linux with SIMD disabled, those definitions override the Rust executable's
libc allocator, causing immediate allocation failures. Limit the stubs to
freestanding targets; hosted embedders resolve these symbols through libc.

remove when: upstream forwards the build's libc configuration to the Wuffs
translator and prevents hosted allocator interposition, and both Windows
cross-compilation and non-SIMD native tests pass without this patch.

verification:

```sh
LIBGHOSTTY_VT_WINDOWS_LIBC=/path/to/windows-libc.txt just windows-lint
LIBGHOSTTY_VT_SIMD=false just test-one ghostty
just maintenance-test
```

## 0005 bounded word selection for wrapped link activation

status: active

patch: `vendor/patches/libghostty-vt/0005-bounded-word-selection.patch`

herdr issue: https://github.com/herdrdev/herdr/issues/1282

upstream discussion: not opened

upstream pr: not opened; related merged PR https://github.com/ghostty-org/ghostty/pull/10132
implements URL selection in the application layer, not the libghostty C API.

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/selection.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/Screen.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/selection.zig`

reason: Ctrl+click must resolve a wrapped token beyond the visible viewport
without scanning an arbitrarily long logical line. The new, opt-in API shares
one cell-inspection budget across both directions and returns no selection on
exhaustion, never a truncated link. Its scan skips wide-character spacer cells.
The existing word-selection functions and option layouts remain unchanged;
only Herdr's link activation uses the new function.

remove when: upstream provides an equivalent bounded, wrap-aware selection API
that handles wide-character spacers, and Herdr passes the tests below using it
without this patch.

verification:

```sh
just test-one link_target
just test-one link_activation
just test-one ctrl_click
just check
```

## 0006 clear screen while preserving the cursor line

status: active

patch: `vendor/patches/libghostty-vt/0006-clear-screen-preserving-cursor-line.patch`

herdr issue: none; requested in https://github.com/herdrdev/herdr/discussions/545

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/terminal.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/terminal.zig`

reason: Herdr needs an explicit screen/history clear that preserves the cursor's
visible soft-wrapped line without writing to the child or interrupting a partial
VT sequence. The new C function operates directly on the screen, leaves alternate
screens untouched, clears image placements, and marks the result dirty.

remove when: the vendored C API provides an equivalent parser-independent clear
operation preserving the visible cursor line, and Herdr passes the checks below
using it without this patch.

verification:

```sh
just test-one clear_pane
just maintenance-test
just check
```

## 0007 experimental encoded PNG and immutable source retention

status: active

patch: `vendor/patches/libghostty-vt/0007-experimental-png-retention.patch`

herdr issue: none; maintainer-directed native Kitty forwarding experiment

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/terminal.h`
- `vendor/libghostty-vt/include/ghostty/vt/kitty_graphics.h`
- `vendor/libghostty-vt/src/terminal/c/terminal.zig`
- `vendor/libghostty-vt/src/terminal/c/kitty_graphics.zig`
- `vendor/libghostty-vt/src/terminal/kitty/graphics_image.zig`
- `vendor/libghostty-vt/src/terminal/kitty/graphics_exec.zig`
- `vendor/libghostty-vt/src/terminal/kitty/graphics_storage.zig`

reason: An explicitly enabled embedding mode retains structurally validated,
quiet PNG uploads as encoded bytes, avoiding pixel decoding before forwarding
through a multiplexer. The existing raw getters retain their meaning; separate
getters expose retained PNG bytes. Queries and response-bearing uploads retain
full validation, and animation operations materialize pixels transactionally.
Storage reserves both encoded bytes and expected decoded size.

This is default-off and experimental: CRC-valid corrupt compressed pixels may
be rejected later than in normal mode, including after placement. Quiet mode
suppresses replies, not validation semantics; this patch is not a claim of full
protocol-equivalent transparent forwarding. Herdr exercises this mode only in
tests; production PNG uploads retain full decoding and validation.

A separate default-off snapshot callback retains host-owned immutable raw RGBA
file backing before reading pixels. Herdr installs this callback automatically
on Linux, using same-filesystem CoW snapshots. It never retains a mutable producer pathname. Unsupported snapshots
use the original loader; animation materializes pixels transactionally. Backing
ownership and bounded reads are explicit in the embedding ABI.

remove when: upstream provides an equivalent opt-in owned encoded-image
representation and immutable host-backed raw sources with bounded storage,
strict query handling and lazy pixel materialization, or this experiment is retired.

verification:

```sh
just test-one native_source
just test-one png_forward_tests
just test-one kitty_png_replacement
just test-one kitty_file_image_survives
(cd vendor/libghostty-vt && zig build test-lib-vt -Dtest-filter='experimental PNG')
just check
```

## 0003 export explicit screens without switching terminal state

status: active

patch: `vendor/patches/libghostty-vt/0003-export-explicit-screen-vt.patch`

herdr issue: none; browser desktop-parity runtime handoff work in the werdr fork

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

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
just libghostty-bindings
```

## 0008 preserve pending single character shifts in VT exports

status: active

patch: `vendor/patches/libghostty-vt/0008-preserve-pending-charset-shift.patch`

herdr issue: none; browser desktop-parity terminal restoration work in the werdr fork

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

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
