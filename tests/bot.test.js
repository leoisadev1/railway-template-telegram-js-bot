"use strict";

// Isolated provider and Redis mocks only; no Discord/Telegram credentials or network calls.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { spawn } = require("node:child_process");
const { Telegram } = require("telegraf");
const { createApp, readConfig, validSecret } = require("../src/index");
const { redisSessionStore, sessions } = require("../src/sessions");

const host = "127.0.0.1";
const token = "1000000000:isolated_mock_not_a_real_token";
const secret = "isolated_mock_webhook_secret";
const baseEnv = { BOT_TOKEN: token, WEBHOOK_SECRET: secret, WEBHOOK_DOMAIN: "isolated.invalid", HOST: host, PORT: "0" };
const logger = { log() {}, warn() {}, error() {} };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeRedis extends EventEmitter {
  constructor(data = new Map()) { super(); this.data = data; this.status = "wait"; this.fail = null; this.disconnected = 0; }
  check(op, key = "") {
    if (this.status !== "ready" || this.fail?.(op, key)) throw new Error("isolated Redis outage");
  }
  async connect() { this.status = "ready"; this.check("connect"); }
  async ping() { this.check("ping"); return "PONG"; }
  async get(key) { this.check("get", key); return this.data.get(key) ?? null; }
  async set(key, value) { this.check("set", key); this.data.set(key, value); return "OK"; }
  async del(key) { this.check("del", key); return Number(this.data.delete(key)); }
  async quit() { this.status = "end"; }
  disconnect() { this.status = "end"; this.disconnected++; }
}

function fixture(t, options = {}) {
  const api = { calls: [], replies: [], url: "", identity: { id: 123, is_bot: true, username: "audit_bot", first_name: "Audit" } };
  t.mock.method(Telegram.prototype, "callApi", async function (method, payload) {
    api.calls.push({ method, payload });
    if (api.intercept) {
      const result = await api.intercept(method, payload);
      if (result !== undefined) return result;
    }
    if (method === "getMe") return api.identity;
    if (method === "setWebhook") { api.url = payload.url; return true; }
    if (method === "getWebhookInfo") return { url: api.url };
    if (method === "sendMessage") { api.replies.push(payload); return { message_id: api.replies.length, text: payload.text }; }
    assert.fail(`Unexpected isolated provider call: ${method}`);
  });
  t.mock.method(require("node:https"), "request", () => assert.fail("Provider network access is forbidden in isolated tests"));
  const redis = options.redis || new FakeRedis();
  let redisOptions;
  const app = createApp({
    env: { ...baseEnv, REDIS_URL: "redis://isolated.invalid:6379", ...options.env },
    logger,
    createRedis(_url, opts) { redisOptions = opts; return redis; },
    ...options.app,
  });
  t.after(() => app.stop());
  return { app, api, redis, get redisOptions() { return redisOptions; } };
}

async function request(app, path = "/health", options = {}) {
  const response = await fetch(`http://${host}:${app.server.address().port}${path}`, options);
  const body = await response.json();
  return { status: response.status, body };
}
function update(id, text, from = 42) {
  return { update_id: id, message: { message_id: id, date: 1, text,
    from: { id: from, is_bot: false, first_name: "Audit" }, chat: { id: 7, type: "private" },
    ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}),
  } };
}
function post(app, data, options = {}) {
  return request(app, "/webhook", { method: "POST", body: JSON.stringify(data),
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, ...options });
}
function record(redis) { return JSON.parse(redis.data.get("tg:session:42:7")); }

