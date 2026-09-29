# libghostty-vt local patches

This file tracks intentional local changes applied on top of the vendored `libghostty-vt` source.
Remove a patch only when the vendored source commit contains the upstream behavior and the listed verification still passes.

## 0028 fixed-origin resize

status: active, Windows resize correction pending live candidate validation

patch: `vendor/patches/libghostty-vt/0028-fixed-origin-resize.patch`

herdr issue: none; fork Windows terminal acceptance regression

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/terminal.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/PageList.zig`
- `vendor/libghostty-vt/src/terminal/Screen.zig`
- `vendor/libghostty-vt/src/terminal/Terminal.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/terminal.zig`

reason: ConPTY retains the old active origin on row enlargement and subsequent PowerShell redraws address that old row.
Pulling retained history into the active screen moves the prompt away from those absolute coordinates and overwrites earlier output.
An opt-in per-resize policy appends blank rows instead, retaining history and tracked cursor positions without changing the original resize API or default policy.
The additive C entry point still uses the stream resize handler, preserving in-band size replies.
Both screens receive the policy, including the hidden primary screen.
Column reflow tracks the old active top, treats history and active content as separate reflow domains, and fills newly vacant active rows with blanks rather than history.
Splitting a soft wrap at that boundary retains historical cell content but intentionally removes its logical-line connection to active content.
Cursor preservation counts wrapping only within the tracked active domain.
The fixed-origin C entry point also opts into ConPTY trailing-padding measurement for nonwrapped active rows.
Literal trailing spaces do not create additional rows, while padding styles remain painted within the actual final destination row.
The padding boundary is computed after text reflow so wide-character margin spacers cannot add a spurious row.
Interior spaces, wrapped rows, retained history, cursor positions and managed or semantic content retain their existing handling.

verification: The bottom-cursor regression failed before implementation with expected row 2, actual row 4.
The native `zig build test-lib-vt -Demit-lib-vt=true -Dtest-filter=resize` suite passed after implementation.
The Rust wrapper regression verifies absolute cursor writes, retained history and size-report/DSR replies.
Full `just check` passed, including Windows cross-target lint and vendor reverse-apply validation.
Additional native tests passed for saved-cursor retention across page growth under a history-line limit and combined wrapped Unicode width/height growth.
The row-growth revision passed native Windows checks, but live validation exposed a remaining one-row width-reflow mismatch.
The column-policy regression failed before implementation with expected cursor row 2, actual row 3.
The expanded column tests pass for history-free reference equivalence, wrapped boundary content and flags, repeated width cycles, wide characters, blank rows, narrowing, combined geometry changes, hidden primary screens, and saved cursors.
Full `just check` passed for the expanded policy, including 4,049 Rust tests and Windows cross-target lint.
Native Windows and live validation of the expanded policy remain pending.
Controlled traces with the packaged ConPTY 1.24.260710001 reproduce a trailing-space mismatch independently of PowerShell: a native prompt at row 3 becomes Ghostty row 4.
The wrapper regression failed before the padding correction and passes afterward for default and background-styled padding, including subsequent absolute cursor writes.
Additional tests cover cursor-in-padding, interior spaces, wrapped spaces, wide text, odd-width wide-character boundaries and unchanged ordinary resize behavior.
The complete captured PowerShell trace now replays through resize and subsequent input without overwriting the preceding output marker.
The native resize suite and full `just check` pass, including 4,147 Rust tests and vendor reverse-apply validation.
All seven render-scale scenarios pass; combined active-pane medians are 553 microseconds for one pane and 608 for fifteen, with background-workspace medians 560 and 568.
The revised padding policy still requires full native Windows and live deployment validation.

remove when: upstream supplies an equivalent fixed-origin growth policy through its C API, and retained-history, cursor-write, hidden-primary, size-report and live ConPTY resize regressions pass without this patch.

## 0027 retained graphics C snapshot boundary

status: active, host coordinator prerequisite; production handoff gate remains closed

patch: `vendor/patches/libghostty-vt/0027-graphics-snapshot-c-boundary.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt.h`
- `vendor/libghostty-vt/include/ghostty/vt/graphics_snapshot.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/graphics_snapshot.zig`

reason: The C embedding boundary needs coordinated capture, attachment retention, generation rebinding and policy ownership for both screens.
Capture visits native-file backing without reading pixels or switching screens; the host owns callback-retained references and must release them if capture aborts.
Restore resolves destination-host references, remaps both stores and saved frame generations, installs transactionally and adopts directory backing under the existing wrapper owner.
The API requires exclusive capture and an unpublished reconstructed destination with prior global graphics policy and destination callbacks.
C terminals have no animation ticker; capture has absent clock authority and preserves nullable timestamps verbatim.
Clock-bearing records and pending producer-backed images reject because this boundary cannot adopt those authorities.
Partial protocol uploads remain supported, including future completion after source destruction.
Tests cover both screens, inactive files, partial retain failure, resolution rollback, allocator failures, shape mismatch, missing hooks, policy replacement, lazy alternate inheritance and opaque timestamps.
Graphics-disabled builds retain rejecting API stubs.
Only opt-in snapshot work is added; no render, parser or mutation fast path changes.
Rust attachment ownership, process transport, effect fencing and production handoff remain separate work.

remove when: upstream provides equivalent C graphics capture/restoration with attachment and policy ownership and all boundary tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=graphics snapshot C' --summary all
zig build test-lib-vt -Demit-lib-vt=true -Dtarget=x86-linux-musl '-Dtest-filter=graphics snapshot C' --summary all
zig build test-lib-vt -Demit-lib-vt=true -Dvt-features=-kitty_graphics '-Dtest-filter=graphics snapshot C' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just libghostty-bindings
just check
```

