import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot, type HostView } from '../shared/fleet.ts';
import { initialSelection, resolveSelection, SelectionRestoration } from '../src/selection-restoration.ts';

const request = { machine: 'local', workspace: 'w2', tab: 't2', pane: 'p2' };
const host = (): HostView => ({ machine: { id: 'local', label: 'fixture', enabled: true }, connection: 'online', snapshot: {
  ...emptySnapshot(), focused_workspace_id: 'w1',
  workspaces: ['1', '2'].map(id => ({ workspace_id: 'w' + id, active_tab_id: 't' + id, label: '', agent_status: 'idle' })),
  tabs: ['1', '2'].map(id => ({ workspace_id: 'w' + id, tab_id: 't' + id, label: '' })),
  panes: ['1', '2'].map(id => ({ workspace_id: 'w' + id, tab_id: 't' + id, pane_id: 'p' + id, terminal_id: 'terminal' + id, agent_status: 'idle' })),
  layouts: ['1', '2'].map(id => ({ tab_id: 't' + id, focused_pane_id: 'p' + id })),
} });

test('explicit URL coordinates never inherit saved descendants, even when storage is malformed', () => {
  const saved = JSON.stringify(request);
  assert.deepEqual(initialSelection('?machine=other', saved).selection, { machine: 'other', workspace: '', tab: '', pane: '' });
  assert.deepEqual(initialSelection('?workspace=w1', saved).selection, { machine: 'local', workspace: 'w1', tab: '', pane: '' });
  assert.deepEqual(initialSelection('?tab=t1', saved).selection, { machine: 'local', workspace: '', tab: 't1', pane: '' });
  assert.deepEqual(initialSelection('?pane=p1', saved).selection, { machine: 'local', workspace: '', tab: '', pane: 'p1' });
  assert.deepEqual(initialSelection('', saved), { selection: request, restore: true });
  assert.deepEqual(initialSelection('?pane=p1', '{broken'), initialSelection('?pane=p1', null));
  assert.deepEqual(initialSelection('', 'null'), initialSelection('', null));
  assert.equal(initialSelection('', null).restore, false);
});

test('selection resolution infers missing parents but rejects missing or contradictory requested IDs', () => {
  const snapshot = host().snapshot!;
  for (const scope of [{ pane: 'p2' }, { tab: 't2' }, { workspace: 'w2' }]) {
    assert.deepEqual(resolveSelection({ machine: 'local', workspace: '', tab: '', pane: '', ...scope }, snapshot), { selection: request, terminal: 'terminal2' });
  }
  const inconsistent = structuredClone(snapshot); inconsistent.tabs[1].workspace_id = 'w1';
  assert.equal(resolveSelection({ machine: 'local', workspace: '', tab: '', pane: 'p2' }, inconsistent), undefined);
  for (const change of [{ workspace: 'w1' }, { tab: 't1' }, { pane: 'gone' }, { workspace: 'gone' }]) assert.equal(resolveSelection({ ...request, ...change }, snapshot), undefined);
});

test('restoration requires fresh validation and matching cached terminal identity', async () => {
  const native = host().snapshot!; const cached = host(); cached.snapshot!.panes[1].terminal_id = 'old-terminal';
  let done!: (value: typeof native) => void; let reads = 0;
  const restoration = new SelectionRestoration(request, () => { reads++; return new Promise(resolve => { done = resolve; }); }, () => {});
  assert.equal(restoration.update(cached), undefined); assert.equal(restoration.update(cached), undefined); assert.equal(reads, 1);
  done(native); await new Promise(resolve => setImmediate(resolve));
  assert.equal(restoration.update(cached), undefined); assert.match(restoration.message, /Waiting for native/);
  cached.snapshot = native;
  assert.deepEqual(restoration.update(cached), request); assert.equal(restoration.active, false);
});

test('missing targets and offline or unknown hosts never resolve to another pane', async () => {
  let reads = 0;
  const restoration = new SelectionRestoration({ ...request, pane: 'gone' }, async () => { reads++; return host().snapshot!; }, () => {});
  assert.equal(restoration.update(undefined), undefined);
  assert.equal(restoration.update({ ...host(), connection: 'offline' }), undefined);
  const disabled = host(); disabled.machine.enabled = false; assert.equal(restoration.update(disabled), undefined); assert.equal(reads, 0);
  restoration.update(host()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(restoration.update(host()), undefined); assert.equal(restoration.active, true); assert.match(restoration.message, /unavailable/);
  restoration.cancel(); assert.equal(restoration.active, false);
});

test('new navigation and endpoint replacement fence delayed restoration replies', async () => {
  for (const replace of [false, true]) {
    let done!: (value: NonNullable<HostView['snapshot']>) => void;
    const restoration = new SelectionRestoration(request, () => new Promise(resolve => { done = resolve; }), () => {});
    restoration.update(host());
    const replacement = host(); replacement.machine = { ...replacement.machine, target: 'another-host', session: 'another-session' };
    if (replace) restoration.update(replacement); else restoration.cancel();
    done(host().snapshot!); await new Promise(resolve => setImmediate(resolve));
    assert.equal(restoration.update(replace ? replacement : host()), undefined);
    if (replace) assert.match(restoration.message, /endpoint changed/); else assert.equal(restoration.active, false);
  }
});

test('a changed terminal or populated empty scope is revalidated while waiting for cache convergence', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  for (const empty of [false, true]) {
    const cached = host(); let reads = 0;
    const initial = empty ? emptySnapshot() : structuredClone(cached.snapshot!);
    if (!empty) cached.snapshot!.panes[1].terminal_id = 'replacement';
    const target = empty ? { machine: 'local', workspace: '', tab: '', pane: '' } : request;
    const restoration = new SelectionRestoration(target, async () => ++reads === 1 ? initial : cached.snapshot!, () => {});
    restoration.update(cached); await new Promise(resolve => setImmediate(resolve));
    assert.equal(restoration.update(cached), undefined);
    context.mock.timers.tick(2000); restoration.update(cached); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2); assert.deepEqual(restoration.update(cached), resolveSelection(target, cached.snapshot!)!.selection);
  }
});
