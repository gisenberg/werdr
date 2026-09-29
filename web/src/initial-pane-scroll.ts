import { scrollState, type ScrollState } from '../shared/scrollbar';

/** Optional metadata is bounded and never guessed from a previous connection. */
export async function initialPaneScroll(read: () => Promise<unknown>, timeoutMs = 2000): Promise<{ terminalId?: string; scroll?: ScrollState } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([read(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]);
    if (!value || typeof value !== 'object') return;
    const record = value as { terminal_id?: unknown; scroll?: unknown };
    return { terminalId: typeof record.terminal_id === 'string' ? record.terminal_id : undefined, scroll: scrollState(record.scroll) };
  } catch { return; }
  finally { clearTimeout(timer); }
}
