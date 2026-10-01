import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookieSecret, loginMode, postAllowed, requestCredential, ticketOriginAllowed, TicketStore, upgradeBinding } from '../server/native-auth.ts';
import { nativeClientName, NATIVE_CLIENT_NAME_MAX, SOCKET_TICKET_SECONDS } from '../shared/native-protocol.ts';
import { sessionStore } from '../server/sessions.ts';

const secret = 'a'.repeat(64), other = 'b'.repeat(64);
const origin = 'http://127.0.0.1:3480';

test('native client names are bounded, trimmed, and printable', () => {
  assert.equal(nativeClientName({ kind: 'native', name: '  Gabe’s iPhone 15 ' }), 'Gabe’s iPhone 15');
  assert.equal(nativeClientName({ kind: 'native', name: 'Pixel 9 📱' }), 'Pixel 9 📱');
  assert.equal(nativeClientName({ kind: 'native', name: 'Family \u{1f468}\u200d\u{1f469}\u200d\u{1f467} iPad' }), 'Family \u{1f468}\u200d\u{1f469}\u200d\u{1f467} iPad');
  assert.equal(nativeClientName({ kind: 'native', name: 'x'.repeat(NATIVE_CLIENT_NAME_MAX) }), 'x'.repeat(NATIVE_CLIENT_NAME_MAX));
  assert.equal(nativeClientName({ kind: 'native', name: '📱'.repeat(NATIVE_CLIENT_NAME_MAX) }), '📱'.repeat(NATIVE_CLIENT_NAME_MAX));
  for (const value of [
    undefined, null, 'native', [], { kind: 'browser', name: 'Phone' }, { kind: 'native' }, { kind: 'native', name: 7 },
    { kind: 'native', name: '' }, { kind: 'native', name: '   ' }, { kind: 'native', name: 'x'.repeat(NATIVE_CLIENT_NAME_MAX + 1) },
    { kind: 'native', name: 'line\nbreak' }, { kind: 'native', name: 'nul\0' }, { kind: 'native', name: 'del\x7f' },
    { kind: 'native', name: 'bidi\u202espoof' }, { kind: 'native', name: 'zero\u200bwidth' }, { kind: 'native', name: 'line\u2028sep' },
    { kind: 'native', name: 'lone\ud800' },
  ]) assert.equal(nativeClientName(value), undefined, JSON.stringify(value));
});

test('login mode separates browser and native sign-in by Origin', () => {
  assert.deepEqual(loginMode({ token: 't' }, origin, origin), { kind: 'browser' });
  assert.deepEqual(loginMode({ token: 't' }, undefined, origin), { kind: 'rejected', status: 403, error: 'Origin required' });
  assert.deepEqual(loginMode({ token: 't', client: { kind: 'native', name: 'Phone' } }, undefined, origin), { kind: 'native', name: 'Phone' });
  assert.equal((loginMode({ token: 't', client: { kind: 'native', name: 'Phone' } }, origin, origin) as { status: number }).status, 400);
  assert.equal((loginMode({ token: 't', client: { kind: 'native', name: 'a\nb' } }, undefined, origin) as { status: number }).status, 400);
  assert.equal((loginMode({ token: 't', client: null }, undefined, origin) as { status: number }).status, 400);
});

test('credentials resolve from cookie or bearer, never both with an Origin', () => {
  assert.equal(cookieSecret(undefined), undefined);
  assert.equal(cookieSecret('theme=dark; werdr=abc; other=1'), 'abc');
  assert.equal(cookieSecret('werdr='), undefined);
  assert.deepEqual(requestCredential({}), { kind: 'none' });
  assert.deepEqual(requestCredential({ cookie: `werdr=${secret}`, origin }), { kind: 'cookie', secret });
  assert.deepEqual(requestCredential({ authorization: `Bearer ${secret}` }), { kind: 'bearer', secret });
  assert.deepEqual(requestCredential({ authorization: `bearer ${secret}` }), { kind: 'bearer', secret });
  // The bearer credential is authoritative for originless native requests.
  assert.deepEqual(requestCredential({ authorization: `Bearer ${secret}`, cookie: `werdr=${other}` }), { kind: 'bearer', secret });
  assert.deepEqual(requestCredential({ authorization: `Bearer ${secret}`, origin }), { kind: 'conflict' });
  assert.deepEqual(requestCredential({ authorization: 'Basic dXNlcjpwYXNz', origin }), { kind: 'conflict' });
  for (const authorization of ['', 'Bearer', `Bearer  ${secret}`, `Bearer ${secret.toUpperCase()}`, `Bearer ${secret}x`, 'Basic dXNlcjpwYXNz', `Token ${secret}`]) {
    assert.deepEqual(requestCredential({ authorization }), { kind: 'invalid' }, authorization);
  }
});

