import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientLifecycle, ClientCancelled } from '../src/client-lifecycle.ts';

test('detach cancels outstanding work and rejects late success and failure after resume', async () => {
  const lifecycle = new ClientLifecycle();
  for (const failure of [false, true]) {
    let settle!: (value: string) => void, fail!: (error: Error) => void, signal!: AbortSignal;
    const epoch = lifecycle.generation;
    const request = lifecycle.request(value => { signal = value; return new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; }); });
    lifecycle.detach(); assert.equal(signal.aborted, true); assert.equal(lifecycle.current(epoch), false);
    await assert.rejects(lifecycle.request(async () => 'must not run'), ClientCancelled);
    lifecycle.resume(); assert.equal(lifecycle.current(epoch), false);
    if (failure) fail(new Error('stale authentication failure')); else settle('stale snapshot');
    await assert.rejects(request, ClientCancelled);
    assert.equal(await lifecycle.request(async () => 'new snapshot'), 'new snapshot');
  }
});

test('detached authentication is explicit and still fenced against subsequent lifecycle changes', async () => {
  const lifecycle = new ClientLifecycle(); lifecycle.detach();
  assert.equal(await lifecycle.request(async () => 'logout', true), 'logout');
  assert.equal(lifecycle.active, false);
  lifecycle.resume();
  await assert.rejects(lifecycle.request(async () => { throw new Error('actual failure'); }), /actual failure/);
});
