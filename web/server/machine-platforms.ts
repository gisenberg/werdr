import { readFile } from 'node:fs/promises';
import type { Machine } from '../shared/fleet.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

interface PlatformRecord { id: string; target: string; session: string; platform: 'windows' | 'posix' }
let records: PlatformRecord[] = [];
let storePath: string | undefined;
const runtime = JSON.parse(await readFile(new URL('../../werdr/runtime.json', import.meta.url), 'utf8'));
if (typeof runtime.version !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(runtime.version)) throw new Error('Invalid pinned runtime version');
export const managedWindowsBinary = `%LOCALAPPDATA%\\werdr\\herdr\\${runtime.version}\\herdr.exe`;
export async function initializePlatforms(path: string) {
  storePath = path;
  const data = await readPrivateJson(path, 128 * 1024) as any;
  if (data === undefined) { records = []; return; }
  if (data.version !== 1 || !Array.isArray(data.machines) || data.machines.length > 128 || data.machines.some((record: any) => !record || !/^[a-f0-9]{32}$/.test(record.id) || typeof record.target !== 'string' || record.target.length > 1024 || typeof record.session !== 'string' || !['windows', 'posix'].includes(record.platform))) throw new Error('Invalid machine platform store');
  records = data.machines;
}
export function withPlatform(machine: Machine): Machine {
  const record = records.find(record => record.id === machine.id && record.target === machine.target && record.session === machine.session);
  return record ? { ...machine, platform: record.platform } : machine;
}
// Called under the machine-management queue, before publishing new native entries.
export async function savePlatform(machine: Machine, platform: PlatformRecord['platform'], currentIds: Set<string>) {
  if (!storePath || !machine.target || !machine.session) throw new Error('Machine platform store unavailable');
  const next = records.filter(record => record.id !== machine.id && currentIds.has(record.id));
  next.push({ id: machine.id, target: machine.target, session: machine.session, platform });
  await writePrivateJson(storePath, { version: 1, machines: next }); records = next;
}
