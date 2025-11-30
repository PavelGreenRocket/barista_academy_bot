// src/bot/train.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// состояние активных тестов
// key: telegram_id, value: { sessionId, mode, topicId, cards: [...], index, showAnswer, correctCount }
const trainSessions = new Map();

function clearTrainSession(userId) {
  trainSessions.delete(userId);
}

function setTrainSession(userId, session) {
  trainSessions.set(userId, session);
}

function getTrainSession(userId) {
  return trainSessions.get(userId);
}

// ---------- УРОВНИ ВОПРОСОВ / АТТЕСТАЦИЯ ----------

// определяем, какие уровни вопросов доступны пользователю по аттестации "теория база"
async function getUserTrainLevelInfo(userId) {
  const res = await pool.query(
    `
    SELECT uas.status
    FROM attestation_items ai
    LEFT JOIN user_attestation_status uas
      ON uas.item_id = ai.id AND uas.user_id = $1
    WHERE ai.is_active = TRUE
      AND lower(ai.title) = 'теория база'
    LIMIT 1
  `,
    [userId]
  );

  if (res.rows.length && res.rows[0].status === "passed") {
    // теория база сдана — открываем все уровни
    return {
      mode: "all",
      levelLabel: "🧠 все уровни",
      allowedLevels: [1, 2, 3],
    };
  }

  // по умолчанию — только базовый уровень
  return {
    mode: "base",
    levelLabel: "⭐ базовый уровень",
    allowedLevels: [1],
  };
}

// ---------- ВСПОМОГАТЕЛЬНЫЕ ЭКРАНЫ ----------

// ---------- ВСПОМОГАТЕЛЬНЫЕ ЭКРАНЫ ----------

