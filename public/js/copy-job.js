/**
 * Copy engine. Copies a selection of Drive files and folders into
 * "Drive Pro/<destination>" in the user's account:
 *   - folders are walked recursively (optionally recreating their structure),
 *   - up to `concurrency` requests run in parallel,
 *   - every failure is recorded with its destination so it can be retried,
 *   - errors that make further work pointless (full Drive, expired login) stop the job.
 *
 * Emits a "change" event whenever progress changes. No DOM access (unit tested).
 */
import { TaskPool } from './lib/pool.js';

const FATAL_CODES = new Set(['storage_full', 'missing_token', 'invalid_token', 'session_expired', 'user_blocked']);

/**
 * @typedef {{ id: string, name: string, kind: 'file'|'folder', targetId?: string, resourceKey?: string, size?: number|null, mimeType?: string, targetMimeType?: string }} DriveItem
 * @typedef {{ item: DriveItem, parentId: string }} CopyTask
 * @typedef {{ key: string, item: DriveItem, status: 'running'|'done'|'failed'|'skipped', message?: string, link?: string }} LogEntry
 */

export class CopyJob extends EventTarget {
  /**
   * @param {import('./api.js').ApiClient} api
   * @param {{ items?: DriveItem[], tasks?: CopyTask[], destination?: {id: string, link: string, name?: string},
   *           destinationPath?: string, keepStructure?: boolean, concurrency?: number }} options
   */
  constructor(api, { items = [], tasks = [], destination = null, destinationPath = '', keepStructure = true, concurrency = 4 }) {
    super();
    this.api = api;
    this.items = items;
    this.initialTasks = tasks;
    this.destination = destination;
    this.destinationPath = destinationPath;
    this.keepStructure = keepStructure;
    this.pool = new TaskPool(concurrency);

    this.status = 'idle'; // idle | running | done | cancelled | failed
    this.error = null;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.stats = { files: 0, folders: 0, copied: 0, failed: 0, skipped: 0, foldersDone: 0, bytesTotal: 0, bytesCopied: 0 };
    /** @type {Map<string, LogEntry>} */
    this.log = new Map();
    /** @type {CopyTask[]} */
    this.failures = [];
    this.warnings = [];
    this.visited = new Set();
    this.seq = 0;
  }

  get isRunning() {
    return this.status === 'running';
  }

  get progress() {
    const s = this.stats;
    const total = s.files + s.folders;
    if (!total) return 0;
    return (s.copied + s.failed + s.skipped + s.foldersDone) / total;
  }

  async run() {
    this.status = 'running';
    this.startedAt = Date.now();
    this.emit();

    try {
      if (!this.destination) this.destination = await this.api.ensureFolder({ path: this.destinationPath });
    } catch (err) {
      return this.finish('failed', err);
    }

    for (const item of this.items) this.schedule(item, this.destination.id);
    for (const task of this.initialTasks) this.schedule(task.item, task.parentId);

    await this.pool.onIdle();
    return this.finish(this.error ? 'failed' : this.pool.cancelled ? 'cancelled' : 'done', this.error);
  }

  cancel() {
    if (!this.isRunning || this.pool.cancelled) return;
    this.pool.cancel();
    this.emit();
  }

  /** A new job that re-attempts every failed task into the same destination folders. */
  retryFailed(concurrency) {
    return new CopyJob(this.api, {
      tasks: this.failures.map((f) => ({ item: f.item, parentId: f.parentId })),
      destination: this.destination,
      keepStructure: this.keepStructure,
      concurrency: concurrency ?? this.pool.concurrency,
    });
  }

  // ------------------------------------------------------------------ internals

  finish(status, error = null) {
    this.status = status;
    this.error = error;
    this.finishedAt = Date.now();
    this.emit();
    return this;
  }

  schedule(item, parentId) {
    if (this.pool.cancelled) return;
    if (item.kind === 'folder') {
      this.stats.folders++;
      this.pool.add(() => this.copyFolder(item, parentId));
    } else {
      this.stats.files++;
      this.stats.bytesTotal += Number(item.size) || 0;
      this.pool.add(() => this.copyFile(item, parentId));
    }
    this.emit();
  }

  async copyFolder(item, parentId) {
    const sourceId = item.targetId || item.id;
    const key = this.track(item, 'running');
    if (this.visited.has(sourceId)) {
      // A shortcut pointing back to an ancestor would otherwise loop forever.
      this.stats.foldersDone++;
      return this.update(key, 'skipped', 'התיקייה כבר הועתקה במסגרת הפעולה הזו');
    }
    this.visited.add(sourceId);

    try {
      const target = this.keepStructure ? await this.api.ensureFolder({ name: item.name, parentId }) : { id: parentId };
      const listing = await this.api.listFolder(sourceId, item.resourceKey);
      if (listing.truncated) this.warnings.push(`בתיקייה "${item.name}" יש יותר מדי פריטים – הועתקו רק הראשונים.`);
      for (const child of listing.files || []) this.schedule(child, target.id);
      this.stats.foldersDone++;
      this.update(key, 'done', `${listing.files?.length ?? 0} פריטים`, target.link);
    } catch (err) {
      this.stats.foldersDone++;
      this.fail(key, item, parentId, err);
    }
  }

  async copyFile(item, parentId) {
    if (this.pool.cancelled) return;
    const key = this.track(item, 'running');
    try {
      const result = await this.api.copyFile({
        fileId: item.targetId || item.id,
        resourceKey: item.resourceKey,
        targetFolderId: parentId,
        name: item.name,
      });
      this.stats.copied++;
      this.stats.bytesCopied += Number(item.size) || 0;
      this.update(key, 'done', undefined, result.newLink || result.webViewLink);
    } catch (err) {
      this.stats.failed++;
      this.fail(key, item, parentId, err);
    }
  }

  fail(key, item, parentId, err) {
    this.failures.push({ item, parentId, error: err });
    this.update(key, 'failed', err?.message || 'שגיאה לא ידועה');
    if (FATAL_CODES.has(err?.code) && !this.error) {
      this.error = err;
      this.pool.cancel();
    }
  }

  track(item, status) {
    const key = `${item.id}:${++this.seq}`;
    this.log.set(key, { key, item, status });
    this.emit();
    return key;
  }

  update(key, status, message, link) {
    const entry = this.log.get(key);
    if (entry) Object.assign(entry, { status, message, link });
    this.emit();
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }
}
