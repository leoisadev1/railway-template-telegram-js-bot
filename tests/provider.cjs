"use strict";

// Isolated CLI provider mock. Never contacts Telegram and never falls through to the SDK API.
const { Telegram, TelegramError } = require("telegraf");
let webhookUrl;
Telegram.prototype.callApi = async function (method, payload) {
  // Telegraf raises Telegram's {"ok":false,"error_code":401} reply for a rejected token as this error.
  if (process.env.TEST_PROVIDER_MODE === "invalid") throw new TelegramError({ ok: false, error_code: 401, description: "Unauthorized" }, { method });
  if (process.env.TEST_PROVIDER_MODE === "forbidden") throw new TelegramError({ ok: false, error_code: 421, description: "Misdirected Request: forbidden token specified" }, { method });
  if (process.env.TEST_PROVIDER_MODE === "outage") throw new Error("isolated provider outage");
  if (method === "getMe") return { id: 123, is_bot: true, username: "audit_bot", first_name: "Audit" };
  if (method === "setWebhook") { webhookUrl = payload.url; return true; }
  if (method === "getWebhookInfo") return { url: webhookUrl };
  throw new Error("Unexpected isolated provider call");
};
require("node:https").request = () => { throw new Error("Provider network access is forbidden in isolated tests"); };
