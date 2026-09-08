import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture';
import { consoleInput } from './console-helpers';

test('configured shell, pane, popup and plugin commands use the browser target and refresh opaque IDs', async ({ page }) => {
  test.setTimeout(120000);
  if (!process.env.WERDR_TEST_HERDR_BIN) throw new Error('Command tests require the candidate native runtime.');
  const runtime = await fixture(false, false, false, undefined, process.env.WERDR_TEST_HERDR_BIN);
  const inputs: string[] = [];
  await page.routeWebSocket('**/ws/terminal?*', socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => { const record = JSON.parse(String(message)); if (record.type === 'terminal.input') inputs.push(record.text); server.send(message); });
  });
  try {
    const marker = join(runtime.directory, 'marker.json'), context = join(runtime.directory, 'plugin-context.json');
    const shell = join(runtime.directory, 'shell.py'), pane = join(runtime.directory, 'pane.py'), plugin = join(runtime.directory, 'plugin');
    await mkdir(plugin);
    await writeFile(shell, `import json, os\nwith open(${JSON.stringify(marker)}, 'w') as f: json.dump(dict(os.environ), f)\n`);
    await writeFile(pane, 'print("COMMAND_READY", flush=True)\nfor line in __import__("sys").stdin:\n print("COMMAND_ECHO:"+line.strip(), flush=True)\n');
    await writeFile(join(plugin, 'action.py'), `import os\nwith open(${JSON.stringify(context)}, 'w') as f: f.write(os.environ['HERDR_PLUGIN_CONTEXT_JSON'])\n`);
    await writeFile(join(plugin, 'herdr-plugin.toml'), `id = "example.command-test"\nname = "Command test"\nversion = "0.1.0"\nmin_herdr_version = "0.7.0"\n[[actions]]\nid = "capture"\ntitle = "Capture"\ncommand = ["python3", ${JSON.stringify(join(plugin, 'action.py'))}]\n`);
    await runtime.cli('plugin', 'link', plugin);
    const config = '[update]\nversion_check = false\nmanifest_check = false\n' + [
      ['y', 'shell', `python3 '${shell}'`, '<b>write marker</b>'],
      ['u', 'pane', `python3 '${pane}'`, 'temporary pane'],
      ['t', 'popup', `python3 '${pane}'`, 'scratch popup'],
      ['i', 'plugin_action', 'example.command-test.capture', 'capture context'],
    ].map(([key, type, command, description]) => `[[keys.command]]\nkey = "prefix+${key}"\ntype = ${JSON.stringify(type)}\ncommand = ${JSON.stringify(command)}\ndescription = ${JSON.stringify(description)}\n`).join('');
    await writeFile(join(runtime.directory, 'herdr/config.toml'), config);
    await runtime.cli('server', 'reload-config');
    await page.goto(runtime.url); await consoleInput(page, 'token', runtime.token); await expect(page.locator('#boot')).toBeHidden();
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('write marker');
    const shellButton = page.locator('#command-list').getByRole('button', { name: /Host command: <b>write marker<\/b>/ });
    await expect(shellButton).toBeVisible(); await expect(shellButton.locator('b')).toHaveCount(0); await shellButton.click();
    await expect.poll(async () => { try { return JSON.parse(await readFile(marker, 'utf8')).HERDR_ACTIVE_PANE_ID ?? null; } catch { return undefined; } }).toBe(null);
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await expect(page.locator('#shield')).toBeHidden();
    const source = Object.fromEntries(new URL(page.url()).searchParams);
    const foreign = JSON.parse(await runtime.cli('workspace', 'create')).result.root_pane;
    await expect(page.locator('#terminal textarea')).toBeFocused();
    await page.keyboard.press('Control+b'); await page.keyboard.press('y');
    await expect.poll(async () => { try { return JSON.parse(await readFile(marker, 'utf8')).HERDR_ACTIVE_PANE_ID; } catch { return undefined; } }).toBe(source.pane);
    await writeFile(marker, '{}');
    await page.keyboard.press('Control+b'); await page.keyboard.press('w'); await page.keyboard.press('ArrowDown');
    await expect(page.locator('#workspaces button.navigate-preview')).toHaveAttribute('data-id', `local/${foreign.workspace_id}`);
    await page.keyboard.press('y');
    await expect.poll(async () => { try { return JSON.parse(await readFile(marker, 'utf8')).HERDR_ACTIVE_PANE_ID; } catch { return undefined; } }).toBe(source.pane);
    expect(new URL(page.url()).searchParams.get('pane')).toBe(source.pane);
    await runtime.cli('workspace', 'focus', foreign.workspace_id);
    const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'command.execute');
    await page.keyboard.press('Control+b'); await page.keyboard.press('u');
    const produced = (await (await createdResponse).json()).effect.pane;
    expect(produced.workspace_id).toBe(source.workspace); expect(produced.tab_id).toBe(source.tab);
    await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(produced.pane_id); await expect(page.locator('#shield')).toBeHidden();
    await page.keyboard.type('test'); await page.keyboard.press('Enter');
    await expect.poll(() => runtime.cli('pane', 'read', produced.pane_id, '--source', 'recent')).toContain('COMMAND_ECHO:test');
    await runtime.cli('pane', 'close', produced.pane_id); await expect.poll(() => new URL(page.url()).searchParams.get('pane')).toBe(source.pane);
    await expect(page.locator('#shield')).toBeHidden();
    let releasePopup = () => {}; let popupRequestHeld = false;
    const popupGate = new Promise<void>(resolve => { releasePopup = resolve; });
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON()?.action === 'command.execute') { popupRequestHeld = true; await popupGate; }
      await route.continue();
    });
    try {
      await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('scratch popup'); await page.locator('#command-list').getByRole('button', { name: /Host command: scratch popup/ }).click();
      await expect.poll(() => popupRequestHeld).toBe(true); await expect(page.locator('#native-popup-pending')).toBeVisible();
      const previousInput = [...inputs];
      await page.keyboard.type('not-for-underlying-pane'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
      expect(inputs).toEqual(previousInput); await expect(page.locator('#native-popup-pending')).toBeVisible();
    } finally { releasePopup(); await page.unrouteAll({ behavior: 'wait' }); }

    await expect(page.locator('#native-popup')).toBeVisible(); await expect(page.locator('#native-popup .pane-shield')).toBeHidden();
    expect(new URL(page.url()).searchParams.get('pane')).toBe(source.pane);
    await page.locator('#native-popup').getByRole('button', { name: '[X] CLOSE', exact: true }).click(); await expect(page.locator('#native-popup')).not.toBeVisible();
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON()?.action === 'command.execute') await route.fulfill({ status: 502, json: { error: 'Popup launch rejected' } });
      else await route.continue();
    });
    await page.keyboard.press('Control+b'); await page.keyboard.press('t');
    await expect(page.locator('#status')).toContainText('Popup launch rejected');
    await expect(page.locator('#native-popup-pending')).not.toBeVisible(); await expect(page.locator('#terminal textarea')).toBeFocused();
    await page.unrouteAll({ behavior: 'wait' });
    await runtime.cli('workspace', 'focus', foreign.workspace_id);
    await page.keyboard.press('Control+b'); await page.keyboard.press('i');
    await expect.poll(async () => { try { return JSON.parse(await readFile(context, 'utf8')).focused_pane_id; } catch { return undefined; } }).toBe(source.pane);
    await page.locator('#settings').click(); await page.locator('[data-setting=copyOnSelect]').uncheck(); await page.getByRole('button', { name: 'SAVE SETTINGS', exact: true }).click();
    await expect(page.locator('#settings-dialog')).toBeHidden();
    await runtime.cli('pane', 'send-text', source.pane, "printf '\\033[2J\\033[HCOMMAND_%s\\n' SELECTION\n");
    await expect.poll(() => runtime.cli('pane', 'read', source.pane, '--source', 'recent')).toContain('COMMAND_SELECTION');
    const canvas = await page.locator('.pane-active canvas').first().boundingBox();
    await page.mouse.dblclick(canvas!.x + 12, canvas!.y + 8);
    await expect(page.locator('.pane-content[data-native-selection]')).toHaveCount(1);
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('capture context');
    await page.locator('#command-list').getByRole('button', { name: /Host command: capture context/ }).click();
    await expect.poll(async () => { try { return JSON.parse(await readFile(context, 'utf8')).selected_text; } catch { return undefined; } }).toBe('COMMAND_SELECTION');
    for (const palette of [false, true]) {
      await writeFile(context, '{}');
      await page.keyboard.press('Control+k');
      await page.locator('#command-list').getByRole('button', { name: 'Terminal: search native scrollback', exact: true }).click();
      await page.locator('.copy-search input').fill('COMMAND_SELECTION');
      await page.locator('.copy-search').getByRole('button', { name: 'FIND', exact: true }).click();
      await expect(page.locator('.copy-status')).toContainText('1/1');
      if (palette) {
        await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('capture context');
        await page.locator('#command-list').getByRole('button', { name: /Host command: capture context/ }).click();
      } else {
        await page.locator('.copy-layer').focus(); await page.keyboard.press('Control+b'); await page.keyboard.press('i');
      }
      await expect.poll(async () => { try { return JSON.parse(await readFile(context, 'utf8')).selected_text; } catch { return undefined; } }).toBe('COMMAND_SELECTION');
      await page.locator('.copy-toolbar [data-copy=exit]').click(); await expect(page.locator('.copy-layer')).toHaveCount(0);
    }
    // A selection valid at dispatch must still fail if output changes before execution.
    await page.keyboard.press('Control+k');
    await page.locator('#command-list').getByRole('button', { name: 'Terminal: search native scrollback', exact: true }).click();
    await page.locator('.copy-search input').fill('COMMAND_SELECTION');
    await page.locator('.copy-search').getByRole('button', { name: 'FIND', exact: true }).click();
    await expect(page.locator('.copy-status')).toContainText('1/1');
    await writeFile(context, '{}');
    await page.route('**/api/action', async route => {
      if (route.request().postDataJSON()?.action === 'command.execute') {
        await runtime.cli('pane', 'send-text', source.pane, "printf 'REVISION_%s\\n' CHANGED\n");
        await expect.poll(() => runtime.cli('pane', 'read', source.pane, '--source', 'recent')).toContain('REVISION_CHANGED');
      }
      await route.continue();
    });
    const rejectedSelection = page.waitForResponse(response => response.url().endsWith('/api/action') && response.request().postDataJSON()?.action === 'command.execute');
    await page.locator('.copy-layer').focus(); await page.keyboard.press('Control+b'); await page.keyboard.press('i');
    const rejection = await rejectedSelection;
    expect(rejection.ok()).toBe(false); expect((await rejection.json()).error).toMatch(/changed|revision|stale/i);
    expect(JSON.parse(await readFile(context, 'utf8'))).toEqual({});
    await page.unrouteAll({ behavior: 'wait' });
    await page.locator('.copy-toolbar [data-copy=exit]').click(); await expect(page.locator('.copy-layer')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('scratch popup');
    await page.locator('#command-list').getByRole('button', { name: /Host command: scratch popup/ }).click();
    await expect(page.locator('#native-popup')).toBeVisible(); await expect(page.locator('#native-popup .pane-shield')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#native-popup').getByRole('button', { name: '[X] CLOSE', exact: true }).click();
    await expect(page.locator('#native-popup')).not.toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    const before = (await (await page.request.get(runtime.url + '/api/fleet')).json()).hosts.find((host: any) => host.machine.id === 'local').commands.commands[0].command_id;
    await writeFile(join(runtime.directory, 'herdr/config.toml'), config.replace('<b>write marker</b>', 'updated marker'));
    await runtime.cli('server', 'reload-config');
    await page.keyboard.press('Control+k'); await page.locator('#command-search').fill('updated marker'); await expect(page.locator('#command-list').getByRole('button', { name: /Host command: updated marker/ })).toBeVisible();
    const snapshot = JSON.parse(await runtime.cli('api', 'snapshot')).result.snapshot;
    const target = snapshot.panes.find((pane: any) => pane.pane_id === source.pane);
    const stale = await page.request.post(runtime.url + '/api/action', { headers: { Origin: runtime.url }, data: { machine: 'local', action: 'command.execute', command_id: before, target } });
    expect(stale.ok()).toBe(false); expect((await stale.json()).error).toContain('stale');
  } finally { await runtime.close(); }
});
