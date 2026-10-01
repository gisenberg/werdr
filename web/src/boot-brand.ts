// The shared wmux boot scenes name their program WMUX. WERDR is one character
// longer, so each substitution absorbs that character into the next column
// filler on the line, keeping directory listings and dotted status columns
// on the machine's native grid.
const filler = / {2,}|\.{3,}/;

export const brandBootText = (text: string): string => text.split('\n').map(line => {
  let branded = line;
  for (let index = branded.search(/WMUX|wmux/); index >= 0; index = branded.search(/WMUX|wmux/)) {
    const name = branded.startsWith('WMUX', index) ? 'WERDR' : 'werdr';
    branded = branded.slice(0, index) + name + branded.slice(index + 4);
    const end = index + name.length;
    const padding = branded.slice(end).search(filler);
    if (padding >= 0) branded = branded.slice(0, end + padding) + branded.slice(end + padding + 1);
  }
  return branded;
}).join('\n');
