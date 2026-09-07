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
