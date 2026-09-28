import { customSoundFor, MAX_CUSTOM_SOUND_BYTES, soundSlots, validateCustomSounds, validSoundId, type CustomSounds, type SoundSlot } from '../shared/custom-sounds';
import { SoundPlayer } from './sound-player';
import doneSound from '../../assets/sounds/done.mp3?url';
import requestSound from '../../assets/sounds/request.mp3?url';

const previewSources = new Map<string, string>();
export const draftSoundUrl = (id: string) => previewSources.get(id);
type Draft = { id: string; bytes: ArrayBuffer; url: string };

/** Files stay local until Save; closing or resetting fences asynchronous decoding. */
export class SoundSettings {
  private value: CustomSounds = { global: null, done: null, request: null };
  private drafts = new Map<SoundSlot, Draft>();
  private pending = new Map<SoundSlot, object>();
  private labels = new Map<SoundSlot, HTMLElement>();
  private player: SoundPlayer;
  private generation = 0;
  constructor(private readonly changed: () => void, private readonly report: (message: string) => void) { this.player = new SoundPlayer(report); }
  close() {
    ++this.generation; this.pending.clear(); this.player.stop(); previewSources.clear();
    for (const draft of this.drafts.values()) URL.revokeObjectURL(draft.url);
    this.drafts.clear();
  }
  read() { return validateCustomSounds(this.value); }
  fill(parent: HTMLElement, value: CustomSounds) {
    this.close(); this.value = validateCustomSounds(value); this.labels.clear();
    const section = document.createElement('details'); section.id = 'settings-custom-sounds';
    const heading = document.createElement('summary'); heading.textContent = 'CUSTOM NOTIFICATION SOUNDS';
    const hint = document.createElement('p'); hint.textContent = 'Choose MP3 files up to 2 MiB each. Event sounds override the global sound. Missing or invalid files use the built-in sound. Files upload only when you save; Preview plays even when alert sound is off.';
    section.append(heading, hint);
    for (const slot of soundSlots) {
      const row = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = slot.toUpperCase();
      const name = document.createElement('p'); name.dataset.soundName = slot; this.labels.set(slot, name);
      const label = document.createElement('label'); label.textContent = `CHOOSE ${slot.toUpperCase()} MP3`;
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.mp3,audio/mpeg'; input.dataset.soundFile = slot;
      input.onchange = () => { const file = input.files?.[0]; if (file) void this.choose(slot, file); };
      label.append(input);
      const actions = document.createElement('div'); actions.className = 'inline-actions';
      const preview = document.createElement('button'); preview.type = 'button'; preview.textContent = 'PREVIEW'; preview.dataset.soundPreview = slot;
      preview.onclick = () => {
        this.player.stop();
        const event = slot === 'request' ? 'request' : 'done';
        const asset = slot === 'global' ? this.value.global : customSoundFor(this.value, event), builtin = event === 'request' ? requestSound : doneSound;
        this.player.play(asset ? draftSoundUrl(asset.id) || `/api/sounds/${asset.id}` : builtin, asset ? builtin : undefined);
      };
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'RESET'; reset.dataset.soundReset = slot;
      reset.onclick = () => { this.pending.delete(slot); this.remove(slot); this.value[slot] = null; input.value = ''; this.updateLabels(); this.changed(); };
      actions.append(preview, reset); row.append(legend, name, label, actions); section.append(row);
    }
    parent.append(section); this.updateLabels();
  }
  private remove(slot: SoundSlot) {
    this.player.stop(); const previous = this.drafts.get(slot);
    if (previous) URL.revokeObjectURL(previous.url);
    this.drafts.delete(slot); this.publish();
  }
  private publish() { previewSources.clear(); for (const draft of this.drafts.values()) previewSources.set(draft.id, draft.url); }
  private updateLabels() {
    for (const slot of soundSlots) this.labels.get(slot)!.textContent = this.pending.has(slot) ? 'CHECKING AUDIO...' : this.value[slot]?.name || (slot === 'global' ? 'BUILT-IN SOUNDS' : 'GLOBAL SOUND OR BUILT-IN');
  }
  private async choose(slot: SoundSlot, file: File) {
    const request = {}, generation = this.generation; this.pending.set(slot, request); this.updateLabels();
    const current = () => generation === this.generation && this.pending.get(slot) === request;
    try {
      if (!file.size || file.size > MAX_CUSTOM_SOUND_BYTES) throw new Error('Choose an MP3 file up to 2 MiB.');
      validateCustomSounds({ [slot]: { id: '0'.repeat(64), name: file.name } });
      const bytes = await file.arrayBuffer(); if (!current()) return;
      const decoder = new OfflineAudioContext(1, 1, 44100);
      try { const decoded = await decoder.decodeAudioData(bytes.slice(0)); if (!decoded.length || !Number.isFinite(decoded.duration)) throw new Error('Empty audio'); }
      catch { throw new Error('This MP3 could not be decoded. Choose another file.'); }
      if (!current()) return;
      // A local preview handle, never a durable asset ID. The server hashes on
      // Save, including on private HTTP origins without Web Crypto digest.
      const id = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      this.remove(slot); this.drafts.set(slot, { id, bytes, url: URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })) });
      this.value[slot] = { id, name: file.name }; this.pending.delete(slot); this.publish(); this.updateLabels(); this.report(''); this.changed();
    } catch (error) { if (current()) { this.pending.delete(slot); this.updateLabels(); this.report((error as Error).message); } }
  }
  async upload(signal: AbortSignal) {
    if (this.pending.size) throw new Error('Wait for the selected audio files to finish decoding.');
    const generation = this.generation, drafts = [...this.drafts], value = this.read();
    for (const [slot, draft] of drafts) {
      if (signal.aborted || generation !== this.generation) throw new Error('Sound selection was cancelled.');
      const response = await fetch('/api/sounds', { method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: draft.bytes, signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Sound upload failed.');
      if (!validSoundId(result.id)) throw new Error('Server returned an invalid sound identity.');
      value[slot] = { ...value[slot]!, id: result.id };
    }
    return value;
  }
}