Run Zig commands inside `vendor/libghostty-vt`.
Binding generation may require the host compiler's include directory through the recipe's Clang arguments.

## 0026 transactional graphics installation into unpublished terminals

status: active, coordinator prerequisite; retained graphics gate remains closed

patch: `vendor/patches/libghostty-vt/0026-storage-unpublished-installation.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/kitty/graphics.zig`
- `vendor/libghostty-vt/src/terminal/kitty/storage_restore.zig`

reason: Decoded graphics records need owned native maps, loading objects and policy backing before installation.
Preparation uses the destination allocator and transfers decoded ownership without retaining any destination screen or binding pins.
Installation requires exclusive access to an unpublished reconstructed terminal, exact screen presence and matching allocators.
It rejects shallow storage aliases, wrong-screen records, missing image references and duplicate placement keys.
Pin binding and rollback remain within one uninterrupted screen-lifetime scope; failure leaves existing stores and policy unchanged and preparation retryable.
Both stores are swapped before old stores release their backing, and no creation API reassigns IDs, generations, counts or parent references.
The returned directory allocation must be adopted by the host policy owner before publication and outlive the installed policy slices.
Tests cover source and preparation destruction, continuation, combined generation/token remapping, final-pin failure, retry, allocation failures and host file-reference cleanup without reads.
Only opt-in restoration work is added; render, parser and mutation fast paths are unchanged.
This is not a production handoff API: clock rebasing, external producer coordination and C/Rust policy adoption remain separate requirements.

remove when: upstream provides equivalent transactional installation and ownership, rollback, continuation, token and attachment tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=storage restore' --summary all
zig build test-lib-vt -Demit-lib-vt=true -Dtarget=x86-linux-musl '-Dtest-filter=storage restore' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig commands inside `vendor/libghostty-vt`.

## 0024 both-screen graphics storage snapshots

status: active, domain prerequisite; retained graphics gate remains closed

patch: `vendor/patches/libghostty-vt/0024-storage-domain-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/kitty/graphics.zig`
- `vendor/libghostty-vt/src/terminal/kitty/storage_snapshot.zig`

