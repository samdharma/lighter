// LRU cache keyed by page number. On overflow, evicts the entry farthest
// from `focus` (the page currently on screen), so fast flings keep the
// pages the reader is most likely to revisit.
export class PageCache<T> {
  private entries = new Map<number, T>();
  private capacity: number;
  private destroy: (value: T) => void;

  constructor(capacity: number, destroy: (value: T) => void = () => undefined) {
    this.capacity = capacity;
    this.destroy = destroy;
  }

  get size(): number {
    return this.entries.size;
  }

  has(page: number): boolean {
    return this.entries.has(page);
  }

  get(page: number): T | undefined {
    const value = this.entries.get(page);
    if (value !== undefined) {
      this.entries.delete(page);
      this.entries.set(page, value);
    }
    return value;
  }

  set(page: number, value: T, focus: number): void {
    if (this.entries.has(page)) this.entries.delete(page);
    this.entries.set(page, value);
    while (this.entries.size > this.capacity) {
      let victim = -1;
      let farthest = -1;
      for (const key of this.entries.keys()) {
        const distance = Math.abs(key - focus);
        if (distance > farthest) {
          farthest = distance;
          victim = key;
        }
      }
      if (victim < 0) break;
      const evicted = this.entries.get(victim);
      this.entries.delete(victim);
      if (evicted !== undefined) this.destroy(evicted);
    }
  }

  clear(): void {
    for (const value of this.entries.values()) this.destroy(value);
    this.entries.clear();
  }
}
