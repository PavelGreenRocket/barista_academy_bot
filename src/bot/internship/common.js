
const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// Shared state maps
const configStates = new Map(); // adminTelegramId -> { mode, ...payload }

function isAdmin(user) {
  return user && user.role === "admin";
}

function isTelegraphUrl(url) {
  if (!url) return false;
  const s = String(url).trim();
  return /^https?:\/\/(telegra\.ph|telegraph\.ph)\/[^\s]+$/i.test(s);
}

module.exports = {
  pool,
  Markup,
  deliver,
  configStates,
  isAdmin,
  isTelegraphUrl,
};
