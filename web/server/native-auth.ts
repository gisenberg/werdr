import { createHash, randomBytes } from 'node:crypto';
import { nativeClientName, SOCKET_TICKET_SECONDS } from '../shared/native-protocol.ts';

/**
 * How a request presents its session secret. Browsers use the `werdr` cookie;
 * native clients use `Authorization: Bearer`, which is only accepted from
 * requests without an `Origin` header. Browsers attach `Origin` to every
 * cross-origin and state-changing request and cannot add `Authorization`
 * cross-origin without a CORS preflight the gateway never grants.
 */
export type Credential =
  | { kind: 'cookie' | 'bearer'; secret: string }
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'conflict' };

export function cookieSecret(cookie: string | undefined): string | undefined {
  return cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('werdr='))?.slice(6) || undefined;
}

export function requestCredential(headers: { cookie?: string; authorization?: string; origin?: string }): Credential {
  if (headers.authorization !== undefined) {
    if (headers.origin !== undefined) return { kind: 'conflict' };
    // The auth scheme is case-insensitive (RFC 9110); session secrets are lowercase hex.
    const match = /^(\S+) ([a-f0-9]{64})$/.exec(headers.authorization);
    return match && match[1].toLowerCase() === 'bearer' ? { kind: 'bearer', secret: match[2] } : { kind: 'invalid' };
  }
  const secret = cookieSecret(headers.cookie);
  return secret ? { kind: 'cookie', secret } : { kind: 'none' };
}

/**
 * State-changing requests must carry the exact browser Origin, except bearer
 * requests and native sign-in, which must carry none.
 */
export function postAllowed(origin: string | undefined, browserOrigin: string, credential: Credential['kind'], pathname: string): boolean {
  if (origin !== undefined) return origin === browserOrigin && credential !== 'bearer';
  // A malformed Authorization header still marks a native request; it fails
  // authentication with 401 instead of the browser-oriented Origin error.
  return credential === 'bearer' || credential === 'invalid' || pathname === '/api/login';
}

export type LoginMode = { kind: 'browser' } | { kind: 'native'; name: string } | { kind: 'rejected'; status: 400 | 403; error: string };

export function loginMode(body: Record<string, unknown>, origin: string | undefined, browserOrigin: string): LoginMode {
  if (body.client === undefined) return origin !== undefined && origin === browserOrigin ? { kind: 'browser' } : { kind: 'rejected', status: 403, error: 'Origin required' };
  if (origin !== undefined) return { kind: 'rejected', status: 400, error: 'Native sign-in cannot be requested with an Origin header' };
  const name = nativeClientName(body.client);
  return name ? { kind: 'native', name } : { kind: 'rejected', status: 400, error: 'Expected client { kind: "native", name } with a printable name of 1 to 64 characters' };
}

/**
 * Ticket upgrades come from native WebViews loaded from local assets, whose
 * Origin is absent, `null`, or `file://`. Any other Origin must match exactly.
 */
export function ticketOriginAllowed(origin: string | undefined, browserOrigin: string): boolean {
  return origin === undefined || origin === 'null' || /^file:\/\//i.test(origin) || origin === browserOrigin;
}

export interface TicketBinding { session: string; secret: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Single-use WebSocket tickets, held only in memory and keyed by hash so a
 * heap or map dump never exposes a redeemable ticket. Each ticket carries the
 * issuing session's secret so the socket it opens re-validates exactly like a
 * cookie socket for its whole lifetime.
 */
export class TicketStore {
  private tickets = new Map<string, TicketBinding & { expiry: number }>();
  constructor(private perSession = 32, private total = 1024, private lifetime = SOCKET_TICKET_SECONDS * 1000) {}
  get size() { return this.tickets.size; }
  /** Returns undefined when the global bound is reached. Per-session overflow evicts that session's oldest ticket. */
  issue(binding: TicketBinding, now = Date.now()): string | undefined {
    this.sweep(now);
    const own = [...this.tickets].filter(([, record]) => record.session === binding.session);
    for (const [key] of own.slice(0, Math.max(0, own.length - this.perSession + 1))) this.tickets.delete(key);
    if (this.tickets.size >= this.total) return undefined;
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(digest(ticket), { session: binding.session, secret: binding.secret, expiry: now + this.lifetime });
    return ticket;
  }
  consume(ticket: unknown, now = Date.now()): TicketBinding | undefined {
    if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) return undefined;
    const key = digest(ticket), record = this.tickets.get(key);
    this.tickets.delete(key);
    return record && record.expiry > now ? { session: record.session, secret: record.secret } : undefined;
  }
  revoke(sessions: readonly string[]) {
    for (const [key, record] of this.tickets) if (sessions.includes(record.session)) this.tickets.delete(key);
  }
  sweep(now = Date.now()) {
    for (const [key, record] of this.tickets) if (record.expiry <= now) this.tickets.delete(key);
  }
}

export interface UpgradeRequest {
  /** The `ticket` query parameter, or null when absent. */
  ticket: string | null;
  origin: string | undefined;
  /** The allowlisted origin for the request's Host header, or undefined when Host is rejected. */
  hostOrigin: string | undefined;
  credential: Credential;
}

/**
 * Resolves a WebSocket upgrade to the session it acts for. Browsers present
 * the cookie with their exact Origin; native WebViews present a single-use
 * ticket, which is consumed before any other check so it can never be
 * replayed. `resolve` returns the live session id for a secret, applying
 * expiry, revocation, and token rotation.
 */
export function upgradeBinding(request: UpgradeRequest, tickets: TicketStore, resolve: (secret: string, expected?: string) => string | undefined): TicketBinding | undefined {
  if (request.ticket !== null) {
    const binding = tickets.consume(request.ticket);
    if (!binding || !request.hostOrigin || !ticketOriginAllowed(request.origin, request.hostOrigin)) return undefined;
    return resolve(binding.secret, binding.session) ? binding : undefined;
  }
  if (!request.hostOrigin || request.origin !== request.hostOrigin || request.credential.kind !== 'cookie') return undefined;
  const session = resolve(request.credential.secret);
  return session ? { session, secret: request.credential.secret } : undefined;
}
