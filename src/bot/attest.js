// src/bot/attest.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// состояния для админских действий (название/описание)
const attestStates = new Map(); // key: telegram_id, value: { step, itemId? }

function setState(userId, state) {
  attestStates.set(userId, state);
}
function clearState(userId) {
  attestStates.delete(userId);
}
function isAdmin(user) {
  return user && user.role === "admin";
}

// -------- ВСПОМОГАТЕЛЬНОЕ --------

async function showUserAttestMenu(ctx, userId) {
  const res = await pool.query(
    `SELECT ai.id,
            ai.title,
            ai.description,
            uas.status
     FROM attestation_items ai
     LEFT JOIN user_attestation_status uas
       ON uas.item_id = ai.id AND uas.user_id = $1
     WHERE ai.is_active = TRUE
     ORDER BY ai.order_index, ai.id`,
    [userId]
  );

  if (!res.rows.length) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🔙 В главное меню", "back_main")],
    ]);

    await deliver(
      ctx,
      {
        text: 'Раздел "Аттестация" пока пуст. Админ ещё не добавил элементы аттестации.',
        extra: keyboard,
      },
      { edit: true }
    );
    return;
  }

  let text = "✅ Аттестация\n\n";

  for (const row of res.rows) {
    let icon = "⚪"; // по умолчанию не сдано
    if (row.status === "passed") icon = "✅";
    text += `${icon} ${row.title}\n`;
  }

  let buttons = res.rows.map((row) => {
    const title = (row.title || "").trim().toLowerCase();

    // если это Техкарта → делаем кнопку-ссылку
    if (title === "техкарта" || title === "техкарты") {
      return [
        Markup.button.url("Техкарта", "https://t.me/TexKarGreenRocketbot"),
      ];
    }

    // иначе обычная кнопка
    return [Markup.button.callback(row.title, `user_attest_item_${row.id}`)];
  });

  // 🔹 Добавляем кнопку назад в главное меню
  buttons.push([Markup.button.callback("🔙", "back_main")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showUserAttestItem(ctx, userId, itemId) {
  const res = await pool.query(
    `SELECT ai.id,
            ai.title,
            ai.description,
            uas.status
     FROM attestation_items ai
     LEFT JOIN user_attestation_status uas
       ON uas.item_id = ai.id AND uas.user_id = $1
     WHERE ai.id = $2`,
    [userId, itemId]
  );

  if (!res.rows.length) {
    await ctx.reply("Элемент аттестации не найден.");
    return;
  }

  const row = res.rows[0];
  let icon = "⚪";
  let statusText = "Ещё не сдано.";
  if (row.status === "passed") {
    icon = "✅";
    statusText = "Сдано ✅";
  }

  let text = `✅ Элемент аттестации\n\n${icon} ${row.title}\n\n${statusText}`;

  if (row.description) {
    text += `\n\nОписание:\n${row.description}`;
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⬅ Назад к списку", "user_attest")],
    [Markup.button.callback("🔙 В главное меню", "back_main")],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

// --- админский список элементов ---

async function showAdminAttestMenu(ctx) {
  const res = await pool.query(
    `SELECT id, title, order_index, is_active
     FROM attestation_items
     ORDER BY order_index, id`
  );

  if (!res.rows.length) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("➕ Новый элемент", "admin_attest_new")],
      [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
    ]);

    await deliver(
      ctx,
      {
        text: "Элементы аттестации ещё не созданы.\nНажми «Новый элемент», чтобы добавить первый.",
        extra: keyboard,
      },
      { edit: true }
    );
    return;
  }

  let text = "✅ Элементы аттестации:\n\n";
  const buttons = [];

  for (const row of res.rows) {
    const icon = row.is_active ? "✅" : "🚫";
    text += `${icon} [${row.order_index}] ${row.title}\n`;
    buttons.push([
      Markup.button.callback(
        `${icon} ${row.title}`,
        `admin_attest_item_${row.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback("➕ Новый элемент", "admin_attest_new"),
  ]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showAdminAttestItem(ctx, itemId) {
  const res = await pool.query(
    "SELECT id, title, description, is_active, COALESCE(is_default, FALSE) AS is_default FROM attestation_items WHERE id = $1",
    [itemId]
  );
  if (!res.rows.length) {
    await ctx.reply("Элемент аттестации не найден.");
    return;
  }
  const row = res.rows[0];

  const statusText = row.is_active ? "Активен ✅" : "Скрыт 🚫";

  let text =
    `✅ Элемент аттестации\n\n` +
    `Название: ${row.title}\n` +
    `Статус: ${statusText}`;

  if (row.description) {
    text += `\n\nОписание:\n${row.description}`;
  }

  const kbRows = [];

  // Дефолтные элементы нельзя переименовывать/удалять — только выключать
  if (!row.is_default) {
    kbRows.push([Markup.button.callback("✏ Название", `admin_attest_rename_${row.id}`)]);
    kbRows.push([Markup.button.callback("📝 Описание", `admin_attest_desc_${row.id}`)]);
  }

  kbRows.push([Markup.button.callback("👁 Вкл/Выкл", `admin_attest_toggle_${row.id}`)]);

  if (!row.is_default) {
    kbRows.push([Markup.button.callback("🗑 Удалить", `admin_attest_delete_${row.id}`)]);
  }

  kbRows.push([Markup.button.callback("🔙 К списку", "admin_attest_menu")]);

  const keyboard = Markup.inlineKeyboard(kbRows);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

// -------- РЕГИСТРАЦИЯ ВСЕГО --------

function registerAttest(bot, ensureUser, logError) {
  // --- пользовательская часть ---

  bot.action("user_attest", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      clearState(ctx.from.id);
      await showUserAttestMenu(ctx, user.id);
    } catch (err) {
      logError("user_attest", err);
      await ctx.reply("Не удалось открыть аттестацию.");
    }
  });

  bot.command("attest", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;
      clearState(ctx.from.id);
      await showUserAttestMenu(ctx, user.id);
    } catch (err) {
      logError("/attest", err);
      await ctx.reply("Не удалось открыть аттестацию.");
    }
  });

  bot.action(/user_attest_item_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      const itemId = parseInt(ctx.match[1], 10);
      await showUserAttestItem(ctx, user.id, itemId);
    } catch (err) {
      logError("user_attest_item_x", err);
    }
  });

  // --- админская часть ---

  bot.action("admin_attest_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clearState(ctx.from.id);
      await showAdminAttestMenu(ctx);
    } catch (err) {
      logError("admin_attest_menu", err);
    }
  });

  bot.action("admin_attest_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setState(ctx.from.id, { step: "attest_new_title" });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К списку", "admin_attest_menu")],
      ]);

      await deliver(
        ctx,
        {
          text: "✏ Введи название нового элемента аттестации одним сообщением:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_attest_new", err);
    }
  });

  bot.action(/admin_attest_item_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clearState(ctx.from.id);
      const itemId = parseInt(ctx.match[1], 10);
      await showAdminAttestItem(ctx, itemId);
    } catch (err) {
      logError("admin_attest_item_x", err);
    }
  });

  bot.action(/admin_attest_rename_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const itemId = parseInt(ctx.match[1], 10);
      const chk = await pool.query(
        "SELECT COALESCE(is_default, FALSE) AS is_default FROM attestation_items WHERE id = $1",
        [itemId]
      );
      if (chk.rows[0]?.is_default) {
        await ctx.answerCbQuery("Этот элемент нельзя переименовывать", { show_alert: false }).catch(() => {});
        await showAdminAttestItem(ctx, itemId);
        return;
      }
      setState(ctx.from.id, { step: "attest_rename_title", itemId });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Назад", `admin_attest_item_${itemId}`)],
      ]);

      await deliver(
        ctx,
        { text: "✏ Введи новое название элемента:", extra: keyboard },
        { edit: true }
      );
    } catch (err) {
      logError("admin_attest_rename_x", err);
    }
  });

  bot.action(/admin_attest_desc_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const itemId = parseInt(ctx.match[1], 10);
      const chk = await pool.query(
        "SELECT COALESCE(is_default, FALSE) AS is_default FROM attestation_items WHERE id = $1",
        [itemId]
      );
      if (chk.rows[0]?.is_default) {
        await ctx.answerCbQuery("Для этого элемента описание недоступно", { show_alert: false }).catch(() => {});
        await showAdminAttestItem(ctx, itemId);
        return;
      }
      setState(ctx.from.id, { step: "attest_edit_desc", itemId });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Назад", `admin_attest_item_${itemId}`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            "📝 Отправь текст описания для этого элемента одним сообщением.\n" +
            "Старое описание будет перезаписано.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_attest_desc_x", err);
    }
  });

  bot.action(/admin_attest_toggle_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const itemId = parseInt(ctx.match[1], 10);
      await pool.query(
        "UPDATE attestation_items SET is_active = NOT is_active WHERE id = $1",
        [itemId]
      );
      await showAdminAttestItem(ctx, itemId);
    } catch (err) {
      logError("admin_attest_toggle_x", err);
    }
  });

  bot.action(/admin_attest_delete_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const itemId = parseInt(ctx.match[1], 10);
      const chk = await pool.query(
        "SELECT COALESCE(is_default, FALSE) AS is_default FROM attestation_items WHERE id = $1",
        [itemId]
      );
      if (chk.rows[0]?.is_default) {
        await ctx.answerCbQuery("Этот элемент нельзя удалить", { show_alert: false }).catch(() => {});
        await showAdminAttestItem(ctx, itemId);
        return;
      }
      await pool.query("DELETE FROM attestation_items WHERE id = $1", [itemId]);
      clearState(ctx.from.id);
      await showAdminAttestMenu(ctx);
    } catch (err) {
      logError("admin_attest_delete_x", err);
    }
  });

  // --- текстовые шаги для админа (название/описание) ---

  bot.on("text", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const state = attestStates.get(ctx.from.id);
      if (!state) return next();

      const text = (ctx.message.text || "").trim();
      if (!text) return next();

      if (state.step === "attest_new_title") {
        const insertRes = await pool.query(
          `INSERT INTO attestation_items (title, order_index, is_default, item_type)
           VALUES (
             $1,
             COALESCE((SELECT MAX(order_index)+1 FROM attestation_items), 1)
           , FALSE, 'normal')
           RETURNING id`,
          [text]
        );

        clearState(ctx.from.id);
        await showAdminAttestMenu(ctx);
        return;
      }

      if (state.step === "attest_rename_title") {
        const itemId = state.itemId;
        await pool.query(
          "UPDATE attestation_items SET title = $1 WHERE id = $2",
          [text, itemId]
        );
        clearState(ctx.from.id);
        await showAdminAttestItem(ctx, itemId);
        return;
      }

      if (state.step === "attest_edit_desc") {
        const itemId = state.itemId;
        await pool.query(
          "UPDATE attestation_items SET description = $1 WHERE id = $2",
          [text, itemId]
        );
        clearState(ctx.from.id);
        await showAdminAttestItem(ctx, itemId);
        return;
      }

      return next();
    } catch (err) {
      logError("attest_text_handler", err);
      return next();
    }
  });
}

module.exports = registerAttest;
