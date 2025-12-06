// src/bot/assistant.js

const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");
const GigaChat = require("gigachat").default;
console.log(
  "GIGACHAT_CREDENTIALS length =",
  (process.env.GIGACHAT_CREDENTIALS || "").length
);
console.log("GIGACHAT_SCOPE =", process.env.GIGACHAT_SCOPE);
console.log("GIGACHAT_MODEL =", process.env.GIGACHAT_MODEL);
const pool = require("../db/pool");
const { getRelevantChunks } = require("./knowledge");
const { Agent } = require("node:https");

// агент, чтобы не заморачиваться с сертификатами (как в доке GigaChat)
const httpsAgent = new Agent({
  rejectUnauthorized: false,
});

const gigaClient = new GigaChat({
  timeout: 60,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  credentials: process.env.GIGACHAT_CREDENTIALS,
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  httpsAgent,
});

// состояние: ждём вопрос от конкретного пользователя (по telegram_id)
const questionState = new Set();
const MAX_AI_LOGS = 500; // сколько последних обращений к ИИ храним в БД

/**
 * Вызов GigaChat: короткий ответ на вопрос бариста
 */
// теперь ассистент опирается на базу знаний
async function getAssistantAnswer(question) {
  // 1) ищем подходящие фрагменты теории
  const chunks = await getRelevantChunks(question, 5);

  if (!chunks.length) {
    // в базе нет ничего похожего
    return (
      "Я не нашёл подходящего ответа в учебной базе. " +
      "Пожалуйста, обратись к наставнику или загляни в методичку."
    );
  }

  const contextText = chunks
    .map(
      (ch, idx) =>
        `[Фрагмент ${idx + 1} из источника "${ch.source}"]\n` + ch.text
    )
    .join("\n\n---\n\n");

  const resp = await gigaClient.chat({
    messages: [
      {
        role: "system",
        content:
          "Ты — наставник по обучению бариста в кофейне. " +
          "Отвечай строго на основе приведённых ниже фрагментов учебной базы. " +
          "Не выдумывай факты, которых там нет. если сомневаешься в ответе, к своему ответу можешь приложить контакты  менедежера по качеству либо старшего администратора, в зависимости от вопроса " +
          "Если информации недостаточно, честно скажи, что по базе нет точного ответа. и дай контакты  менедежера по качеству либо главному администратору, в зависимости от вопроса" +
          "Если вопрос связан с качеством, техникой приготовления (например приготовление напитков), правилами сервиса, или с теоретической базой, в случае если нет подходящего ответа, можно обратится к менеджеру по качеству +7 913 457 5883 (Шах), По всем другим вопросам к клавному администратору @k0nfe11ka (Ярославе).",
      },
      {
        role: "user",
        content:
          "Вопрос бариста:\n" +
          question +
          "\n\nВот выдержки из учебной базы:\n\n" +
          contextText +
          "\n\nСформулируй короткий и понятный ответ, опираясь только на эти фрагменты.",
      },
    ],
    temperature: 0.3,
    max_tokens: 400,
  });

  const answer = resp.choices?.[0]?.message?.content || "";
  return answer.trim();
}

/**
 * Регистрация хендлеров ассистента
 */
function registerAssistant(bot, ensureUser, logError) {
  // 1) Пользователь нажал кнопку "Вопрос по обучению"
  bot.action("user_ask_question", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      questionState.add(ctx.from.id);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 В меню", "back_main")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "❓ Задай свой вопрос по обучению бариста.\n\n" +
            "Например:\n" +
            "• почему кофе получается кислым?\n" +
            "• как понять, что молоко взбито правильно?\n" +
            "• что делать, если эспрессо течёт слишком быстро?\n\n" +
            "Напиши вопрос одним сообщением.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("user_ask_question", err);
    }
  });

  // 2) Перехватываем текст, если ждём вопрос
  bot.on("text", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return next();

      if (!questionState.has(ctx.from.id)) {
        return next();
      }

      // это вопрос для ассистента
      questionState.delete(ctx.from.id);

      const question = (ctx.message.text || "").trim();
      if (!question) {
        await ctx.reply("Вопрос пустой. Напиши его словами 🙂");
        return;
      }

      // сообщение-заглушка, пока думаем
      const thinkingMsg = await ctx.reply("Думаю над ответом…");

      let answer;
      try {
        answer = await getAssistantAnswer(question);
      } catch (err) {
        logError("getAssistantAnswer", err);
        await ctx.telegram.editMessageText(
          thinkingMsg.chat.id,
          thinkingMsg.message_id,
          undefined,
          "Не удалось получить подсказку от ассистента. Попробуй ещё раз позже."
        );
        return;
      }

      // ---- ЛОГИРУЕМ ОБЩЕНИЕ С ИИ ----
      try {
        // user мы уже получили в начале handler'а: const user = await ensureUser(ctx);
        await pool.query(
          `
          INSERT INTO ai_chat_logs (user_id, question, answer)
          VALUES ($1, $2, $3)
          `,
          [user.id, question, answer]
        );

        // оставляем в таблице только 20 последних записей (глобально)
        await pool.query(`
          DELETE FROM ai_chat_logs
          WHERE id NOT IN (
            SELECT id
            FROM ai_chat_logs
            ORDER BY created_at DESC
            LIMIT 20
          )
        `);
      } catch (err) {
        logError("ai_chat_logs_insert", err);
      }
      // ---- КОНЕЦ ЛОГИРОВАНИЯ ----

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("❓ Задать ещё вопрос", "user_ask_question")],
        [Markup.button.callback("🔙 В меню", "back_main")],
      ]);

      await ctx.telegram.editMessageText(
        thinkingMsg.chat.id,
        thinkingMsg.message_id,
        undefined,
        `❓ Твой вопрос:\n${question}\n\n💡 Подсказка:\n${answer}`,
        {
          reply_markup: keyboard.reply_markup,
        }
      );
    } catch (err) {
      logError("assistant_on_text", err);
      return next();
    }
  });
}

module.exports = {
  registerAssistant,
};