test('POST requires the exact browser Origin unless the request is native', () => {
  assert.equal(postAllowed(origin, origin, 'cookie', '/api/action'), true);
  assert.equal(postAllowed(origin, origin, 'none', '/api/login'), true);
  assert.equal(postAllowed('http://foreign.invalid', origin, 'cookie', '/api/action'), false);
  assert.equal(postAllowed(undefined, origin, 'cookie', '/api/action'), false);
  assert.equal(postAllowed(undefined, origin, 'none', '/api/action'), false);
  assert.equal(postAllowed(undefined, origin, 'bearer', '/api/action'), true);
  assert.equal(postAllowed(undefined, origin, 'invalid', '/api/action'), true);
  assert.equal(postAllowed(undefined, origin, 'none', '/api/login'), true);
  assert.equal(postAllowed(origin, origin, 'bearer', '/api/action'), false);
});

test('ticket upgrades accept local WebView origins and exact http origins only', () => {
  for (const value of [undefined, 'null', 'file://', 'file:///android_asset/index.html', 'FILE://', origin]) assert.equal(ticketOriginAllowed(value, origin), true, String(value));
  for (const value of ['http://foreign.invalid', 'https://127.0.0.1:3480', 'http://127.0.0.1:3481', 'app://local', '', 'null ']) assert.equal(ticketOriginAllowed(value, origin), false, value);
});

test('tickets are single use, expire, and bind to their session', () => {
  const tickets = new TicketStore();
  const now = 1_000_000;
  const ticket = tickets.issue({ session: 's1', secret }, now)!;
  assert.match(ticket, /^[a-f0-9]{64}$/);
  assert.deepEqual(tickets.consume(ticket, now + 1), { session: 's1', secret });
  assert.equal(tickets.consume(ticket, now + 2), undefined);
  const expired = tickets.issue({ session: 's1', secret }, now)!;
  assert.equal(tickets.consume(expired, now + SOCKET_TICKET_SECONDS * 1000), undefined);
  assert.equal(tickets.consume(expired, now), undefined, 'an expired presentation still burns the ticket');
  for (const value of [undefined, '', 'x', ticket.toUpperCase(), 'c'.repeat(64)]) assert.equal(tickets.consume(value, now), undefined);
  const live = tickets.issue({ session: 's1', secret }, now)!, kept = tickets.issue({ session: 's2', secret: other }, now)!;
  tickets.revoke(['s1']);
  assert.equal(tickets.consume(live, now), undefined);
  assert.deepEqual(tickets.consume(kept, now), { session: 's2', secret: other });
  tickets.issue({ session: 's3', secret }, now); tickets.sweep(now + SOCKET_TICKET_SECONDS * 1000);
  assert.equal(tickets.size, 0);
});

test('outstanding tickets are bounded per session and globally', () => {
  const tickets = new TicketStore(3, 5);
  const now = 1_000_000;
  const first = tickets.issue({ session: 's1', secret }, now)!;
  const rest = [1, 2, 3].map(() => tickets.issue({ session: 's1', secret }, now)!);
  assert.equal(tickets.size, 3);
  assert.equal(tickets.consume(first, now), undefined, 'the oldest ticket of a full session is evicted');
  assert.ok(tickets.consume(rest[0], now));
  assert.ok(tickets.issue({ session: 's2', secret: other }, now));
  assert.ok(tickets.issue({ session: 's2', secret: other }, now));
  assert.ok(tickets.issue({ session: 's3', secret: other }, now));
  assert.equal(tickets.size, 5);
  assert.equal(tickets.issue({ session: 's4', secret: other }, now), undefined, 'the global bound rejects new sessions');
  assert.ok(tickets.issue({ session: 's4', secret: other }, now + SOCKET_TICKET_SECONDS * 1000), 'expired tickets free global capacity');
});

