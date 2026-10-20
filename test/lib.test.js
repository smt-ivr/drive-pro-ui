import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, parseLinks } from '../public/js/lib/links.js';
import { fileType, formatBytes, joinAnd, plural, sortItems } from '../public/js/lib/format.js';
import { TaskPool } from '../public/js/lib/pool.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUv';

test('parseLink recognizes folders, files and bare ids', () => {
  assert.deepEqual(parseLink(`https://drive.google.com/drive/folders/${ID}?usp=sharing`), { raw: `https://drive.google.com/drive/folders/${ID}?usp=sharing`, id: ID, hint: 'folder' });
  assert.equal(parseLink(`https://docs.google.com/spreadsheets/d/${ID}/edit`).hint, 'file');
  assert.equal(parseLink(`https://drive.google.com/open?id=${ID}`).id, ID);
  assert.equal(parseLink(ID).hint, 'unknown');
  assert.equal(parseLink('https://example.com'), null);
  assert.equal(parseLink(''), null);
});

test('parseLinks splits, de-duplicates and reports invalid tokens', () => {
  const text = `https://drive.google.com/file/d/${ID}/view\n  https://drive.google.com/file/d/${ID}/view , hello\nhttps://drive.google.com/drive/folders/${ID}x`;
  const { links, invalid } = parseLinks(text);
  assert.deepEqual(links.map((l) => l.id), [ID, `${ID}x`]);
  assert.deepEqual(invalid, ['hello']);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '—');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
});

test('plural (Hebrew)', () => {
  assert.equal(plural(1, 'קובץ אחד', 'קבצים'), 'קובץ אחד');
  assert.equal(joinAnd(['2 תיקיות', '6 קבצים']), '2 תיקיות ו-6 קבצים');
  assert.equal(joinAnd(['תיקייה אחת', 'קובץ אחד']), 'תיקייה אחת וקובץ אחד');
  assert.equal(joinAnd([0, '3 קבצים']), '3 קבצים');
  assert.equal(plural(3, 'קובץ', 'קבצים'), '3 קבצים');
});

test('fileType maps common mime types', () => {
  assert.equal(fileType('application/vnd.google-apps.folder').tone, 'folder');
  assert.equal(fileType('application/pdf').label, 'PDF');
  assert.equal(fileType('image/png').tone, 'image');
  assert.equal(fileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document').label, 'Word');
  assert.equal(fileType('application/x-whatever').tone, 'other');
  assert.equal(fileType(undefined).tone, 'other');
});

test('sortItems keeps folders first and sorts naturally', () => {
  const items = [
    { name: 'file 10', kind: 'file', size: 5 },
    { name: 'file 2', kind: 'file', size: 50 },
    { name: 'B', kind: 'folder' },
    { name: 'a', kind: 'folder' },
  ];
  assert.deepEqual(sortItems(items).map((i) => i.name), ['a', 'B', 'file 2', 'file 10']);
  assert.deepEqual(sortItems(items, 'size', 'desc').map((i) => i.name), ['a', 'B', 'file 2', 'file 10']);
  assert.deepEqual(sortItems(items, 'name', 'desc').map((i) => i.name), ['B', 'a', 'file 10', 'file 2']);
});

test('TaskPool respects concurrency, supports nested tasks and cancel', async () => {
  const pool = new TaskPool(2);
  let running = 0;
  let peak = 0;
  const done = [];
  const task = (id) => async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    done.push(id);
    if (id === 1) pool.add(task('child'));
  };
  [1, 2, 3, 4].forEach((i) => pool.add(task(i)));
  await pool.onIdle();
  assert.equal(peak, 2);
  assert.equal(done.length, 5);
  assert.ok(done.includes('child'));

  const p2 = new TaskPool(1);
  const ran = [];
  p2.add(async () => { ran.push('a'); p2.cancel(); });
  p2.add(async () => ran.push('b'));
  await p2.onIdle();
  assert.deepEqual(ran, ['a']);
});
