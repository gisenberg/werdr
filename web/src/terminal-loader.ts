let ghostty: Promise<typeof import('ghostty-web')> | undefined;
export function loadGhostty() {
  return ghostty ??= import('ghostty-web').then(async library => { await library.init(); return library; }).catch(error => { ghostty = undefined; throw error; });
}
