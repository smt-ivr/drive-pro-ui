import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopyJob } from '../public/js/copy-job.js';

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** In-memory fake of the Drive Pro API. `tree` maps folder ids to children. */
function fakeApi(tree, { failIds = new Set(), fatalIds = new Set() } = {}) {
  const calls = { ensure: [], copy: [], list: [] };
  let n = 0;
  return {
    calls,
    async ensureFolder(opts) {
      calls.ensure.push(opts);
      const id = `dest${++n}`;
      return { id, link: `https://drive.google.com/drive/folders/${id}`, name: opts.name || opts.path };
    },
    async listFolder(id) {
      calls.list.push(id);
      return { folderId: id, files: tree[id] || [] };
    },
    async copyFile(opts) {
      calls.copy.push(opts);
      if (fatalIds.has(opts.fileId)) throw new ApiError('full', 'storage_full');
      if (failIds.has(opts.fileId)) throw new ApiError('nope', 'forbidden');
      return { newLink: `https://drive.google.com/file/d/c_${opts.fileId}/view` };
    },
  };
}

const file = (id, size = 10) => ({ id, name: `${id}.txt`, kind: 'file', size });
const folder = (id) => ({ id, name: id, kind: 'folder' });

test('copies files and recursive folders, preserving structure', async () => {
  const api = fakeApi({ A: [file('a1'), folder('B')], B: [file('b1'), file('b2')] });
  const job = await new CopyJob(api, { items: [file('top'), folder('A')], destinationPath: 'Backup', concurrency: 3 }).run();

  assert.equal(job.status, 'done');
  assert.deepEqual(job.stats.copied, 4);
  assert.equal(job.stats.folders, 2);
  assert.equal(job.stats.bytesCopied, 40);
  assert.equal(job.progress, 1);
  assert.deepEqual(api.calls.ensure[0], { path: 'Backup' });

  const folderIds = Object.fromEntries(api.calls.ensure.slice(1).map((c, i) => [c.name, `dest${i + 2}`]));
  const parentOf = Object.fromEntries(api.calls.copy.map((c) => [c.fileId, c.targetFolderId]));
  assert.equal(parentOf.top, 'dest1');
  assert.equal(parentOf.a1, folderIds.A);
  assert.equal(parentOf.b1, folderIds.B);
  assert.equal(api.calls.ensure.find((c) => c.name === 'B').parentId, folderIds.A);
});

test('flattens when keepStructure is off', async () => {
  const api = fakeApi({ A: [file('a1'), folder('B')], B: [file('b1')] });
  const job = await new CopyJob(api, { items: [folder('A')], keepStructure: false }).run();
  assert.equal(api.calls.ensure.length, 1);
  assert.ok(api.calls.copy.every((c) => c.targetFolderId === 'dest1'));
  assert.equal(job.stats.copied, 2);
});

test('records failures and retries them into the same folders', async () => {
  const api = fakeApi({ A: [file('ok'), file('bad')] }, { failIds: new Set(['bad']) });
  const job = await new CopyJob(api, { items: [folder('A')] }).run();
  assert.equal(job.status, 'done');
  assert.equal(job.failures.length, 1);
  assert.equal(job.failures[0].item.id, 'bad');

  const failedParent = job.failures[0].parentId;
  api.calls.copy.length = 0;
  const retry = job.retryFailed();
  const ensureBefore = api.calls.ensure.length;
  await retry.run();
  assert.equal(api.calls.ensure.length, ensureBefore, 'retry reuses the destination');
  assert.deepEqual(api.calls.copy.map((c) => [c.fileId, c.targetFolderId]), [['bad', failedParent]]);
});

test('stops on fatal errors such as a full Drive', async () => {
  const items = Array.from({ length: 20 }, (_, i) => file(`f${i}`));
  const api = fakeApi({}, { fatalIds: new Set(['f0']) });
  const job = await new CopyJob(api, { items, concurrency: 1 }).run();
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'storage_full');
  assert.equal(api.calls.copy.length, 1);
});

test('cancel stops queued work', async () => {
  const items = Array.from({ length: 10 }, (_, i) => file(`f${i}`));
  const api = fakeApi({});
  const job = new CopyJob(api, { items, concurrency: 1 });
  job.addEventListener('change', () => {
    if (job.stats.copied === 2) job.cancel();
  });
  await job.run();
  assert.equal(job.status, 'cancelled');
  assert.ok(job.stats.copied < 10);
});

test('does not loop on folder shortcuts that point to an ancestor', async () => {
  const api = fakeApi({ A: [file('x'), { id: 'sc', name: 'loop', kind: 'folder', targetId: 'A' }] });
  const job = await new CopyJob(api, { items: [folder('A')] }).run();
  assert.equal(job.status, 'done');
  assert.deepEqual(api.calls.list, ['A']);
});

test('fails cleanly when the destination cannot be created', async () => {
  const api = fakeApi({});
  api.ensureFolder = async () => {
    throw new ApiError('no', 'forbidden');
  };
  const job = await new CopyJob(api, { items: [file('a')] }).run();
  assert.equal(job.status, 'failed');
  assert.equal(job.error.message, 'no');
});
