import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchDeviceScale } from '../src/device-scale.ts';

test('device scale watcher re-arms its resolution query and reports resizes until disposed', () => {
  const queries: { media: string; listeners: Set<() => void> }[] = [];
  const windowListeners = new Map<string, Set<() => void>>();
  const fake = {
    devicePixelRatio: 1,
    matchMedia(media: string) {
      const query = { media, listeners: new Set<() => void>(), addEventListener: (_: string, listener: () => void) => query.listeners.add(listener), removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener) };
      queries.push(query); return query;
    },
    addEventListener: (type: string, listener: () => void) => { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type)!.add(listener); },
    removeEventListener: (type: string, listener: () => void) => windowListeners.get(type)?.delete(listener),
  };
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fake;
  try {
    const ratios: number[] = [];
    const dispose = watchDeviceScale(ratio => ratios.push(ratio));
    assert.equal(queries.at(-1)!.media, '(resolution: 1dppx)');
    fake.devicePixelRatio = 1.5; [...queries.at(-1)!.listeners].forEach(listener => listener());
    assert.deepEqual(ratios, [1.5]);
    assert.equal(queries.at(-1)!.media, '(resolution: 1.5dppx)');
    assert.equal(queries.filter(query => query.listeners.size).length, 1);
    fake.devicePixelRatio = 2; windowListeners.get('resize')!.forEach(listener => listener());
    assert.deepEqual(ratios, [1.5, 2]);
    dispose();
    assert.equal(queries.filter(query => query.listeners.size).length, 0);
    assert.equal(windowListeners.get('resize')!.size, 0);
  } finally { (globalThis as { window?: unknown }).window = previous; }
});