reason: GSTOR1 owns both screens' graphics metadata, policy values, images, placements and loading continuations under aggregate limits.
Nonallocating structural preflight validates both screens and reserves all structural metadata before payload allocation or host attachment resolution.
Semantic validation checks image and placement identities, references, counts and exact native byte accounting while preserving reachable over-limit stores and unresolved placement cycles.
Failure releases all owned arrays, directories, loading data and resolved file references.
Budgets cover encoded bytes, logical backing and pending reservations, object counts and policy bytes, not allocator capacity, scratch maps, transient copies or total process memory.
Capture requires exclusive terminal access; file attachments and pending producers require separate fenced host coordination.
Generations and animation timestamps remain in the source domain.
This adds no runtime installation, C/Rust handoff API, render-path work or relaxation of the retained graphics gate.

remove when: upstream provides equivalent owned aggregate storage snapshots and both-screen budget, malformed-input, allocation-failure, attachment rollback and source-destruction tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=storage snapshot' --summary all
zig build test-lib-vt -Demit-lib-vt=true -Dtarget=x86-linux-musl '-Dtest-filter=storage snapshot' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig commands inside `vendor/libghostty-vt`.

## 0025 page alignment assertion width

status: active

patch: `vendor/patches/libghostty-vt/0025-page-alignment-width.patch`

