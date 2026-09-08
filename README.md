# Deploy and Host Telegram Bot (Telegraf) on Railway

A Node.js Telegram webhook worker with Telegraf 4.16.3, authenticated webhook requests, and Redis-backed sessions. Included commands are `/start`, `/help`, `/ping`, `/status`, and text echo. It does not use long polling.

## About Hosting Telegram Bot (Telegraf)

The stack contains one non-root Node 24 bot and private authenticated Redis 8.2. Railway terminates public HTTPS and forwards HTTP to the bot on port 3000; Redis uses private port 6379 with a `/data` volume and no public TCP proxy. Keep a single bot worker with sleeping disabled.

### Deploy and connect Telegram

1. Create a bot using [BotFather](https://t.me/BotFather) and set required `BOT_TOKEN` privately in Railway. There is no generated or dummy token default.
2. Deploy the bot and Redis. Confirm Redis can write its mounted `/data` directory and start append-only persistence.
3. Keep the generated `WEBHOOK_SECRET` and the private `REDIS_URL` reference. Enable the bot's public HTTPS domain and keep its target port aligned with `PORT=3000`.
4. Startup authenticates with `getMe`, registers the webhook, and checks the reported webhook URL. Wait for `/health`, then send `/start` and `/ping` in a real Telegram chat.
5. Verify actual delivery and replies; a matching `getWebhookInfo` URL alone does not prove that Telegram can reach the service.

**A real BotFather token is required for authentication and delivery.** No live Telegram E2E or real Redis crash-persistence result is claimed. Missing/rejected tokens must fail readiness rather than leave a healthy HTTP-only process.

### Variables and webhook protection

- `BOT_TOKEN`: required user secret.
- `WEBHOOK_SECRET`: generated 32-character alphanumeric secret; Telegram must send it in `X-Telegram-Bot-Api-Secret-Token` on every request.
- `REDIS_URL=${{Redis.REDIS_URL}}`: private authoritative session backend. Optional `REDIS_PRIVATE_URL` takes precedence if set.
- `RAILWAY_PUBLIC_DOMAIN`: provided by the bot's Railway domain. `WEBHOOK_DOMAIN` is a fallback HTTPS host only when that Railway variable is absent.
- `WEBHOOK_PATH`: `/webhook`; `PORT`: `3000`; `HOST`: `0.0.0.0` in the container.
- Redis uses `REDISUSER=default`, `REDISPORT=6379`, and a generated password. Do not expose its credentials or proxy publicly.

`/health`, `/healthz`, `/ready`, and `/` require authenticated provider identity, registered/matching webhook state, and working Redis read/write access. `/live` is independent liveness. Railway uses `/health` with a 60-second startup allowance. Provider state refresh is cached for up to 30 seconds during health/webhook requests; it is not instantaneous token-revocation detection.

Wrong/missing webhook secrets are rejected before handlers. Malformed requests are rejected; handler or persistence failures return 503 so Telegram may retry. Shutdown drains work without deleting the replacement deployment's webhook.

### Sessions and persistence limits

Redis uses AOF with `appendfsync everysec`, snapshots, and `noeviction`. Verify volume permissions and session readback across bot and Redis restarts before relying on it. Every-second fsync can lose recent writes on a crash; a volume is not a backup. A configured Redis outage fails readiness and never silently switches to memory.

Updates are serialized per user/chat within one worker. Sessions retain the last 100 successful update IDs for bounded retry suppression. This is not exactly-once delivery: old IDs can repeat, replicas do not share the application lock, and a sent reply followed by a failed Redis commit can be repeated. Do not add replicas without distributed coordination. Deliberately omitting both Redis URLs enables non-durable development memory mode only.

## Common Use Cases

- A webhook-based Telegram command starter.
- Extending text replies and per-chat state.
- Learning explicit retry and dependency-failure handling.

## Dependencies for Telegram Bot (Telegraf) Hosting

A real Telegram Bot token, public HTTPS bot domain, generated webhook secret, private Redis, and writable Redis volume.

### Deployment Dependencies

- [Template source](https://github.com/leoisadev1/railway-template-telegram-js-bot).
- [Telegraf](https://telegraf.js.org/) and [Telegram Bot API](https://core.telegram.org/bots/api).
- Node 24, the npm lockfile, and Redis 8.2.

## Why Deploy Telegram Bot (Telegraf) on Railway?

Railway provides HTTPS webhook routing, private service references, logs, and Redis storage. You supply Telegram credentials, validate real delivery, and maintain backups and a single-worker retry design.
