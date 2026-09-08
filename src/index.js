"use strict";

const http = require("node:http");
const { once } = require("node:events");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const { Telegraf } = require("telegraf");
const { message } = require("telegraf/filters");
const Redis = require("ioredis");
const { redisSessionStore, sessions } = require("./sessions");

function readConfig(env) {
  const token = (env.BOT_TOKEN || "").trim();
  if (!token) throw new Error("BOT_TOKEN is required");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("BOT_TOKEN has an invalid format");
  const secret = env.WEBHOOK_SECRET || "";
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error("WEBHOOK_SECRET is required and must contain 1-256 letters, digits, underscores or hyphens");
  }
  const domain = (env.RAILWAY_PUBLIC_DOMAIN || env.WEBHOOK_DOMAIN || "").trim();
  let publicUrl;
  try {
    publicUrl = new URL(domain.includes("://") ? domain : `https://${domain}`);
    if (publicUrl.protocol !== "https:" || !publicUrl.hostname || publicUrl.username || publicUrl.password
        || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error();
  } catch {
    throw new Error("RAILWAY_PUBLIC_DOMAIN or WEBHOOK_DOMAIN must be an HTTPS host without a path or credentials");
  }
  let path = env.WEBHOOK_PATH || "/webhook";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9_/-]+$/.test(path) || ["/health", "/healthz", "/ready", "/live"].includes(path)) {
    throw new Error("WEBHOOK_PATH must be a non-reserved URL path");
  }
  const port = Number(env.PORT || "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
  const redisUrl = (env.REDIS_PRIVATE_URL || env.REDIS_URL || "").trim();
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      if (!["redis:", "rediss:"].includes(url.protocol) || !url.hostname) throw new Error();
    } catch {
      throw new Error("REDIS_URL / REDIS_PRIVATE_URL must be a Redis URL");
    }
  }
  return { token, secret, path, port, host: env.HOST || "0.0.0.0", redisUrl,
    domain: publicUrl.host, webhookUrl: `${publicUrl.origin}${path}` };
}

function validSecret(header, expected) {
  if (typeof header !== "string") return false;
  const received = Buffer.from(header);
  const secret = Buffer.from(expected);
  return received.length === secret.length && timingSafeEqual(received, secret);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let finished = false;
    const timer = setTimeout(() => finish(httpError(408, "request timeout")), 10_000);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chunks = [];
      if (error) reject(error);
      else resolve(value);
    }
    req.on("data", (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > 2_000_000) finish(httpError(413, "request body too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", () => finish(httpError(400, "request error")));
    req.on("aborted", () => finish(httpError(400, "request aborted")));
  });
}

function buildBot(token, store, state, domain) {
  const bot = new Telegraf(token, { handlerTimeout: 15_000 });
  bot.use(sessions(store));
  bot.start(async (ctx) => {
    ctx.session ??= {};
    ctx.session.starts = (ctx.session.starts || 0) + 1;
    await ctx.reply([
      "Welcome to the Railway Telegraf starter.", "",
      "This bot uses HTTPS webhooks on your Railway domain (not long polling).",
      "Try /help, /ping, or /status.",
    ].join("\n"));
  });
  bot.help((ctx) => ctx.reply([
    "/start — welcome message", "/help — this list", "/ping — round-trip check",
    "/status — webhook + session backend", "Send any text and I will echo it.",
  ].join("\n")));
  bot.command("ping", (ctx) => ctx.reply("pong"));
  bot.command("status", (ctx) => ctx.reply([
    `webhook: ${state.webhook}`, `sessions: ${state.sessions}`,
    `telegram: ${state.telegram}`, `domain: ${domain}`,
  ].join("\n")));
  bot.on(message("text"), async (ctx) => {
    ctx.session ??= {};
    ctx.session.messages = (ctx.session.messages || 0) + 1;
    await ctx.reply(ctx.message.text);
  });
  // A failed update must reach HTTP as a failure so Telegram can retry it.
  bot.catch((error) => { throw error; });
  return bot;
}

