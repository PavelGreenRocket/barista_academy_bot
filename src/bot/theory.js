// src/bot/theory.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// состояние сессий карточек в теории: по пользователю
// key: telegram_id, value: { topicId, blockId, cards: [...], index, showAnswer }
const theorySessions = new Map();

function clearSession(userId) {
  theorySessions.delete(userId);
}

function setSession(userId, session) {
  theorySessions.set(userId, session);
}

function getSession(userId) {
  return theorySessions.get(userId);
}

// ---------- ПРОГРЕСС ПО ТЕМАМ / БЛОКАМ ----------

// получаем прогресс по всем темам для конкретного пользователя
async function getTopicsProgress(userId) {
  const res = await pool.query(
    `
    SELECT
      t.id,
      t.title,
      t.order_index,
      t.pdf_file,
      COUNT(b.id) AS total_blocks,
      COALESCE(
        SUM(
          CASE WHEN ubs.status = 'passed' THEN 1 ELSE 0 END
        ),
        0
      ) AS passed_blocks
    FROM topics t
    LEFT JOIN blocks b
      ON b.topic_id = t.id
    LEFT JOIN user_block_status ubs
      ON ubs.block_id = b.id AND ubs.user_id = $1
    GROUP BY t.id, t.title, t.order_index, t.pdf_file
    ORDER BY t.order_index, t.id
  `,
    [userId]
  );

  return res.rows.map((row) => {
    const total = Number(row.total_blocks) || 0;
    const passed = Number(row.passed_blocks) || 0;
    const percent = total > 0 ? Math.round((passed * 100) / total) : 0;
    const isDone = total > 0 && passed === total;
    return {
      id: row.id,
      title: row.title,
      totalBlocks: total,
      passedBlocks: passed,
      percent,
      isDone,
      pdfFile: row.pdf_file, // <-- добавили
    };
  });
}

// блоки темы + статус пользователя по каждому
async function getTopicBlocksProgress(userId, topicId) {
  const res = await pool.query(
    `
    SELECT
      b.id,
      b.title,
      COALESCE(ubs.status, 'not_passed') AS status
    FROM blocks b
    LEFT JOIN user_block_status ubs
      ON ubs.block_id = b.id AND ubs.user_id = $1
    WHERE b.topic_id = $2
    ORDER BY b.order_index, b.id
  `,
    [userId, topicId]
  );

  return res.rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    isPassed: row.status === "passed",
  }));
}

// ---------- ЭКРАНЫ ДЛЯ ПОЛЬЗОВАТЕЛЯ ----------

