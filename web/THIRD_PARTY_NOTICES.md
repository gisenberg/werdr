# Web package notices

New werdr browser and gateway code is MIT-licensed under [LICENSE](LICENSE).
The upstream herdr runtime remains Apache-2.0-licensed under the repository root license.

## Wmux-derived code

`src/wmux/retro-boot-profiles.ts` and `src/wmux/retro-boot-audio.ts` were copied from wmux commit `5dd1affd1230479ac36519f77811dc64aeaaf80f`.
Their original MIT notice is retained in `src/wmux/LICENSE`.
The UI adapts selected profile text at display time and uses system fonts.

## Ghostty browser fork

The browser uses the MIT-licensed `ghostty-web` package with wmux's local patches.
Exact source commits, build details, checksums, patch order, and the removal condition are retained in [vendor/ghostty-web-pr169/UPSTREAM.md](vendor/ghostty-web-pr169/UPSTREAM.md).
The upstream MIT license is included inside the package archive.
This is not an official Coder release.

Other JavaScript dependencies retain the licenses declared in their installed packages and the locked dependency graph.

## Historical material

The wmux-specific Damien Guard font permission does not grant independent redistribution here.
Those fonts and the unlicensed Amiga Workbench screenshot are not included.
Historical product names in boot text identify the systems being simulated and do not imply endorsement.
Any future imported artwork or fonts need their own redistribution terms and provenance.
