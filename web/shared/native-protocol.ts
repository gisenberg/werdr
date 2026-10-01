// Native client contract shared with werdr-mobile, which vendors this
// directory verbatim. Keep this file free of imports outside web/shared.

/** Bumped whenever the native wire contract changes incompatibly. */
export const NATIVE_PROTOCOL_VERSION = 1;
/** Lifetime of a WebSocket ticket issued by `POST /api/socket-ticket`. */
export const SOCKET_TICKET_SECONDS = 30;
/** Longest accepted native device name, in Unicode code points. */
export const NATIVE_CLIENT_NAME_MAX = 64;

/** `GET /api/protocol`, unauthenticated. */
export interface ProtocolResponse {
  gateway: 'werdr';
  protocolVersion: number;
  nativeClients: true;
}

export interface NativeClient {
  kind: 'native';
  /** Device label shown in the SESSIONS panel. */
  name: string;
}

/** `POST /api/login` without an `Origin` header. */
export type NativeLoginRequest = ({ token: string } | { username: string; password: string }) & { client: NativeClient };

/** Successful native login. `session` is the bearer secret; no cookie is set. */
export interface NativeLoginResponse {
  ok: true;
  session: string;
}

/** `POST /api/socket-ticket`. Pass `ticket` as the `?ticket=` query parameter of one WebSocket upgrade. */
export interface SocketTicketResponse {
  ticket: string;
  expiresInSeconds: number;
}

export type SessionKind = 'browser' | 'native';

/** One entry of `GET /api/sessions`. */
export interface SessionSummary {
  id: string;
  issued: number;
  expiry: number;
  method: 'password' | 'token';
  /** Browser user agent, or the native device name. */
  client: string;
  kind: SessionKind;
  current: boolean;
}

/** Every non-2xx JSON response. */
export interface ErrorResponse {
  error: string;
}

/**
 * Returns the trimmed device name when `value` is a valid native client
 * descriptor, otherwise undefined. Names must be 1 to 64 code points with no
 * control, format (except the emoji zero-width joiner), surrogate,
 * private-use, unassigned, or line/paragraph separator characters.
 */
export function nativeClientName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const client = value as Record<string, unknown>;
  if (client.kind !== 'native' || typeof client.name !== 'string' || client.name.length > NATIVE_CLIENT_NAME_MAX * 2) return undefined;
  const name = client.name.trim();
  if (!name || [...name].length > NATIVE_CLIENT_NAME_MAX || /(?!\u200d)[\p{C}\p{Zl}\p{Zp}]/u.test(name)) return undefined;
  return name;
}