async function showTheoryTopics(ctx, userId) {
  const topics = await getTopicsProgress(userId);

  if (topics.length === 0) {
    const text = "Пока нет ни одной темы. Обратись к администратору.";
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🔙 В главное меню", "back_main")],
    ]);
    await deliver(ctx, { text, extra: keyboard }, { edit: true });
    return;
  }

  let text = "📚 Темы теории\n\nВыбери тему:";

  const buttons = topics.map((t) => {
    const percent = t.totalBlocks > 0 ? t.percent : 0;

    // если 100% — добавляем галочку
    const titleLabel = percent === 100 ? `✅ ${t.title}` : t.title;

    const label = `${titleLabel} (${percent}%)`;

    return [Markup.button.callback(label, `theory_topic_${t.id}`)];
  });

  buttons.push([Markup.button.callback("🔙 В главное меню", "back_main")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showTopicBlocks(ctx, userId, topicId) {
  const topicRes = await pool.query(
    "SELECT id, title, description FROM topics WHERE id = $1",
    [topicId]
  );
  if (!topicRes.rows.length) {
    await ctx.reply("Тема не найдена.");
    return;
  }

  const topic = topicRes.rows[0];
  const blocks = await getTopicBlocksProgress(userId, topicId);

  let text = `📚 Тема: ${topic.title}\n\n`;

  if (topic.description) {
    text += `${topic.description}\n\n`;
  }

  if (blocks.length === 0) {
    text += "В этой теме пока нет блоков.";
  }

  const buttons = blocks.map((b) => [
    Markup.button.callback(
      `${b.isPassed ? "✅" : "⚪"} ${b.title}`,
      `theory_block_${b.id}`
    ),
  ]);

  // 🔹 новая кнопка PDF, всегда показываем
  buttons.push([
    Markup.button.callback("подробно в PDF 📄", `theory_topic_pdf_${topic.id}`),
  ]);

  // кнопка назад к списку тем
  buttons.push([Markup.button.callback("🔙 К темам", "user_theory")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// ---------- ТЕКСТ БЛОКА В ТЕОРИИ (без карточек) ----------

async function showBlockDescription(ctx, userId, blockId) {
  const res = await pool.query(
    `
    SELECT 
      b.id,
      b.title,
      b.description,
      b.topic_id,
      t.title AS topic_title
    FROM blocks b
    JOIN topics t ON t.id = b.topic_id
    WHERE b.id = $1
  `,
    [blockId]
  );

  if (!res.rows.length) {
    await ctx.reply("Блок не найден.");
    return;
  }

  const block = res.rows[0];

  let text = `📦 Блок: ${block.title}\n` + `📚 Тема: ${block.topic_title}\n\n`;

  if (block.description && block.description.trim()) {
    text += block.description.trim();
  } else {
    text += "Текст для этого блока пока не добавлен.";
  }

  const buttons = [
    [Markup.button.callback("🔙 К теме", `theory_topic_${block.topic_id}`)],
  ];

  await deliver(ctx, {
    text,
    extra: Markup.inlineKeyboard(buttons),
  });
}

// ---------- КАРТОЧКИ ПО БЛОКУ ----------

// загружаем все карточки для блока (напрямую из cards по block_id)
async function loadBlockCards(blockId) {
  const res = await pool.query(
    `
    SELECT
      id,
      question,
      answer,
      explanation
    FROM cards
    WHERE block_id = $1
    ORDER BY id
  `,
    [blockId]
  );

  return res.rows;
}

async function startBlockCards(ctx, userId, blockId) {
  const blockRes = await pool.query(
    "SELECT id, title, topic_id FROM blocks WHERE id = $1",
    [blockId]
  );
  if (!blockRes.rows.length) {
    await ctx.reply("Блок не найден.");
    return;
  }

  const block = blockRes.rows[0];
  const cards = await loadBlockCards(blockId);

  if (!cards.length) {
    await ctx.reply("В этом блоке пока нет карточек.");
    return;
  }

  setSession(userId, {
    topicId: block.topic_id,
    blockId: block.id,
    cards,
    index: 0,
    showAnswer: false,
  });

  await renderCurrentCard(ctx, userId);
}

async function renderCurrentCard(ctx, userId) {
  const session = getSession(userId);
  if (!session || !session.cards || !session.cards.length) {
    await ctx.reply("Сессия карточек не найдена. Начни заново из блока.");
    return;
  }

  const { cards, index, showAnswer, topicId } = session;

  if (index < 0 || index >= cards.length) {
    clearSession(userId);
    // возвращаемся к списку блоков
    const user = await pool
      .query("SELECT id FROM users WHERE telegram_id = $1", [userId])
      .then((r) => r.rows[0])
      .catch(() => null);

    if (user && topicId) {
      await showTopicBlocks(ctx, user.id, topicId);
    } else {
      await ctx.reply("Карточки закончились.");
    }
    return;
  }

  const card = cards[index];

  let text =
    `📖 Карточка ${index + 1} из ${cards.length}\n\n` +
    `❓ *Вопрос:*\n${card.question}`;

  if (showAnswer) {
    text += `\n\n✅ *Ответ:*\n${card.answer}`;
    if (card.explanation) {
      text += `\n\nℹ️ ${card.explanation}`;
    }
  }

  const buttons = [];

  if (!showAnswer) {
    buttons.push([
      Markup.button.callback("👁 Показать ответ", "theory_card_show_answer"),
    ]);
  } else {
    buttons.push([Markup.button.callback("➡ Следующая", "theory_card_next")]);
  }

  if (session.topicId) {
    buttons.push([
      Markup.button.callback(
        "🔙 К блокам темы",
        `theory_topic_${session.topicId}`
      ),
    ]);
  } else {
    buttons.push([Markup.button.callback("🔙 К темам", "user_theory")]);
  }

  await deliver(
    ctx,
    {
      text,
      extra: Markup.inlineKeyboard(buttons),
    },
    { edit: true }
  );
}

// ---------- РЕГИСТРАЦИЯ ХЕНДЛЕРОВ ----------

function registerTheory(bot, ensureUser, logError) {
  // кнопка "📚 Теория" из главного меню
  bot.action("user_theory", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      clearSession(ctx.from.id);
      await showTheoryTopics(ctx, user.id);
    } catch (err) {
      logError("user_theory", err);
      await ctx.reply("Не удалось открыть теорию. Попробуй позже.");
    }
  });

  // /theory как альтернатива
  bot.command("theory", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;
      clearSession(ctx.from.id);
      await showTheoryTopics(ctx, user.id);
    } catch (err) {
      logError("/theory", err);
      await ctx.reply("Не удалось открыть теорию. Попробуй позже.");
    }
  });

  // выбор темы
  bot.action(/theory_topic_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      clearSession(ctx.from.id);
      const topicId = parseInt(ctx.match[1], 10);
      await showTopicBlocks(ctx, user.id, topicId);
    } catch (err) {
      logError("theory_topic_x", err);
    }
  });

  // отправка PDF по теме
  bot.action(/theory_topic_pdf_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const topicId = parseInt(ctx.match[1], 10);
      const res = await pool.query(
        "SELECT title, pdf_file FROM topics WHERE id = $1",
        [topicId]
      );
      if (!res.rows.length || !res.rows[0].pdf_file) {
        await ctx.reply("Для этой темы пока не прикреплён PDF.");
        return;
      }

      const topic = res.rows[0];

      await ctx.replyWithDocument(topic.pdf_file, {
        caption: `Тема: ${topic.title}`,
      });
    } catch (err) {
      logError("theory_topic_pdf_x", err);
      await ctx.reply("Не удалось отправить PDF по этой теме.");
    }
  });

  // выбор блока — старт карточек
  bot.action(/theory_block_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const blockId = parseInt(ctx.match[1], 10);

      // В теории больше не запускаем карточки, просто показываем текст блока
      clearSession(ctx.from.id); // на всякий случай чистим старые сессии
      await showBlockDescription(ctx, user.id, blockId);
    } catch (err) {
      logError("theory_block_x", err);
      await ctx.reply("Не удалось открыть блок. Попробуй ещё раз.");
    }
  });

  // показать ответ
  bot.action("theory_card_show_answer", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const session = getSession(ctx.from.id);
      if (!session) return;
      setSession(ctx.from.id, { ...session, showAnswer: true });
      await renderCurrentCard(ctx, ctx.from.id);
    } catch (err) {
      logError("theory_card_show_answer", err);
    }
  });

  // следующая карточка
  bot.action("theory_card_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const session = getSession(ctx.from.id);
      if (!session) return;
      const nextIndex = session.index + 1;
      setSession(ctx.from.id, {
        ...session,
        index: nextIndex,
        showAnswer: false,
      });
      await renderCurrentCard(ctx, ctx.from.id);
    } catch (err) {
      logError("theory_card_next", err);
    }
  });
}

module.exports = registerTheory;