test("configuration rejects missing/invalid credentials, domain, path, Redis URL and port before binding", () => {
  for (const patch of [{ BOT_TOKEN: "" }, { BOT_TOKEN: "dummy" }, { WEBHOOK_SECRET: "" }, { WEBHOOK_SECRET: "bad secret" },
    { WEBHOOK_SECRET: "x".repeat(257) }, { WEBHOOK_DOMAIN: "" }, { WEBHOOK_DOMAIN: "http://isolated.invalid" },
    { WEBHOOK_DOMAIN: "https://user:password@isolated.invalid" }, { WEBHOOK_DOMAIN: "isolated.invalid/path" },
    { WEBHOOK_PATH: "/health" }, { WEBHOOK_PATH: "/" }, { WEBHOOK_PATH: "/webhook?x=1" },
    { REDIS_URL: "https://isolated.invalid" }, { PORT: "NaN" }, { PORT: "70000" }, { PORT: "1.5" }]) {
    assert.throws(() => createApp({ env: { ...baseEnv, ...patch } }));
  }
  const config = readConfig({ ...baseEnv, WEBHOOK_PATH: "custom/", REDIS_PRIVATE_URL: "rediss://private.invalid:6379", REDIS_URL: "redis://other.invalid:6379" });
  assert.equal(config.webhookUrl, "https://isolated.invalid/custom");
  assert.equal(config.redisUrl, "rediss://private.invalid:6379");
  assert.equal(validSecret(secret, secret), true);
  for (const input of [undefined, [secret], "", "x".repeat(secret.length), `${secret}, ${secret}`]) assert.equal(validSecret(input, secret), false);
});

test("readiness waits for identity and verified authenticated webhook; liveness is independent", async (t) => {
  const f = fixture(t);
  const entered = deferred();
  const gate = deferred();
  f.api.intercept = async (method) => { if (method === "getMe") { entered.resolve(); await gate.promise; } };
  const start = f.app.start();
  await entered.promise;
  assert.equal((await request(f.app)).status, 503);
  assert.equal((await request(f.app, "/live")).status, 200);
  gate.resolve();
  await start;
  for (const path of ["/", "/health", "/healthz", "/ready?check=1"]) {
    const response = await request(f.app, path);
    assert.equal(response.status, 200);
    assert.equal(response.body.ready, true);
    assert.equal(response.body.durable, true);
    assert.ok(!JSON.stringify(response.body).includes(token));
    assert.ok(!JSON.stringify(response.body).includes(secret));
  }
  const registration = f.api.calls.find((call) => call.method === "setWebhook");
  assert.deepEqual(registration.payload, { url: "https://isolated.invalid/webhook", secret_token: secret, max_connections: 1 });
  assert.ok(f.api.calls.some((call) => call.method === "getWebhookInfo"));
  assert.equal(f.redisOptions.enableOfflineQueue, false);
  assert.equal(f.redisOptions.family, 0);
  await f.app.stop();
  assert.equal(f.app.server.listening, false);
  assert.equal((await f.app.health()).ready, false);
  assert.equal((await f.app.health()).live, false);
  assert.equal(f.redis.disconnected, 1);
  assert.equal(f.api.calls.some((call) => ["getUpdates", "deleteWebhook"].includes(call.method)), false);
});

test("mock provider rejection, bad identity, registration rejection/mismatch and timeout close startup resources", async (t) => {
  for (const failure of ["token", "identity", "registration", "mismatch", "timeout"]) {
    const f = fixture(t, { app: { providerTimeoutMs: 25 } });
    f.api.intercept = async (method) => {
      if (failure === "token" && method === "getMe") throw new Error("401 isolated provider rejection");
      if (failure === "identity" && method === "getMe") return { id: 123, is_bot: false };
      if (failure === "registration" && method === "setWebhook") return false;
      if (failure === "mismatch" && method === "getWebhookInfo") return { url: "https://other.invalid/webhook" };
      if (failure === "timeout" && method === "getMe") return new Promise(() => {});
    };
    await assert.rejects(f.app.start(), /Bot startup failed/);
    assert.equal(f.app.server.listening, false);
    assert.equal((await f.app.health()).ready, false);
    assert.equal(f.redis.status, "end");
  }
});

