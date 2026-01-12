// src/bot/techcards.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// key: telegram_id, value: { step, groupId?, itemId?, draft? }
const tcStates = new Map();

function setState(userId, state) {
  tcStates.set(userId, state);
}
function getState(userId) {
  return tcStates.get(userId);
}
function clearState(userId) {
  tcStates.delete(userId);
}

function isAdmin(user) {
  return user && user.role === "admin";
}

function escHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeNumberText(input) {
  // сохраняем как строку, но подчистим пробелы
  return String(input || "").trim();
}

function renderComposition(draftOrRows) {
  const rows = Array.isArray(draftOrRows) ? draftOrRows : [];
  if (!rows.length) return "<i>Пока пусто</i>";
  const lines = rows.map((r) => {
    const name = escHtml(r.name);
    const amount = escHtml(r.amount);
    const unit = escHtml(r.unit);
    return `• ${name}: ${amount}${unit ? unit : ""}`;
  });
  return lines.join("\n");
}

async function showGroups(ctx) {
  const res = await pool.query(
    `SELECT id, title
     FROM techcard_groups
     ORDER BY id DESC`
  );

  let text = "📋 <b>Тех карта</b>\n\n";
  text += "Выберите группу или добавьте новую:";

  const buttons = [];
  for (const g of res.rows) {
    buttons.push([Markup.button.callback(g.title, `tc_group_${g.id}`)]);
  }
  buttons.push([Markup.button.callback("➕ Добавить группу", "tc_group_add")]);
  buttons.push([Markup.button.callback("⬅️ Назад", "admin_settings")]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(buttons) }, { edit: true });
}

async function showGroup(ctx, groupId) {
  const gRes = await pool.query(
    `SELECT id, title FROM techcard_groups WHERE id = $1`,
    [groupId]
  );
  if (!gRes.rows.length) {
    await ctx.reply("Группа не найдена.");
    return;
  }
  const group = gRes.rows[0];

  const itemsRes = await pool.query(
    `SELECT id, title, is_active
     FROM techcard_items
     WHERE group_id = $1
     ORDER BY id DESC`,
    [groupId]
  );

  let text = `📦 <b>${escHtml(group.title)}</b>\n\n`;
  text += "Выберите товар или добавьте новый:";

  const buttons = [];
  for (const it of itemsRes.rows) {
    const suffix = it.is_active ? "" : " (выкл.)";
    buttons.push([Markup.button.callback(`${it.title}${suffix}`, `tc_item_${it.id}`)]);
  }

  buttons.push([Markup.button.callback("➕ Добавить товар", `tc_item_add_${groupId}`)]);
  buttons.push([Markup.button.callback("⬅️ Назад", "admin_techcards")]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(buttons) }, { edit: true });
}

async function showItemCard(ctx, itemId, opts = {}) {
  const res = await pool.query(
    `SELECT i.id, i.title, i.group_id, i.is_active,
            i.method_text, i.video_file_id,
            g.title AS group_title
     FROM techcard_items i
     JOIN techcard_groups g ON g.id = i.group_id
     WHERE i.id = $1`,
    [itemId]
  );
  if (!res.rows.length) {
    await ctx.reply("Товар не найден.");
    return;
  }
  const item = res.rows[0];

  const ingRes = await pool.query(
    `SELECT id, name, amount, unit, position
     FROM techcard_ingredients
     WHERE item_id = $1
     ORDER BY position ASC, id ASC`,
    [itemId]
  );

  const comp = renderComposition(ingRes.rows);
  const methodLine = item.method_text ? "Способ приготовления: <b>добавлено</b>" : "Способ приготовления: <i>не добавлено</i>";
  const videoLine = item.video_file_id ? "Видео: <b>прикреплено</b>" : "Видео: <i>не прикреплено</i>";
  const statusLine = item.is_active ? "Статус: <b>включен</b>" : "Статус: <b>выключен</b>";

  let text = `🧾 <b>${escHtml(item.title)}</b>\n`;
  text += `Группа: ${escHtml(item.group_title)}\n`;
  text += `${statusLine}\n\n`;
  text += `<b>Состав:</b>\n${comp}\n\n`;
  text += `${methodLine}\n${videoLine}`;

  const toggleLabel = item.is_active ? "Выключить товар" : "Включить товар";
  const methodBtn = item.method_text
    ? "📝 Способ приготовления (добавлено)"
    : "📝 Добавить способ приготовления";
  const videoBtn = item.video_file_id ? "🎬 Видео (прикреплено)" : "🎬 Видео (прикрепить)";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Изменить состав", `tc_item_edit_${itemId}`)],
    [Markup.button.callback(methodBtn, `tc_item_method_${itemId}`)],
    [Markup.button.callback(videoBtn, `tc_item_video_${itemId}`)],
    [Markup.button.callback(toggleLabel, `tc_item_toggle_${itemId}`)],
    [Markup.button.callback("🗑 Удалить товар", `tc_item_delete_${itemId}`)],
    [Markup.button.callback("⬅️ Назад", `tc_group_${item.group_id}`)],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true, ...opts });
}