test('upgrades bind to the cookie or ticket session and consume tickets first', () => {
  const tickets = new TicketStore();
  const live = new Map([[secret, 's1']]);
  const resolve = (value: string, expected?: string) => { const id = live.get(value); return id && (expected === undefined || id === expected) ? id : undefined; };
  const cookie = { kind: 'cookie' as const, secret };
  assert.deepEqual(upgradeBinding({ ticket: null, origin, hostOrigin: origin, credential: cookie }, tickets, resolve), { session: 's1', secret });
  assert.equal(upgradeBinding({ ticket: null, origin: undefined, hostOrigin: origin, credential: cookie }, tickets, resolve), undefined);
  assert.equal(upgradeBinding({ ticket: null, origin: 'null', hostOrigin: origin, credential: cookie }, tickets, resolve), undefined);
  assert.equal(upgradeBinding({ ticket: null, origin, hostOrigin: undefined, credential: cookie }, tickets, resolve), undefined);
  assert.equal(upgradeBinding({ ticket: null, origin, hostOrigin: origin, credential: { kind: 'cookie', secret: other } }, tickets, resolve), undefined);
  assert.equal(upgradeBinding({ ticket: null, origin: undefined, hostOrigin: origin, credential: { kind: 'bearer', secret } }, tickets, resolve), undefined);

  const none = { kind: 'none' as const };
  const ticket = tickets.issue({ session: 's1', secret })!;
  assert.deepEqual(upgradeBinding({ ticket, origin: undefined, hostOrigin: origin, credential: none }, tickets, resolve), { session: 's1', secret });
  assert.equal(upgradeBinding({ ticket, origin: undefined, hostOrigin: origin, credential: none }, tickets, resolve), undefined, 'tickets are single use');
  const foreign = tickets.issue({ session: 's1', secret })!;
  assert.equal(upgradeBinding({ ticket: foreign, origin: 'http://foreign.invalid', hostOrigin: origin, credential: none }, tickets, resolve), undefined);
  assert.equal(upgradeBinding({ ticket: foreign, origin: undefined, hostOrigin: origin, credential: none }, tickets, resolve), undefined, 'a rejected presentation burns the ticket');
  const badHost = tickets.issue({ session: 's1', secret })!;
  assert.equal(upgradeBinding({ ticket: badHost, origin: 'null', hostOrigin: undefined, credential: none }, tickets, resolve), undefined);
  const revoked = tickets.issue({ session: 's1', secret })!;
  live.clear();
  assert.equal(upgradeBinding({ ticket: revoked, origin: 'file://', hostOrigin: origin, credential: cookie }, tickets, resolve), undefined);
  live.set(secret, 's2');
  const rebound = tickets.issue({ session: 's1', secret })!;
  assert.equal(upgradeBinding({ ticket: rebound, origin: undefined, hostOrigin: origin, credential: none }, tickets, resolve), undefined, 'tickets stay bound to the issuing session id');
  assert.equal(upgradeBinding({ ticket: '', origin, hostOrigin: origin, credential: cookie }, tickets, resolve), undefined, 'an empty ticket parameter never falls back to the cookie');
});

test('native sessions persist their kind and device label, and old records read as browsers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werdr-native-sessions-')); const path = join(directory, 'sessions.json');
  const version = 'c'.repeat(64);
  try {
    const store = await sessionStore(path);
    const browser = await store.create('password', 'Mozilla/5.0', version);
    const native = await store.create('token', 'Pixel 9', version, 'native');
    const data = await readFile(path, 'utf8');
    assert.equal(data.includes(native), false);
    const loaded = await sessionStore(path);
    const current = loaded.get(native, version)!.id;
    const listed = loaded.list(current, version);
    assert.deepEqual(listed.map(({ client, kind, method, current }) => ({ client, kind, method, current })).sort((a, b) => a.kind.localeCompare(b.kind)), [
      { client: 'Mozilla/5.0', kind: 'browser', method: 'password', current: false },
      { client: 'Pixel 9', kind: 'native', method: 'token', current: true },
    ]);
    assert.equal(JSON.parse(data).sessions.find((record: { client: string }) => record.client === 'Mozilla/5.0').kind, undefined, 'browser records keep the original schema');
    assert.ok(loaded.get(browser, version));
    assert.equal(loaded.get(native, 'd'.repeat(64)), undefined, 'token rotation invalidates native token sessions');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