test("Redis startup failure is fatal rather than an implicit memory fallback", async (t) => {
  for (const operation of ["connect", "set", "get"]) {
    const f = fixture(t);
    f.redis.fail = (op) => op === operation;
    await assert.rejects(f.app.start(), /Bot startup failed/);
    assert.equal(f.app.server.listening, false);
    assert.equal(f.app.state.sessions, "redis");
    assert.equal(f.api.calls.length, 0);
  }
});

test("real Telegraf dispatch runs /start, /help, /ping, /status and text echo against the isolated API", async (t) => {
  const f = fixture(t);
  await f.app.start();
  const texts = ["/start", "/help", "/ping", "/status", "hello from isolated test", "/ping@audit_bot"];
  for (const [id, text] of texts.entries()) assert.equal((await post(f.app, update(id, text))).status, 200);
  assert.match(f.api.replies[0].text, /Welcome/);
  assert.match(f.api.replies[1].text, /\/start.*\n\/help.*\n\/ping.*\n\/status/);
  assert.equal(f.api.replies[2].text, "pong");
  assert.match(f.api.replies[3].text, /webhook: registered\nsessions: redis\ntelegram: ok/);
  assert.equal(f.api.replies[4].text, texts[4]);
  assert.equal(f.api.replies[5].text, "pong");
  assert.deepEqual(record(f.redis).session, { starts: 1, messages: 1 });
  assert.equal((await post(f.app, { update_id: 10, callback_query: { id: "isolated" } })).status, 200);
  assert.equal(f.api.replies.length, 6);
});

test("webhook secret is mandatory and malformed/oversized payloads do not execute handlers", async (t) => {
  const f = fixture(t);
  await f.app.start();
  for (const header of [undefined, "wrong", `${secret}, ${secret}`]) {
    const headers = { "content-type": "application/json" };
    if (header) headers["x-telegram-bot-api-secret-token"] = header;
    assert.equal((await post(f.app, update(1, "/start"), { headers })).status, 401);
  }
  assert.equal((await post(f.app, update(1, "/start"), { headers: { "x-telegram-bot-api-secret-token": secret } })).status, 415);
  for (const payload of [null, [], {}, { update_id: -1 }, { update_id: "1" }, { update_id: 1.5 }]) {
    assert.equal((await post(f.app, payload)).status, 400);
  }
  assert.equal((await post(f.app, {}, { body: "{" })).status, 400);
  assert.equal((await post(f.app, {}, { body: "x".repeat(2_000_001) })).status, 413);
  assert.equal((await request(f.app, "/webhook")).status, 404);
  assert.equal((await request(f.app, "/other", { method: "POST" })).status, 404);
  assert.equal(f.api.replies.length, 0);
});

test("provider revocation and stolen webhook are detected on readiness refresh and can recover", async (t) => {
  let clock = 0;
  const f = fixture(t, { app: { now: () => clock, providerCheckIntervalMs: 30 } });
  await f.app.start();
  f.api.intercept = async (method) => { if (method === "getMe") throw new Error("401 isolated revocation"); };
  clock = 31;
  assert.equal((await request(f.app)).status, 503);
  assert.equal((await request(f.app, "/live")).status, 200);
  assert.equal((await post(f.app, update(1, "/start"))).status, 503);
  f.api.intercept = null;
  clock = 62;
  assert.equal((await request(f.app)).status, 200);
  f.api.url = "https://other.invalid/webhook";
  clock = 93;
  assert.equal((await request(f.app)).status, 503);
});