herdr issue: none; fork 32-bit snapshot verification

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/page.zig`

reason: The page layout assertion coerces Cell's eight-byte size to the alignment value's narrow integer type, which is u3 on x86.
Performing the size arithmetic as usize preserves the assertion and permits real 32-bit snapshot verification.
This changes no runtime behavior.

remove when: upstream performs this assertion in a type that represents Cell's size and the x86-linux-musl tests compile and pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true -Dtarget=x86-linux-musl '-Dtest-filter=storage snapshot' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.

## 0023 coordinated graphics generation rebinding

status: active, storage prerequisite; retained graphics gate remains closed

patch: `vendor/patches/libghostty-vt/0023-generation-domain-rebinding.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/kitty/graphics.zig`
- `vendor/libghostty-vt/src/terminal/kitty/graphics_storage.zig`
- `vendor/libghostty-vt/src/terminal/kitty/generation_snapshot.zig`

reason: Restoration must preserve source generation ordering and equivalence classes while assigning globally fresh destination stamps.
The mapping registers both stores, image generations, live or stale frame-target generations and separately supplied external pending-token generations.
It preserves zero, sorts and deduplicates bounded source references, then atomically reserves an ordered contiguous range with checked exhaustion.
Preparation completes allocations before reserving stamps; aborted restores may leave unused stamps, which are never recycled.
Application validates every source reference and rejects repeated store, loading and shallow image-map ownership before any write.
It changes only generations, preserving dirty flags, image data, ages, stale-reference distinctions and caller-owned clocks.
The atomic and mutex implementations share the same existing counter with ordinary mutations, whose single-stamp fast path is unchanged.
Tests cover both implementations, concurrent reservation/native-mutation interleaving, exhaustion, allocation cleanup, all-store preflight, pending completion, frame continuation, number lookup and eviction order.
Only opt-in restore work is added; no render or mutation fast path receives extra work.
Aggregate storage installation, animation clock rebasing, host attachments and external producer ownership remain separate coordinator responsibilities.

remove when: upstream provides equivalent coordinated generation rebinding and ordering, authority, concurrency, exhaustion and rollback tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=generation snapshot' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.

## 0022 screen-qualified graphics placement snapshots

status: active, domain prerequisite; retained graphics gate remains closed

patch: `vendor/patches/libghostty-vt/0022-placement-domain-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/kitty/graphics.zig`
- `vendor/libghostty-vt/src/terminal/kitty/placement_snapshot.zig`

reason: Graphics placements own screen-specific tracked pins or resolved relative-parent references that cannot be restored by replaying creation commands.
PLCST1 preserves screen identity, internal/external key namespaces, all placement geometry and virtual, relative or pin location in a fixed 96-byte record.
Live and garbage pins retain global physical rows and columns because even garbage coordinates participate in later reflow.
Capture checks tracked-pointer membership before dereferencing it, then validates live-page membership and row/column bounds without slow-runtime-safety-only helpers.
Binding requires an already reconstructed screen and checks the addressed page width rather than desired terminal width, preserving mixed-width history.
Each bound pin has explicit destination-screen ownership and rollback cleanup; capture and decoding allocate nothing.
Neither capture nor binding creates screens, changes image counts, reaps garbage, assigns IDs/generations or re-resolves parent preference.
Native ancestor replacement can create over-depth chains, and anonymous internal-ID wrap can create cycles; records preserve their bounded unresolved behavior rather than rejecting these reachable states.
The coordinator still owns aggregate limits, duplicate-key/reference/count validation, atomic map installation and generation/clock mapping.
Only opt-in snapshot work is added, not render, input or fanout work; no C/Rust handoff API or graphics exclusion gate changes.

remove when: upstream provides equivalent placement preservation and ownership, mixed-width, reflow, graph and lazy-reaping tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=placement snapshot' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.
Native tests bind individual records or replace placement values in existing storage; this is not evidence of complete cross-process storage installation.

## 0021 retained graphics loading snapshots

status: active, domain prerequisite; retained graphics gate remains closed

patch: `vendor/patches/libghostty-vt/0021-loading-domain-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/kitty/graphics.zig`
- `vendor/libghostty-vt/src/terminal/kitty/loading_snapshot.zig`

reason: A chunked graphics upload retains its initial command and raw payload independently of stored images and later continuation commands.
LDGST1 preserves unresolved image metadata, accumulated bytes, quiet mode, response identifiers, deferred display and complete animation-frame command plus source target generation.
Explicit field and enum schemas avoid native layout dependence and force review when upstream adds command fields.
Validation checks tags, booleans, reserved bytes, exact size and encoded/payload budgets before allocating one owned payload.
The record is restricted to quiescent storage.loading values, whose image has empty complete backing and no animation, generation or placements.
It deliberately does not validate incomplete PNG, compression or dimensions because completion and its errors are future behavior.
Initialization-only temporary-directory slices can already dangle after wrapper policy replacement; capture never dereferences them and decode canonicalizes both directory and file hook to null.
Neither capture nor decode invokes file operations, callbacks, decompression or command execution.
Generation remapping, aggregate storage budgets, placement references and atomic installation remain coordinator work; no C/Rust restore API or graphics exclusion gate changes.
Only opt-in snapshot paths are added, with no render, input or fanout work.

remove when: upstream provides equivalent owned quiescent loading preservation and the field, ownership, failure and command-continuation tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=loading snapshot' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.
Native executor tests replace only loading state in an existing terminal and do not prove whole-storage or cross-process restoration.

## 0020 owned image-domain snapshots

status: active, domain prerequisite; retained graphics gate remains closed

patch: `vendor/patches/libghostty-vt/0020-image-domain-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/kitty/graphics.zig`
- `vendor/libghostty-vt/src/terminal/kitty/image_snapshot.zig`
- `vendor/libghostty-vt/src/terminal/kitty/graphics_storage.zig`

reason: Complete graphics restoration needs an owned image representation before storage references and placement pins can be installed.
IMGST1 preserves image identifiers, dimensions, format, metadata, source generation, complete/pending/encoded-PNG/native-file variants and full animation state and frames.
Explicit format tags include native grayscale and grayscale-alpha images, characterized through direct command loading and storage without relying on the byte parser's narrower format set.
Capture never decodes PNGs, reads files, invokes protocol commands or changes source ownership.
Native-file records retain only identity and expected length; separately retained/exported host attachments and a destination-provenance resolver are mandatory to restore them.
The resolver transfers one valid destination reference, runs after local allocations, and is never called for malformed or over-budget input.
Pending bytes are a logical reservation, not a payload or a transferred producer.
Preflight bounds encoded bytes and logical backing, including decoded PNG reservation, pending/file reservation, animation objects, frame entries and pixels, before allocation.
Allocator overhead, retained capacities and host attachment implementation overhead are not total-RSS bounded by these logical budgets.
Generations and nullable animation timestamps remain source-domain values; coordinated storage restoration must remap generations, dependent references and clocks before installation.
This codec handles stored image values, not partially initialized loading images, placement graphs or ownership of external completion jobs.
The codec adds only opt-in snapshot work and no render, input or fanout work.
Review exposed an infinite-playback loop counter overflow; the native ticker now saturates that counter once per wrapping animation frame, preserving monotonic finite-budget behavior.
Herdr does not currently call the native animation ticker, so this repair adds no work to its pane-scaled render paths.
No C/Rust handoff API or graphics exclusion gate is changed by this patch.

remove when: upstream provides equivalent owned image preservation and non-overflowing animation loop accounting, and ownership, bounds, deferred-backing, failure and animation-continuation tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=image snapshot' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.
Same-clock tick tests characterize image state only; they do not prove cross-process clock rebasing or placement restoration.

## 0019 authoritative APC handler snapshots

status: active, private pane draft integration; retained graphics remain unsupported

patch: `vendor/patches/libghostty-vt/0019-apc-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/snapshot.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/apc.zig`
- `vendor/libghostty-vt/src/terminal/apc_snapshot.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/apc_snapshot.zig`

reason: Continuation replay can resurrect discarded APC commands or lose unknown-command truncation and recognition/limit policy.
APCST1 preserves inactive, ignore, initialized identification, unknown capture, Kitty parsing and glyph parsing, plus independent future recognition and optional limits.
Kitty records contain only present key values and initialized temporary/payload bytes, with stable explicit state tags and a-z/A-Z key order.
Unknown capture retains sticky truncation even below its captured limit and can resume after an allocation failure.
Unsupported-build protocols reject before allocation; replacement stages destination-owned data and requires exact agreement with outer APC activity before releasing old state.
No completion, command execution or callback occurs during capture/replacement.
Encoded limits do not include allocator overhead or retained capacities.
These operations are opt-in snapshot work, not additional per-byte, render or pane-fanout work.
Patch 0012 is amended to allow policy application during APC parsing without changing the active parser; the private pane draft then applies APCST1 authoritatively.
The draft still rejects retained images, placements, loading, counters, byte accounting, glossary entries and unknown exclusion flags.
Payloads contain private terminal data and must not be logged.
This is not complete terminal preservation or external effect/runtime ownership transfer.

remove when: upstream preserves equivalent authoritative APC state and every-cut, failure, aliasing, reduced-feature, policy and coordinated pane tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=apc snapshot' --summary all
zig build test-lib-vt -Demit-lib-vt=true '-Dvt-features=-kitty_graphics,-glyph_protocol' '-Dtest-filter=apc snapshot' --summary all
just test-one apc_snapshot
just test-one pane_state_draft
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig commands inside `vendor/libghostty-vt`.
Rust bindings are generated with `just libghostty-bindings`.

## 0018 authoritative OSC capture snapshots

status: active, private pane draft integration; not complete runtime preservation

patch: `vendor/patches/libghostty-vt/0018-osc-capture-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/snapshot.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/osc_snapshot.zig`
- `vendor/libghostty-vt/src/terminal/osc.zig`
- `vendor/libghostty-vt/src/terminal/osc_snapshot.zig`

reason: Successful continuation replay can resurrect OSC commands discarded after allocation failure or change fixed-buffer fallback behavior.
OSCPS1 preserves quiescent parser state, allocator intent, initialized capture bytes, backing kind and independent configured/effective limits.
Restoration validates and stages aliased inputs before resetting with the old allocator, then binds writer pointers in final destination storage without emitting callbacks.
Inactive records canonicalize cleanup-only capture state; active records must agree with outer OSC parsing and reject reentrant command dispatch.
Encoded-byte limits do not bound retained capacity, allocator overhead or total RSS.
The patch also stages allocating capture construction before publishing its optional value, fixing a partial-initialization assertion on allocation failure before fixed fallback.
That repair adds no per-byte or render work and no additional allocation.
The C API has owning Rust wrappers and a separately bounded private pane draft payload.
Payloads may contain sensitive command data and must not be logged.
This does not establish complete terminal restoration or external runtime/effect ownership.

remove when: upstream provides equivalent authoritative OSC preservation and allocation-safe fixed fallback, and continuation, failure, aliasing, atomicity and private pane draft tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=osc snapshot' --summary all
just test-one osc_capture
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.
Rust bindings are generated with `just libghostty-bindings`.

## 0017 coordinated stream handler snapshots

status: active, private pane draft integration; unfinished OSC capture remains separate

patch: `vendor/patches/libghostty-vt/0017-handler-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/snapshot.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/handler_snapshot.zig`

reason: Core continuation replay omits handler policy and can resurrect a DCS query discarded after allocation failure.
HNDLR1 preserves the exact semantic-failure latch, title-report policy, nullable raw terminfo name, future clipboard-write limit, ordered password grants and nested DCSST1 state.
Replacement validates and stages all allocations before freeing replay-created DCS state or old grants, then rebinds terminfo bytes into destination-owned backing without callbacks.
A non-inactive DCS handler requires outer DCS passthrough, but passthrough may legitimately have an inactive handler after parameter overflow.
Limits bound encoded bytes and grant entry/password backing plus nested DCS bytes, not allocator overhead or total RSS.
Grant flags, raw passwords and ordering are preserved directly, retaining one-time wrong-direction consumption, swap removal and oldest-entry eviction.
Snapshot payloads contain permission-grant secrets and must not be logged.
This does not preserve unfinished OSC allocation-failure state or establish external effect ownership.

remove when: upstream preserves equivalent handler state and atomicity, and allocation-failure, continuation, policy, grant ordering and private pane draft tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=handler snapshot' --summary all
just test-one handler
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.
Rust bindings are generated with `just libghostty-bindings`.

## 0016 authoritative DCS domain snapshots

status: active, domain codec; coordinated handler restoration tracked by patch 0017

patch: `vendor/patches/libghostty-vt/0016-dcs-domain-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/dcs.zig`
- `vendor/libghostty-vt/src/terminal/dcs_snapshot.zig`

reason: Successful parser continuation replay can recreate a DCS query that the source discarded after an allocation failure.
The DCSST1 domain codec preserves inactive, ignore, XTGETTCAP and initialized DECRQSS state plus the exact byte limit.
Tmux-enabled builds additionally preserve parser state, retained idle bytes, independent buffer limit and in-progress payloads without reading already-freed broken-state buffers.
Unsupported builds reject tmux records instead of changing their meaning.
Malformed and over-budget records reject before allocation, and decoding constructs destination-owned writers without emitting commands.
This codec must be applied authoritatively after outer parser reconstruction; it does not itself integrate handler state into pane restoration.
Encoded size bounds variable payload, not allocator overhead, retained capacities or total RSS.

remove when: upstream provides equivalent authoritative DCS preservation and allocation-failure, every-cut, initialized-buffer and tmux continuation tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=dcs snapshot' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.
The standard library build disables tmux, so its tmux continuation test is skipped and unsupported-state rejection is exercised.
Also qualify the same filtered library suite with Oniguruma enabled and linked in the isolated test configuration; production build settings remain unchanged.
The full Ghostty application test target is unavailable in this trimmed vendor tree because its GLAD source is not vendored.

## 0015 transactional DND snapshot C boundary

status: active, private pane draft integration; not complete runtime preservation

patch: `vendor/patches/libghostty-vt/0015-dnd-snapshot-boundary.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/snapshot.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/dnd_snapshot.zig`

reason: Expose the native DND domain codec through snapshot-gated capture and atomic replacement so the private Rust pane draft can preserve its omitted state.
Empty bytes represent absent state and explicitly clear a destination registration.
Replacement decodes all owned data before releasing the original state, including held drop data and MIME arrays.
Restoration never emits historical replies, callbacks or native drag events, and does not transfer external drag ownership.
Limits bound encoded bytes and logical variable backing independently, not allocator overhead or total RSS.
Payloads may contain private dropped data and must not be logged.

remove when: upstream exposes equivalent transactional DND capture and restoration and C allocation-failure, Rust every-cut and coordinated pane draft tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=dnd snapshot' --summary all
just test-one dnd
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.
Rust bindings are generated with `just libghostty-bindings`.

## 0014 native DND domain snapshots

status: active, native domain codec; boundary and private pane draft integration tracked by patch 0015

patch: `vendor/patches/libghostty-vt/0014-dnd-domain-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/src/terminal/kitty/dnd.zig`
- `vendor/libghostty-vt/src/terminal/kitty/dnd_snapshot.zig`

reason: Core terminal snapshots omit DND registration, chunk metadata, acceptance buffers, offered MIME types and held drop data.
The DNDST1 codec preserves these as owned native data without emitting events or assuming ownership of an external drag session.
It retains binary buffers, absent versus present-empty arrays, inactive chunk metadata and reachable partial states after allocation or writer failure.
Offered lists are not restricted by the separate sixteen-item native drop cap.
Preflight bounds encoded bytes and logical variable backing storage before allocation, including slice-array amplification.
Fixed state, allocator bookkeeping and simultaneous input/output allocations are separate from this limit.
Snapshot payloads can contain private dropped data and must not be logged.
This domain codec alone does not preserve DND through pane snapshots or establish safe runtime migration.

remove when: upstream provides equivalent owned DND snapshots and every-cut, future-response, allocation-failure, reset and budget tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=dnd snapshot' --summary all
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.

## 0013 in-flight clipboard write snapshots

status: active, private pane draft integration; not complete runtime preservation

patch: `vendor/patches/libghostty-vt/0013-clipboard-write-snapshots.patch`

herdr issue: none; fork lossless runtime restoration prerequisite

upstream discussion: not opened

upstream pr: not opened

vendored base: `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`

local files:

- `vendor/libghostty-vt/include/ghostty/vt/snapshot.h`
- `vendor/libghostty-vt/src/lib_vt.zig`
- `vendor/libghostty-vt/src/terminal/c/main.zig`
- `vendor/libghostty-vt/src/terminal/c/clipboard_snapshot.zig`
- `vendor/libghostty-vt/src/terminal/kitty/clipboard.zig`
- `vendor/libghostty-vt/src/terminal/kitty/clipboard_snapshot.zig`

reason: A completed OSC 5522 packet can leave a clipboard transaction alive at parser ground, so core terminal snapshots and continuation alone lose pending clipboard contents.
The CLIPW1 codec preserves metadata, complete spool including overwritten MIME data, ordered mappings and aliases, captured size limit, current entry and initialized base64 carry.
Encoding uses one bounded exact allocation; decoding validates bounded borrowed views before constructing a new owned transaction.
C replacement commits only after all allocations succeed and never emits historical callbacks or responses.
IDs must obey the parser's sanitized alphabet because future replies interpolate them verbatim.
Payloads include sensitive clipboard contents and passwords and must not be logged.
Encoded-byte limits bound variable payload, not arena slack, allocator bookkeeping or total process memory.
Clipboard grants, DND state and future-write handler policy remain separate preservation obligations.

remove when: upstream provides equivalent exact in-flight write preservation and transactional restoration, and every-cut, budget, failure-cleanup and future-commit tests pass without this patch.

verification:

```sh
zig build test-lib-vt -Demit-lib-vt=true '-Dtest-filter=clipboard snapshot' --summary all
just test-one clipboard
python3 -m unittest scripts.test_vendor_libghostty_vt
just check
```

Run the Zig command inside `vendor/libghostty-vt`.
Rust bindings are generated with `just libghostty-bindings`.

## 0012 exact empty-storage graphics policy restoration

status: active, private restore prerequisite; retained graphics remain excluded

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
Expose a frozen sized V1 policy record with borrowed reads and transactional application to a matching graphics-empty terminal.
Policy application leaves an active APC parser untouched; patch 0019 preserves that parser authoritatively after outer continuation replay.
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
The draft now exempts only the APC bit when carrying the authoritative APCST1 payload from patch 0019; the query itself remains conservative.
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
