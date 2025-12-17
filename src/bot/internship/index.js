// src/internship/index.js
"use strict";

/**
 * Тонкий входной модуль стажировки.
 * Экспортируем ровно то, что раньше экспортировал большой internship.js,
 * чтобы подключение в боте осталось 1-в-1.
 */

const {
  registerInternship,
  hasActiveInternshipSessionForTrainer,
} = require("./actions");

module.exports = {
  registerInternship,
  hasActiveInternshipSessionForTrainer,
};
