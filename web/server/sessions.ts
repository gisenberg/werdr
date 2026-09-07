import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SESSION_SECONDS = 90 * 24 * 3600;
interface Record { id: string; hash: string; issued: number; expiry: number; method: 'password' | 'token'; client: string; tokenVersion?: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// Corrupt or future stores fail closed. Never restore revoked credentials from a backup.
export async function sessionStore(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let records: Record[] = [];
  try {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 128 * 1024 || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new Error('Session store must be an owner-only regular file');
      const data = JSON.parse(await file.readFile('utf8'));
      if (data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > 64) throw new Error('Invalid session store version or size');
      const ids = new Set(), hashes = new Set();
      for (const record of data.sessions) {
        if (!record || !hex(record.id) || !hex(record.hash) || ids.has(record.id) || hashes.has(record.hash) ||
            !Number.isSafeInteger(record.issued) || !Number.isSafeInteger(record.expiry) || record.issued < 0 || record.expiry <= record.issued ||
            !['password', 'token'].includes(record.method) || typeof record.client !== 'string' || record.client.length > 256 ||
            (record.method === 'token' && !hex(record.tokenVersion))) throw new Error('Invalid session record');
        ids.add(record.id); hashes.add(record.hash);
      }
      records = data.sessions;
    } finally { await file.close(); }
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  let queue: Promise<unknown> = Promise.resolve();
  const mutate = <T>(change: (next: Record[]) => T): Promise<T> => {
    const task = queue.then(async () => {
      const next = records.filter(record => record.expiry > Date.now());
      const result = change(next);
      const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, sessions: next })); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
        records = next;
        const directory = await open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(() => {}); }
      return result;
    });
    queue = task.catch(() => {});
    return task;
  };
  return {
    get(secret: string | undefined, tokenVersion: string, now = Date.now()) {
      if (!hex(secret)) return undefined;
      const hash = digest(secret!);
      return records.find(record => record.hash === hash && record.expiry > now && (record.method !== 'token' || record.tokenVersion === tokenVersion));
    },
    list(current: string, tokenVersion: string) {
      return records.filter(record => record.expiry > Date.now() && (record.method !== 'token' || record.tokenVersion === tokenVersion))
        .map(({ id, issued, expiry, method, client }) => ({ id, issued, expiry, method, client, current: id === current }));
    },
    create(method: Record['method'], client: string, tokenVersion: string) {
      const secret = randomBytes(32).toString('hex');
      return mutate(next => {
        // Rotated access tokens cannot retain slots in the bounded store.
        for (let i = next.length - 1; i >= 0; i--) if (next[i].method === 'token' && next[i].tokenVersion !== tokenVersion) next.splice(i, 1);
        if (next.length >= 64) throw new Error('Session limit reached');
        const issued = Date.now();
        next.push({ id: randomBytes(32).toString('hex'), hash: digest(secret), issued, expiry: issued + SESSION_SECONDS * 1000, method, client: client.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256), ...(method === 'token' ? { tokenVersion } : {}) });
        return secret;
      });
    },
    revoke(select: (record: Readonly<Record>) => boolean) {
      return mutate(next => {
        const revoked = next.filter(select).map(record => record.id);
        for (let i = next.length - 1; i >= 0; i--) if (revoked.includes(next[i].id)) next.splice(i, 1);
        return revoked;
      });
    },
  };
}
