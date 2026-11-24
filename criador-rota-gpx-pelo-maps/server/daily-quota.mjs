import { DurableObject } from 'cloudflare:workers';

const LIMIT = 20;
const DAY_MS = 86_400_000;
const STORAGE_KEY = 'daily';

export class DailyQuota extends DurableObject {
  async take() {
    const storage = this.ctx.storage;
    const now = Date.now();
    const resetAt = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    const previous = storage.kv.get(STORAGE_KEY);
    const count = previous?.resetAt === resetAt ? previous.count : 0;
    if (count >= LIMIT) return { allowed: false, remaining: 0, resetAt };

    // The read and increment are synchronous within this IP's single object.
    storage.kv.put(STORAGE_KEY, { count: count + 1, resetAt });
    if (count === 0) await storage.setAlarm(resetAt);
    return { allowed: true, remaining: LIMIT - count - 1, resetAt };
  }

  async alarm() {
    const storage = this.ctx.storage;
    const entry = storage.kv.get(STORAGE_KEY);
    if (entry && entry.resetAt <= Date.now()) storage.kv.delete(STORAGE_KEY);
  }
}
