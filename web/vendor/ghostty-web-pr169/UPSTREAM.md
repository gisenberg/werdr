# ghostty-web PR 169

`ghostty-web-0.4.1-pr169-faf6fbd-wmux4.tgz` is a temporary, locally built npm package of [coder/ghostty-web pull request 169](https://github.com/coder/ghostty-web/pull/169).
It is not an official Coder release.

- Source repository: <https://github.com/diegosouzapw/ghostty-web>
- Source commit: `faf6fbd055f5768923b3df659f3968c2abbab4a1`
- Ghostty submodule: `6590196661f769dd8f2b3e85d6c98262c4ec5b3b`
- Base artifact: `ghostty-web-0.4.1-pr169-faf6fbd.tgz`
- Base artifact SHA-256: `8a926a5996d8db6c7438841a01878e0a4a44937873295641c6a1869da32ed8d4`
- Package version: `0.4.1-pr169.faf6fbd.wmux4`
- Artifact SHA-256: `2cdad41e69dcf767c84a06c7df5257fdd677091fee59805f1a273c659155c80a`
- License: MIT; the upstream license is included in the package archive.

wmux applies `wmux-single-viewport-render.patch`, `wmux-cell-paint-efficiency.patch`, `wmux-device-pixel-ratio.patch`, and `wmux-block-elements.patch` in that order on top of the source commit.
The patches let the canvas renderer extract the active viewport once per render pass instead of calling the full-viewport `getLine()` compatibility path for every dirty row, cache parsed font strings, skip glyph draws for undecorated spaces, refresh measured metrics and canvas backing stores after browser scale changes, and render the complete Unicode Block Elements range with exact cell geometry.

The base artifact was built with Bun 1.3.14 and Zig 0.15.2.
Its Zig archive matched the published SHA-256 checksum `02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239`.
The wmux4 artifact preserves that base artifact's `ghostty-vt.wasm` byte-for-byte (SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`).
Its patched library bundles were built locally with Node 22.23.1, TypeScript 5.9.3, and Vite 4.5.14.
The retained declaration rollup was amended with the optional bulk-viewport and device-scale interfaces.
npm 10.9.8 produced the package archive.

For a clean source rebuild, recursively clone the source at the commit above and apply the four patches in the order above.
Place the reviewed base artifact's `ghostty-vt.wasm` at the source root before running `npm install` and `npm run build:lib` so Vite embeds the same WASM bytes.
Copy that WASM file into `dist/ghostty-vt.wasm`, then run `npm pack`.
Do not create a Git tag.
The checked-in hashes above identify the exact reviewed artifacts even when archive metadata differs between build hosts.

This pin can be removed once the changes are merged upstream and available as a published package.
At the time of pinning, the pull request has merge conflicts, its 612 KiB WASM artifact exceeds the pull request's stated 512 KiB CI budget, and its Bun test invocation also discovers Playwright specifications.
wmux's own unit, type, build, and browser tests pass against this artifact.

## Werdr keyboard encoder extension

Werdr uses `ghostty-web-0.4.1-pr169.faf6fbd.werdr1.tgz` with package version `0.4.1-pr169.faf6fbd.werdr1`.
Its SHA-256 is `b88dcacd14ea22391e6abff1751e7b408d26a1bb0a51f1b4379da5a2904431d8`.
Apply `werdr-key-encoder-fields.patch` after the four wmux patches listed above.
The wrapper now forwards consumed modifiers, composition state, and the unshifted codepoint from its existing `KeyEvent` interface to WASM.
Without the unshifted codepoint, Kitty encoding falls back to plain text for printable keys even when the application requests event reporting.
The WASM binary remains byte-identical to the wmux4 artifact.
Build the library with `npm run build:lib`, retain the root and dist WASM copies, set the package version above, include `LICENSE` in the package files, and run `npm pack`.
Werdr verifies printable Kitty press, repeat, release, and reset behavior through its browser and pinned native-runtime fixture.

## Werdr selection viewport correction

Werdr now uses `ghostty-web-0.4.1-pr169.faf6fbd.werdr2.tgz`, version `0.4.1-pr169.faf6fbd.werdr2`.
Its SHA-256 is `a4777a97f711dae465c91c565d94453c549e26b27478460db3d1c9050023208e`.
Apply `werdr-selection-viewport.patch` after the five patches above.
Programmatic `select()` and `selectAll()` now translate visible rows through the same scrollback coordinates as mouse selection and `selectLines()`.
They previously selected old history rows after the buffer accumulated scrollback, which could leave the visible selection without a highlight.
Replacing a programmatic selection also marks its previous rows for repaint, and invalid or oversized selection lengths are bounded without an unbounded loop.
The patch includes selection-manager regressions for visible and scrolled viewports, replacement repainting, and length bounds.
Build and package as above with the new version; do not rebuild WASM or edit generated bundles manually.
Both packaged WASM copies retain SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`.
Remove this patch when an adopted upstream package includes these fixes and the native-selection browser checks still pass.

## Werdr idle theme repaint

Werdr now uses `ghostty-web-0.4.1-pr169.faf6fbd.werdr3.tgz`, version `0.4.1-pr169.faf6fbd.werdr3`.
Its SHA-256 is `8b6096ab0404c7abf32bf41f282f3c0e4a0d24f409ce1883a50eb68c4921b859`.
Apply `werdr-idle-theme-repaint.patch` after the six patches above.
Theme changes previously updated renderer and terminal color configuration without scheduling a repaint, leaving idle canvases in the old palette until unrelated output arrived.
The patch schedules a full repaint through the normal render loop, retaining synchronized-output deferral and preserving explicit application colors, terminal contents and identity.
The browser regression in `web/test/terminal-theme.spec.ts` checks actual canvas pixels with cursor blinking disabled, light/dark transitions, explicit RGB cells, stable dimensions and synchronized-output behavior.
Build and package from source as above with the new version and include `LICENSE`; do not edit generated bundles or rebuild WASM.
Both WASM copies retain SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`.
Remove this patch when the adopted upstream package reliably repaints idle theme changes and the painted-color regression passes.

## Werdr glyph bounds

Werdr now uses `ghostty-web-0.4.1-pr169.faf6fbd.werdr4.tgz`, version `0.4.1-pr169.faf6fbd.werdr4`.
Its SHA-256 is `41fcedaa10d5de264367cee473ee1b77ee3ac294442f8cea1e5afe54e53cdb0c`.
Apply `werdr-glyph-metrics.patch` after the seven patches above.
Browser font bounding boxes can under-report actual glyph ink, causing underscores to paint below their allocated row and disappear when the following row is cleared.
Font measurement now includes printable ASCII ink bounds in regular, bold, italic and bold-italic styles.
The row height also includes independently rounded baseline and descent space at fractional device-pixel ratios.
The additional measurement happens only when font metrics change, not while painting cells.
The browser regression in `web/test/terminal-glyphs.spec.ts` compares painted underscore pixels with an independent canvas reference across all four configured font families, six font sizes, four styles and four device scales.
It fails against werdr3 and passes against werdr4.
The werdr4 library was built with Node 22.22.2, TypeScript 5.9.3 and Vite 4.5.14, then packed with npm 11.18.0.
Build and package from source as above with the new version and include `LICENSE`; do not edit generated bundles or rebuild WASM.
Both WASM copies retain SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`.
Remove this patch when the adopted upstream package preserves glyph ink within its cell metrics and the painted-glyph regression passes.

## Werdr cursor appearance invalidation

Werdr now uses `ghostty-web-0.4.1-pr169.faf6fbd.werdr5.tgz`, version `0.4.1-pr169.faf6fbd.werdr5`.
Its SHA-256 is `fa0e2249535abd09368b081899188f188200f22f461f5ebbc3df33386efec58e`.
Apply `werdr-cursor-invalidation.patch` after the eight patches above.
Cursor-only visibility and shape changes previously left the old cursor pixels painted when no terminal cells or cursor coordinates changed.
The renderer now tracks the previous cursor appearance and repaints its row on those transitions, without painting active-buffer rows over a scrolled-back viewport.
The browser regression in `web/test/terminal-cursor.spec.ts` checks actual pixels for show, hide, shape changes, and synchronized-output deferral with cursor blinking disabled.
The hide regression fails against werdr4 and passes against werdr5.
This is a scalar comparison per render, with row repainting only when cursor appearance changes; it does not add work to per-cell loops.
Build and package from source as above with Node 22.22.2, TypeScript 5.9.3, Vite 4.5.14 and npm 11.18.0; do not edit generated bundles or rebuild WASM.
Both WASM copies retain SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`.
Remove this patch when the adopted upstream package correctly erases cursor-only appearance changes and the painted-cursor regression passes.

## Inverse video with default colors

Werdr now uses `ghostty-web-0.4.1-pr169.faf6fbd.werdr6.tgz`, version `0.4.1-pr169.faf6fbd.werdr6`.
Its SHA-256 is `fe5568edbdaf2a3ff232c6a7e6cea07c65d83ffe97e9136de73a9cb653c7c9f2`.
Apply `wmux-inverse-default-colors.patch` after the nine patches above.
The renderer previously skipped the inverse background whenever the swapped color was the theme default, and drew the text in the theme foreground.
Inverse cells with default colors, in terminal panes and in the retro boot scenes alike, therefore painted as normal text.
The patch paints the theme foreground behind such cells and draws their text in the theme background, leaving explicit RGB and palette colors unchanged.
The browser regression in `web/test/terminal-inverse.spec.ts` samples painted pixels for plain, default inverse and explicit-color inverse cells.
It fails against werdr5 and passes against werdr6.
Rebuilding the werdr5 patch stack reproduced its library bundles byte-for-byte before this patch was applied.
The patch only changes the color chosen for each painted inverse cell and adds no per-cell work for other cells.
Build and package from source as above with Node 22.22.2, TypeScript 5.9.3, Vite 4.5.14 and npm 11.18.0; do not edit generated bundles or rebuild WASM.
Both WASM copies retain SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`.
Remove this patch when the adopted upstream package paints inverse default colors and the painted-pixel regression passes.

## Upstream fixes

Werdr now uses `ghostty-web-0.4.1-pr169.faf6fbd.werdr7.tgz`, version `0.4.1-pr169.faf6fbd.werdr7`.
Its SHA-256 is `26f050e969ac4d0d3820e5eeb35a386e2d6e4d07f63082cc2d58bcf7587600c2`.
Apply `wmux-paste-control-characters.patch`, `wmux-fractional-dpr-backing-store.patch`, `wmux-empty-write.patch` and `wmux-fractional-viewport-rows.patch` in that order after the ten patches above.
They carry fixes that upstream `coder/ghostty-web` has reported or proposed but not released; upstream `main` and its published 0.4.0 package predate this pin's Ghostty 1.3 WASM and lack APIs werdr uses, so moving to upstream is not yet possible.

- The paste patch ports [coder/ghostty-web#193](https://github.com/coder/ghostty-web/pull/193) for CVE-2026-26982: pasted control bytes become spaces, so clipboard text cannot end a bracketed paste early with `ESC[201~` or reach the line discipline as Ctrl characters.
- The backing-store patch fixes [coder/ghostty-web#198](https://github.com/coder/ghostty-web/issues/198): at fractional device scales every frame resized and repainted the terminal because the truncated canvas size never equalled the unrounded product, and `Terminal.resize()` overwrote the device-scaled backing store with an unscaled size.
- The empty-write patch fixes [coder/ghostty-web#199](https://github.com/coder/ghostty-web/issues/199): `write('')` threw from a zero-length WASM allocation and skipped its callback.
- The viewport patch ports [coder/ghostty-web#171](https://github.com/coder/ghostty-web/pull/171): smooth scrolling compared rows with a fractional offset but indexed with its floor, dropping the top screen row.

Each patch includes Bun regression tests, and the fork's full Bun suite passes with all fourteen patches (456 tests, Bun 1.3.14).
The browser regression in `web/test/terminal-device-scale.spec.ts` checks idle rendering at a 1.1 device scale, empty writes and paste sanitizing against the packaged bundle, and that native panes re-measure their cells after a device-scale change.
Build and package from source as above with Node 22.22.2, TypeScript 5.9.3, Vite 4.5.14 and npm 11.18.0; do not edit generated bundles or rebuild WASM.
Both WASM copies retain SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`.
Remove each patch when an adopted upstream package contains the corresponding fix and its regression passes.
