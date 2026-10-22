export class CommandQueue {
  constructor() {
    this.tail = Promise.resolve(); this.waiting = 0; this.generation = 0;
    this.reads = new Map(); this.active = null;
  }
  run(action, label = 'command') {
    // A read arriving after a command must observe that command's result.
    this.reads.clear();
    return this.enqueue(action, label);
  }
  read(key, action) {
    if (this.reads.has(key)) return this.reads.get(key);
    const result = this.enqueue(action, `read:${key}`).finally(() => {
      if (this.reads.get(key) === result) this.reads.delete(key);
    });
    this.reads.set(key, result);
    return result;
  }
  status() {
    return { waiting: this.waiting, active: this.active && {
      label: this.active.label, startedAt: new Date(this.active.startedAt).toISOString(),
      durationMs: Date.now() - this.active.startedAt,
    } };
  }
  enqueue(action, label) {
    this.waiting++;
    const result = this.tail.then(() => {
      this.active = { label, startedAt: Date.now() };
      return action();
    }).finally(() => { this.active = null; this.waiting--; this.generation++; });
    this.tail = result.catch(() => {});
    return result;
  }
}