test("Redis disconnect, read-only writes and failed reads turn readiness red without losing durable state", async (t) => {
  const f = fixture(t);
  await f.app.start();
  await post(f.app, update(1, "/start"));
  const saved = f.redis.data.get("tg:session:42:7");
  for (const failure of ["disconnect", "set", "get"]) {
    if (failure === "disconnect") { f.redis.status = "reconnecting"; f.redis.emit("close"); }
    else f.redis.fail = (op) => op === failure;
    assert.equal((await request(f.app)).status, 503);
    assert.equal((await request(f.app, "/live")).status, 200);
    assert.equal((await post(f.app, update(2, "/start"))).status, 503);
    assert.equal(f.app.state.sessions, "redis");
    assert.equal(f.redis.data.get("tg:session:42:7"), saved);
    f.redis.status = "ready";
    f.redis.fail = null;
    assert.equal((await request(f.app)).status, 200);
  }
  assert.equal(f.api.replies.length, 1);
  assert.equal((await post(f.app, update(2, "/start"))).status, 200);
  assert.equal(record(f.redis).session.starts, 2);
});

test("failed session reads, corrupt records and failed commits return 503 and are retryable", async (t) => {
  const f = fixture(t);
  await f.app.start();
  f.redis.fail = (op, key) => op === "get" && key.startsWith("tg:session:");
  assert.equal((await post(f.app, update(1, "/start"))).status, 503);
  assert.equal(f.api.replies.length, 0);
  f.redis.fail = null;
  for (const corrupt of ["not-json", "null", "[]", '{"format":"railway-session-v1","updates":"invalid"}']) {
    f.redis.data.set("tg:session:42:7", corrupt);
    assert.equal((await post(f.app, update(1, "/start"))).status, 503);
  }
  f.redis.data.delete("tg:session:42:7");
  f.redis.fail = (op, key) => op === "set" && key.startsWith("tg:session:");
  assert.equal((await post(f.app, update(1, "/start"))).status, 503);
  assert.equal(f.redis.data.has("tg:session:42:7"), false);
  f.redis.fail = null;
  assert.equal((await post(f.app, update(1, "/start"))).status, 200);
  assert.equal(record(f.redis).session.starts, 1);
  assert.equal(f.api.replies.length, 2, "a reply before a failed commit can be repeated; this is not exactly-once delivery");
});

test("handler failures propagate to HTTP without leaking provider error details or committing state", async (t) => {
  const f = fixture(t);
  await f.app.start();
  f.api.intercept = async (method) => {
    if (method === "sendMessage") throw Object.assign(new Error(`isolated error containing ${token}`), { status: 400, code: 401 });
  };
  const response = await post(f.app, update(1, "/start"));
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(response.body).includes(token));
  assert.equal(f.app.state.telegram, "unavailable");
  assert.equal(f.redis.data.has("tg:session:42:7"), false);
  f.api.intercept = null;
  assert.equal((await post(f.app, update(1, "/start"))).status, 200);
});

test("retries and concurrent duplicates commit once; persisted retry history survives an app restart", async (t) => {
  const shared = new Map();
  const f = fixture(t, { redis: new FakeRedis(shared) });
  await f.app.start();
  const results = await Promise.all(Array.from({ length: 5 }, () => post(f.app, update(1, "/start"))));
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(f.api.replies.length, 1);
  assert.equal(record(f.redis).session.starts, 1);
  assert.equal((await post(f.app, update(2, "/ping"))).status, 200);
  await f.app.stop();
  const restarted = fixture(t, { redis: new FakeRedis(shared) });
  await restarted.app.start();
  assert.equal((await post(restarted.app, update(1, "/start"))).status, 200);
  assert.equal((await post(restarted.app, update(2, "/ping"))).status, 200);
  assert.equal(restarted.api.replies.length, 0);
  await Promise.all([post(restarted.app, update(3, "/start")), post(restarted.app, update(4, "/start"))]);
  assert.equal(record(restarted.redis).session.starts, 3);
  assert.equal(restarted.api.replies.length, 2);
});

