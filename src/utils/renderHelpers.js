// src/utils/renderHelpers.js

const { menuMessageIds } = require("../flow/menuMap");
const { recordMessage, clearLastMessages } = require("./messageManagement");

// универсальная функция доставки/редактирования меню
async function deliver(ctx, { text, extra = {} }, { edit } = {}) {
  const chatId = ctx.chat.id;

  // Автоопределение edit:
  // - если явно передали edit, используем его
  // - иначе: если это callbackQuery (нажатие кнопки), пробуем редактировать
  const forceEdit =
    typeof edit === "boolean" ? edit : Boolean(ctx.callbackQuery);

  if (forceEdit) {
    const lastId = menuMessageIds.get(ctx.from.id);
    if (lastId) {
      try {
        // пробуем отредактировать предыдущее меню
        return await ctx.telegram.editMessageText(chatId, lastId, null, text, {
          parse_mode: "HTML",
          ...extra,
        });
      } catch (e) {
        // если редактирование не удалось — просто отправим новое сообщение
      }
    }
  }

  const hasKeyboard = Boolean(extra.reply_markup?.inline_keyboard);

  // отправляем новое сообщение
  const sent = await ctx.replyWithHTML(text, extra);

  // если это меню с inline-клавиатурой — запоминаем и подчистим хвост
  if (hasKeyboard) {
    recordMessage(ctx, sent.message_id);
    menuMessageIds.set(ctx.from.id, sent.message_id);
    await clearLastMessages(ctx, 3, [sent.message_id]);
  }

  return sent;
}

module.exports = {
  deliver,
};
