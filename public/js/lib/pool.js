/**
 * A small async task pool with bounded concurrency. Tasks may enqueue more tasks
 * while running (used for recursive folder copies). Pure logic (unit tested).
 */
export class TaskPool {
  /** @param {number} concurrency */
  constructor(concurrency = 4) {
    this.concurrency = Math.max(1, concurrency);
    this.queue = [];
    this.running = 0;
    this.cancelled = false;
    this.idleWaiters = [];
  }

  /** @param {() => Promise<void>} task */
  add(task) {
    if (this.cancelled) return;
    this.queue.push(task);
    this.pump();
  }

  get pending() {
    return this.queue.length;
  }

  /** Drops queued tasks; tasks already running are allowed to finish. */
  cancel() {
    this.cancelled = true;
    this.queue.length = 0;
    this.checkIdle();
  }

  /** Resolves once the queue is empty and nothing is running. */
  onIdle() {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(task)
        .catch((err) => console.error('Unhandled task error', err))
        .finally(() => {
          this.running--;
          this.pump();
          this.checkIdle();
        });
    }
  }

  checkIdle() {
    if (this.running === 0 && this.queue.length === 0) {
      const waiters = this.idleWaiters.splice(0);
      waiters.forEach((resolve) => resolve());
    }
  }
}
