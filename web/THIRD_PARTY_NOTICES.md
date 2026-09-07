# Web package notices

New werdr browser and gateway code is MIT-licensed under [LICENSE](LICENSE).
The upstream herdr runtime remains Apache-2.0-licensed under the repository root license.

## Wmux-derived code

`src/wmux/retro-boot-profiles.ts`, `src/wmux/retro-boot-audio.ts`, `src/wmux/RetroBootArtwork.tsx`, the adapted graphical desktop renderer, and boot CSS were copied from wmux commit `5dd1affd1230479ac36519f77811dc64aeaaf80f`.
Their original MIT notice is retained in `src/wmux/LICENSE`.
The UI adapts selected profile text and authentication prompts at display time.
The terminal-backed authentication flow in `src/boot.ts` adapts wmux's `RetroBootScreen.tsx` and terminal input configuration under the same retained MIT notice.

## Ghostty browser fork

The browser uses the MIT-licensed `ghostty-web` package with wmux's local patches.
Exact source commits, build details, checksums, patch order, and the removal condition are retained in [vendor/ghostty-web-pr169/UPSTREAM.md](vendor/ghostty-web-pr169/UPSTREAM.md).
The upstream MIT license is included inside the package archive.
This is not an official Coder release.

Other JavaScript dependencies retain the licenses declared in their installed packages and the locked dependency graph.

## Boot-screen fonts

`public/fonts/c64/C64_Pro_Mono-STYLE.woff2` is the unmodified C64 Pro Mono webfont, copyright Style.
Its original filename and [license](public/fonts/c64/license.txt) are preserved, along with [provenance](public/fonts/c64/UPSTREAM.md).
The font permits embedding in websites and inclusion in software freely provided to end users; it remains outside werdr's MIT license.

The 17 ZX Origins font files used across the historical profiles can be provisioned privately for embedded website use through `WERDR_BOOT_FONT_DIR`.
They are unmodified WOFF2 conversions from Damien Guard's ZX Origins Micropack, copyright 1988-2023 Damien Guard.
Credit: [DamienG / ZX Origins](https://damieng.com/zx-origins/).
Their terms permit embedded website use with attribution but restrict standalone redistribution, rehosting for direct font download, and inclusion in asset collections.
Wmux's additional repository permission is specific to wmux and is not represented as permission to publish these files in this fork.
The font binaries are therefore not included in werdr's public repository or release archive; deployment provisions them separately for the application.
See [private-font provenance](../werdr/BOOT_FONTS.md) for setup and source information.

## Historical material

The Amiga Workbench screenshot is not included in the public repository or release archive.
It has no identified source-redistribution license and is provisioned separately for private deployment through `WERDR_BOOT_ASSET_DIR`.
Its exact source and status are recorded in [asset provenance](src/wmux/assets/retro/UPSTREAM.md).
The TOS screenshot and boot logos are included with their original public-domain or CC BY-SA terms and attribution in the [asset provenance](src/wmux/assets/retro/UPSTREAM.md) and [logo provenance](src/wmux/assets/retro/logos/UPSTREAM.md).
The artwork renderer preserves the wmux raster palettes and transparency normalization; those asset changes remain under their respective source licenses.
Historical product names in boot text identify the systems being simulated and do not imply endorsement.
React and React DOM are MIT-licensed and are used to retain wmux's existing artwork and graphical desktop presentation without duplicating its vector renderer.
