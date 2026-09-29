import type { Api } from './host-manager';
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export function initializeAccount(api: Api, refresh: () => Promise<void>) {
  const tokenDialog = element<HTMLDialogElement>('token-dialog');
  element('access-token').onclick = () => tokenDialog.showModal();
  element('token-done').onclick = () => tokenDialog.close();
  tokenDialog.addEventListener('close', () => {
    element<HTMLInputElement>('generated-token').value = ''; element('generated-token-field').hidden = true;
    element('token-error').textContent = '';
  });
  element('generate-token').onclick = async () => {
    const button = element<HTMLButtonElement>('generate-token'); button.disabled = true;
    try {
      const { token } = await api('/api/token', {});
      if (!tokenDialog.open) return;
      element('generated-token-field').hidden = false;
      const input = element<HTMLInputElement>('generated-token'); input.value = token; input.focus(); input.select();
    } catch (error) { element('token-error').textContent = (error as Error).message; }
    finally { button.disabled = false; }
  };
  element('revoke-token').onclick = async () => {
    const button = element<HTMLButtonElement>('revoke-token'); button.disabled = true;
    try { await api('/api/token/revoke', {}); element<HTMLInputElement>('generated-token').value = ''; element('generated-token-field').hidden = true; element('token-error').textContent = 'Access token revoked. Browsers signed in with it were disconnected.'; }
    catch (error) { element('token-error').textContent = (error as Error).message; }
    finally { button.disabled = false; }
  };
  const sessionsDialog = element<HTMLDialogElement>('sessions-dialog');
  async function showSessions() {
    const { sessions } = await api('/api/sessions');
    element('session-list').replaceChildren();
    for (const session of sessions) {
      const row = document.createElement('div'); row.className = 'session-row';
      const label = document.createElement('strong'); label.textContent = session.current ? '[THIS BROWSER]' : '[BROWSER]';
      const client = document.createElement('div');
      const browser = /Edg\//.test(session.client) ? 'Edge' : /(?:Chrome|CriOS)\//.test(session.client) ? 'Chrome' : /(?:Firefox|FxiOS)\//.test(session.client) ? 'Firefox' : /Safari\//.test(session.client) ? 'Safari' : 'Browser';
      const platform = /Android/.test(session.client) ? 'Android' : /iPhone|iPad/.test(session.client) ? 'iOS' : /Windows/.test(session.client) ? 'Windows' : /Macintosh/.test(session.client) ? 'macOS' : /Linux/.test(session.client) ? 'Linux' : 'Unknown device';
      client.textContent = `${browser} / ${platform}`; client.title = session.client;
      const dates = document.createElement('div'); dates.textContent = `Signed in ${new Date(session.issued).toLocaleString()} / Expires ${new Date(session.expiry).toLocaleDateString()} / ${session.method}`;
      const revoke = document.createElement('button'); revoke.textContent = session.current ? 'SIGN OUT THIS BROWSER' : 'REVOKE';
      revoke.onclick = async () => {
        revoke.disabled = true;
        try {
          await api('/api/sessions/revoke', { id: session.id });
          if (session.current) { sessionsDialog.close(); await refresh(); } else await showSessions();
        } catch (error) { element('session-error').textContent = (error as Error).message; revoke.disabled = false; }
      };
      row.append(label, client, dates, revoke); element('session-list').append(row);
    }
  }
  element('sessions').onclick = () => { sessionsDialog.showModal(); element('session-error').textContent = ''; void showSessions().catch(error => { element('session-error').textContent = error.message; }); };
  element('sessions-done').onclick = () => sessionsDialog.close();
  element('revoke-others').onclick = async () => {
    const button = element<HTMLButtonElement>('revoke-others'); button.disabled = true;
    try { await api('/api/sessions/revoke', { others: true }); await showSessions(); }
    catch (error) { element('session-error').textContent = (error as Error).message; }
    finally { button.disabled = false; }
  };
}
