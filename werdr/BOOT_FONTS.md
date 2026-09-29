# Boot-screen fonts and artwork

The startup and authentication console share one randomly selected machine profile, palette, and font.
The 30 text profiles write boot text and authentication prompts into the same Ghostty terminal, using the wmux input scheme.
The six graphical profiles preserve the RISC OS, Atari TOS, Lisa, IRIX, NeXTSTEP, and OS/2 desktop login presentations.
Rows, columns, font size, and canvas geometry remain fixed through the authentication transition; only an actual browser viewport change adjusts the outer display scale.
The terminal's hidden textarea handles keyboard and paste input, with input-assistance attributes matching wmux and accessible prompt labels.
Authentication proceeds through username, password, verification, and access-granted prompts without leaving that console.
Secret characters are not echoed, and failed login or sign-out clears them.

## Bundled C64 face

`web/public/fonts/c64/C64_Pro_Mono-STYLE.woff2` is copied unchanged from wmux's `src/client/src/assets/c64/` directory.
The filename, Style license, and upstream provenance are retained beside it.
It is used only as an embedded application font, not presented as a font download.

## Privately provisioned ZX Origins faces

The 17 `.woff2` files listed in `web/server/boot-fonts.ts` come from Damien Guard's ZX Origins Micropack archive, dated December 1, 2023, at <https://dl.damieng.com/fonts/conversions/Micropack.zip>.
They are the same unmodified conversions used by wmux under `src/client/src/assets/retro/`.
Credit: [DamienG / ZX Origins](https://damieng.com/zx-origins/).
The upstream terms permit embedded site use with credit while restricting standalone redistribution and font-collection bundling.
Wmux's separate permission for repository inclusion does not extend to publishing these files in werdr.

Provision all 17 files in a private directory outside the checkout and set `WERDR_BOOT_FONT_DIR` to it when starting the gateway.
The homelab installer provisions its private copy from the neighboring wmux checkout; `WERDR_BOOT_FONT_SOURCE_DIR` can select another legally obtained source directory.
The gateway validates and serves only the exact font paths, behind its existing bind and Host/Origin boundary, so startup works before sign-in without exposing arbitrary files.
Do not add these binary files to the public repository or release archive.
The browser waits briefly for the selected face and falls back to monospace if it is unavailable, so font delivery cannot block login.

For browser verification with provisioned fonts, set `WERDR_TEST_BOOT_FONT_DIR` to the same private directory before running `npm --prefix web run test:e2e`.
Without that optional directory, the suite tests the bundled C64 face and missing-font fallback, and explicitly skips the private-font rendering checks for Apple II and IBM CGA.

## Artwork and sound

Redistributable logos and the CC BY-SA TOS screenshot live under `web/src/wmux/assets/retro/`, with attribution and terms beside them.
The Workbench 1.3 screenshot has no identified source-redistribution license and must remain outside the public source tree and release archive.
A private deployment can provision `workbench13-bootscreen.gif` in `WERDR_BOOT_ASSET_DIR` from its existing wmux assets.
The gateway serves that one validated GIF path behind the same private-network and Host/Origin boundary as boot fonts.
Set `WERDR_TEST_BOOT_ASSET_DIR` to this directory for browser verification.
The homelab installer provisions this asset alongside the private fonts.

POST beeps and Amiga floppy sounds are synthesized by wmux's retained MIT-licensed Web Audio code; there are no sampled sound files to distribute.
Browser autoplay restrictions may suppress sound, and blocked audio is never replayed during a later password keystroke.
The complete sequence supports reduced motion and click/key skipping, with Guru acknowledgement advancing into the Workbench recovery sequence.
