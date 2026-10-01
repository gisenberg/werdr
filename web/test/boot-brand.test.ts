import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandBootText } from '../src/boot-brand.ts';
import { RETRO_BOOT_PROFILES } from '../src/wmux/retro-boot-profiles.ts';

test('branding keeps fixed-width listings and dotted status columns aligned', () => {
  assert.equal(brandBootText('0 "WMUX BOOT DISK  " 64 2A'), '0 "WERDR BOOT DISK " 64 2A');
  assert.equal(brandBootText('4    "WMUX"             PRG'), '4    "WERDR"            PRG');
  assert.equal(brandBootText('A: WMUX     COM : LOGIN    COM'), 'A: WERDR    COM : LOGIN    COM');
  assert.equal(brandBootText('wmux-handler ............. loaded'), 'werdr-handler ............ loaded');
  assert.equal(brandBootText('CHAIN "WMUX"\nWMUX READY.'), 'CHAIN "WERDR"\nWERDR READY.');
});

test('branded boot scenes stay within each native grid and preserve typed prompt boundaries', () => {
  for (const profile of RETRO_BOOT_PROFILES) {
    for (const step of profile.boot) {
      const branded = brandBootText(step.text);
      for (const line of branded.split('\n')) assert.ok(line.length <= profile.columns, `${profile.id}: ${line}`);
      if (step.typedFrom !== undefined) assert.equal(branded.slice(0, step.typedFrom), step.text.slice(0, step.typedFrom), profile.id);
    }
  }
});
