// src/utils/renderHelpers.js

const { menuMessageIds } = require("../flow/menuMap");
const { recordMessage, clearLastMessages } = require("./messageManagement");

// универсальная функция доставки/редактирования меню
async function deliver(ctx, { text, extra = {} }, { edit } = {}) {
  // В callbackQuery для inline-сообщений (когда меню было отправлено через inline-mode)
  // может не быть ctx.chat / ctx.message. Тогда редактируем по inline_message_id.
  const chatId = ctx.chat?.id;

  // Автоопределение edit:
  // - если явно передали edit, используем его
  // - иначе: если это callbackQuery (нажатие кнопки), пробуем редактировать
  const forceEdit =
    typeof edit === "boolean" ? edit : Boolean(ctx.callbackQuery);

  if (forceEdit) {
    const inlineMessageId = ctx.callbackQuery?.inline_message_id;
    if (inlineMessageId) {
      try {
        // редактируем inline-сообщение
        return await ctx.telegram.editMessageText(
          undefined,
          undefined,
          inlineMessageId,
          text,
          {
            parse_mode: "HTML",
            ...extra,
          }
        );
      } catch (e) {
        // fallthrough
      }
    }

    const lastId = menuMessageIds.get(ctx.from.id);
    if (lastId) {
      try {
        // пробуем отредактировать предыдущее меню
        if (!chatId) throw new Error("chatId is missing");
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
  // если chatId отсутствует (inline callback) — отправить новое сообщение нельзя
  if (!chatId) return;

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