async function showEditIngredients(ctx, itemId) {
  const ingRes = await pool.query(
    `SELECT id, name, amount, unit, position
     FROM techcard_ingredients
     WHERE item_id = $1
     ORDER BY position ASC, id ASC`,
    [itemId]
  );

  let text = "✏️ <b>Состав</b>\n\n";
  if (!ingRes.rows.length) {
    text += "Пока нет ингредиентов.";
  } else {
    text += "Нажмите на объем, чтобы изменить, или ❌ чтобы удалить.";
  }

  const buttons = [];
  for (const r of ingRes.rows) {
    const nameBtn = Markup.button.callback(r.name, "tc_noop");
    const valBtn = Markup.button.callback(
      `${r.amount}${r.unit ? r.unit : ""}`,
      `tc_ing_edit_${r.id}`
    );
    const delBtn = Markup.button.callback("❌", `tc_ing_del_${r.id}`);
    buttons.push([nameBtn, valBtn, delBtn]);
  }
  buttons.push([Markup.button.callback("⬅️ Назад", `tc_item_${itemId}`)]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(buttons) }, { edit: true });
}

async function showMethod(ctx, itemId) {
  const res = await pool.query(
    `SELECT id, method_text FROM techcard_items WHERE id = $1`,
    [itemId]
  );
  if (!res.rows.length) {
    await ctx.reply("Товар не найден.");
    return;
  }
  const item = res.rows[0];

  if (!item.method_text) {
    setState(ctx.from.id, { step: "await_method_text", itemId });
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Назад", `tc_item_${itemId}`)],
    ]);
    await deliver(
      ctx,
      {
        text: "📝 Пришлите описание приготовления одним сообщением:",
        extra: keyboard,
      },
      { edit: true }
    );
    return;
  }

  const text = `📝 <b>Способ приготовления</b>\n\n${escHtml(item.method_text)}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🔁 Заменить", `tc_item_method_replace_${itemId}`)],
    [Markup.button.callback("⬅️ Назад", `tc_item_${itemId}`)],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showVideo(ctx, itemId) {
  const res = await pool.query(
    `SELECT id, video_file_id FROM techcard_items WHERE id = $1`,
    [itemId]
  );
  if (!res.rows.length) {
    await ctx.reply("Товар не найден.");
    return;
  }
  const item = res.rows[0];

  if (!item.video_file_id) {
    setState(ctx.from.id, { step: "await_video", itemId });
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Назад", `tc_item_${itemId}`)],
    ]);
    await deliver(
      ctx,
      {
        text: "🎬 Пришлите видео одним сообщением:",
        extra: keyboard,
      },
      { edit: true }
    );
    return;
  }

  // Отправляем видео отдельным сообщением
  await ctx.replyWithVideo(item.video_file_id, {
    caption: "🎬 Видео (прикреплено)",
  });

  const text = "🎬 Видео прикреплено. Хотите заменить?";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🔁 Заменить", `tc_item_video_replace_${itemId}`)],
    [Markup.button.callback("⬅️ Назад", `tc_item_${itemId}`)],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

function registerTechcards(bot, ensureUser, logError) {
  // entry from admin settings
  bot.action("admin_techcards", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clearState(ctx.from.id);
      await showGroups(ctx);
    } catch (err) {
      logError("admin_techcards", err);
    }
  });

  bot.action("tc_noop", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
  });

  // groups list
  bot.action("tc_groups", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clearState(ctx.from.id);
      await showGroups(ctx);
    } catch (err) {
      logError("tc_groups", err);
    }
  });

  bot.action(/^tc_group_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const groupId = Number(ctx.match[1]);
      clearState(ctx.from.id);
      await showGroup(ctx, groupId);
    } catch (err) {
      logError("tc_group_x", err);
    }
  });

  bot.action("tc_group_add", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setState(ctx.from.id, { step: "await_group_title" });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", "admin_techcards")],
      ]);
      await deliver(
        ctx,
        { text: "➕ Введите название группы одним сообщением:", extra: keyboard },
        { edit: true }
      );
    } catch (err) {
      logError("tc_group_add", err);
    }
  });

  // add item wizard
  bot.action(/^tc_item_add_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const groupId = Number(ctx.match[1]);
      setState(ctx.from.id, {
        step: "await_item_title",
        groupId,
        draft: {
          title: null,
          ingredients: [],
          pendingIngredientName: null,
          pendingAmount: null,
          pendingUnit: null,
        },
      });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", `tc_group_${groupId}`)],
      ]);
      await deliver(
        ctx,
        { text: "➕ Введите название товара одним сообщением:", extra: keyboard },
        { edit: true }
      );
    } catch (err) {
      logError("tc_item_add_x", err);
    }
  });

  bot.action(/^tc_item_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);
      clearState(ctx.from.id);
      await showItemCard(ctx, itemId);
    } catch (err) {
      logError("tc_item_x", err);
    }
  });

  bot.action(/^tc_item_edit_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);
      clearState(ctx.from.id);
      await showEditIngredients(ctx, itemId);
    } catch (err) {
      logError("tc_item_edit_x", err);
    }
  });

  bot.action(/^tc_ing_del_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const ingId = Number(ctx.match[1]);
      const res = await pool.query(
        `SELECT id, item_id, name FROM techcard_ingredients WHERE id = $1`,
        [ingId]
      );
      if (!res.rows.length) {
        await ctx.reply("Ингредиент не найден.");
        return;
      }
      const ing = res.rows[0];
      const text = `Удалить ингредиент <b>${escHtml(ing.name)}</b>?`;
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Да", `tc_ing_del_yes_${ingId}`),
          Markup.button.callback("❌ Нет", `tc_item_edit_${ing.item_id}`),
        ],
      ]);
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("tc_ing_del_x", err);
    }
  });

  bot.action(/^tc_ing_del_yes_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const ingId = Number(ctx.match[1]);
      const res = await pool.query(
        `DELETE FROM techcard_ingredients
         WHERE id = $1
         RETURNING item_id`,
        [ingId]
      );
      if (!res.rows.length) {
        await ctx.reply("Ингредиент не найден.");
        return;
      }
      const itemId = res.rows[0].item_id;
      await showEditIngredients(ctx, itemId);
    } catch (err) {
      logError("tc_ing_del_yes_x", err);
    }
  });

  bot.action(/^tc_ing_edit_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const ingId = Number(ctx.match[1]);
      const res = await pool.query(
        `SELECT id, item_id, name, amount, unit
         FROM techcard_ingredients
         WHERE id = $1`,
        [ingId]
      );
      if (!res.rows.length) {
        await ctx.reply("Ингредиент не найден.");
        return;
      }
      const ing = res.rows[0];

      setState(ctx.from.id, { step: "await_ing_amount", ingId, itemId: ing.item_id });
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", `tc_item_edit_${ing.item_id}`)],
      ]);
      await deliver(
        ctx,
        {
          text: `Введите новый объём для <b>${escHtml(ing.name)}</b> (текущий: ${escHtml(ing.amount)}${escHtml(ing.unit || "")}):`,
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("tc_ing_edit_x", err);
    }
  });

  bot.action(/^tc_item_method_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);
      clearState(ctx.from.id);
      await showMethod(ctx, itemId);
    } catch (err) {
      logError("tc_item_method_x", err);
    }
  });

  bot.action(/^tc_item_method_replace_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);
      setState(ctx.from.id, { step: "await_method_text", itemId });
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", `tc_item_${itemId}`)],
      ]);
      await deliver(
        ctx,
        { text: "📝 Пришлите новое описание приготовления:", extra: keyboard },
        { edit: true }
      );
    } catch (err) {
      logError("tc_item_method_replace_x", err);
    }
  });

  bot.action(/^tc_item_video_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);
      clearState(ctx.from.id);
      await showVideo(ctx, itemId);
    } catch (err) {
      logError("tc_item_video_x", err);
    }
  });

  bot.action(/^tc_item_video_replace_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);
      setState(ctx.from.id, { step: "await_video", itemId });
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", `tc_item_${itemId}`)],
      ]);
      await deliver(
        ctx,
        { text: "🎬 Пришлите новое видео одним сообщением:", extra: keyboard },
        { edit: true }
      );
    } catch (err) {
      logError("tc_item_video_replace_x", err);
    }
  });

  bot.action(/^tc_item_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);

      await pool.query(
        `UPDATE techcard_items
         SET is_active = NOT is_active
         WHERE id = $1`,
        [itemId]
      );
      await showItemCard(ctx, itemId);
    } catch (err) {
      logError("tc_item_toggle_x", err);
    }
  });

  bot.action(/^tc_item_delete_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);

      const res = await pool.query(
        `SELECT id, title, group_id FROM techcard_items WHERE id = $1`,
        [itemId]
      );
      if (!res.rows.length) {
        await ctx.reply("Товар не найден.");
        return;
      }
      const item = res.rows[0];
      const text = `Удалить товар <b>${escHtml(item.title)}</b>?`;
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Да", `tc_item_delete_yes_${itemId}`),
          Markup.button.callback("❌ Нет", `tc_item_${itemId}`),
        ],
      ]);
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("tc_item_delete_x", err);
    }
  });

  bot.action(/^tc_item_delete_yes_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const itemId = Number(ctx.match[1]);

      const res = await pool.query(
        `DELETE FROM techcard_items
         WHERE id = $1
         RETURNING group_id`,
        [itemId]
      );
      if (!res.rows.length) {
        await ctx.reply("Товар не найден.");
        return;
      }
      await showGroup(ctx, res.rows[0].group_id);
    } catch (err) {
      logError("tc_item_delete_yes_x", err);
    }
  });

  // "Готово" из мастера
  bot.action("tc_wizard_done", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;
      if (!["wizard", "wizard_amount", "wizard_unit"].includes(st.step)) return;

      const { groupId, draft } = st;
      if (!draft?.title) {
        await ctx.reply("Сначала задайте название товара.");
        return;
      }

      // если был введен ингредиент, но не завершен (нет количества/ед) — не сохраняем его
      const ingredients = Array.isArray(draft.ingredients) ? draft.ingredients : [];

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const itemRes = await client.query(
          `INSERT INTO techcard_items (group_id, title)
           VALUES ($1, $2)
           RETURNING id`,
          [groupId, draft.title]
        );
        const itemId = itemRes.rows[0].id;

        for (let i = 0; i < ingredients.length; i++) {
          const ing = ingredients[i];
          await client.query(
            `INSERT INTO techcard_ingredients (item_id, name, amount, unit, position)
             VALUES ($1, $2, $3, $4, $5)`,
            [itemId, ing.name, ing.amount, ing.unit || "", i + 1]
          );
        }

        await client.query("COMMIT");
        clearState(ctx.from.id);
        await showItemCard(ctx, itemId);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      logError("tc_wizard_done", err);
    }
  });

  // обработка текстовых сообщений (группа/товар/ингредиенты/метод)
  bot.on("text", async (ctx, next) => {
    const st = getState(ctx.from.id);
    if (!st) return next();

    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const text = (ctx.message.text || "").trim();
      if (!text) return next();

      if (st.step === "await_group_title") {
        await pool.query(`INSERT INTO techcard_groups (title) VALUES ($1)`, [text]);
        clearState(ctx.from.id);
        await showGroups(ctx);
        return;
      }

      if (st.step === "await_item_title") {
        st.draft.title = text;
        setState(ctx.from.id, { ...st, step: "wizard" });

        const comp = renderComposition(st.draft.ingredients);
        const msg = `Введите ингредиент 1\n\n<b>Состав:</b>\n${comp}`;
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("Готово ✅", "tc_wizard_done")],
          [Markup.button.callback("⬅️ Назад", `tc_group_${st.groupId}`)],
        ]);
        await deliver(ctx, { text: msg, extra: keyboard }, { edit: true });
        return;
      }

      if (st.step === "wizard") {
        // ожидаем имя ингредиента
        st.draft.pendingIngredientName = text;
        setState(ctx.from.id, { ...st, step: "wizard_amount" });

        const comp = renderComposition(st.draft.ingredients);
        const msg = `Введите объём ингредиента (${escHtml(text)})\n\n<b>Состав:</b>\n${comp}`;
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("Готово ✅", "tc_wizard_done")],
          [Markup.button.callback("⬅️ Назад", `tc_group_${st.groupId}`)],
        ]);
        await deliver(ctx, { text: msg, extra: keyboard }, { edit: true });
        return;
      }

      if (st.step === "wizard_amount") {
        st.draft.pendingAmount = normalizeNumberText(text);
        setState(ctx.from.id, { ...st, step: "wizard_unit" });

        const name = st.draft.pendingIngredientName;
        const comp = renderComposition(st.draft.ingredients);
        const msg = `Выберите единицу объёма либо введите своё\n\n<b>Состав:</b>\n${comp}`;
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("шт", "tc_unit_шт"),
            Markup.button.callback("г", "tc_unit_г"),
            Markup.button.callback("мл", "tc_unit_мл"),
          ],
          [
            Markup.button.callback("Готово ✅", "tc_wizard_done"),
            Markup.button.callback("⬅️ Назад", `tc_group_${st.groupId}`),
          ],
        ]);
        await deliver(ctx, { text: msg, extra: keyboard }, { edit: true });
        return;
      }

      if (st.step === "wizard_unit") {
        // пользователь ввёл свою единицу текстом
        const unit = text;
        const name = st.draft.pendingIngredientName;
        const amount = st.draft.pendingAmount;

        st.draft.ingredients.push({ name, amount, unit });
        st.draft.pendingIngredientName = null;
        st.draft.pendingAmount = null;
        st.draft.pendingUnit = null;

        const nextIdx = st.draft.ingredients.length + 1;
        setState(ctx.from.id, { ...st, step: "wizard" });

        const comp = renderComposition(st.draft.ingredients);
        const msg = `Введите ингредиент ${nextIdx}\n\n<b>Состав:</b>\n${comp}`;
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("Готово ✅", "tc_wizard_done")],
          [Markup.button.callback("⬅️ Назад", `tc_group_${st.groupId}`)],
        ]);
        await deliver(ctx, { text: msg, extra: keyboard }, { edit: true });
        return;
      }

      if (st.step === "await_method_text") {
        await pool.query(
          `UPDATE techcard_items SET method_text = $2 WHERE id = $1`,
          [st.itemId, text]
        );
        clearState(ctx.from.id);
        await showItemCard(ctx, st.itemId);
        return;
      }

      if (st.step === "await_ing_amount") {
        const amount = normalizeNumberText(text);
        // затем выбор/ввод единицы
        setState(ctx.from.id, { ...st, step: "await_ing_unit", amount });
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback("шт", "tc_ing_unit_шт"),
            Markup.button.callback("г", "tc_ing_unit_г"),
            Markup.button.callback("мл", "tc_ing_unit_мл"),
          ],
          [Markup.button.callback("⬅️ Назад", `tc_item_edit_${st.itemId}`)],
        ]);
        await deliver(
          ctx,
          { text: "Выберите единицу измерения либо введите свою:", extra: keyboard },
          { edit: true }
        );
        return;
      }

      if (st.step === "await_ing_unit") {
        await pool.query(
          `UPDATE techcard_ingredients
           SET amount = $2, unit = $3
           WHERE id = $1`,
          [st.ingId, st.amount, text]
        );
        const itemId = st.itemId;
        clearState(ctx.from.id);
        await showEditIngredients(ctx, itemId);
        return;
      }
    } catch (err) {
      logError("techcards_text", err);
    }

    return next();
  });

  // обработка видео
  bot.on("video", async (ctx, next) => {
    const st = getState(ctx.from.id);
    if (!st || st.step !== "await_video") return next();

    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const v = ctx.message.video;
      if (!v?.file_id) return next();

      await pool.query(
        `UPDATE techcard_items
         SET video_file_id = $2, video_file_unique_id = $3
         WHERE id = $1`,
        [st.itemId, v.file_id, v.file_unique_id]
      );
      clearState(ctx.from.id);
      await showItemCard(ctx, st.itemId);
    } catch (err) {
      logError("techcards_video", err);
    }
  });

  // unit button in wizard
  bot.action(/^tc_unit_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "wizard_unit") return;

      const unit = ctx.match[1];
      const name = st.draft.pendingIngredientName;
      const amount = st.draft.pendingAmount;

      st.draft.ingredients.push({ name, amount, unit });
      st.draft.pendingIngredientName = null;
      st.draft.pendingAmount = null;
      st.draft.pendingUnit = null;

      const nextIdx = st.draft.ingredients.length + 1;
      setState(ctx.from.id, { ...st, step: "wizard" });

      const comp = renderComposition(st.draft.ingredients);
      const msg = `Введите ингредиент ${nextIdx}\n\n<b>Состав:</b>\n${comp}`;
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("Готово ✅", "tc_wizard_done")],
        [Markup.button.callback("⬅️ Назад", `tc_group_${st.groupId}`)],
      ]);
      await deliver(ctx, { text: msg, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("tc_unit_x", err);
    }
  });

  // unit button in ingredient edit
  bot.action(/^tc_ing_unit_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "await_ing_unit") return;

      const unit = ctx.match[1];
      await pool.query(
        `UPDATE techcard_ingredients
         SET amount = $2, unit = $3
         WHERE id = $1`,
        [st.ingId, st.amount, unit]
      );
      const itemId = st.itemId;
      clearState(ctx.from.id);
      await showEditIngredients(ctx, itemId);
    } catch (err) {
      logError("tc_ing_unit_x", err);
    }
  });
}

module.exports = registerTechcards;
