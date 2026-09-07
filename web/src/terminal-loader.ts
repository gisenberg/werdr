async function initialize() {
  const library = await import('ghostty-web'); await library.init();
  class Terminal extends library.Terminal { createInputEncoder() { return this.ghostty.createKeyEncoder(); } }
  return { ...library, Terminal };
}
let ghostty: ReturnType<typeof initialize> | undefined;
export function loadGhostty() {
  return ghostty ??= initialize().catch(error => { ghostty = undefined; throw error; });
}
