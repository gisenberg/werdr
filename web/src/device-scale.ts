// Browser zoom and moving a window to a monitor with another scale change
// devicePixelRatio without resizing the terminal's container. A resolution
// query matches only the current ratio, so re-arm it after every change; the
// window resize event covers browsers that zoom without firing it.
export function watchDeviceScale(changed: (devicePixelRatio: number) => void): () => void {
  let query: MediaQueryList | undefined;
  const notify = () => { changed(window.devicePixelRatio || 1); arm(); };
  const arm = () => {
    query?.removeEventListener('change', notify);
    query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query?.addEventListener('change', notify);
  };
  const resized = () => changed(window.devicePixelRatio || 1);
  arm();
  window.addEventListener('resize', resized);
  return () => { query?.removeEventListener('change', notify); window.removeEventListener('resize', resized); };
}
