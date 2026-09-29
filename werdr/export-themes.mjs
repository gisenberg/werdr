import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/app/state.rs', root), 'utf8');
const config = await readFile(new URL('src/config/theme.rs', root), 'utf8');
const names = [...config.match(/THEME_NAMES:.*?= &\[([\s\S]*?)\];/)[1].matchAll(/"([\w-]+)"/g)].map(match => match[1]);
const themes = {};
for (const name of names) {
  const method = name.replaceAll('-', '_');
  const body = source.match(new RegExp(`pub fn ${method}\\(\\) -> Self \\{\\s*Self \\{([\\s\\S]*?)\\n        \\}\\n    \\}`))?.[1];
  if (!body) throw new Error(`Cannot extract native theme ${name}`);
  const tokens = {};
  for (const match of body.matchAll(/(\w+): Color::(Rgb\(\d+, \d+, \d+\)|\w+),/g)) {
    tokens[match[1]] = match[2].startsWith('Rgb') ? '#' + match[2].match(/\d+/g).map(value => Number(value).toString(16).padStart(2, '0')).join('') : match[2];
  }
  if (Object.keys(tokens).length !== 19) throw new Error(`Incomplete native theme ${name}`);
  themes[name] = tokens;
}
const output = JSON.stringify(themes, null, 2) + '\n';
const target = new URL('web/shared/native-themes.json', root);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Native theme data is stale; run node werdr/export-themes.mjs');
} else await writeFile(target, output);
