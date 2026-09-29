/** Begin the clipboard operation inside the gesture, before the native read resolves. */
export function writeTerminalClipboard(text: Promise<string>): Promise<void> {
  void text.catch(() => {});
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const blob = text.then(value => new Blob([value], { type: 'text/plain' }));
      void blob.catch(() => {});
      return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    }
    if (navigator.clipboard?.writeText) return text.then(value => navigator.clipboard.writeText(value));
    return Promise.reject(new Error('Clipboard requires a secure browser connection.'));
  } catch (error) { return Promise.reject(error); }
}
