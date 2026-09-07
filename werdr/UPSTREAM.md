# Pulling changes from herdr

Keep `origin` pointed at your werdr fork and `upstream` pointed at `herdrdev/herdr`.
The upstream default branch is `master`.
The local upstream push URL may be set to `DISABLED` to prevent accidental publication there.
No helper pushes, commits, or changes your current branch automatically.

Check the cached divergence:

```sh
node werdr/upstream.mjs status
```

## Update the runtime

Begin from a clean checkout with completed web work committed.
Create a topic branch, then prepare an upstream merge:

```sh
git switch -c update/herdr
node werdr/upstream.mjs prepare-sync
```

The helper fetches upstream master and merges its exact fetched commit with `--no-ff --no-commit`.
Resolve conflicts, inspect `git diff --cached`, run upstream `just check` and the web checks, and commit the reviewed merge.
Use `git merge --abort` to abandon a merge that is still in progress.
Publish the topic branch to your fork and review it against your fork's default branch.

## Review or integrate an individual PR

Fetch and inspect a PR without merging:

```sh
node werdr/upstream.mjs fetch-pr 1234
git log --oneline HEAD..upstream/pr/1234
git diff HEAD...upstream/pr/1234
```

To prepare a merge of an open PR on a clean topic branch:

```sh
git switch -c integrate/herdr-pr-1234
node werdr/upstream.mjs prepare-pr 1234
```

The PR helper requires the GitHub CLI and verifies the fetched head against current PR metadata.
If the PR changes during fetch, it stops for a fresh inspection.
It refuses to prepare closed or merged PRs; use `prepare-sync` for merged work to avoid replaying pre-squash history.
PR #3670 is already integrated and must not be replayed.

An open PR may bring its base-branch ancestors with it.
Review the entire resulting diff rather than assuming the PR title describes every incoming change.
If upstream later squash-merges a PR you previously merged, review the subsequent upstream merge for duplicate or conflicting changes.
The helper does not pretend that differing Git histories are automatically equivalent.

Keep native fixes separate from browser changes so they can be reviewed or removed independently.
Do not rename upstream packages, bulk-reformat upstream files, or edit generated release metadata as part of web development.
