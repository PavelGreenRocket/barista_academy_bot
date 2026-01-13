// src/bot/adminCards.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// key: telegram_id, value: { step, blockId?, cardId?, tmpQuestion?, difficulty? }
const cardStates = new Map();

function isAdmin(user) {
  return user && user.role === "admin" || user.role === "super_admin";
}

function setCardState(userId, state) {
  cardStates.set(userId, state);
}

function clearCardState(userId) {
  cardStates.delete(userId);
}

async function showBlockCards(ctx, blockId) {
  const blockRes = await pool.query(
    `SELECT b.id, b.title, b.topic_id, t.title AS topic_title
     FROM blocks b
     JOIN topics t ON b.topic_id = t.id
     WHERE b.id = $1`,
    [blockId]
  );
  if (!blockRes.rows.length) {
    await ctx.reply("Блок не найден.");
    return;
  }
  const block = blockRes.rows[0];

  const cardsRes = await pool.query(
    "SELECT id, question, difficulty FROM cards WHERE block_id = $1 ORDER BY id",
    [blockId]
  );

  let text = `🃏 Карточки блока: "${block.title}"\nТема: "${block.topic_title}"\n\n`;

  if (!cardsRes.rows.length) {
    text += "В этом блоке пока нет карточек.";
  } else {
    text += "Список карточек:\n\n";
  }

  const buttons = [];

  for (const row of cardsRes.rows) {
    const shortQ =
      row.question.length > 40
        ? row.question.slice(0, 37) + "..."
        : row.question;

    const level = row.difficulty || 1;
    const icon = level === 1 ? "⭐" : level === 2 ? "⭐⭐" : "⭐⭐⭐";

    buttons.push([
      Markup.button.callback(`${icon} ${shortQ}`, `admin_card_${row.id}`),
      Markup.button.callback("🗑", `admin_delete_card_${row.id}`),
    ]);
  }

  buttons.push([
    Markup.button.callback("➕ Новая карточка", `admin_new_card_${blockId}`),
  ]);
  buttons.push([
    Markup.button.callback("🔙 К блоку", `admin_block_${blockId}`),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

function registerAdminCardCommands(bot, ensureUser, logError) {
  // открыть карточки блока из admin.js
  bot.action(/admin_block_cards_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const blockId = parseInt(ctx.match[1], 10);
      clearCardState(ctx.from.id);
      await showBlockCards(ctx, blockId);
    } catch (err) {
      logError("admin_block_cards_x", err);
    }
  });

  // новая карточка — сначала выбор уровня
  bot.action(/admin_new_card_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const blockId = parseInt(ctx.match[1], 10);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⭐ Базовый",
            `admin_new_card_level_${blockId}_1`
          ),
        ],
        [
          Markup.button.callback(
            "⭐⭐ Средний",
            `admin_new_card_level_${blockId}_2`
          ),
        ],
        [
          Markup.button.callback(
            "⭐⭐⭐ Продвинутый",
            `admin_new_card_level_${blockId}_3`
          ),
        ],
        [
          Markup.button.callback(
            "🔙 К карточкам",
            `admin_block_cards_${blockId}`
          ),
        ],
      ]);

      await deliver(
        ctx,
        {
          text: "Выбери уровень вопроса:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_new_card_x", err);
    }
  });

  // выбор уровня новой карточки → ждём текст вопроса
  bot.action(/admin_new_card_level_(\d+)_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const blockId = parseInt(ctx.match[1], 10);
      const difficulty = parseInt(ctx.match[2], 10);

      setCardState(ctx.from.id, {
        step: "await_card_question",
        blockId,
        difficulty,
      });

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔙 К карточкам",
            `admin_block_cards_${blockId}`
          ),
        ],
      ]);

      await deliver(
        ctx,
        {
          text: "✏ Введи текст вопроса для новой карточки одним сообщением:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_new_card_level_x", err);
    }
  });

  // экран конкретной карточки
  bot.action(/admin_card_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const cardId = parseInt(ctx.match[1], 10);

      const res = await pool.query(
        `SELECT c.id,
                c.block_id,
                c.question,
                c.answer,
                c.check_type,
                c.explanation,
                c.difficulty,
                b.title AS block_title,
                t.title AS topic_title
         FROM cards c
         JOIN blocks b ON c.block_id = b.id
         JOIN topics t ON b.topic_id = t.id
         WHERE c.id = $1`,
        [cardId]
      );
      if (!res.rows.length) {
        await ctx.reply("Карточка не найдена.");
        return;
      }
      const card = res.rows[0];

      const level = card.difficulty || 1;
      const levelLabel =
        level === 1
          ? "⭐ Базовый"
          : level === 2
          ? "⭐⭐ Средний"
          : "⭐⭐⭐ Продвинутый";

      let text =
        `🃏 Карточка\n` +
        `Тема: ${card.topic_title}\n` +
        `Блок: ${card.block_title}\n` +
        `Уровень: ${levelLabel}\n\n` +
        `❓ Вопрос:\n${card.question}\n\n` +
        `💡 Ответ:\n${card.answer}`;

      if (card.explanation) {
        text += `\n\nℹ️ Пояснение:\n${card.explanation}`;
      }

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✏ Вопрос",
            `admin_edit_card_question_${card.id}`
          ),
          Markup.button.callback(
            "✏ Ответ",
            `admin_edit_card_answer_${card.id}`
          ),
        ],
        [
          Markup.button.callback(
            "✏ Пояснение",
            `admin_edit_card_expl_${card.id}`
          ),
        ],
        [Markup.button.callback("🗑 Удалить", `admin_delete_card_${card.id}`)],
        [
          Markup.button.callback(
            "🔙 К карточкам блока",
            `admin_block_cards_${card.block_id}`
          ),
        ],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_card_x", err);
    }
  });

  // удаление карточки
  bot.action(/admin_delete_card_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const cardId = parseInt(ctx.match[1], 10);

      const res = await pool.query(
        "DELETE FROM cards WHERE id = $1 RETURNING block_id",
        [cardId]
      );
      if (!res.rows.length) {
        await ctx.reply("Карточка не найдена.");
        return;
      }

      const blockId = res.rows[0].block_id;
      clearCardState(ctx.from.id);
      await showBlockCards(ctx, blockId);
    } catch (err) {
      logError("admin_delete_card_x", err);
    }
  });

  // редактирование: вопрос
  bot.action(/admin_edit_card_question_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const cardId = parseInt(ctx.match[1], 10);

      const res = await pool.query(
        "SELECT id, block_id, question FROM cards WHERE id = $1",
        [cardId]
      );
      if (!res.rows.length) {
        await ctx.reply("Карточка не найдена.");
        return;
      }
      const card = res.rows[0];

      setCardState(ctx.from.id, {
        step: "await_edit_question",
        cardId,
        blockId: card.block_id,
      });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К карточке", `admin_card_${card.id}`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            "✏ Введи НОВЫЙ текст вопроса одним сообщением:\n\n" +
            `Сейчас: ${card.question}`,
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_edit_card_question_x", err);
    }
  });

  // редактирование: ответ
  bot.action(/admin_edit_card_answer_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const cardId = parseInt(ctx.match[1], 10);

      const res = await pool.query(
        "SELECT id, block_id, answer FROM cards WHERE id = $1",
        [cardId]
      );
      if (!res.rows.length) {
        await ctx.reply("Карточка не найдена.");
        return;
      }
      const card = res.rows[0];

      setCardState(ctx.from.id, {
        step: "await_edit_answer",
        cardId,
        blockId: card.block_id,
      });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К карточке", `admin_card_${card.id}`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            "✏ Введи НОВЫЙ текст ответа одним сообщением:\n\n" +
            `Сейчас:\n${card.answer}`,
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_edit_card_answer_x", err);
    }
  });

  // редактирование: пояснение
  bot.action(/admin_edit_card_expl_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const cardId = parseInt(ctx.match[1], 10);

      const res = await pool.query(
        "SELECT id, block_id, explanation FROM cards WHERE id = $1",
        [cardId]
      );
      if (!res.rows.length) {
        await ctx.reply("Карточка не найдена.");
        return;
      }
      const card = res.rows[0];

      setCardState(ctx.from.id, {
        step: "await_edit_expl",
        cardId,
        blockId: card.block_id,
      });

      const current = card.explanation || "— пусто —";

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К карточке", `admin_card_${card.id}`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            "✏ Введи НОВОЕ пояснение одним сообщением:\n\n" +
            `Сейчас:\n${current}`,
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_edit_card_expl_x", err);
    }
  });

  // ----- ТЕКСТОВЫЕ ШАГИ -----
  bot.on("text", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const state = cardStates.get(ctx.from.id);
      if (!state) return next();

      const text = (ctx.message.text || "").trim();
      if (!text) return next();

      // создание карточки: вопрос
      if (state.step === "await_card_question") {
        const { blockId, difficulty } = state;
        setCardState(ctx.from.id, {
          step: "await_card_answer",
          blockId,
          difficulty: difficulty || 1,
          tmpQuestion: text,
        });

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔙 К карточкам",
              `admin_block_cards_${blockId}`
            ),
          ],
        ]);

        await ctx.reply(
          "✏ Теперь введи текст ОТВЕТА для этой карточки одним сообщением:",
          keyboard
        );
        return;
      }

      // создание карточки: ответ
      if (state.step === "await_card_answer") {
        const { blockId, tmpQuestion, difficulty } = state;
        await pool.query(
          `INSERT INTO cards (block_id, question, answer, check_type, explanation, difficulty)
           VALUES ($1, $2, $3, 'free', '', $4)`,
          [blockId, tmpQuestion, text, difficulty || 1]
        );

        clearCardState(ctx.from.id);
        await showBlockCards(ctx, blockId);
        return;
      }

      // редактирование вопроса
      if (state.step === "await_edit_question") {
        const { cardId, blockId } = state;
        await pool.query("UPDATE cards SET question = $1 WHERE id = $2", [
          text,
          cardId,
        ]);
        clearCardState(ctx.from.id);
        await showBlockCards(ctx, blockId);
        return;
      }

      // редактирование ответа
      if (state.step === "await_edit_answer") {
        const { cardId, blockId } = state;
        await pool.query("UPDATE cards SET answer = $1 WHERE id = $2", [
          text,
          cardId,
        ]);
        clearCardState(ctx.from.id);
        await showBlockCards(ctx, blockId);
        return;
      }

      // редактирование пояснения
      if (state.step === "await_edit_expl") {
        const { cardId, blockId } = state;
        await pool.query("UPDATE cards SET explanation = $1 WHERE id = $2", [
          text,
          cardId,
        ]);
        clearCardState(ctx.from.id);
        await showBlockCards(ctx, blockId);
        return;
      }

      return next();
    } catch (err) {
      logError("admin_card_text_handler", err);
      return next();
    }
  });
}

module.exports = registerAdminCardCommands;
