# Telegram Bot (Telegraf)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/eJeud7)

Node.js **Telegraf** starter that serves **HTTPS webhooks on your Railway domain** (not long polling), exposes **`GET /health`**, and optionally stores sessions on **Railway Redis**.

This listing is meant to replace rotting JS/TS Telegram starters that generate a fake `BOT_TOKEN`, skip healthchecks, and pin Bitnami Redis. HTTP comes up first so Railway health stays green even while you paste a real BotFather token.

## One-click deploy

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token (`123456789:AA...`).
2. Click **Deploy on Railway** and paste that token into **`BOT_TOKEN`** (required).
3. Deploy. Railway assigns a public HTTPS domain; the bot registers `https://<RAILWAY_PUBLIC_DOMAIN>/webhook` with Telegram.
4. Open `https://<your-domain>/health` — you should see `{"ok":true,...}`.
5. Message the bot `/start`, `/help`, `/ping`, or `/status`.

## Required vs generated variables

| Variable | Service | Required | Source |
| --- | --- | --- | --- |
| `BOT_TOKEN` | bot | **Yes (you provide)** | [@BotFather](https://t.me/BotFather). Never generated. Dummy values will still boot `/health`. |
| `WEBHOOK_SECRET` | bot | Generated | `${{secret()}}`. Sent to Telegram as `secret_token` and checked on `/webhook`. |
| `REDIS_URL` | bot | Wired | `${{Redis.REDIS_PRIVATE_URL}}` — private network, not public TCP. |
| `WEBHOOK_PATH` | bot | Optional | Default `/webhook`. |
| `PORT` | bot | Railway-provided | HTTP listen port. |
| `RAILWAY_PUBLIC_DOMAIN` | bot | Railway-provided | Used as the webhook host. |

Do **not** bake a real bot token into the template. If Redis is missing, the bot keeps in-memory sessions and stays healthy.

## Services, volume, ports

- **bot** — Node 20 Alpine image (digest-pinned), Telegraf `4.16.3`, `GET /health` + `POST /webhook`. Public HTTP on port `3000` (Railway `PORT`).
- **Redis** — official Railway Redis. Private URL only. Railway manages its volume; the bot itself does not mount a volume.
- No SSH, no long polling, no public Redis.

## How to log in / talk to the bot

There is no web login. After deploy:

1. Open Telegram and search for the bot you created with BotFather.
2. Send `/start`.
3. `/status` shows whether the webhook registered and whether sessions are `redis` or `memory`.

`GET /` on the public domain returns JSON status. `GET /health` is the Railway healthcheck (HTTP 200).

## Why this is healthier than rotting marketplace clones

- **Pinned Node 20 image digest**, pinned `telegraf@4.16.3`, lockfile (`package-lock.json`). Not `:latest`.
- **Webhooks via `RAILWAY_PUBLIC_DOMAIN`**, not long polling (Railway dynos are not a good poll loop).
- **Required user `BOT_TOKEN`**, not a generated dummy that makes Telegram 401 and tanks template health.
- **`/health` healthcheck** with `restartPolicyType = ON_FAILURE`. The HTTP server binds **before** talking to Telegram, so a throwaway token still deploys SUCCESS.
- **Official Railway Redis over `REDIS_PRIVATE_URL`**, with a hard timeout and in-memory fallback. Not unpinned Bitnami, not a required public `REDIS_URL`.
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
