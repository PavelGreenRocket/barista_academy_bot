// src/bot/admin.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// key: telegram_id, value: { step, topicId?, blockId? }
const adminStates = new Map();
const topicPdfUploadState = new Map();

function isAdmin(user) {
  return user && user.role === "admin";
}
function setState(userId, state) {
  adminStates.set(userId, state);
}
function clearState(userId) {
  adminStates.delete(userId);
}

// ----- ВСПОМОГАТЕЛЬНЫЕ ЭКРАНЫ -----

async function showAdminMenu(ctx) {
  const text = "🛠 Панель администратора\n\nВыбери действие:";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⚙️ Настройки", "admin_settings")],
    [Markup.button.callback("⬅️ Назад", "back_main")],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showTopics(ctx) {
  const res = await pool.query(
    "SELECT id, title, order_index FROM topics ORDER BY order_index, id"
  );

  if (!res.rows.length) {
    const text =
      "Пока нет ни одной темы.\n\n" +
      "Нажми «➕ Новая тема», чтобы создать первую.";
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("➕ Новая тема", "admin_new_topic")],
      [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
    ]);
    await deliver(ctx, { text, extra: keyboard }, { edit: true });
    return;
  }

  let text = "📚 Темы:\n";
  const buttons = [];

  for (const row of res.rows) {
    buttons.push([Markup.button.callback(row.title, `admin_topic_${row.id}`)]);
  }

  // Кнопки действий под списком
  buttons.push([Markup.button.callback("➕ Новая тема", "admin_new_topic")]);
  buttons.push([
    Markup.button.callback(
      "🔁 Изменить последовательность",
      "admin_topics_reorder"
    ),
  ]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showTradePoints(ctx) {
  const res = await pool.query(
    `
    SELECT id, title
    FROM trade_points
    WHERE is_active = TRUE
    ORDER BY id
    `
  );

  let text = "🏬 Торговые точки:\n\n";
  const buttons = [];

  if (!res.rows.length) {
    text +=
      "Пока нет ни одной торговой точки.\n\n" +
      "Нажми «➕ Добавить торговую точку», чтобы создать первую.";
  } else {
    for (const row of res.rows) {
      text += `• ${row.title}\n`;
    }
  }

  buttons.push([
    Markup.button.callback(
      "➕ Добавить торговую точку",
      "admin_trade_point_new"
    ),
  ]);
  buttons.push([Markup.button.callback("🔙 К настройкам", "admin_settings")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showTopicBlocks(ctx, topicId) {
  const topicRes = await pool.query(
    "SELECT id, title, description FROM topics WHERE id = $1",
    [topicId]
  );
  if (!topicRes.rows.length) {
    await ctx.reply("Тема не найдена.");
    return;
  }

  const topic = topicRes.rows[0];

  const blocksRes = await pool.query(
    "SELECT id, title, order_index FROM blocks WHERE topic_id = $1 ORDER BY order_index, id",
    [topicId]
  );

  let text = `📚 Тема: ${topic.title}\n\n`;

  if (topic.description) {
    text += `${topic.description}\n\n`;
  }

  if (!blocksRes.rows.length) {
    text += "В этой теме пока нет блоков.";
  }

  const buttons = [];

  for (const row of blocksRes.rows) {
    buttons.push([Markup.button.callback(row.title, `admin_block_${row.id}`)]);
  }

  buttons.push([
    Markup.button.callback("➕ Новый блок", `admin_new_block_${topicId}`),
  ]);

  // 🔹 Новая кнопка для загрузки/замены PDF
  buttons.push([
    Markup.button.callback("📄 PDF для темы", `admin_topic_pdf_${topicId}`),
  ]);

  buttons.push([
    Markup.button.callback("📝 Текст темы", `admin_edit_topic_text_${topicId}`),
  ]);
  buttons.push([
    Markup.button.callback("🗑 Удалить тему", `admin_delete_topic_${topicId}`),
  ]);
  buttons.push([Markup.button.callback("🔙 К темам", "admin_topics")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showTopicsReorder(ctx) {
  const res = await pool.query(
    "SELECT id, title, order_index FROM topics ORDER BY order_index, id"
  );

  if (!res.rows.length) {
    await showTopics(ctx);
    return;
  }

  const text =
    "📚 Темы (режим изменения порядка):\n\n" +
    "Нажимай стрелки ⬆️ / ⬇️ рядом с темами,\n" +
    "а затем вернись к обычному списку.";

  const buttons = [];

  res.rows.forEach((row, index) => {
    const upCb = index > 0 ? `admin_topic_up_${row.id}` : null;
    const downCb =
      index < res.rows.length - 1 ? `admin_topic_down_${row.id}` : null;

    const rowButtons = [
      Markup.button.callback(row.title, `admin_topic_${row.id}`),
    ];

    if (upCb) {
      rowButtons.push(Markup.button.callback("⬆️", upCb));
    }
    if (downCb) {
      rowButtons.push(Markup.button.callback("⬇️", downCb));
    }

    buttons.push(rowButtons);
  });

  buttons.push([
    Markup.button.callback("✅ Закончить изменение порядка", "admin_topics"),
  ]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showBlock(ctx, blockId) {
  const res = await pool.query(
    `SELECT b.id, b.title, b.description, b.topic_id, t.title AS topic_title
     FROM blocks b
     JOIN topics t ON b.topic_id = t.id
     WHERE b.id = $1`,
    [blockId]
  );
  if (!res.rows.length) {
    await ctx.reply("Блок не найден.");
    return;
  }

  const block = res.rows[0];

  let text = `📦 Блок: "${block.title}"\nТема: "${block.topic_title}"\n\n`;
  if (block.description) {
    text += block.description;
  } else {
    text += "Пока нет текста для этого блока.";
  }

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "📝 Текст блока",
        `admin_edit_block_text_${block.id}`
      ),
    ],
    [
      Markup.button.callback(
        "🃏 Карточки блока",
        `admin_block_cards_${block.id}`
      ),
    ],
    [
      Markup.button.callback(
        "🗑 Удалить блок",
        `admin_delete_block_${block.id}`
      ),
    ],
    [
      Markup.button.callback(
        "🔙 К блокам темы",
        `admin_topic_${block.topic_id}`
      ),
    ],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

// ----- РЕГИСТРАЦИЯ КОМАНД -----

function registerAdminCommands(bot, ensureUser, logError) {
  // /admin
  bot.command("admin", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) {
        return ctx.reply("У тебя нет прав администратора.");
      }
      clearState(ctx.from.id);
      await showAdminMenu(ctx);
    } catch (err) {
      logError("/admin", err);
      await ctx.reply("Ошибка при открытии админ-панели.");
    }
  });

  // кнопка из главного меню
  bot.action("admin_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clearState(ctx.from.id);
      await showAdminMenu(ctx);
    } catch (err) {
      logError("admin_menu", err);
    }
  });

  bot.action(/admin_topic_pdf_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const topicId = parseInt(ctx.match[1], 10);

      topicPdfUploadState.set(ctx.from.id, topicId);

      await ctx.reply("Отправь PDF-файл для этой темы.\n\nФормат: *pdf*.");
    } catch (err) {
      logError("admin_topic_pdf_x", err);
    }
  });

  bot.action("admin_settings", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const text = "🛠 Настройки\n\nВыберите, что хотите настроить:";

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔧 Темы", "admin_topics")],
        [Markup.button.callback("🔧 Элементы аттестации", "admin_attest_menu")],
        [
          Markup.button.callback(
            "🔧 Настроить стажировку",
            "admin_internship_menu"
          ),
        ],
        [Markup.button.callback("🔧 Торговые точки", "admin_trade_points")],
        [Markup.button.callback("⬅️ Назад", "admin_menu")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_settings", err);
    }
  });

  // включение режима изменения порядка
  bot.action("admin_topics_reorder", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showTopicsReorder(ctx);
    } catch (err) {
      logError("admin_topics_reorder", err);
    }
  });

  bot.action("admin_trade_points", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      clearState(ctx.from.id);
      await showTradePoints(ctx);
    } catch (err) {
      logError("admin_trade_points", err);
    }
  });

  bot.action("admin_trade_point_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setState(ctx.from.id, { step: "await_trade_point_title" });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К торговым точкам", "admin_trade_points")],
      ]);

      await deliver(
        ctx,
        {
          text: "🏬 Введи название новой торговой точки одним сообщением:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_trade_point_new", err);
    }
  });

  // перемещение темы вверх
  bot.action(/^admin_topic_up_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);

      const res = await pool.query(
        "SELECT id, order_index FROM topics ORDER BY order_index, id"
      );
      const topics = res.rows;
      const index = topics.findIndex((t) => t.id === topicId);
      if (index <= 0) {
        await showTopicsReorder(ctx);
        return;
      }

      const current = topics[index];
      const prev = topics[index - 1];

      await pool.query("UPDATE topics SET order_index = $1 WHERE id = $2", [
        prev.order_index,
        current.id,
      ]);
      await pool.query("UPDATE topics SET order_index = $1 WHERE id = $2", [
        current.order_index,
        prev.id,
      ]);

      await showTopicsReorder(ctx);
    } catch (err) {
      logError("admin_topic_up_x", err);
    }
  });

  // перемещение темы вниз
  bot.action(/^admin_topic_down_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);

      const res = await pool.query(
        "SELECT id, order_index FROM topics ORDER BY order_index, id"
      );
      const topics = res.rows;
      const index = topics.findIndex((t) => t.id === topicId);
      if (index === -1 || index >= topics.length - 1) {
        await showTopicsReorder(ctx);
        return;
      }

      const current = topics[index];
      const next = topics[index + 1];

      await pool.query("UPDATE topics SET order_index = $1 WHERE id = $2", [
        next.order_index,
        current.id,
      ]);
      await pool.query("UPDATE topics SET order_index = $1 WHERE id = $2", [
        current.order_index,
        next.id,
      ]);

      await showTopicsReorder(ctx);
    } catch (err) {
      logError("admin_topic_down_x", err);
    }
  });

  // список тем
  bot.action("admin_topics", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clearState(ctx.from.id);
      await showTopics(ctx);
    } catch (err) {
      logError("admin_topics", err);
    }
  });

  // перемещение темы вверх
  bot.action(/admin_topic_up_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);

      const curRes = await pool.query(
        "SELECT id, order_index FROM topics WHERE id = $1",
        [topicId]
      );
      if (!curRes.rows.length) {
        await ctx.reply("Тема не найдена.");
        return;
      }
      const current = curRes.rows[0];

      // тема выше (с меньшим order_index)
      const upRes = await pool.query(
        `SELECT id, order_index
         FROM topics
         WHERE order_index < $1
         ORDER BY order_index DESC, id DESC
         LIMIT 1`,
        [current.order_index]
      );
      if (!upRes.rows.length) {
        // уже самая верхняя
        await showTopics(ctx);
        return;
      }
      const upper = upRes.rows[0];

      try {
        await pool.query("BEGIN");
        await pool.query("UPDATE topics SET order_index = $1 WHERE id = $2", [
          upper.order_index,
          current.id,
        ]);
        await pool.query("UPDATE topics SET order_index = $1 WHERE id = $2", [
          current.order_index,
          upper.id,
        ]);
        await pool.query("COMMIT");
      } catch (err) {
        await pool.query("ROLLBACK").catch(() => {});
        throw err;
      }

      await showTopics(ctx);
    } catch (err) {
      logError("admin_topic_up_x", err);
    }
  });

  // перемещение темы вниз
  bot.action(/admin_topic_down_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);

      const curRes = await pool.query(
        "SELECT id, order_index FROM topics WHERE id = $1",
        [topicId]
      );
      if (!curRes.rows.length) {
        await ctx.reply("Тема не найдена.");
        return;
      }
      const current = curRes.rows[0];

      // тема ниже (с большим order_index)
      const downRes = await pool.query(
        `SELECT id, order_index
         FROM topics
         WHERE order_index > $1
         ORDER BY order_index ASC, id ASC
         LIMIT 1`,
        [current.order_index]
      );
      if (!downRes.rows.length) {
        // уже самая нижняя
        await showTopics(ctx);
        return;
      }
      const lower = downRes.rows[0];

      try {
        await pool.query("BEGIN");
        await pool.query("UPDATE topics SET order_index = $1 WHERE id = $2", [
          lower.order_index,
          current.id,
        ]);
        await pool.query("UPDATE topics SET order_index = $1 WHERE id = $2", [
          current.order_index,
          lower.id,
        ]);
        await pool.query("COMMIT");
      } catch (err) {
        await pool.query("ROLLBACK").catch(() => {});
        throw err;
      }

      await showTopics(ctx);
    } catch (err) {
      logError("admin_topic_down_x", err);
    }
  });

  // новая тема
  bot.action("admin_new_topic", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setState(ctx.from.id, { step: "await_topic_title" });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
      ]);

      await deliver(
        ctx,
        {
          text: "✏ Введи название новой темы одним сообщением:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_new_topic", err);
    }
  });

  // экран конкретной темы (список блоков)
  bot.action(/admin_topic_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);
      clearState(ctx.from.id);
      await showTopicBlocks(ctx, topicId);
    } catch (err) {
      logError("admin_topic_x", err);
    }
  });

  // редактирование текста темы
  bot.action(/admin_edit_topic_text_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);
      const topicRes = await pool.query(
        "SELECT id, title, description FROM topics WHERE id = $1",
        [topicId]
      );
      if (!topicRes.rows.length) {
        await ctx.reply("Тема не найдена.");
        return;
      }

      const topic = topicRes.rows[0];

      setState(ctx.from.id, { step: "await_topic_description", topicId });

      let text = `✏ Редактирование текста темы:\n"${topic.title}"\n\n`;
      if (topic.description) {
        text += `Сейчас текст:\n\n${topic.description}\n\n`;
      }
      text += "Отправь новый текст темы одним сообщением:";

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К теме", `admin_topic_${topicId}`)],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_edit_topic_text_x", err);
    }
  });

  // подтверждение удаления темы
  bot.action(/admin_delete_topic_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);
      const topicRes = await pool.query(
        "SELECT id, title FROM topics WHERE id = $1",
        [topicId]
      );
      if (!topicRes.rows.length) {
        await ctx.reply("Тема не найдена.");
        return;
      }

      const topic = topicRes.rows[0];
      const text =
        `⚠️ Удалить тему:\n\n"${topic.title}"?\n\n` +
        "Будут удалены все её блоки и карточки.";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("❌ Отмена", `admin_topic_${topicId}`),
          Markup.button.callback(
            "🗑 Да, удалить",
            `admin_delete_topic_confirm_${topicId}`
          ),
        ],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_delete_topic", err);
    }
  });

  // реальное удаление темы
  bot.action(/admin_delete_topic_confirm_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);

      await pool.query("BEGIN");

      // удаляем карточки всех блоков темы
      await pool.query(
        `
        DELETE FROM cards
        WHERE block_id IN (
          SELECT id FROM blocks WHERE topic_id = $1
        )
      `,
        [topicId]
      );

      // статусы прохождения блоков
      await pool.query(
        `
        DELETE FROM user_block_status
        WHERE block_id IN (
          SELECT id FROM blocks WHERE topic_id = $1
        )
      `,
        [topicId]
      );

      // блоки
      await pool.query("DELETE FROM blocks WHERE topic_id = $1", [topicId]);

      // тема
      await pool.query("DELETE FROM topics WHERE id = $1", [topicId]);

      await pool.query("COMMIT");

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К списку тем", "admin_topics")],
      ]);

      await deliver(
        ctx,
        {
          text: "🗑 Тема удалена.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      await pool.query("ROLLBACK").catch(() => {});
      logError("admin_delete_topic_confirm", err);
      await ctx.reply("Не удалось удалить тему (ошибка БД).");
    }
  });

  // новый блок
  bot.action(/admin_new_block_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const topicId = parseInt(ctx.match[1], 10);
      setState(ctx.from.id, { step: "await_block_title", topicId });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К теме", `admin_topic_${topicId}`)],
      ]);

      await deliver(
        ctx,
        {
          text: "✏ Введи название нового блока одним сообщением:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_new_block_x", err);
    }
  });

  // экран блока
  bot.action(/admin_block_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const blockId = parseInt(ctx.match[1], 10);
      clearState(ctx.from.id);
      await showBlock(ctx, blockId);
    } catch (err) {
      logError("admin_block_x", err);
    }
  });

  // перемещение блока вверх
  bot.action(/admin_block_up_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const blockId = parseInt(ctx.match[1], 10);

      const curRes = await pool.query(
        "SELECT id, topic_id, order_index FROM blocks WHERE id = $1",
        [blockId]
      );
      if (!curRes.rows.length) {
        await ctx.reply("Блок не найден.");
        return;
      }
      const current = curRes.rows[0];

      const upRes = await pool.query(
        `SELECT id, order_index
         FROM blocks
         WHERE topic_id = $1 AND order_index < $2
         ORDER BY order_index DESC, id DESC
         LIMIT 1`,
        [current.topic_id, current.order_index]
      );
      if (!upRes.rows.length) {
        await showTopicBlocks(ctx, current.topic_id);
        return;
      }
      const upper = upRes.rows[0];

      try {
        await pool.query("BEGIN");
        await pool.query("UPDATE blocks SET order_index = $1 WHERE id = $2", [
          upper.order_index,
          current.id,
        ]);
        await pool.query("UPDATE blocks SET order_index = $1 WHERE id = $2", [
          current.order_index,
          upper.id,
        ]);
        await pool.query("COMMIT");
      } catch (err) {
        await pool.query("ROLLBACK").catch(() => {});
        throw err;
      }

      await showTopicBlocks(ctx, current.topic_id);
    } catch (err) {
      logError("admin_block_up_x", err);
    }
  });

  // перемещение блока вниз
  bot.action(/admin_block_down_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const blockId = parseInt(ctx.match[1], 10);

      const curRes = await pool.query(
        "SELECT id, topic_id, order_index FROM blocks WHERE id = $1",
        [blockId]
      );
      if (!curRes.rows.length) {
        await ctx.reply("Блок не найден.");
        return;
      }
      const current = curRes.rows[0];

      const downRes = await pool.query(
        `SELECT id, order_index
         FROM blocks
         WHERE topic_id = $1 AND order_index > $2
         ORDER BY order_index ASC, id ASC
         LIMIT 1`,
        [current.topic_id, current.order_index]
      );
      if (!downRes.rows.length) {
        await showTopicBlocks(ctx, current.topic_id);
        return;
      }
      const lower = downRes.rows[0];

      try {
        await pool.query("BEGIN");
        await pool.query("UPDATE blocks SET order_index = $1 WHERE id = $2", [
          lower.order_index,
          current.id,
        ]);
        await pool.query("UPDATE blocks SET order_index = $1 WHERE id = $2", [
          current.order_index,
          lower.id,
        ]);
        await pool.query("COMMIT");
      } catch (err) {
        await pool.query("ROLLBACK").catch(() => {});
        throw err;
      }

      await showTopicBlocks(ctx, current.topic_id);
    } catch (err) {
      logError("admin_block_down_x", err);
    }
  });

  // редактирование текста блока
  bot.action(/admin_edit_block_text_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const blockId = parseInt(ctx.match[1], 10);
      const res = await pool.query(
        `SELECT b.id, b.title, b.description, b.topic_id, t.title AS topic_title
         FROM blocks b
         JOIN topics t ON b.topic_id = t.id
         WHERE b.id = $1`,
        [blockId]
      );
      if (!res.rows.length) {
        await ctx.reply("Блок не найден.");
        return;
      }

      const block = res.rows[0];

      setState(ctx.from.id, { step: "await_block_description", blockId });

      let text = `✏ Редактирование блока:\n"${block.title}"\n\n`;
      if (block.description) {
        text += `Сейчас текст:\n\n${block.description}\n\n`;
      }
      text += "Отправь новый текст блока одним сообщением:";

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К блоку", `admin_block_${blockId}`)],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_edit_block_text_x", err);
    }
  });

  // удаление блока (подтверждение)
  bot.action(/admin_delete_block_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const blockId = parseInt(ctx.match[1], 10);
      const res = await pool.query(
        `SELECT b.id, b.title, b.topic_id, t.title AS topic_title
         FROM blocks b
         JOIN topics t ON b.topic_id = t.id
         WHERE b.id = $1`,
        [blockId]
      );
      if (!res.rows.length) {
        await ctx.reply("Блок не найден.");
        return;
      }

      const block = res.rows[0];

      const text =
        `⚠️ Удалить блок:\n\n"${block.title}" (тема "${block.topic_title}")?\n\n` +
        "Будут удалены все карточки этого блока.";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("❌ Отмена", `admin_block_${blockId}`),
          Markup.button.callback(
            "🗑 Да, удалить",
            `admin_delete_block_confirm_${blockId}`
          ),
        ],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_delete_block", err);
    }
  });

  // реальное удаление блока
  bot.action(/admin_delete_block_confirm_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const blockId = parseInt(ctx.match[1], 10);

      const res = await pool.query(
        "SELECT id, topic_id FROM blocks WHERE id = $1",
        [blockId]
      );
      if (!res.rows.length) {
        await ctx.reply("Блок не найден.");
        return;
      }
      const topicId = res.rows[0].topic_id;

      await pool.query("BEGIN");

      // карточки
      await pool.query("DELETE FROM cards WHERE block_id = $1", [blockId]);

      // статусы пользователей
      await pool.query("DELETE FROM user_block_status WHERE block_id = $1", [
        blockId,
      ]);

      // блок
      await pool.query("DELETE FROM blocks WHERE id = $1", [blockId]);

      await pool.query("COMMIT");

      await showTopicBlocks(ctx, topicId);
    } catch (err) {
      await pool.query("ROLLBACK").catch(() => {});
      logError("admin_delete_block_confirm", err);
      await ctx.reply("Не удалось удалить блок.");
    }
  });

  bot.on("document", async (ctx, next) => {
    try {
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return next();

      const topicId = topicPdfUploadState.get(ctx.from.id);
      if (!topicId) return next();

      const file = ctx.message.document;

      if (!file.mime_type || !file.mime_type.includes("pdf")) {
        await ctx.reply("Файл должен быть PDF.");
        return;
      }

      const fileId = file.file_id;

      // сохраняем file_id в базе
      await pool.query("UPDATE topics SET pdf_file = $1 WHERE id = $2", [
        fileId,
        topicId,
      ]);

      topicPdfUploadState.delete(ctx.from.id);

      await ctx.reply("PDF успешно загружен и прикреплён к теме!");
      await showTopics(ctx);
    } catch (err) {
      logError("admin_pdf_upload_x", err);
    }
  });

  // ----- ТЕКСТОВЫЕ ШАГИ -----

  bot.on("text", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const adminState = adminStates.get(ctx.from.id);
      if (!adminState) return next();

      const text = (ctx.message.text || "").trim();
      if (!text) return next();

      // новая торговая точка
      if (adminState.step === "await_trade_point_title") {
        await pool.query(
          `
          INSERT INTO trade_points (title, is_active)
          VALUES ($1, TRUE)
          `,
          [text]
        );

        clearState(ctx.from.id);
        await showTradePoints(ctx);
        return;
      }

      // новая тема
      if (adminState.step === "await_topic_title") {
        const insertRes = await pool.query(
          `INSERT INTO topics (title, order_index)
         VALUES (
           $1,
           COALESCE((SELECT MAX(order_index) + 1 FROM topics), 1)
         )
         RETURNING id`,
          [text]
        );
        const topicId = insertRes.rows[0].id;
        clearState(ctx.from.id);
        await showTopicBlocks(ctx, topicId);
        return;
      }

      // текст темы
      if (adminState.step === "await_topic_description") {
        const topicId = adminState.topicId;
        await pool.query("UPDATE topics SET description = $1 WHERE id = $2", [
          text,
          topicId,
        ]);
        clearState(ctx.from.id);
        await showTopicBlocks(ctx, topicId);
        return;
      }

      // новый блок
      if (adminState.step === "await_block_title") {
        const topicId = adminState.topicId;
        const insertRes = await pool.query(
          `INSERT INTO blocks (topic_id, title, order_index)
         VALUES (
           $1,
           $2,
           COALESCE((SELECT MAX(order_index) + 1 FROM blocks WHERE topic_id = $1), 1)
         )
         RETURNING id`,
          [topicId, text]
        );
        const blockId = insertRes.rows[0].id;
        clearState(ctx.from.id);
        await showBlock(ctx, blockId);
        return;
      }

      // текст блока
      if (adminState.step === "await_block_description") {
        const blockId = adminState.blockId;
        await pool.query("UPDATE blocks SET description = $1 WHERE id = $2", [
          text,
          blockId,
        ]);
        clearState(ctx.from.id);
        await showBlock(ctx, blockId);
        return;
      }

      return next();
    } catch (err) {
      logError("admin_text_handler", err);
      return next();
    }
  });
}

module.exports = registerAdminCommands;
