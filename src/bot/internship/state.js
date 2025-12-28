// src/internship/state.js
"use strict";

/**
 * Состояния админских сценариев стажировки.
 * Важно: это in-memory Map, поведение должно остаться ровно как было в internship.js.
 */

// состояние для настройки (ожидание названия / документа)
const configStates = new Map(); // key: adminTelegramId → { mode, partId?, sectionId?, stepId?, title?, durationMin? }

// состояние ожидания медиа по этапам
const mediaStates = new Map(); // key: adminTelegramId → { sessionId, sectionId, stepId, type, userId }

// состояние для завершения стажировки (замечания и комментарий)
const finishSessionStates = new Map(); // key: adminTelegramId → { mode, sessionId, userId, issuesText? }

// состояние для комментариев по стажировке (как в ЛК)
const internshipCommentStates = new Map(); // key: adminTelegramId → { sessionId, userId }

function isAdmin(user) {
  return user && user.role === "admin";
}

function isTelegraphUrl(url) {
  if (!url) return false;
  const s = String(url).trim();
  // допускаем telegra.ph / telegraph.ph
  return /^https?:\/\/(telegra\.ph|telegraph\.ph)\/[^\s]+$/i.test(s);
}

module.exports = {
  configStates,
  mediaStates,
  finishSessionStates,
  internshipCommentStates,
  isAdmin,
  isTelegraphUrl,
};
