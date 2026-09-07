# Deploy and Host Telegram Bot (Telegraf) on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/eJeud7)

Node.js **Telegraf** starter that serves **HTTPS webhooks on your Railway domain** (not long polling), exposes **`GET /health`**, and stores sessions on **Railway Redis**. HTTP binds first, so a missing or dummy `BOT_TOKEN` still deploys healthy.

## About Hosting Telegram Bot (Telegraf)

This template runs a digest-pinned Node 20 Alpine image with Telegraf `4.16.3`. Railway assigns a public HTTPS domain; the bot registers `https://<RAILWAY_PUBLIC_DOMAIN>/webhook` with Telegram. Official Railway Redis is wired on the private network for sessions, with an in-memory fallback if Redis is down.

There is no web login. Create a bot with [@BotFather](https://t.me/BotFather), paste the token into **`BOT_TOKEN`**, deploy, then message `/start` in Telegram.

## Common Use Cases

- Production Telegram bots that should use webhooks, not long polling
- Command starters (`/start`, `/help`, `/ping`, `/status`) you can extend in JavaScript
- Session-backed bots (wizard flows, per-user state) on Railway Redis
- Always-on webhook workers with a Railway healthcheck

## Dependencies for Telegram Bot (Telegraf) Hosting

- Node.js 20+ (digest-pinned `node:20-alpine` image)
- [Telegraf](https://telegraf.js.org/) `4.16.3` with `package-lock.json`
- Official Railway Redis (`redis:8.2`) on `/data`, private `REDIS_URL`
- Public HTTPS domain (`RAILWAY_PUBLIC_DOMAIN`) for Telegram webhooks
- A BotFather token you provide (never generated)

### Deployment Dependencies

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token (`123456789:AA...`).
2. Click **Deploy on Railway** and paste that token into **`BOT_TOKEN`** (required).
3. Deploy. Railway assigns a public HTTPS domain and generates `WEBHOOK_SECRET`.
4. Open `https://<your-domain>/health` — you should see `{"ok":true,...}`.
5. Message the bot `/start`, `/help`, `/ping`, or `/status`.

## Why Deploy Telegram Bot (Telegraf) on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Telegram Bot (Telegraf) on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.

## Required vs generated variables

| Variable | Service | Required | Source |
| --- | --- | --- | --- |
| `BOT_TOKEN` | bot | **Yes (you provide)** | [@BotFather](https://t.me/BotFather). Never generated. Dummy values still boot `/health`. |
| `WEBHOOK_SECRET` | bot | Generated | `${{secret()}}`. Sent to Telegram as `secret_token` and checked on `/webhook`. |
| `REDIS_URL` | bot | Wired | `${{Redis.REDIS_URL}}` — private network, not public TCP. |
| `PORT` | bot | Railway-provided | HTTP listen port. |
| `RAILWAY_PUBLIC_DOMAIN` | bot | Railway-provided | Used as the webhook host. |

Do **not** bake a real bot token into the template. If Redis is missing, the bot keeps in-memory sessions and stays healthy.

## Services, volume, ports

- **bot** — Node 20 Alpine image (digest-pinned), Telegraf `4.16.3`, `GET /health` + `POST /webhook`. Public HTTP on port `3000` (Railway `PORT`).
- **Redis** — official Railway Redis 8.2. Private URL only. Volume at `/data`. The bot itself does not mount a volume.
- No SSH, no long polling, no public Redis.

## How to log in / talk to the bot

There is no web login. After deploy:

1. Open Telegram and search for the bot you created with BotFather.
2. Send `/start`.
3. `/status` shows whether the webhook registered and whether sessions are `redis` or `memory`.

`GET /` on the public domain returns JSON status. `GET /health` is the Railway healthcheck (HTTP 200).

## Why this is healthier than rotting marketplace clones

- **Pinned Node 20 image digest**, pinned `telegraf@4.16.3`, lockfile (`package-lock.json`). Not `:latest`.
- **Webhooks via `RAILWAY_PUBLIC_DOMAIN`**, not long polling.
- **Required user `BOT_TOKEN`**, not a generated dummy that makes Telegram 401 and tanks template health.
- **`/health` healthcheck** with `restartPolicyType = ON_FAILURE`. The HTTP server binds **before** talking to Telegram, so a throwaway token still deploys SUCCESS.
- **Official Railway Redis over private `REDIS_URL`**, with a hard timeout and in-memory fallback. Not unpinned Bitnami.
- **Webhook secret** generated with `${{secret()}}`.
- App sleeping disabled so the webhook stays reachable.

## Local run

```bash
cp .env.example .env   # set BOT_TOKEN
npm ci
npm start
```

Health: `curl -fsS http://127.0.0.1:3000/health`

## Source

GitHub: [leoisadev1/railway-template-telegram-js-bot](https://github.com/leoisadev1/railway-template-telegram-js-bot)
