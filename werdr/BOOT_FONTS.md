# Boot-screen fonts

The startup and authentication console share one randomly selected machine profile, palette, and font.
DOM-backed username, password, and token inputs retain native keyboard, autofill, paste, and accessibility support.
Authentication proceeds through username, password, verification, and access-granted prompts without leaving that console.
Secret characters are not echoed, and failed login or sign-out clears them.

## Bundled C64 face

`web/public/fonts/c64/C64_Pro_Mono-STYLE.woff2` is copied unchanged from wmux's `src/client/src/assets/c64/` directory.
The filename, Style license, and upstream provenance are retained beside it.
It is used only as an embedded application font, not presented as a font download.

## Privately provisioned Apple II and IBM CGA faces

`Apple_2.woff2` and `IBM_CGA.woff2` come from Damien Guard's ZX Origins Micropack archive, dated December 1, 2023, at <https://dl.damieng.com/fonts/conversions/Micropack.zip>.
They are the same unmodified conversions used by wmux under `src/client/src/assets/retro/`.
Credit: [DamienG / ZX Origins](https://damieng.com/zx-origins/).
The upstream terms permit embedded site use with credit while restricting standalone redistribution and font-collection bundling.
Wmux's separate permission for repository inclusion does not extend to publishing these files in werdr.

Provision both files in a private directory outside the checkout and set `WERDR_BOOT_FONT_DIR` to it when starting the gateway.
The homelab installer provisions its private copy from the neighboring wmux checkout; `WERDR_BOOT_FONT_SOURCE_DIR` can select another legally obtained source directory.
The gateway validates and serves only the two exact font paths, behind its existing bind and Host/Origin boundary, so startup works before sign-in without exposing arbitrary files.
Do not add these binary files to the public repository or release archive.
The browser waits briefly for the selected face and falls back to monospace if it is unavailable, so font delivery cannot block login.

For browser verification with provisioned fonts, set `WERDR_TEST_BOOT_FONT_DIR` to the same private directory before running `npm --prefix web run test:e2e`.
Without that optional directory, the suite tests the bundled C64 face and missing-font fallback, and explicitly skips the two private-font rendering checks.
