import { publicId } from './herdr.ts';
import { ManagementError } from './machine-management.ts';
function optionalText(value: unknown, name: string, max = 4096) {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\0\r\n]/.test(value)) throw new ManagementError(`Invalid ${name}.`);
  return { [name]: value };
}
export function worktreeAction(value: Record<string, unknown>) {
  const method = String(value.action);
  if (!['worktree.list', 'worktree.create', 'worktree.open', 'worktree.remove'].includes(method)) throw new ManagementError('Unsupported worktree action.');
  if (value.trust !== undefined && typeof value.trust !== 'boolean') throw new ManagementError('Invalid repository trust.');
  const trust = { trust_repository: value.trust === true };
  if (method === 'worktree.remove') {
    if (value.force !== undefined && typeof value.force !== 'boolean') throw new ManagementError('Invalid force option.');
    return { method, params: { workspace_id: publicId(value.id), force: value.force === true, ...trust } };
  }
  const cwd = optionalText(value.cwd, 'cwd');
  if (!Object.keys(cwd).length && value.id === undefined) throw new ManagementError('Choose a workspace or enter a repository path on this host.');
  const source = Object.keys(cwd).length ? cwd : { workspace_id: publicId(value.id) };
  if (method === 'worktree.list') return { method, params: { ...source, ...trust } };
  const path = optionalText(value.path, 'path'), branch = optionalText(value.branch, 'branch', 256), label = optionalText(value.label, 'label', 256);
  if (method === 'worktree.open' && Object.keys(path).length === Object.keys(branch).length) throw new ManagementError('Choose exactly one worktree path or branch.');
  return { method, params: { ...source, ...trust, ...path, ...branch, ...label, ...(method === 'worktree.create' ? optionalText(value.base, 'base', 256) : {}), focus: true } };
}
