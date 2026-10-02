import { NativeApiError } from './native-api.ts';
import { POSIX_HERDR_NOT_FOUND } from './herdr.ts';

const LEFT_RUNNING = 'Existing sessions are left running.';
export const GENERIC_OFFLINE_DETAIL = `SSH or native server unavailable. ${LEFT_RUNNING}`;

/**
 * Explain why a saved host is offline without forwarding remote output.
 * SSH and shell diagnostics are matched against known failures and replaced by
 * fixed advice, so browser payloads never carry arbitrary remote stderr.
 */
export function offlineDetail(error: unknown): string {
  if (error instanceof NativeApiError) return `${error.message} ${LEFT_RUNNING}`;
  const failure = error as { message?: unknown; stderr?: unknown; code?: unknown; killed?: unknown } | null;
  const text = [failure?.stderr, failure?.message].filter(value => typeof value === 'string').join('\n');
  const advice = (() => {
    if (text.includes('Host key verification failed')) return "The gateway does not trust this host's SSH key. As the gateway user, run ssh once with this target to verify it.";
    if (/Permission denied \(|Too many authentication failures/.test(text)) return "SSH key login was refused. Add the gateway's public key to this host's authorized_keys.";
    if (/Could not resolve hostname|Name or service not known|nodename nor servname/.test(text)) return "The gateway cannot resolve this host's name.";
    if (/Connection refused/.test(text)) return 'SSH refused the connection. Enable Remote Login or sshd on this host.';
    if (/Connection timed out|Operation timed out|No route to host|Network is unreachable|Host is down/.test(text)) return 'The gateway cannot reach this host over SSH.';
    if (text.includes(POSIX_HERDR_NOT_FOUND) || /(command )?not found:? herdr|herdr: (command )?not found/.test(text) || failure?.code === 127) return "Herdr is not installed on this host, or not where SSH commands can find it. Use SET UP to install it.";
    if (failure?.killed === true) return 'This host did not answer within 15 seconds.';
    if (text.includes('SSH API tunnel')) return "SSH connected, but the native server's API socket could not be forwarded.";
    return undefined;
  })();
  return advice ? `${advice} ${LEFT_RUNNING}` : GENERIC_OFFLINE_DETAIL;
}
