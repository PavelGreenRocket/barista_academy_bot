// src/flow/menuMap.js

// id последнего "меню" для каждого пользователя
const menuMessageIds = new Map();

// история отправленных сообщений (чтобы иметь что удалять)
const messageHistory = new Map();

module.exports = {
  menuMessageIds,
  messageHistory,
};