async function showTrainMenu(ctx, userId, targetUserId = null) {
  // реальный пользователь, для которого смотрим уровень
  const realUserId = targetUserId ?? userId;

  const levelInfo = await getUserTrainLevelInfo(realUserId);

  const text =
    "🎯 Тренировки\n" +
    `(${levelInfo.levelLabel})\n\n` +
    "Выбери режим:\n" +
    "• Тест по одной теме\n" +
    "• Тест по всем темам\n" +
    "• История твоих тестов";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🧩 Тест по теме", "train_by_topic")],
    [Markup.button.callback("🌍 Тест по всем темам", "train_all_topics")],
    [Markup.button.callback("📜 История тестов", "train_history")],
    [Markup.button.callback("🔙 В главное меню", "back_main")],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function getTopics() {
  const res = await pool.query(
    "SELECT id, title FROM topics ORDER BY order_index, id"
  );
  return res.rows;
}

async function getBlocksByTopic(topicId) {
  const res = await pool.query(
    "SELECT id, title FROM blocks WHERE topic_id = $1 ORDER BY order_index, id",
    [topicId]
  );
  return res.rows;
}

async function getAllBlocks() {
  const res = await pool.query(
    "SELECT id, topic_id FROM blocks ORDER BY topic_id, order_index, id"
  );
  return res.rows;
}

// теперь фильтруем по уровню сложности
async function getCardsByBlock(blockId, allowedLevels) {
  const res = await pool.query(
    `
    SELECT id
    FROM cards
    WHERE block_id = $1
      AND COALESCE(difficulty, 1) = ANY($2)
    ORDER BY random()
  `,
    [blockId, allowedLevels]
  );
  return res.rows.map((r) => r.id);
}

// алгоритм распределения вопросов по блокам с лимитом 50
function selectCardsWithLimit(blockIdToCardsIds, basePerBlock, maxQuestions) {
  // blockIdToCardsIds: Map(blockId -> [cardId1, cardId2, ...] в случайном порядке)
  const blockIds = [...blockIdToCardsIds.keys()].filter(
    (id) => blockIdToCardsIds.get(id).length > 0
  );
  if (!blockIds.length) return [];

  // начальные квоты: не больше basePerBlock и не больше количества карточек
  const quotas = {};
  let totalIdeal = 0;
  for (const blockId of blockIds) {
    const cards = blockIdToCardsIds.get(blockId);
    const q = Math.min(basePerBlock, cards.length);
    quotas[blockId] = q;
    totalIdeal += q;
  }

  if (totalIdeal <= maxQuestions) {
    // всё помещается, используем как есть
    const result = [];
    for (const blockId of blockIds) {
      const cards = blockIdToCardsIds.get(blockId);
      const q = quotas[blockId];
      for (let i = 0; i < q; i++) {
        result.push({ blockId, cardId: cards[i] });
      }
    }
    // перемешаем порядок
    shuffleInPlace(result);
    return result;
  }

  // нужно ужать до maxQuestions
  const M = blockIds.length;
  const base = Math.max(1, Math.floor(maxQuestions / M));

  const newQuotas = {};
  let sum = 0;
  for (const blockId of blockIds) {
    const maxForBlock = quotas[blockId];
    const q = Math.min(base, maxForBlock);
    newQuotas[blockId] = q;
    sum += q;
  }

  let remaining = maxQuestions - sum;

  // распределяем оставшиеся вопросы по блокам, где ещё есть запас
  while (remaining > 0) {
    let progressed = false;
    const randomOrder = [...blockIds];
    shuffleInPlace(randomOrder);

    for (const blockId of randomOrder) {
      if (remaining <= 0) break;
      if (newQuotas[blockId] < quotas[blockId]) {
        newQuotas[blockId] += 1;
        remaining -= 1;
        progressed = true;
        if (remaining <= 0) break;
      }
    }

    if (!progressed) break; // больше добавить некуда
  }

  const result = [];
  for (const blockId of blockIds) {
    const cards = blockIdToCardsIds.get(blockId);
    const q = newQuotas[blockId] || 0;
    for (let i = 0; i < q; i++) {
      result.push({ blockId, cardId: cards[i] });
    }
  }
  shuffleInPlace(result);
  return result;
}

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// грузим данные по выбранным карточкам (текст вопросов/ответов)
async function loadCardsDetails(cardPairs) {
  const ids = [...new Set(cardPairs.map((p) => p.cardId))];
  if (!ids.length) return [];

  const res = await pool.query(
    "SELECT id, question, answer, difficulty FROM cards WHERE id = ANY($1)",
    [ids]
  );

  const byId = new Map();
  for (const row of res.rows) {
    byId.set(row.id, row);
  }

  // вернём массив в том порядке, в котором будут задаваться вопросы
  return cardPairs
    .map((p) => {
      const row = byId.get(p.cardId);
      if (!row) return null;
      return {
        id: row.id,
        blockId: p.blockId,
        question: row.question,
        answer: row.answer,
        difficulty: row.difficulty || 1,
      };
    })
    .filter(Boolean);
}

// рендер текущего вопроса
async function renderCurrentTrainCard(ctx, userId) {
  const session = getTrainSession(userId);
  if (!session || !session.cards || !session.cards.length) {
    await ctx.reply("Тест не найден. Начни заново из раздела «Тренировки».");
    return;
  }

  const { cards, index, showAnswer } = session;
  if (index < 0 || index >= cards.length) {
    await ctx.reply("Вопросы закончились.");
    clearTrainSession(userId);
    return;
  }

  const card = cards[index];
  const total = cards.length;
  const humanIndex = index + 1;

  const level = card.difficulty || 1;
  const levelIcon = level === 1 ? "⭐" : level === 2 ? "⭐⭐" : "⭐⭐⭐";

  let text =
    `${levelIcon} Вопрос ${humanIndex}/${total}\n\n` + `❓ ${card.question}`;

  if (showAnswer) {
    text += `\n\n💡 Ответ:\n${card.answer}\n\n`;
    text += "Отметь, как ты ответил:";
  }

  const buttons = [];

  if (!showAnswer) {
    buttons.push([
      Markup.button.callback("👁 Показать ответ", "train_show_answer"),
    ]);
  } else {
    buttons.push([
      Markup.button.callback("✅ Верно", "train_mark_correct"),
      Markup.button.callback("❌ Не вспомнил", "train_mark_wrong"),
    ]);
  }

  buttons.push([Markup.button.callback("🔙 В тренировки", "user_train")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// ---------- РЕГИСТРАЦИЯ КОМАНД ----------

function registerTrain(bot, ensureUser, logError) {
  // кнопка «🎯 Тренировки» из главного меню
  bot.action("user_train", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      clearTrainSession(ctx.from.id);
      await showTrainMenu(ctx, user.id);
    } catch (err) {
      logError("user_train", err);
      await ctx.reply("Не удалось открыть тренировки. Попробуй позже.");
    }
  });

  // /train как альтернатива
  bot.command("train", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      clearTrainSession(ctx.from.id);
      await showTrainMenu(ctx, user.id);
    } catch (err) {
      logError("/train", err);
      await ctx.reply("Не удалось открыть тренировки. Попробуй позже.");
    }
  });

  // выбор режима: тест по теме
  bot.action("train_by_topic", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      const userId = user.id;

      clearTrainSession(ctx.from.id);

      const topics = await getTopics();
      if (!topics.length) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("🔙 В тренировки", "user_train")],
        ]);
        await deliver(
          ctx,
          {
            text: "Тем пока нет. Обратись к администратору.",
            extra: keyboard,
          },
          { edit: true }
        );
        return;
      }

      const text = "Выбери тему для теста:";
      const buttons = topics.map((t) => [
        Markup.button.callback(t.title, `train_topic_${t.id}`),
      ]);
      buttons.push([Markup.button.callback("🔙 В тренировки", "user_train")]);

      // сохранять levelInfo в сессии тут не обязательно — мы вычислим его ещё раз при старте теста
      await deliver(
        ctx,
        { text, extra: Markup.inlineKeyboard(buttons) },
        { edit: true }
      );
    } catch (err) {
      logError("train_by_topic", err);
    }
  });

  // запуск теста по конкретной теме
  bot.action(/train_topic_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);

      const targetUserId = ctx.session?.adminTestingUser || admin.id;
      const conductedBy = ctx.session?.adminTestingUser ? admin.id : null;
      clearTrainSession(ctx.from.id);

      const levelInfo = await getUserTrainLevelInfo(targetUserId);

      const topicId = parseInt(ctx.match[1], 10);
      const blocks = await getBlocksByTopic(topicId);

      if (!blocks.length) {
        await ctx.reply("В этой теме пока нет блоков.");
        return;
      }

      // собираем карточки по блокам
      const blockIdToCardsIds = new Map();
      for (const b of blocks) {
        const ids = await getCardsByBlock(b.id, levelInfo.allowedLevels);
        if (ids.length) {
          blockIdToCardsIds.set(b.id, ids);
        }
      }

      if (!blockIdToCardsIds.size) {
        await ctx.reply("В этой теме пока нет карточек.");
        return;
      }

      // по идее 3 вопроса с блока, но с лимитом 50
      const pairs = selectCardsWithLimit(blockIdToCardsIds, 3, 50);
      const cards = await loadCardsDetails(pairs);
      if (!cards.length) {
        await ctx.reply("Не удалось собрать вопросы для теста.");
        return;
      }

      // создаём сессию в БД
      const sessionRes = await pool.query(
        `INSERT INTO test_sessions (user_id, mode, topic_id, question_count, correct_count, conducted_by)
   VALUES ($1, 'topic', $2, $3, 0, $4)
   RETURNING id`,
        [targetUserId, topicId, cards.length, conductedBy]
      );

      const sessionId = sessionRes.rows[0].id;

      setTrainSession(ctx.from.id, {
        sessionId,
        mode: "topic",
        topicId,
        cards,
        index: 0,
        showAnswer: false,
        correctCount: 0,
      });

      await renderCurrentTrainCard(ctx, ctx.from.id);
    } catch (err) {
      logError("train_topic_x", err);
      await ctx.reply("Не удалось запустить тест по теме.");
    }
  });

  // выбор режима: тест по всем темам
  bot.action("train_all_topics", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);

      const targetUserId = ctx.session?.adminTestingUser || admin.id;
      const conductedBy = ctx.session?.adminTestingUser ? admin.id : null;

      clearTrainSession(ctx.from.id);

      const levelInfo = await getUserTrainLevelInfo(targetUserId);

      const blocks = await getAllBlocks();
      if (!blocks.length) {
        await ctx.reply("Пока нет ни одного блока с теорией.");
        return;
      }

      const blockIdToCardsIds = new Map();
      for (const b of blocks) {
        const ids = await getCardsByBlock(b.id, levelInfo.allowedLevels);
        if (ids.length) {
          blockIdToCardsIds.set(b.id, ids);
        }
      }

      if (!blockIdToCardsIds.size) {
        await ctx.reply("Пока нет ни одной карточки.");
        return;
      }

      // по идее 2 вопроса с блока, но с лимитом 50
      const pairs = selectCardsWithLimit(blockIdToCardsIds, 2, 50);
      const cards = await loadCardsDetails(pairs);
      if (!cards.length) {
        await ctx.reply("Не удалось собрать вопросы для теста.");
        return;
      }

      const sessionRes = await pool.query(
        `INSERT INTO test_sessions (user_id, mode, topic_id, question_count, correct_count, conducted_by)
   VALUES ($1, 'all', NULL, $2, 0, $3)
   RETURNING id`,
        [targetUserId, cards.length, conductedBy]
      );

      const sessionId = sessionRes.rows[0].id;

      setTrainSession(ctx.from.id, {
        sessionId,
        mode: "all",
        topicId: null,
        cards,
        index: 0,
        showAnswer: false,
        correctCount: 0,
      });

      await renderCurrentTrainCard(ctx, ctx.from.id);
    } catch (err) {
      logError("train_all_topics", err);
      await ctx.reply("Не удалось запустить общий тест.");
    }
  });

  // показать ответ
  bot.action("train_show_answer", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const session = getTrainSession(ctx.from.id);
      if (!session) {
        await ctx.reply(
          "Тест не найден. Начни заново из раздела «Тренировки»."
        );
        return;
      }
      session.showAnswer = true;
      setTrainSession(ctx.from.id, session);
      await renderCurrentTrainCard(ctx, ctx.from.id);
    } catch (err) {
      logError("train_show_answer", err);
    }
  });

  // отметка: верно / не верно
  async function handleMark(ctx, isCorrect) {
    const session = getTrainSession(ctx.from.id);
    if (!session) {
      await ctx.reply("Тест не найден. Начни заново из раздела «Тренировки».");
      return;
    }

    const { sessionId, cards, index } = session;
    if (index < 0 || index >= cards.length) {
      await ctx.reply("Вопросы уже закончились.");
      clearTrainSession(ctx.from.id);
      return;
    }

    const card = cards[index];
    const position = index + 1;

    try {
      // записываем ответ в БД
      await pool.query(
        `INSERT INTO test_session_answers (session_id, card_id, position, is_correct)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, card.id, position, isCorrect]
      );

      if (isCorrect) {
        session.correctCount += 1;
        await pool.query(
          "UPDATE test_sessions SET correct_count = correct_count + 1 WHERE id = $1",
          [sessionId]
        );
      }

      // переходим к следующему вопросу
      if (index < cards.length - 1) {
        session.index += 1;
        session.showAnswer = false;
        setTrainSession(ctx.from.id, session);
        await renderCurrentTrainCard(ctx, ctx.from.id);
      } else {
        // тест завершён
        const total = cards.length;
        const correct = session.correctCount;
        const percent = total > 0 ? Math.round((correct / total) * 100) : 0;

        clearTrainSession(ctx.from.id);

        const text =
          "✅ Тест завершён.\n\n" +
          `Результат: ${correct} из ${total} (${percent}%).`;

        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("🎯 Ещё тест", "user_train")],
          [Markup.button.callback("🔙 В главное меню", "back_main")],
        ]);

        await deliver(ctx, { text, extra: keyboard }, { edit: true });
      }
    } catch (err) {
      logError("train_mark_answer", err);
      await ctx.reply("Не удалось сохранить результат ответа.");
    }
  }

  bot.action("train_mark_correct", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await handleMark(ctx, true);
  });

  bot.action("train_mark_wrong", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await handleMark(ctx, false);
  });

  // история тестов пользователя
  bot.action("train_history", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      const userId = user.id;

      const res = await pool.query(
        `SELECT ts.id,
                ts.mode,
                ts.topic_id,
                ts.question_count,
                ts.correct_count,
                ts.created_at,
                t.title AS topic_title
         FROM test_sessions ts
         LEFT JOIN topics t ON ts.topic_id = t.id
         WHERE ts.user_id = $1
         ORDER BY ts.created_at DESC
         LIMIT 10`,
        [userId]
      );

      if (!res.rows.length) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("🔙 В тренировки", "user_train")],
        ]);
        await deliver(
          ctx,
          {
            text: "Ты ещё не проходил ни одного теста.",
            extra: keyboard,
          },
          { edit: true }
        );
        return;
      }

      let text = "📜 Твои последние тесты:\n\n";

      for (const row of res.rows) {
        const date = row.created_at.toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });

        const modeLabel =
          row.mode === "topic"
            ? `по теме: "${row.topic_title || "Без названия"}"`
            : "по всем темам";

        const total = row.question_count;
        const correct = row.correct_count;
        const percent = total > 0 ? Math.round((correct / total) * 100) : 0;

        text +=
          `• ${date} — ${modeLabel}\n` +
          `  Результат: ${correct}/${total} (${percent}%)\n\n`;
      }

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 В тренировки", "user_train")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("train_history", err);
      await ctx.reply("Не удалось получить историю тестов.");
    }
  });
}

module.exports = registerTrain;
