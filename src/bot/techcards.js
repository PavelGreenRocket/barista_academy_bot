// src/bot/techcards.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// key: telegram_id, value: { step, groupId?, itemId?, draft? }
const tcStates = new Map();

// Пользовательский режим просмотра техкарт (не админ-настройка)
// key: telegram_id, value: { active: boolean }
const userTcStates = new Map();

// Тренировки по техкартам
// key: telegram_id, value: { userId, sessionId, mode, groupId?, queue, idx, correct, wrong, phase: 'question'|'answer' }
const tcTrainStates = new Map();

function setState(userId, state) {
  tcStates.set(userId, state);
}
function getState(userId) {
  return tcStates.get(userId);
}
function clearState(userId) {
  tcStates.delete(userId);
}

function setUserTcActive(tgId, active) {
  if (active) userTcStates.set(tgId, { active: true });
  else userTcStates.delete(tgId);
}

function isUserTcActive(tgId) {
  return userTcStates.has(tgId);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isAdmin(user) {
  return user && user.role === "admin" || user.role === "super_admin";
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

async function showUserTechcardsHome(ctx) {
  // Статус:
  // - по умолчанию: "не сдана"
  // - если пройден экзамен (>=95%) — "готов к сдаче ✅"
  let statusText = "не сдана";
  try {
    const uRes = await pool.query(
      `INSERT INTO users (telegram_id, role)
       VALUES ($1, 'user')
       ON CONFLICT (telegram_id) DO UPDATE SET telegram_id = EXCLUDED.telegram_id
       RETURNING id`,
      [ctx.from.id]
    );
    const userId = uRes.rows[0]?.id;
    if (userId) {
      const passRes = await pool.query(
        `SELECT 1
         FROM techcard_exam_passes
         WHERE user_id = $1
         LIMIT 1`,
        [userId]
      );
      if (passRes.rowCount > 0) statusText = "готов к сдаче ✅";
    }
  } catch (_) {
    // если таблиц ещё нет — просто оставим статус по умолчанию
  }

  const text = `📖 <b>Техкарта</b>\n\nТехкарта: <b>${escHtml(statusText)}</b>\n\nВыберите режим:`;

  const keyboard = Markup.inlineKeyboard([
    // «кнопка-список» через inline-mode (стрелка справа как на скрине)
    [Markup.button.switchToCurrentChat("📁 Выбрать группу", "#spisokGroup ")],
    [Markup.button.switchToCurrentChat("🔎 Общий поиск", "#spisokMenu ")],
    [Markup.button.callback("🏁 Приступить к тренировке", "utc_train_menu")],
    [Markup.button.callback(\"⬅️ Назад\", \"back_main\")],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function buildUserItemCardText(itemId) {
  const res = await pool.query(
    `SELECT i.id, i.title, i.group_id, i.is_active,
            i.method_text, i.video_file_id,
            g.title AS group_title
     FROM techcard_items i
     JOIN techcard_groups g ON g.id = i.group_id
     WHERE i.id = $1
     LIMIT 1`,
    [itemId]
  );
  if (!res.rows.length) return null;
  const item = res.rows[0];

  const ingRes = await pool.query(
    `SELECT name, amount, unit, position
     FROM techcard_ingredients
     WHERE item_id = $1
     ORDER BY position ASC, id ASC`,
    [itemId]
  );

  const compLines = ingRes.rows.length
    ? ingRes.rows
        .map((r) => {
          const unit = r.unit ? String(r.unit) : "";
          return `${escHtml(r.name)} — ${escHtml(r.amount)}${escHtml(unit)}`;
        })
        .join("\n")
    : "<i>пока пусто</i>";

  let text = `<b>${escHtml(item.title)}</b>\n\n`;
  text += `ингредиенты:\n${compLines}\n\n`;

  if (item.method_text) {
    text += `способ приготовления:\n${escHtml(item.method_text)}`;
  } else {
    text += `способ приготовления:\n<i>не добавлено</i>`;
  }

  return { item, text };
}

function buildUserNavKeyboard({ groupId, itemId, hasVideo }) {
  const rows = [];

  if (hasVideo) {
    rows.push([Markup.button.callback("🎥 Видео", `utc_video_${itemId}`)]);
  }

  // нижняя навигация остаётся
  rows.push([
    Markup.button.switchToCurrentChat("группы 📂", "#spisokGroup "),
    Markup.button.switchToCurrentChat("общий поиск 🔎", "#spisokMenu "),
  ]);

  // «назад» — всегда внизу
  if (groupId) rows.push([Markup.button.callback("⬅️ Назад", `utc_group_${groupId}`)]);
  else rows.push([Markup.button.callback("⬅️ Назад", "user_techcards")]);

  return Markup.inlineKeyboard(rows);
}

async function showUserItemCard(ctx, itemId, opts = {}) {
  const data = await buildUserItemCardText(itemId);
  if (!data) return;
  const { item, text } = data;

  const keyboard = buildUserNavKeyboard({
    groupId: item.group_id,
    itemId: item.id,
    hasVideo: !!item.video_file_id,
  });

  await deliver(ctx, { text, extra: keyboard }, { edit: true, ...opts });
}

async function showUserGroupItems(ctx, groupId) {
  const gRes = await pool.query(
    `SELECT id, title FROM techcard_groups WHERE id = $1 LIMIT 1`,
    [groupId]
  );
  if (!gRes.rows.length) return;
  const group = gRes.rows[0];

  const itemsRes = await pool.query(
    `SELECT id, title
     FROM techcard_items
     WHERE group_id = $1 AND is_active = TRUE
     ORDER BY title ASC`,
    [groupId]
  );

  let text = `📂 <b>${escHtml(group.title)}</b>\n\nВыберите товар:`;
  const rows = [];

  for (const it of itemsRes.rows) {
    rows.push([Markup.button.callback(it.title, `utc_item_${it.id}`)]);
  }

  rows.push([
    Markup.button.switchToCurrentChat("группы 📂", "#spisokGroup "),
    Markup.button.switchToCurrentChat("общий поиск 🔎", "#spisokMenu "),
  ]);
  rows.push([Markup.button.callback("⬅️ Назад", "user_techcards")]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(rows) }, { edit: true });
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
  // ----------------------
  // TRAINING HELPERS (USER)
  // ----------------------
  async function createTrainingSession(userId, mode, groupId = null) {
    const res = await pool.query(
      `INSERT INTO techcard_training_sessions (user_id, mode, group_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, mode, groupId]
    );
    return res.rows[0].id;
  }

  async function recordTrainingAnswer({ userId, sessionId, itemId, isCorrect }) {
    await pool.query(
      `INSERT INTO techcard_training_answers (session_id, user_id, item_id, is_correct)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, userId, itemId, isCorrect]
    );

    await pool.query(
      `INSERT INTO techcard_user_item_stats (user_id, item_id, correct_count, wrong_count, last_is_correct, last_answered_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id, item_id) DO UPDATE
       SET correct_count = techcard_user_item_stats.correct_count + EXCLUDED.correct_count,
           wrong_count = techcard_user_item_stats.wrong_count + EXCLUDED.wrong_count,
           last_is_correct = EXCLUDED.last_is_correct,
           last_answered_at = now()`,
      [userId, itemId, isCorrect ? 1 : 0, isCorrect ? 0 : 1, isCorrect]
    );
  }

  async function finishTrainingSession(sessionId, { total, correct, wrong, passed }) {
    const score = total > 0 ? correct / total : 0;
    await pool.query(
      `UPDATE techcard_training_sessions
       SET ended_at = now(), total_questions = $2, correct = $3, wrong = $4, score = $5, passed = $6
       WHERE id = $1`,
      [sessionId, total, correct, wrong, score, passed]
    );
    return score;
  }

  async function ensureExamPass(userId, sessionId, score) {
    await pool.query(
      `INSERT INTO techcard_exam_passes (user_id, session_id, score, passed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE
       SET session_id = EXCLUDED.session_id,
           score = EXCLUDED.score,
           passed_at = now()`,
      [userId, sessionId, score]
    );
  }

  async function loadQueue(mode, groupId, userId) {
    if (mode === "group") {
      const res = await pool.query(
        `SELECT id FROM techcard_items WHERE group_id = $1 AND is_active = TRUE ORDER BY title ASC`,
        [groupId]
      );
      return res.rows.map((r) => r.id);
    }

    if (mode === "errors") {
      const res = await pool.query(
        `SELECT s.item_id AS id
         FROM techcard_user_item_stats s
         JOIN techcard_items i ON i.id = s.item_id
         WHERE s.user_id = $1
           AND i.is_active = TRUE
           AND (s.last_is_correct = FALSE OR s.wrong_count > 0)
         ORDER BY s.last_answered_at DESC NULLS LAST
         LIMIT 200`,
        [userId]
      );
      return res.rows.map((r) => r.id);
    }

    // random | exam
    const res = await pool.query(
      `SELECT id FROM techcard_items WHERE is_active = TRUE ORDER BY title ASC`
    );
    return res.rows.map((r) => r.id);
  }

  async function showTrainingMenu(ctx) {
    const text = `🏁 <b>Тренировки по техкарте</b>\n\nВыберите режим:`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("📁 Выбрать группу для тестирования", "utc_tr_mode_group")],
      [Markup.button.callback("🎲 Произвольное тестирование", "utc_tr_mode_random")],
      [Markup.button.callback("🧾 Пройти тестовый экзамен", "utc_tr_mode_exam")],
      [Markup.button.callback("🧯 Тесты по ошибкам", "utc_tr_mode_errors")],
      [Markup.button.callback("⬅️ Назад", "user_techcards")],
    ]);
    await deliver(ctx, { text, extra: kb }, { edit: true });
  }

  async function showTrainingGroupPicker(ctx) {
    const res = await pool.query(`SELECT id, title FROM techcard_groups ORDER BY title ASC`);
    const rows = res.rows.map((g) => [Markup.button.callback(g.title, `utc_tr_pickgroup_${g.id}`)]);
    rows.push([Markup.button.callback("⬅️ Назад", "utc_train_menu")]);
    const text = `📁 <b>Выберите группу для тестирования</b>`;
    await deliver(ctx, { text, extra: Markup.inlineKeyboard(rows) }, { edit: true });
  }

  async function showQuestion(ctx) {
    const st = tcTrainStates.get(ctx.from.id);
    if (!st) return;
    const itemId = st.queue[st.idx];
    if (!itemId) return;

    const data = await buildUserItemCardText(itemId);
    if (!data) return;

    const total = st.queue.length;
    const text = `⭐ <b>Вопрос ${st.idx + 1}/${total}</b>\n\n❓ Назовите состав: <b>${escHtml(
      data.item.title
    )}</b>`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("👁 Показать ответ", "utc_tr_show")],
      [Markup.button.callback("⏹ Закончить", "utc_tr_stop")],
    ]);

    st.phase = "question";
    tcTrainStates.set(ctx.from.id, st);
    await deliver(ctx, { text, extra: kb }, { edit: true });
  }

  async function showAnswer(ctx) {
    const st = tcTrainStates.get(ctx.from.id);
    if (!st) return;
    const itemId = st.queue[st.idx];
    if (!itemId) return;

    const data = await buildUserItemCardText(itemId);
    if (!data) return;

    let text = `⭐ <b>Вопрос ${st.idx + 1}/${st.queue.length}</b>\n\n`;
    text += `💡 <b>Ответ:</b>\n\n${data.text}`;

    const rows = [];
    if (data.item.video_file_id) {
      rows.push([Markup.button.callback("🎥 Видео", `utc_video_${data.item.id}`)]);
    }
    rows.push([
      Markup.button.callback("✅ Верно", "utc_tr_mark_ok"),
      Markup.button.callback("❌ Не вспомнил", "utc_tr_mark_bad"),
    ]);
    rows.push([Markup.button.callback("⏹ Закончить", "utc_tr_stop")]);

    st.phase = "answer";
    tcTrainStates.set(ctx.from.id, st);
    await deliver(ctx, { text, extra: Markup.inlineKeyboard(rows) }, { edit: true });
  }

  async function startTraining(ctx, { mode, groupId = null }) {
    const user = await ensureUser(ctx);
    if (!user) return;

    let queue = await loadQueue(mode === "group" ? "group" : mode, groupId, user.id);
    if (!queue.length) {
      await deliver(
        ctx,
        {
          text:
            mode === "errors"
              ? "✅ <b>Ошибок пока нет.</b>"
              : "⚠️ <b>В этой группе нет активных карточек.</b>",
          extra: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "utc_train_menu")]]),
        },
        { edit: true }
      );
      return;
    }

    if (mode === "random" || mode === "errors" || mode === "exam") {
      queue = shuffleInPlace([...queue]);
    }

    const sessionId = await createTrainingSession(user.id, mode, groupId);
    tcTrainStates.set(ctx.from.id, {
      userId: user.id,
      sessionId,
      mode,
      groupId,
      queue,
      idx: 0,
      correct: 0,
      wrong: 0,
      phase: "question",
    });

    await showQuestion(ctx);
  }
  // ----------------------
  // USER: вход в раздел 📖 техкарта
  // ----------------------
  bot.action("user_techcards", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      // активируем быстрый поиск по тексту в этом разделе
      setUserTcActive(ctx.from.id, true);
      await showUserTechcardsHome(ctx);
    } catch (err) {
      logError("user_techcards", err);
      await ctx.reply("Не удалось открыть техкарту. Попробуй позже.");
    }
  });

  bot.action("utc_train_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showTrainingMenu(ctx);
    } catch (err) {
      logError("utc_train_menu", err);
    }
  });

  bot.action("utc_tr_mode_group", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showTrainingGroupPicker(ctx);
    } catch (err) {
      logError("utc_tr_mode_group", err);
    }
  });

  bot.action(/^utc_tr_pickgroup_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const groupId = Number(ctx.match[1]);
      await startTraining(ctx, { mode: "group", groupId });
    } catch (err) {
      logError("utc_tr_pickgroup_x", err);
    }
  });

  bot.action("utc_tr_mode_random", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await startTraining(ctx, { mode: "random" });
    } catch (err) {
      logError("utc_tr_mode_random", err);
    }
  });

  bot.action("utc_tr_mode_exam", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await startTraining(ctx, { mode: "exam" });
    } catch (err) {
      logError("utc_tr_mode_exam", err);
    }
  });

  bot.action("utc_tr_mode_errors", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await startTraining(ctx, { mode: "errors" });
    } catch (err) {
      logError("utc_tr_mode_errors", err);
    }
  });

  bot.action("utc_tr_show", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showAnswer(ctx);
    } catch (err) {
      logError("utc_tr_show", err);
    }
  });

  async function handleVerdict(ctx, isCorrect) {
    const st = tcTrainStates.get(ctx.from.id);
    if (!st) return;
    const itemId = st.queue[st.idx];
    if (!itemId) return;

    await recordTrainingAnswer({
      userId: st.userId,
      sessionId: st.sessionId,
      itemId,
      isCorrect,
    });

    if (isCorrect) st.correct += 1;
    else st.wrong += 1;

    st.idx += 1;
    tcTrainStates.set(ctx.from.id, st);

    // конец очереди
    if (st.idx >= st.queue.length) {
      const total = st.queue.length;
      const passed = st.mode === "exam" ? st.correct / total >= 0.95 : null;
      const score = await finishTrainingSession(st.sessionId, {
        total,
        correct: st.correct,
        wrong: st.wrong,
        passed: passed === null ? false : passed,
      });

      if (st.mode === "exam" && passed) {
        await ensureExamPass(st.userId, st.sessionId, score);
      }

      tcTrainStates.delete(ctx.from.id);

      let text = `🏁 <b>Тренировка завершена</b>\n\n`;
      text += `Верно: <b>${st.correct}</b>\n`;
      text += `Не вспомнил: <b>${st.wrong}</b>\n`;
      text += `Результат: <b>${Math.round(score * 100)}%</b>`;

      if (st.mode === "exam") {
        text += `\n\nЭкзамен: ${passed ? "<b>зачтено ✅</b>" : "<b>не зачтено</b>"}`;
      }

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ В техкарту", "user_techcards")],
        [Markup.button.callback("🏁 В тренировки", "utc_train_menu")],
      ]);

      await deliver(ctx, { text, extra: kb }, { edit: true });
      return;
    }

    await showQuestion(ctx);
  }

  bot.action("utc_tr_mark_ok", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await handleVerdict(ctx, true);
    } catch (err) {
      logError("utc_tr_mark_ok", err);
    }
  });

  bot.action("utc_tr_mark_bad", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await handleVerdict(ctx, false);
    } catch (err) {
      logError("utc_tr_mark_bad", err);
    }
  });

  bot.action("utc_tr_stop", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const st = tcTrainStates.get(ctx.from.id);
      if (st) {
        const total = st.queue.length;
        await finishTrainingSession(st.sessionId, {
          total,
          correct: st.correct,
          wrong: st.wrong,
          passed: false,
        });
        tcTrainStates.delete(ctx.from.id);
      }
      await showTrainingMenu(ctx);
    } catch (err) {
      logError("utc_tr_stop", err);
    }
  });

  // выбор группы (кнопки внутри сообщения)
  bot.action(/^utc_group_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const groupId = Number(ctx.match[1]);
      await showUserGroupItems(ctx, groupId);
    } catch (err) {
      logError("utc_group_x", err);
    }
  });

  // выбор товара (из списка группы)
  bot.action(/^utc_item_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const itemId = Number(ctx.match[1]);
      await showUserItemCard(ctx, itemId);
    } catch (err) {
      logError("utc_item_x", err);
    }
  });

  // видео приготовления (кнопка показывается только если есть file_id)
  bot.action(/^utc_video_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const itemId = Number(ctx.match[1]);

      const res = await pool.query(
        `SELECT video_file_id
         FROM techcard_items
         WHERE id = $1 AND is_active = TRUE
         LIMIT 1`,
        [itemId]
      );
      const fileId = res.rows[0]?.video_file_id;
      if (!fileId) {
        // кнопки не должно быть, но на всякий случай
        await ctx.reply("Видео пока не прикреплено.");
        return;
      }
      await ctx.replyWithVideo(fileId);
    } catch (err) {
      logError("utc_video_x", err);
      await ctx.reply("Не удалось отправить видео.");
    }
  });

  // inline-mode списки (кнопки-списки как на скринах)
  bot.on("inline_query", async (ctx) => {
    try {
      const qRaw = String(ctx.inlineQuery?.query || "").trim();

      // группы
      if (qRaw.startsWith("#spisokGroup")) {
        const term = qRaw.replace(/^#spisokGroup\s*/i, "").trim();

        const gRes = await pool.query(
          `SELECT id, title
           FROM techcard_groups
           WHERE ($1 = '' OR title ILIKE '%' || $1 || '%')
           ORDER BY title ASC
           LIMIT 30`,
          [term]
        );

        const results = [];
        for (const g of gRes.rows) {
          // готовим сообщение "экран группы" с кнопками товаров
          const itemsRes = await pool.query(
            `SELECT id, title
             FROM techcard_items
             WHERE group_id = $1 AND is_active = TRUE
             ORDER BY title ASC
             LIMIT 60`,
            [g.id]
          );

          const rows = [];
          for (const it of itemsRes.rows) {
            rows.push([Markup.button.callback(it.title, `utc_item_${it.id}`)]);
          }
          rows.push([Markup.button.callback("⬅️ Назад", "user_techcards")]);
          rows.push([
            Markup.button.switchToCurrentChat("группы 📂", "#spisokGroup "),
            Markup.button.switchToCurrentChat("общий поиск 🔎", "#spisokMenu "),
          ]);

          results.push({
            type: "article",
            id: `g_${g.id}`,
            title: g.title,
            description: `${itemsRes.rowCount} товаров`,
            input_message_content: {
              message_text: `📂 <b>${escHtml(g.title)}</b>\n\nВыберите товар:`,
              parse_mode: "HTML",
            },
            reply_markup: Markup.inlineKeyboard(rows).reply_markup,
          });
        }

        await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
        return;
      }

      // общий поиск
      if (qRaw.startsWith("#spisokMenu")) {
        const term = qRaw.replace(/^#spisokMenu\s*/i, "").trim();

        const itRes = await pool.query(
          `SELECT i.id, i.title, i.group_id, i.method_text, i.video_file_id,
                  g.title AS group_title
           FROM techcard_items i
           JOIN techcard_groups g ON g.id = i.group_id
           WHERE i.is_active = TRUE
             AND ($1 = '' OR i.title ILIKE '%' || $1 || '%')
           ORDER BY i.title ASC
           LIMIT 40`,
          [term]
        );

        const results = [];
        for (const it of itRes.rows) {
          const card = await buildUserItemCardText(it.id);
          if (!card) continue;
          const keyboard = buildUserNavKeyboard({
            groupId: it.group_id,
            itemId: it.id,
            hasVideo: !!it.video_file_id,
          });

          results.push({
            type: "article",
            id: `i_${it.id}`,
            title: it.title,
            description: it.group_title,
            input_message_content: {
              message_text: card.text,
              parse_mode: "HTML",
            },
            reply_markup: keyboard.reply_markup,
          });
        }

        await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
        return;
      }
    } catch (err) {
      logError("inline_query_techcards", err);
      // молча (Telegram не любит спам в inline)
    }
  });

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
    // USER: быстрый поиск по названию товара, пока пользователь находится в разделе 📖 техкарта
    try {
      if (isUserTcActive(ctx.from.id)) {
        const q = String(ctx.message.text || "").trim();
        if (!q || q.startsWith("/")) return next();

        const rowsRes = await pool.query(
          `SELECT i.id, i.title
           FROM techcard_items i
           WHERE i.is_active = TRUE
             AND i.title ILIKE '%' || $1 || '%'
           ORDER BY char_length(i.title) ASC, i.title ASC
           LIMIT 10`,
          [q]
        );

        if (rowsRes.rowCount === 1) {
          await showUserItemCard(ctx, rowsRes.rows[0].id, { edit: false });
          return;
        }

        if (rowsRes.rowCount > 1) {
          const kb = Markup.inlineKeyboard(
            rowsRes.rows.map((r) => [Markup.button.callback(r.title, `utc_item_${r.id}`)])
          );
          await ctx.reply("Найдено несколько вариантов — выбери:", kb);
          return;
        }

        // ничего не нашли — молчим
        return;
      }
    } catch (err) {
      logError("user_tc_quick_search", err);
    }

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