test("legacy sessions migrate and retry history is bounded to the last 100 committed updates", async () => {
  const data = new Map([["42:7", { starts: 2 }]]);
  const middleware = sessions(data);
  for (let id = 0; id < 105; id++) {
    const ctx = { from: { id: 42 }, chat: { id: 7 }, update: { update_id: id } };
    await middleware(ctx, async () => { ctx.session.starts++; });
  }
  assert.equal(data.get("42:7").session.starts, 107);
  assert.equal(data.get("42:7").updates.length, 100);
  assert.equal(data.get("42:7").updates[0], 5);
  const ctx = { from: { id: 42 }, chat: { id: 7 }, update: { update_id: 104 } };
  await middleware(ctx, async () => assert.fail("committed duplicate executed"));
});

test("explicit no-Redis mode is labeled non-durable and loses sessions on restart", async (t) => {
  const f = fixture(t, { env: { REDIS_URL: "" } });
  await f.app.start();
  const status = await f.app.health();
  assert.equal(status.sessions, "memory");
  assert.equal(status.durable, false);
  await post(f.app, update(1, "/start"));
  await post(f.app, update(1, "/start"));
  assert.equal(f.api.replies.length, 1);
  await f.app.stop();
  const restarted = fixture(t, { env: { REDIS_URL: "" } });
  await restarted.app.start();
  await post(restarted.app, update(1, "/start"));
  assert.equal(restarted.api.replies.length, 1);
});

test("shutdown aborts startup provider waits and drains in-flight session commits before Redis disconnect", async (t) => {
  const f = fixture(t);
  const entered = deferred();
  f.api.intercept = async (method) => { if (method === "getMe") { entered.resolve(); return new Promise(() => {}); } };
  const start = f.app.start();
  const rejected = assert.rejects(start, /Bot startup failed/);
  await entered.promise;
  await f.app.stop();
  await rejected;
  assert.equal(f.app.server.listening, false);
  const active = fixture(t);
  await active.app.start();
  const sending = deferred();
  const gate = deferred();
  active.api.intercept = async (method) => { if (method === "sendMessage") { sending.resolve(); await gate.promise; } };
  const response = post(active.app, update(1, "/start"));
  await sending.promise;
  const stop = active.app.stop();
  assert.equal(active.redis.status, "ready");
  gate.resolve();
  assert.equal((await response).status, 200);
  await stop;
  assert.equal(record(active.redis).session.starts, 1);
  assert.equal(active.redis.status, "end");
});

test("Redis store validates missing/read/write/delete results and propagates failures", async () => {
  const redis = new FakeRedis();
  await redis.connect();
  let failures = 0;
  const store = redisSessionStore(redis, () => failures++);
  assert.equal(await store.get("new"), undefined);
  await store.set("new", { count: 1 });
  assert.deepEqual(await store.get("new"), { count: 1 });
  await store.delete("new");
  assert.equal(await store.get("new"), undefined);
  redis.set = async () => null;
  await assert.rejects(store.set("new", {}), /write failed/);
  assert.equal(failures, 1);
});

async function childResult(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: require("node:path").join(__dirname, ".."),
    env: { PATH: process.env.PATH, ...baseEnv, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (data) => output.push(data.toString()));
  child.stderr.on("data", (data) => output.push(data.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  return { code, signal, output: output.join("") };
}

test("real CLI rejects missing and mocked-invalid credentials with exit 1", async () => {
  const missing = await childResult(["src/index.js"], { BOT_TOKEN: "" });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /BOT_TOKEN is required/);
  const invalid = await childResult(["--require", "./tests/provider.cjs", "src/index.js"], { TEST_PROVIDER_MODE: "invalid" });
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /Bot startup failed/);
  assert.ok(!invalid.output.includes(token));
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`real CLI handles ${signal} with an isolated provider and exits cleanly`, async (t) => {
    const child = spawn(process.execPath, ["--require", "./tests/provider.cjs", "src/index.js"], {
      cwd: require("node:path").join(__dirname, ".."),
      env: { PATH: process.env.PATH, ...baseEnv }, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); });
    child.stdout.on("data", (data) => { if (data.toString().includes("webhook verified")) child.kill(signal); });
    assert.deepEqual(await exited, [0, null]);
  });
}
