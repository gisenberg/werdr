export interface WorkspacePreview { machine: string; workspace: string }

/** Client-only highlight. Moving it never changes the active terminal selection. */
export class NavigatePreview {
  private value: WorkspacePreview | undefined;
  get target(): Readonly<WorkspacePreview> | undefined { return this.value; }

  enter(machine: string, workspace: string) { this.value = { machine, workspace }; }
  clear() { this.value = undefined; }

  /** Validate against all workspaces, including rows hidden by collapsed groups. */
  reconcile(machine: string, workspaces: readonly string[], focused: string) {
    if (!this.value) return;
    if (this.value.machine !== machine) { this.clear(); return; }
    if (!workspaces.includes(this.value.workspace)) {
      this.value = { machine, workspace: workspaces.includes(focused) ? focused : '' };
    }
  }

  /** Desktop wraps rendered rows; mobile clamps the expanded workspace list. */
  move(entries: readonly string[], direction: 1 | -1, mobile: boolean) {
    if (!this.value || !entries.length) return;
    const current = Math.max(0, entries.indexOf(this.value.workspace));
    const index = mobile
      ? Math.max(0, Math.min(entries.length - 1, current + direction))
      : (current + direction + entries.length) % entries.length;
    this.value = { machine: this.value.machine, workspace: entries[index] };
  }

  /** Resolve before ending Navigate mode so callers can retain the stable target. */
  confirm(workspaces: readonly string[]): WorkspacePreview | undefined {
    return this.value && workspaces.includes(this.value.workspace) ? { ...this.value } : undefined;
  }

  indexed(entries: readonly string[], index: number): WorkspacePreview | undefined {
    if (!this.value || !Number.isInteger(index) || index < 0 || index > 8 || index >= entries.length) return;
    return { machine: this.value.machine, workspace: entries[index] };
  }
}
