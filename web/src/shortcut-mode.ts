import type { NativeCommand } from '../shared/commands';
import { parseChord, type Chord, compileShortcuts, matchesChord, type ShortcutKey, type Shortcuts, type ShortcutAction, type Binding } from '../shared/shortcuts';
export type ShortcutResult = { consume: boolean; forward?: boolean; action?: ShortcutAction; command?: string; index?: number; navigate?: 'confirm' };
/** Pure client input mode. No terminal bytes or server operations originate here. */
export class ShortcutMode {
  mode: 'terminal' | 'prefix' | 'resize' | 'navigate' = 'terminal';
  private compiled: ReturnType<typeof compileShortcuts>;
  private commands: { chord: Chord; id: string }[] = [];
  private held = new Map<string, Binding | undefined>();
  constructor(value: Shortcuts) { this.compiled = compileShortcuts(value); }
  update(value: Shortcuts) { this.compiled = compileShortcuts(value); this.reset(); }
  updateCommands(commands: readonly NativeCommand[]) {
    this.commands = commands.flatMap(command => command.binding_labels.flatMap(label => {
      try { return [{ chord: parseChord(label), id: command.command_id }]; } catch { return []; }
    }));
    this.reset();
  }
  private resolve(event: ShortcutKey, eligible: (binding: Binding) => boolean, customEligible: (chord: Chord) => boolean) {
    const ordinary = this.compiled.bindings.find(binding => binding.index === undefined && eligible(binding) && matchesChord(binding.chord, event));
    if (ordinary) return { binding: ordinary };
    // Endpoint and browser prefixes can differ; reserve the effective browser prefix.
    const custom = !matchesChord(this.compiled.prefix, event) && this.commands.find(command => customEligible(command.chord) && matchesChord(command.chord, event));
    return custom ? { command: custom.id } : { binding: this.compiled.bindings.find(binding => binding.index !== undefined && eligible(binding) && matchesChord(binding.chord, event)) };
  }
  reset() { this.mode = 'terminal'; for (const code of this.held.keys()) this.held.set(code, undefined); }
  blur() { this.reset(); this.held.clear(); }
  owns(code: string) { return this.held.has(code); }
  up(code: string) { const consumed = this.held.has(code); this.held.delete(code); return consumed; }
  down(event: ShortcutKey, copy = false): ShortcutResult {
    if (event.isComposing || event.keyCode === 229 || ['Dead', 'Process', 'Unidentified'].includes(event.key) || event.getModifierState('AltGraph')) { this.reset(); return { consume: false }; }
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock'].includes(event.key)) return { consume: false };
    if (event.repeat && this.held.has(event.code)) {
      const binding = this.held.get(event.code);
      return binding && (binding.action.startsWith('resize_pane_') && this.mode === 'resize' || binding.action.startsWith('navigate_') && this.mode === 'navigate') ? { consume: true, action: binding.action } : { consume: true };
    }
    const consume = (binding?: Binding): ShortcutResult => { if (!event.repeat) this.held.set(event.code, binding); return { consume: true, action: binding?.action, index: binding?.index }; };
    if (this.mode === 'navigate') {
      if (event.key === 'Escape' || matchesChord(this.compiled.prefix, event)) { this.reset(); return consume(); }
      if (event.repeat) return { consume: true };
      const navigation = this.compiled.navigate.find(binding => binding.action.startsWith('navigate_workspace_') && matchesChord(binding.chord, event));
      if (navigation) return consume(navigation);
      const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      if (plain && event.key === 'Enter') { consume(); return { consume: true, navigate: 'confirm' }; }
      if (plain && /^[1-9]$/.test(event.key)) return consume({ chord: this.compiled.prefix, action: 'switch_workspace', index: Number(event.key) - 1 });
      if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab') {
        this.reset(); return consume({ chord: this.compiled.prefix, action: event.shiftKey ? 'cycle_pane_previous' : 'cycle_pane_next' });
      }
      if (plain && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return consume({ chord: this.compiled.prefix, action: event.key === 'ArrowLeft' ? 'navigate_pane_left' : 'navigate_pane_right' });
      const pane = this.compiled.navigate.find(binding => binding.action.startsWith('navigate_pane_') && matchesChord(binding.chord, event));
      if (pane) return consume(pane);
      const { binding, command } = this.resolve(event, binding => (binding.chord.prefix || binding.action === 'command_palette') && !binding.action.startsWith('focus_pane_'), chord => chord.prefix);
      if (command) { this.reset(); consume(); return { consume: true, command }; }
      if (binding) { this.mode = binding.index !== undefined ? 'navigate' : binding.action === 'resize_mode' ? 'resize' : binding.action === 'workspace_picker' ? 'navigate' : 'terminal'; return consume(binding); }
      return consume();
    }
    if (this.mode === 'resize') {
      if (['Escape', 'Enter'].includes(event.key) || this.compiled.bindings.some(binding => binding.action === 'resize_mode' && matchesChord(binding.chord, event))) { this.reset(); return consume(); }
      const direction = ({ h: 'left', j: 'down', k: 'up', l: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up', ArrowRight: 'right' } as Record<string, string>)[event.key];
      return consume(direction ? { chord: this.compiled.prefix, action: `resize_pane_${direction}` as ShortcutAction } : undefined);
    }
    if (event.repeat && this.mode === 'prefix') return { consume: true };
    const wasPrefix = this.mode === 'prefix';
    if (wasPrefix) {
      this.reset();
      if (matchesChord(this.compiled.prefix, event)) { if (copy) { consume(); return { consume: true, forward: true }; } return { consume: false }; }
      if (event.key === 'Escape') return consume();
    }
    const { binding, command } = this.resolve(event, binding => binding.chord.prefix === wasPrefix && (!copy || wasPrefix || binding.action === 'command_palette'), chord => chord.prefix === wasPrefix && (!copy || wasPrefix));
    if (command) { if (event.repeat) return { consume: true }; consume(); return { consume: true, command }; }
    if (binding) { if (event.repeat) return { consume: true }; if (binding.action === 'resize_mode') this.mode = 'resize'; return consume(binding); }
    if (wasPrefix) return consume();
    if (matchesChord(this.compiled.prefix, event)) { if (!event.repeat) this.mode = 'prefix'; return consume(); }
    return { consume: false };
  }
}
