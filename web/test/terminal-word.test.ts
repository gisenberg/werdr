import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalWord, type WordCell } from '../src/terminal-word.ts';

function cells(text: string): WordCell[] {
  let column = 0;
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(({ segment }) => {
    const width = /[你好先跑界東京]/u.test(segment) ? 2 : 1;
    const cell = { text: segment, start: column, end: column + width - 1 }; column += width; return cell;
  });
}
function select(row: string, click: string, extra = 0) {
  const rendered = cells(row), index = row.indexOf(click);
  assert.ok(index >= 0);
  const column = cells(row.slice(0, index)).reduce((width, cell) => width + cell.end - cell.start + 1, 0) + extra;
  const range = terminalWord(rendered, column);
  return range && rendered.filter(cell => range.start <= cell.start && cell.end <= range.end).map(cell => cell.text).join('');
}

// Native-reference cases from src/app/actions.rs, double_click_word_bounds_cover_terminal_text.
test('double-click token rules match native URLs, quoted paths and command punctuation', () => {
  for (const [row, click, expected] of [
    ['see https://example.com/a-b_c?q=x@y.', 'example.com', 'https://example.com/a-b_c?q=x@y'],
    ['open "https://example.com/a,b;c?q=x";', 'example.com', 'https://example.com/a,b;c?q=x'],
    ['see https://en.wikipedia.org/wiki/Foo_(bar_(baz)),', 'wikipedia', 'https://en.wikipedia.org/wiki/Foo_(bar_(baz))'],
    ['see (https://example.com/a(b(c)d)))', 'example.com', 'https://example.com/a(b(c)d)'],
    ['open ./src/app/actions.rs:795', 'actions', './src/app/actions.rs:795'],
    ['edit src/app/actions.rs,then', 'actions', 'src/app/actions.rs'],
    ['cat "/tmp/build output/log.txt"', 'output', '/tmp/build output/log.txt'],
    ["cat '/Users/me/Library/Application Support/app/config.json'", 'Support', '/Users/me/Library/Application Support/app/config.json'],
    ['echo 你好-world done', '好', '你好-world'],
    ['先跑 cargo test', 'cargo', 'cargo'],
    ['export PATH=$HOME/.cargo/bin:$PATH', '$HOME', 'PATH=$HOME/.cargo/bin:$PATH'],
    ['git checkout feature/foo-bar_baz', 'foo', 'feature/foo-bar_baz'],
    ['refs #123 and @owner/name', 'owner', '@owner/name'],
    ['cargo test --package=herdr', '--package', '--package=herdr'],
    ['cargo test app::actions::tests', 'app::', 'app::actions::tests'],
    ['image ghcr.io/org/app:latest', 'ghcr', 'ghcr.io/org/app:latest'],
    ['ERROR [worker-1] request_id=abc-123', 'worker', 'worker-1'],
    ['tmux|newhoo|fixhoo', 'newhoo', 'newhoo'],
    ['render_status_line(app, area)', 'app', 'app'],
    ['println!("hi")', 'println', 'println'],
    ['( master)$', 'master', 'master'],
    ['regex foo$', 'foo', 'foo$'],
  ]) assert.equal(select(row, click), expected, row);
});

test('word selection honors display cells and never selects surrounding delimiters', () => {
  assert.equal(select('echo 你好-world done', '好', 1), '你好-world');
  assert.equal(select('界 áb done', 'á'), 'áb');
  assert.equal(select('h́ttps://example.test/a,b;', 'example'), 'h́ttps://example.test/a');
  assert.equal(select('open "/tmp/build output/log.txt"', ' output', 1), '/tmp/build output/log.txt');
  for (const [row, click] of [['alpha,beta', ','], ['alpha;beta', ';'], ['a|b', '|'], ['render(app)', '('], ['alpha beta', ' '], ['"quoted"', '"'], ['https://example.com/a).', ')']]) assert.equal(select(row, click), undefined, row);
  assert.equal(terminalWord([], 0), undefined);
  assert.equal(terminalWord(cells('abc'), 5), undefined);
});
