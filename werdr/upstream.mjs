#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const [action = 'status', number] = process.argv.slice(2);
try {
  if (!['status', 'prepare-sync', 'fetch-pr', 'prepare-pr'].includes(action)) throw new Error('Usage: node werdr/upstream.mjs status|prepare-sync|fetch-pr N|prepare-pr N');
  if (action.endsWith('-pr') && !/^[1-9][0-9]*$/.test(number || '')) throw new Error('Provide a positive PR number');
  if (action === 'status') {
    console.log(`Branch: ${git('branch', '--show-current')}`);
    console.log(`Upstream: ${git('remote', 'get-url', 'upstream')}`);
    console.log(`Local HEAD: ${git('rev-parse', 'HEAD')}`);
    console.log(`Cached upstream/master: ${git('rev-parse', 'upstream/master')}`);
    console.log(`Local-only / upstream-only commits: ${git('rev-list', '--left-right', '--count', 'HEAD...upstream/master')}`);
    console.log('Status uses cached refs. prepare-sync fetches current upstream before preparing a merge.');
  } else {
    if (action.startsWith('prepare-')) {
      if (git('status', '--porcelain')) throw new Error('Commit or stash local changes before preparing an upstream merge');
      const branch = git('branch', '--show-current');
      if (!branch || ['main', 'master'].includes(branch)) throw new Error('Switch to a topic branch before preparing an upstream merge');
      const merge = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd });
      if (merge.status === 0) throw new Error('Finish or abort the existing merge first');
      if (merge.status !== 1) throw new Error('Could not inspect merge state');
    }
    if (action.endsWith('-pr')) {
      const metadata = JSON.parse(execFileSync('gh', ['pr', 'view', number, '--repo', 'herdrdev/herdr', '--json', 'state,headRefOid,title'], { cwd, encoding: 'utf8' }));
      if (action === 'prepare-pr' && metadata.state !== 'OPEN') throw new Error(`PR #${number} is ${metadata.state}. Use prepare-sync for merged work instead of replaying its pre-merge commits.`);
      const ref = `refs/remotes/upstream/pr/${number}`;
      git('fetch', 'upstream', `+refs/pull/${number}/head:${ref}`);
      const sha = git('rev-parse', ref);
      if (sha !== metadata.headRefOid) throw new Error('PR changed during fetch. Re-run to inspect its current head.');
      console.log(`PR #${number}: ${metadata.title}\nPinned head: ${sha}\nInspect: git show --stat ${sha}`);
      if (action === 'prepare-pr') prepare(sha);
    } else {
      git('fetch', 'upstream', '+refs/heads/master:refs/remotes/upstream/master');
      prepare(git('rev-parse', 'upstream/master'));
    }
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
function prepare(sha) {
  execFileSync('git', ['merge', '--no-ff', '--no-commit', sha], { cwd, stdio: 'inherit' });
  console.log('Review git diff --cached, run the applicable checks, and commit the merge when ready.');
  console.log('To abandon an in-progress merge: git merge --abort. Nothing was pushed.');
}
