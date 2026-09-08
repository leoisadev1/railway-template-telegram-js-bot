"use strict";

// Isolated CLI provider mock. Never contacts Telegram and never falls through to the SDK API.
const { Telegram } = require("telegraf");
let webhookUrl;
Telegram.prototype.callApi = async function (method, payload) {
  if (process.env.TEST_PROVIDER_MODE === "invalid") throw new Error("401 isolated provider rejection");
  if (method === "getMe") return { id: 123, is_bot: true, username: "audit_bot", first_name: "Audit" };
  if (method === "setWebhook") { webhookUrl = payload.url; return true; }
  if (method === "getWebhookInfo") return { url: webhookUrl };
  throw new Error("Unexpected isolated provider call");
};
require("node:https").request = () => { throw new Error("Provider network access is forbidden in isolated tests"); };
