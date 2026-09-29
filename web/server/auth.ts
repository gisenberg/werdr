import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { equalToken } from './policy.ts';

interface Credentials { username: string; passwordHash: string }
export function parseCredentials(value: unknown): Credentials {
  const record = value as Partial<Credentials> | null;
  if (!record || typeof record.username !== 'string' || !record.username.length || record.username.length > 256 ||
      typeof record.passwordHash !== 'string' || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/i.test(record.passwordHash)) {
    throw new Error('Invalid credentials file');
  }
  return { username: record.username, passwordHash: record.passwordHash };
}
async function privateRead(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new Error('Authentication files must be owner-only regular files');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
export async function verifyCredentials(credentials: Credentials, username: unknown, password: unknown): Promise<boolean> {
  if (typeof username !== 'string' || username.length > 256 || typeof password !== 'string' || password.length > 4096) return false;
  const [, salt, hash] = credentials.passwordHash.split('$');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'hex'), 32, (error, key) => error ? reject(error) : resolve(key));
  });
  return timingSafeEqual(derived, Buffer.from(hash, 'hex')) && equalToken(username, credentials.username);
}
export class LoginLimiter {
  private attempts = new Map<string, { count: number; until: number }>();
  take(address: string, now = Date.now()): boolean {
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    let attempt = this.attempts.get(address);
    if (!attempt) {
      if (this.attempts.size >= 1024) return false;
      attempt = { count: 0, until: now + 60_000 }; this.attempts.set(address, attempt);
    }
    return ++attempt.count <= 10;
  }
}
export async function authentication(tokenPath: string, credentialsPath?: string) {
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  try {
    const file = await open(tokenPath, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32).toString('hex')); await file.sync(); } finally { await file.close(); }
  } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  let token = (await privateRead(tokenPath)).trim();
  if (token.length < 32) throw new Error('Token must contain at least 32 characters');
  const credentials = credentialsPath ? parseCredentials(JSON.parse(await privateRead(credentialsPath))) : undefined;
  let rotating = false;
  return {
    passwordEnabled: !!credentials,
    get tokenVersion() { return createHash('sha256').update(token).digest('hex'); },
    verifyPassword: (username: unknown, password: unknown) => credentials ? verifyCredentials(credentials, username, password) : Promise.resolve(false),
    verifyToken: (value: unknown) => typeof value === 'string' && value.length <= 4096 && equalToken(value, token),
    async rotateToken(): Promise<string> {
      if (rotating) throw new Error('Token update already in progress');
      rotating = true;
      const next = randomBytes(32).toString('hex');
      const temporary = `${tokenPath}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
        await rename(temporary, tokenPath);
        token = next;
        const directory = await open(dirname(tokenPath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        return next;
      } finally { rotating = false; await unlink(temporary).catch(() => {}); }
    },
  };
}
