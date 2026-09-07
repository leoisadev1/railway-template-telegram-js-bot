"use strict";

const http = require("node:http");
const { Telegraf, session } = require("telegraf");
const { message } = require("telegraf/filters");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const WEBHOOK_PATH = normalizePath(process.env.WEBHOOK_PATH || "/webhook");
const WEBHOOK_SECRET = sanitizeSecret(process.env.WEBHOOK_SECRET);
const PUBLIC_DOMAIN = (process.env.RAILWAY_PUBLIC_DOMAIN || process.env.WEBHOOK_DOMAIN || "")
  .trim()
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const REDIS_URL = (process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "").trim();

const state = {
  startedAt: new Date().toISOString(),
  webhook: "inactive",
  sessions: "memory",
  telegram: "not-configured",
  lastError: null,
};

let bot = null;
let redis = null;

function normalizePath(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function sanitizeSecret(raw) {
  if (!raw) return undefined;
  const cleaned = String(raw).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 256);
  return cleaned || undefined;
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

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function healthBody() {
  return {
    ok: true,
    status: "ok",
    webhook: state.webhook,
    sessions: state.sessions,
    telegram: state.telegram,
    domain: PUBLIC_DOMAIN || null,
    uptimeSec: Math.round(process.uptime()),
    startedAt: state.startedAt,
  };
}

async function connectRedis() {
  if (!REDIS_URL) {
    console.log("No REDIS_URL / REDIS_PRIVATE_URL; using in-memory sessions");
    return null;
  }

  const Redis = require("ioredis");
  const client = new Redis(REDIS_URL, {
    family: 0,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    commandTimeout: 4000,
    retryStrategy: () => null,
  });

  client.on("error", (err) => {
    console.warn("Redis error:", err.message);
  });

  try {
    await client.connect();
    await client.ping();
    state.sessions = "redis";
    console.log("Redis session store connected");
    return client;
  } catch (err) {
    console.warn("Redis unavailable, falling back to in-memory sessions:", err.message);
    try {
      client.disconnect();
    } catch {
      // ignore
    }
    state.sessions = "memory";
    state.lastError = `redis: ${err.message}`;
    return null;
  }
}

function redisSessionStore(client) {
  const prefix = "tg:session:";
  return {
    async get(key) {
      const raw = await client.get(prefix + key);
      return raw ? JSON.parse(raw) : undefined;
    },
    async set(key, value) {
      await client.set(prefix + key, JSON.stringify(value));
    },
    async delete(key) {
      await client.del(prefix + key);
    },
  };
}

function buildBot(token, store) {
  const instance = new Telegraf(token, { handlerTimeout: 15_000 });
  instance.use(store ? session({ store }) : session());

  instance.start(async (ctx) => {
    ctx.session ??= {};
    ctx.session.starts = (ctx.session.starts || 0) + 1;
    await ctx.reply(
      [
        "Welcome to the Railway Telegraf starter.",
        "",
        "This bot uses HTTPS webhooks on your Railway domain (not long polling).",
        "Try /help, /ping, or /status.",
      ].join("\n"),
    );
  });

  instance.help(async (ctx) => {
    await ctx.reply(
      [
        "/start — welcome message",
        "/help — this list",
        "/ping — round-trip check",
        "/status — webhook + session backend",
        "Send any text and I will echo it.",
      ].join("\n"),
    );
  });

  instance.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  instance.command("status", async (ctx) => {
    await ctx.reply(
      [
        `webhook: ${state.webhook}`,
        `sessions: ${state.sessions}`,
        `telegram: ${state.telegram}`,
        `domain: ${PUBLIC_DOMAIN || "unset"}`,
      ].join("\n"),
    );
  });

  instance.on(message("text"), async (ctx) => {
    ctx.session ??= {};
    ctx.session.messages = (ctx.session.messages || 0) + 1;
    await ctx.reply(ctx.message.text);
  });

  instance.catch((err) => {
    console.error("Telegraf handler error:", err);
  });

  return instance;
}

async function registerWebhook(instance) {
  if (!PUBLIC_DOMAIN) {
    state.webhook = "no-domain";
    state.telegram = "awaiting-domain";
    console.warn("RAILWAY_PUBLIC_DOMAIN is unset; serving HTTP only (webhook not registered)");
    return;
  }

  const url = `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`;
  const extra = {};
  if (WEBHOOK_SECRET) extra.secret_token = WEBHOOK_SECRET;

  try {
    await instance.telegram.setWebhook(url, extra);
    state.webhook = "registered";
    state.telegram = "ok";
    console.log(`Telegram webhook registered at ${url}`);
  } catch (err) {
    state.webhook = "http-only";
    state.telegram = "token-rejected";
    state.lastError = err.message;
    console.warn(
      "Could not register Telegram webhook (dummy or invalid BOT_TOKEN is OK for /health):",
      err.message,
    );
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    json(res, 200, healthBody());
    return;
  }

  if (req.method === "GET" && path === "/") {
    json(res, 200, {
      name: "Telegram Bot (Telegraf)",
      health: "/health",
      webhook: WEBHOOK_PATH,
      ...healthBody(),
    });
    return;
  }

  if (req.method === "POST" && path === WEBHOOK_PATH) {
    if (!bot) {
      text(res, 503, "bot not ready");
      return;
    }
    if (WEBHOOK_SECRET) {
      const header = req.headers["x-telegram-bot-api-secret-token"];
      if (header !== WEBHOOK_SECRET) {
        text(res, 401, "unauthorized");
        return;
      }
    }
    try {
      const raw = await readBody(req);
      const update = JSON.parse(raw.toString("utf8") || "{}");
      await bot.handleUpdate(update);
      text(res, 200, "ok");
    } catch (err) {
      console.error("Webhook error:", err);
      text(res, 200, "ok");
    }
    return;
  }

  text(res, 404, "not found");
});

server.on("error", (err) => {
  console.error("HTTP server error:", err);
  process.exit(1);
});

async function main() {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP listening on ${PORT} (health GET /health, webhook POST ${WEBHOOK_PATH})`);
  });

  redis = await connectRedis();
  const store = redis ? redisSessionStore(redis) : undefined;

  if (!BOT_TOKEN) {
    state.telegram = "missing-token";
    console.warn("BOT_TOKEN is empty. /health is live; add a BotFather token to enable Telegram.");
    return;
  }

  bot = buildBot(BOT_TOKEN, store);
  await registerWebhook(bot);
}

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  if (redis) {
    try {
      redis.disconnect();
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error("Startup error (HTTP server still running if listen succeeded):", err);
});
