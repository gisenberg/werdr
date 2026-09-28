export const MAX_CUSTOM_SOUND_BYTES = 2 * 1024 * 1024;
export const soundSlots = ['global', 'done', 'request'] as const;
export type SoundSlot = typeof soundSlots[number];
export interface SoundAsset { id: string; name: string }
export type CustomSounds = Record<SoundSlot, SoundAsset | null>;
export const defaultCustomSounds: CustomSounds = { global: null, done: null, request: null };
export const validSoundId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateCustomSounds(value: unknown): CustomSounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid custom sounds.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !soundSlots.includes(key as SoundSlot))) throw new Error('Unknown custom sound slot.');
  const result = { ...defaultCustomSounds };
  for (const slot of soundSlots) {
    const asset = input[slot];
    if (asset === null || asset === undefined) continue;
    if (typeof asset !== 'object' || Array.isArray(asset)) throw new Error('Invalid custom sound reference.');
    const record = asset as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== 'id' && key !== 'name') || !validSoundId(record.id)
      || typeof record.name !== 'string' || record.name.length > 128 || !/\.mp3$/i.test(record.name)
      || /[\x00-\x1f\x7f/\\]/.test(record.name)) throw new Error('Invalid custom sound reference.');
    result[slot] = { id: record.id, name: record.name };
  }
  return result;
}

/** Match native event-specific-over-global precedence; playback owns built-in fallback. */
export function customSoundFor(sounds: CustomSounds, event: 'done' | 'request'): SoundAsset | null {
  return sounds[event] ?? sounds.global;
}
