# Web package notices

New werdr browser and gateway code is MIT-licensed under [LICENSE](LICENSE).
The upstream herdr runtime remains Apache-2.0-licensed under the repository root license.

## Wmux-derived code

`src/wmux/retro-boot-profiles.ts` and `src/wmux/retro-boot-audio.ts` were copied from wmux commit `5dd1affd1230479ac36519f77811dc64aeaaf80f`.
Their original MIT notice is retained in `src/wmux/LICENSE`.
The UI adapts selected profile text and authentication prompts at display time.

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

The Apple II and IBM CGA faces can be provisioned privately for embedded website use through `WERDR_BOOT_FONT_DIR`.
They are unmodified WOFF2 conversions from Damien Guard's ZX Origins Micropack, copyright 1988-2023 Damien Guard.
Credit: [DamienG / ZX Origins](https://damieng.com/zx-origins/).
Their terms permit embedded website use with attribution but restrict standalone redistribution, rehosting for direct font download, and inclusion in asset collections.
Wmux's additional repository permission is specific to wmux and is not represented as permission to publish these files in this fork.
The font binaries are therefore not included in werdr's public repository or release archive; deployment provisions them separately for the application.
See [private-font provenance](../werdr/BOOT_FONTS.md) for setup and source information.

## Historical material

The unlicensed Amiga Workbench screenshot is not included.
Historical product names in boot text identify the systems being simulated and do not imply endorsement.
Any future imported artwork or fonts need their own redistribution terms and provenance.