function createApp({
  env = process.env,
  createRedis = (url, options) => new Redis(url, options),
  botFactory = buildBot,
  logger = console,
  providerTimeoutMs = 5_000,
  providerCheckIntervalMs = 30_000,
  shutdownTimeoutMs = 20_000,
  now = Date.now,
} = {}) {
  const config = readConfig(env);
  const state = {
    startedAt: new Date().toISOString(), webhook: "inactive", telegram: "connecting",
    sessions: config.redisUrl ? "redis" : "memory",
    redis: config.redisUrl ? "connecting" : "not-configured",
  };
  let bot;
  let redis;
  let stopping = false;
  let stopPromise;
  let providerCheckedAt = -Infinity;
  let providerCheck;
  const calls = new Set();
  const requests = new Set();

  function checkRunning() {
    if (stopping) throw new Error("Bot is stopping");
  }

  async function telegramCall(method, payload = {}) {
    checkRunning();
    const controller = new AbortController();
    calls.add(controller);
    let timer;
    try {
      return await Promise.race([
        bot.telegram.callApi(method, payload, { signal: controller.signal }),
        new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("Telegram request aborted or timed out")), { once: true });
          timer = setTimeout(() => controller.abort(), providerTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      calls.delete(controller);
    }
  }

  async function checkRedis() {
    if (!config.redisUrl) return true;
    const probeKey = `tg:health:${randomUUID()}`;
    try {
      if (!redis || redis.status !== "ready") throw new Error("Redis disconnected");
      if (await redis.ping() !== "PONG") throw new Error("Redis ping failed");
      if (await redis.set(probeKey, "1", "PX", 10_000) !== "OK") throw new Error("Redis write failed");
      if (await redis.get(probeKey) !== "1") throw new Error("Redis read failed");
      await redis.del(probeKey);
      state.redis = "ready";
      return true;
    } catch {
      state.redis = "unavailable";
      return false;
    }
  }

  async function checkProvider(force = false) {
    if (!bot || state.webhook === "inactive" || stopping) return;
    if (providerCheck) return providerCheck;
    if (!force && now() - providerCheckedAt < providerCheckIntervalMs) return;
    providerCheck = (async () => {
      try {
        const me = await telegramCall("getMe");
        if (!me.is_bot || !Number.isSafeInteger(me.id)) throw new Error("Invalid bot identity");
        const info = await telegramCall("getWebhookInfo");
        if (info.url !== config.webhookUrl) throw new Error("Webhook URL mismatch");
        checkRunning();
        bot.botInfo = me;
        state.telegram = "ok";
        state.webhook = "registered";
      } catch {
        state.telegram = "unavailable";
        state.webhook = "unverified";
      } finally {
        providerCheckedAt = now();
      }
    })();
    try {
      await providerCheck;
    } finally {
      providerCheck = null;
    }
  }

  async function health() {
    const [redisReady] = await Promise.all([checkRedis(), checkProvider()]);
    const ready = !stopping && state.telegram === "ok" && state.webhook === "registered" && redisReady;
    return { ...state, ready, ok: ready, live: !stopping, durable: Boolean(config.redisUrl),
      domain: config.domain, uptimeSec: Math.round(process.uptime()) };
  }

  async function handleRequest(req, res) {
    const path = (req.url || "/").split("?", 1)[0].replace(/\/+$/, "") || "/";
    if (req.method === "GET" && path === "/live") {
      json(res, stopping ? 503 : 200, { ok: !stopping, live: !stopping });
      return;
    }
    if (req.method === "GET" && ["/", "/health", "/healthz", "/ready"].includes(path)) {
      const body = await health();
      json(res, body.ready ? 200 : 503, body);
      return;
    }
    if (req.method !== "POST" || path !== config.path) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!validSecret(req.headers["x-telegram-bot-api-secret-token"], config.secret)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (!(await health()).ready) {
      json(res, 503, { error: "bot not ready" });
      return;
    }
    try {
      if (req.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") {
        throw httpError(415, "application/json required");
      }
      const raw = await readBody(req);
      let update;
      try { update = JSON.parse(raw.toString("utf8")); }
      catch { throw httpError(400, "invalid JSON"); }
      if (!update || Array.isArray(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
        throw httpError(400, "invalid update");
      }
      await bot.handleUpdate(update);
      json(res, 200, { ok: true });
    } catch (error) {
      if (error.code === 401 || error.response?.error_code === 401) {
        state.telegram = "unavailable";
        providerCheckedAt = -Infinity;
      }
      const status = error.httpStatus || 503;
      if (status === 503) logger.error("Webhook processing failed; update was not acknowledged");
      json(res, status, { error: status === 503 ? "update processing failed" : error.message });
    }
  }

  const server = http.createServer((req, res) => {
    const task = handleRequest(req, res).catch(() => {
      logger.error("HTTP request failed");
      if (!res.headersSent) json(res, 503, { error: "request failed" });
      else res.destroy();
    }).finally(() => requests.delete(task));
    requests.add(task);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    for (const controller of calls) controller.abort();
    stopPromise = (async () => {
      let timer;
      try {
        await Promise.race([
          (async () => {
            await new Promise((resolve) => server.close(resolve));
            await Promise.allSettled([...requests]);
            if (redis?.status === "ready") await redis.quit();
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Telegram shutdown timed out")), shutdownTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        server.closeAllConnections();
        redis?.disconnect();
      }
    })();
    return stopPromise;
  }

  async function start() {
    try {
      checkRunning();
      server.listen(config.port, config.host);
      await once(server, "listening");
      logger.log(`HTTP listening on ${server.address().port}`);
      if (config.redisUrl) {
        redis = createRedis(config.redisUrl, {
          family: 0, lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false,
          connectTimeout: 5_000, commandTimeout: 4_000,
          retryStrategy: (times) => Math.min(times * 100, 2_000),
        });
        redis.on("error", () => { state.redis = "unavailable"; logger.error("Redis connection error"); });
        redis.on("close", () => { state.redis = "unavailable"; });
        await redis.connect();
        if (!(await checkRedis())) throw new Error("Redis is unavailable or does not allow session reads/writes");
      } else {
        logger.warn("No Redis URL configured: sessions are in memory and will be lost on restart");
      }
      checkRunning();
      const store = redis ? redisSessionStore(redis, () => { state.redis = "unavailable"; }) : new Map();
      bot = botFactory(config.token, store, state, config.domain);
      const me = await telegramCall("getMe");
      if (!me.is_bot || !Number.isSafeInteger(me.id)) throw new Error("Invalid bot identity");
      bot.botInfo = me;
      if (await telegramCall("setWebhook", { url: config.webhookUrl, secret_token: config.secret, max_connections: 1 }) !== true) {
        throw new Error("Telegram did not accept the webhook");
      }
      state.webhook = "verifying";
      await checkProvider(true);
      if (state.telegram !== "ok") throw new Error("Telegram webhook verification failed");
      checkRunning();
      logger.log("Telegram bot authenticated and webhook verified");
    } catch {
      state.telegram = "unavailable";
      await stop();
      throw new Error("Bot startup failed; check BOT_TOKEN, webhook configuration, Telegram connectivity and Redis availability");
    }
  }

  return { start, stop, health, server, state, config, get bot() { return bot; } };
}

async function main() {
  const app = createApp();
  const shutdown = (code) => app.stop().then(
    () => process.exit(code),
    (error) => { console.error(error.message); process.exit(1); },
  );
  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));
  process.on("unhandledRejection", () => {
    console.error("Unhandled rejection; stopping the bot");
    shutdown(1);
  });
  await app.start();
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { createApp, readConfig, buildBot, validSecret };
