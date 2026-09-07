import { readFile } from 'node:fs/promises';
import { createSecureContext, type SecureContextOptions } from 'node:tls';
import type { Server } from 'node:https';

export async function tlsConfiguration(certPath?: string, keyPath?: string) {
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) throw new Error('WERDR_CERT_FILE and WERDR_KEY_FILE must be configured together');
  const read = async (): Promise<SecureContextOptions & { cert: Buffer; key: Buffer }> => {
    const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
    const options = { cert, key, minVersion: 'TLSv1.2' as const };
    createSecureContext(options); // Reject malformed or mismatched replacements before changing the live context.
    return options;
  };
  let current = await read();
  return {
    options: current,
    async reload(server: Pick<Server, 'setSecureContext'>) {
      const next = await read();
      if (next.cert.equals(current.cert) && next.key.equals(current.key)) return false;
      server.setSecureContext(next); current = next;
      return true;
    },
  };
}
