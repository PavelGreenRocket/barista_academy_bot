// src/bot/adminUsers.js

const { registerAdminUsersList } = require("./adminUsers/list");
const { registerAdminAiLogs } = require("./adminUsers/aiLogs");
const { registerAdminUsersSearch } = require("./adminUsers/search");
//const { registerAdminUsersPerf } = require("./adminUsers/perf");

function registerAdminUsers(bot, ensureUser, logError) {
  // Подключаем все подмодули административного раздела пользователей
  registerAdminUsersList(bot, ensureUser, logError);
  registerAdminAiLogs(bot, ensureUser, logError);
  registerAdminUsersSearch(bot, ensureUser, logError);
  //registerAdminUsersPerf(bot, ensureUser, logError);
}

module.exports = registerAdminUsers;
