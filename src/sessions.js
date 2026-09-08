"use strict";

function redisSessionStore(client, onFailure = () => {}) {
  async function run(operation) {
    try { return await operation(); }
    catch (error) { onFailure(); throw error; }
  }
  const prefix = "tg:session:";
  return {
    get: (key) => run(async () => {
      const raw = await client.get(prefix + key);
      if (raw === null) return undefined;
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored session");
      return value;
    }),
    set: (key, value) => run(async () => {
      if (await client.set(prefix + key, JSON.stringify(value)) !== "OK") throw new Error("Session write failed");
    }),
    delete: (key) => run(() => client.del(prefix + key)),
  };
}

function sessions(store) {
  const pending = new Map();
  return async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();
    const key = `${ctx.from.id}:${ctx.chat.id}`;
    // Serialize a user's updates, and never cache a failed Redis read.
    const task = (pending.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const stored = await store.get(key);
      const record = stored?.format === "railway-session-v1" ? stored : { session: stored, updates: [] };
      if (!Array.isArray(record.updates) || !record.updates.every(Number.isSafeInteger)) {
        throw new Error("Invalid stored update history");
      }
      const updateId = ctx.update.update_id;
      if (record.updates.includes(updateId)) return;
      ctx.session = structuredClone(record.session);
      await next();
      // Commit session state and retry history together; Telegram replies are not transactional.
      await store.set(key, {
        format: "railway-session-v1",
        session: ctx.session ?? null,
        updates: [...record.updates, updateId].slice(-100),
      });
    });
    pending.set(key, task);
    try { await task; }
    finally { if (pending.get(key) === task) pending.delete(key); }
  };
}

module.exports = { redisSessionStore, sessions };
