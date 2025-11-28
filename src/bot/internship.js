const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// состояние для настройки (ожидание названия / документа)
const configStates = new Map(); // key: adminTelegramId → { mode, partId?, stepId?, title? }
// состояние ожидания медиа по этапам
const mediaStates = new Map(); // key: adminTelegramId → { sessionId, stepId, type, partId, userId }

function isAdmin(user) {
  return user && user.role === "admin";
}

// ---------- HELPERS БАЗЫ ----------

// активная сессия стажировки по тренеру (для кнопки в главном меню)
async function hasActiveInternshipSessionForTrainer(trainerUserId) {
  const res = await pool.query(
    `
    SELECT 1
    FROM internship_sessions
    WHERE started_by = $1
      AND finished_at IS NULL
      AND is_canceled = FALSE
    LIMIT 1
  `,
    [trainerUserId]
  );
  return res.rows.length > 0;
}

// активная сессия по пользователю
async function getActiveSessionForUser(userId) {
  const res = await pool.query(
    `
    SELECT *
    FROM internship_sessions
    WHERE user_id = $1
      AND finished_at IS NULL
      AND is_canceled = FALSE
    ORDER BY started_at DESC
    LIMIT 1
  `,
    [userId]
  );
  return res.rows[0] || null;
}

// части + этапы
async function getPartsWithSteps() {
  const res = await pool.query(
    `
    SELECT
      p.id AS part_id,
      p.title AS part_title,
      p.order_index AS part_order,
      p.doc_file_id,
      s.id AS step_id,
      s.title AS step_title,
      s.step_type,
      s.order_index AS step_order
    FROM internship_parts p
    LEFT JOIN internship_steps s
      ON s.part_id = p.id
    ORDER BY p.order_index, p.id, s.order_index, s.id
  `
  );

  const partsMap = new Map();

  for (const row of res.rows) {
    let part = partsMap.get(row.part_id);
    if (!part) {
      part = {
        id: row.part_id,
        title: row.part_title,
        order_index: row.part_order,
        doc_file_id: row.doc_file_id,
        steps: [],
      };
      partsMap.set(row.part_id, part);
    }

    if (row.step_id) {
      part.steps.push({
        id: row.step_id,
        title: row.step_title,
        type: row.step_type,
        order_index: row.step_order,
      });
    }
  }

  return [...partsMap.values()];
}

// мапа step_id → состояние по сессии
async function getSessionStepMap(sessionId) {
  const res = await pool.query(
    `
    SELECT
      r.step_id,
      r.is_passed,
      r.checked_at,
      u.full_name AS checked_by_name
    FROM internship_step_results r
    LEFT JOIN users u ON u.id = r.checked_by
    WHERE r.session_id = $1
  `,
    [sessionId]
  );

  const map = new Map();
  for (const row of res.rows) {
    map.set(row.step_id, {
      is_passed: row.is_passed,
      checked_at: row.checked_at,
      checked_by_name: row.checked_by_name,
    });
  }
  return map;
}

function formatDurationMs(ms) {
  if (!ms || ms <= 0) return "-";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (!hours && !minutes) return "< 1 мин";
  if (!hours) return `${minutes} мин`;
  return `${hours} ч ${minutes} мин`;
}

// ---------- МЕНЮ СТАЖИРОВКИ ПО ПОЛЬЗОВАТЕЛЮ ----------

async function showUserInternshipMenu(ctx, admin, targetUserId) {
  const uRes = await pool.query(
    "SELECT id, full_name, role, staff_status, intern_days_completed FROM users WHERE id = $1",
    [targetUserId]
  );
  if (!uRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = uRes.rows[0];
  const name = user.full_name || "Без имени";

  const activeSession = await getActiveSessionForUser(user.id);

  const isIntern = user.staff_status === "intern";
  const nextDay = (user.intern_days_completed || 0) + 1;

  let text =
    `👤 ${name}\n` +
    `Роль: ${user.role}\n` +
    (isIntern
      ? `Статус: стажёр (день ${nextDay})\n\n`
      : `Статус: работник\n\n`);

  const buttons = [];

  if (!activeSession) {
    if (isIntern) {
      text +=
        "Здесь можно запустить стажировку по дням и смотреть прогресс.\n\nВыбери действие:";

      buttons.push([
        Markup.button.callback(
          "▶️ Приступить к стажировке",
          `admin_internship_start_${user.id}`
        ),
      ]);
    } else {
      text +=
        "Этот сотрудник уже работник. Новую стажировку запустить нельзя, но можно посмотреть историю.\n\nВыбери действие:";
    }

    buttons.push([
      Markup.button.callback(
        "🌱 Данные о стажировке",
        `admin_internship_data_${user.id}`
      ),
    ]);
    buttons.push([
      Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
    ]);
  } else {
    text +=
      `Сейчас идёт стажировка (день ${activeSession.day_number}).\n` +
      "Ниже — части этого дня:\n\n";

    const parts = await getPartsWithSteps();
    const stepMap = await getSessionStepMap(activeSession.id);

    for (const part of parts) {
      if (!part.steps.length) continue;
      const passed = part.steps.every(
        (s) => stepMap.get(s.id)?.is_passed === true
      );
      const icon = passed ? "✅" : "❌";
      buttons.push([
        Markup.button.callback(
          `${icon} ${part.title}`,
          `admin_internship_session_part_${activeSession.id}_${part.id}_${user.id}`
        ),
      ]);
    }

    buttons.push([
      Markup.button.callback(
        "⏹ Закончить стажировку",
        `admin_internship_finish_${activeSession.id}_${user.id}`
      ),
    ]);
    buttons.push([
      Markup.button.callback(
        "❌ Отменить стажировку",
        `admin_internship_cancel_${activeSession.id}_${user.id}`
      ),
    ]);
    buttons.push([
      Markup.button.callback(
        "🌱 Данные о стажировке",
        `admin_internship_data_${user.id}`
      ),
    ]);
    buttons.push([
      Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
    ]);
  }

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function startInternshipSession(ctx, admin, targetUserId) {
  const uRes = await pool.query(
    "SELECT id, full_name, staff_status, intern_days_completed FROM users WHERE id = $1",
    [targetUserId]
  );
  if (!uRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = uRes.rows[0];

  if (user.staff_status !== "intern") {
    await ctx.reply(
      "Этот сотрудник уже работник. Новую стажировку для него запустить нельзя."
    );
    return;
  }

  const active = await getActiveSessionForUser(user.id);
  if (active) {
    await ctx.reply(
      "У этого стажёра уже есть незавершённая стажировка. Сначала завершите или отмените её."
    );
    return;
  }

  const nextDay = (user.intern_days_completed || 0) + 1;

  const ins = await pool.query(
    `
    INSERT INTO internship_sessions (user_id, day_number, started_by)
    VALUES ($1, $2, $3)
    RETURNING id
  `,
    [user.id, nextDay, admin.id]
  );
  const sessionId = ins.rows[0].id;

  await ctx.reply(
    `Стажировка начата. День ${nextDay}. Стажёр: ${
      user.full_name || "Без имени"
    }.`
  );

  await showUserInternshipMenu(ctx, admin, user.id);
}

// показать часть с этапами
async function showSessionPart(ctx, sessionId, partId, userId) {
  const sRes = await pool.query(
    "SELECT * FROM internship_sessions WHERE id = $1",
    [sessionId]
  );
  if (!sRes.rows.length) {
    await ctx.reply("Сессия стажировки не найдена.");
    return;
  }
  const session = sRes.rows[0];

  const pRes = await pool.query(
    "SELECT id, title, doc_file_id FROM internship_parts WHERE id = $1",
    [partId]
  );
  if (!pRes.rows.length) {
    await ctx.reply("Часть стажировки не найдена.");
    return;
  }
  const part = pRes.rows[0];

  const stepsRes = await pool.query(
    `
    SELECT id, title, step_type, order_index
    FROM internship_steps
    WHERE part_id = $1
    ORDER BY order_index, id
  `,
    [partId]
  );
  const steps = stepsRes.rows;

  const stepMap = await getSessionStepMap(sessionId);

  let text =
    `🎓 Стажировка — день ${session.day_number}\n` +
    `Часть: ${part.title}\n\n` +
    "Этапы:\n";

  const buttons = [];

  if (!steps.length) {
    text += "(В этой части пока нет этапов.)";
  } else {
    for (const step of steps) {
      const state = stepMap.get(step.id);
      const passed = state?.is_passed === true;
      const icon = passed ? "✅" : "❌";

      let typeIcon = "🔘";
      if (step.step_type === "video") typeIcon = "🎥";
      else if (step.step_type === "photo") typeIcon = "📷";

      const label = `${icon} ${typeIcon} ${step.title}`;

      if (step.step_type === "simple") {
        buttons.push([
          Markup.button.callback(
            label,
            `admin_internship_step_toggle_${sessionId}_${step.id}_${partId}_${userId}`
          ),
        ]);
      } else {
        buttons.push([
          Markup.button.callback(
            label,
            `admin_internship_step_media_${sessionId}_${step.id}_${partId}_${userId}`
          ),
        ]);
      }
    }
  }

  if (part.doc_file_id) {
    buttons.push([
      Markup.button.callback(
        "📄 Описание части",
        `admin_internship_part_doc_${part.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback("🔙 К частям", `admin_user_internship_${userId}`),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// переключение обычного этапа
async function toggleSimpleStep(sessionId, stepId, adminId) {
  const res = await pool.query(
    `
    SELECT is_passed
    FROM internship_step_results
    WHERE session_id = $1 AND step_id = $2
  `,
    [sessionId, stepId]
  );

  if (!res.rows.length) {
    await pool.query(
      `
      INSERT INTO internship_step_results (session_id, step_id, is_passed, checked_by, checked_at)
      VALUES ($1, $2, TRUE, $3, NOW())
    `,
      [sessionId, stepId, adminId]
    );
  } else {
    const current = res.rows[0].is_passed;
    const newVal = !current;
    await pool.query(
      `
      UPDATE internship_step_results
      SET is_passed = $3,
          checked_by = CASE WHEN $3 THEN $4 ELSE checked_by END,
          checked_at = CASE WHEN $3 THEN NOW() ELSE checked_at END
      WHERE session_id = $1 AND step_id = $2
    `,
      [sessionId, stepId, newVal, adminId]
    );
  }
}

// установить медиа‑этап как выполненный
async function setMediaStepPassed(sessionId, stepId, adminId, fileId) {
  const res = await pool.query(
    `
    SELECT 1
    FROM internship_step_results
    WHERE session_id = $1 AND step_id = $2
  `,
    [sessionId, stepId]
  );

  if (!res.rows.length) {
    await pool.query(
      `
      INSERT INTO internship_step_results (session_id, step_id, is_passed, checked_by, checked_at, media_file_id)
      VALUES ($1, $2, TRUE, $3, NOW(), $4)
    `,
      [sessionId, stepId, adminId, fileId]
    );
  } else {
    await pool.query(
      `
      UPDATE internship_step_results
      SET is_passed = TRUE,
          checked_by = $3,
          checked_at = NOW(),
          media_file_id = $4
      WHERE session_id = $1 AND step_id = $2
    `,
      [sessionId, stepId, adminId, fileId]
    );
  }
}

// завершить день стажировки
async function finishInternshipSession(ctx, sessionId, userId) {
  const sRes = await pool.query(
    "SELECT * FROM internship_sessions WHERE id = $1",
    [sessionId]
  );
  if (!sRes.rows.length) {
    await ctx.reply("Сессия стажировки не найдена.");
    return;
  }
  const session = sRes.rows[0];
  if (session.finished_at || session.is_canceled) {
    await ctx.reply("Эта стажировка уже завершена или отменена.");
    return;
  }

  const end = new Date();
  const start = new Date(session.started_at);
  const durationMs = end - start;

  await pool.query(
    `
    UPDATE internship_sessions
    SET finished_at = NOW(),
        is_canceled = FALSE
    WHERE id = $1
  `,
    [sessionId]
  );

  await pool.query(
    `
    UPDATE users
    SET intern_days_completed = intern_days_completed + 1
    WHERE id = $1
  `,
    [session.user_id]
  );

  const durText = formatDurationMs(durationMs);

  await ctx.reply(
    `Стажировка (день ${session.day_number}) завершена. Длительность: ${durText}.`
  );
}

// отменить день
async function cancelInternshipSession(ctx, sessionId) {
  const sRes = await pool.query(
    "SELECT * FROM internship_sessions WHERE id = $1",
    [sessionId]
  );
  if (!sRes.rows.length) {
    await ctx.reply("Сессия стажировки не найдена.");
    return;
  }
  const session = sRes.rows[0];
  if (session.finished_at || session.is_canceled) {
    await ctx.reply("Эта стажировка уже завершена или отменена.");
    return;
  }

  await pool.query(
    `
    UPDATE internship_sessions
    SET finished_at = NOW(),
        is_canceled = TRUE
    WHERE id = $1
  `,
    [sessionId]
  );

  await ctx.reply(
    `Стажировка (день ${session.day_number}) отменена. День не засчитан.`
  );
}

// ---------- ИСТОРИЯ ПО ПОЛЬЗОВАТЕЛЮ ----------

async function showUserInternshipData(ctx, userId) {
  const uRes = await pool.query(
    "SELECT id, full_name, role, staff_status, intern_days_completed FROM users WHERE id = $1",
    [userId]
  );
  if (!uRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = uRes.rows[0];
  const name = user.full_name || "Без имени";

  const sRes = await pool.query(
    `
    SELECT
      s.id,
      s.day_number,
      s.started_at,
      s.finished_at,
      s.is_canceled,
      u.full_name AS trainer_name
    FROM internship_sessions s
    LEFT JOIN users u ON u.id = s.started_by
    WHERE s.user_id = $1
    ORDER BY s.day_number, s.started_at
  `,
    [user.id]
  );
  const sessions = sRes.rows;

  const completedCount = sessions.filter(
    (s) => !s.is_canceled && s.finished_at
  ).length;

  let text =
    `🌱 Стажировка: ${name}\n` +
    `Роль: ${user.role}\n` +
    (user.staff_status === "intern"
      ? `Статус: стажёр (день ${(user.intern_days_completed || 0) + 1})\n`
      : `Статус: работник\n`) +
    `\nВсего завершённых стажировок (дней): ${completedCount}\n\n`;

  if (!sessions.length) {
    text += "Стажировок пока не было.";
  } else {
    const parts = await getPartsWithSteps();

    for (const s of sessions) {
      const trainer = s.trainer_name || "Неизвестно";
      const day = s.day_number;
      const started = s.started_at.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      let statusText;
      let durationMs = null;
      if (s.is_canceled) {
        statusText = "отменена";
      } else if (!s.finished_at) {
        statusText = "в процессе";
      } else {
        statusText = "завершена";
        durationMs = new Date(s.finished_at) - new Date(s.started_at);
      }

      text += `День ${day} (стажировал: ${trainer}, статус: ${statusText}`;
      if (durationMs !== null) {
        text += `, длительность: ${formatDurationMs(durationMs)}`;
      }
      text += `, начало: ${started})\n`;

      const stepMap = await getSessionStepMap(s.id);

      for (const part of parts) {
        if (!part.steps.length) continue;
        const allPassed = part.steps.every(
          (st) => stepMap.get(st.id)?.is_passed === true
        );
        const pIcon = allPassed ? "✅" : "❌";
        text += `  • ${pIcon} Часть: ${part.title}\n`;

        for (const step of part.steps) {
          const st = stepMap.get(step.id);
          const passed = st?.is_passed === true;
          const icon = passed ? "✅" : "❌";
          text += `    - ${icon} ${step.title}`;
          if (passed && st.checked_by_name && st.checked_at) {
            const dt = st.checked_at.toLocaleString("ru-RU", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
            text += ` (${st.checked_by_name}, ${dt})`;
          }
          text += `\n`;
        }
      }

      text += `\n`;
    }
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`)],
    [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

// ---------- НАСТРОЙКА СТАЖИРОВКИ В АДМИН‑ПАНЕЛИ ----------

async function showInternshipConfigMenu(ctx) {
  const parts = await getPartsWithSteps();

  let text = "🎓 Настройка стажировки\n\nЧасти:\n";

  const buttons = [];

  if (!parts.length) {
    text += "Пока нет ни одной части.\n";
  } else {
    for (const part of parts) {
      text += `• [${part.order_index}] ${part.title}\n`;
      buttons.push([
        Markup.button.callback(part.title, `admin_internship_part_${part.id}`),
      ]);
    }
  }

  buttons.push([
    Markup.button.callback("➕ Новая часть", "admin_internship_part_new"),
  ]);
  buttons.push([Markup.button.callback("🔙 Назад", "admin_settings")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showInternshipPart(ctx, partId) {
  const pRes = await pool.query(
    "SELECT id, title, order_index, doc_file_id FROM internship_parts WHERE id = $1",
    [partId]
  );
  if (!pRes.rows.length) {
    await ctx.reply("Часть стажировки не найдена.");
    return;
  }
  const part = pRes.rows[0];

  const sRes = await pool.query(
    `
    SELECT id, title, step_type, order_index
    FROM internship_steps
    WHERE part_id = $1
    ORDER BY order_index, id
  `,
    [partId]
  );
  const steps = sRes.rows;

  let text =
    `Часть стажировки:\n` +
    `Название: ${part.title}\n` +
    `Порядок: ${part.order_index}\n` +
    `Документ: ${part.doc_file_id ? "✅ прикреплён" : "❌ нет"}\n\n` +
    "Этапы:\n";

  if (!steps.length) {
    text += "(пока нет этапов)\n";
  } else {
    for (const st of steps) {
      let typeLabel =
        st.step_type === "video"
          ? "🎥"
          : st.step_type === "photo"
          ? "📷"
          : "🔘";
      text += `• [${st.order_index}] ${typeLabel} ${st.title}\n`;
    }
  }

  const buttons = [];

  for (const st of steps) {
    buttons.push([
      Markup.button.callback(
        st.title,
        `admin_internship_step_${st.id}_${part.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "➕ Добавить этап",
      `admin_internship_step_new_${part.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback(
      "📎 Документ (Word)",
      `admin_internship_part_doc_edit_${part.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback(
      "⬆️ Часть вверх",
      `admin_internship_part_up_${part.id}`
    ),
    Markup.button.callback(
      "⬇️ Часть вниз",
      `admin_internship_part_down_${part.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback(
      "🗑 Удалить часть",
      `admin_internship_part_del_${part.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("🔙 К частям", "admin_internship_menu"),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// ---------- РЕГИСТРАЦИЯ ВСЕГО В БОТЕ ----------

function registerInternship(bot, ensureUser, logError, showMainMenu) {
  // кнопка в карточке пользователя
  bot.action(/^admin_user_internship_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      await showUserInternshipMenu(ctx, admin, userId);
    } catch (err) {
      logError("admin_user_internship_x", err);
    }
  });

  // данные о стажировке
  bot.action(/^admin_internship_data_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      await showUserInternshipData(ctx, userId);
    } catch (err) {
      logError("admin_internship_data_x", err);
    }
  });

  // старт дня стажировки
  bot.action(/^admin_internship_start_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      await startInternshipSession(ctx, admin, userId);
    } catch (err) {
      logError("admin_internship_start_x", err);
    }
  });

  // часть с этапами
  bot.action(
    /^admin_internship_session_part_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const admin = await ensureUser(ctx);
        if (!isAdmin(admin)) return;
        const sessionId = parseInt(ctx.match[1], 10);
        const partId = parseInt(ctx.match[2], 10);
        const userId = parseInt(ctx.match[3], 10);
        await showSessionPart(ctx, sessionId, partId, userId);
      } catch (err) {
        logError("admin_internship_session_part_x", err);
      }
    }
  );

  // toggle простого этапа
  bot.action(
    /^admin_internship_step_toggle_(\d+)_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const admin = await ensureUser(ctx);
        if (!isAdmin(admin)) return;

        const sessionId = parseInt(ctx.match[1], 10);
        const stepId = parseInt(ctx.match[2], 10);
        const partId = parseInt(ctx.match[3], 10);
        const userId = parseInt(ctx.match[4], 10);

        await toggleSimpleStep(sessionId, stepId, admin.id);
        await showSessionPart(ctx, sessionId, partId, userId);
      } catch (err) {
        logError("admin_internship_step_toggle_x", err);
      }
    }
  );

  // запрос медиа для этапа
  bot.action(
    /^admin_internship_step_media_(\d+)_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const admin = await ensureUser(ctx);
        if (!isAdmin(admin)) return;

        const sessionId = parseInt(ctx.match[1], 10);
        const stepId = parseInt(ctx.match[2], 10);
        const partId = parseInt(ctx.match[3], 10);
        const userId = parseInt(ctx.match[4], 10);

        const stepRes = await pool.query(
          "SELECT step_type, title FROM internship_steps WHERE id = $1",
          [stepId]
        );
        if (!stepRes.rows.length) {
          await ctx.reply("Этап не найден.");
          return;
        }
        const step = stepRes.rows[0];

        const typeText =
          step.step_type === "video"
            ? "видео"
            : step.step_type === "photo"
            ? "фото"
            : "медиа";
        await ctx.reply(
          `Отправь ${typeText} для этапа:\n"${step.title}"\n\nКак только файл будет получен, этап автоматически отметится как ✅.`
        );

        mediaStates.set(ctx.from.id, {
          sessionId,
          stepId,
          type: step.step_type,
          partId,
          userId,
        });
      } catch (err) {
        logError("admin_internship_step_media_x", err);
      }
    }
  );

  // завершить день
  bot.action(/^admin_internship_finish_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sessionId = parseInt(ctx.match[1], 10);
      const userId = parseInt(ctx.match[2], 10);

      await finishInternshipSession(ctx, sessionId, userId);
      await showUserInternshipMenu(ctx, admin, userId);
    } catch (err) {
      logError("admin_internship_finish_x", err);
    }
  });

  // отменить день
  bot.action(/^admin_internship_cancel_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sessionId = parseInt(ctx.match[1], 10);
      const userId = parseInt(ctx.match[2], 10);

      await cancelInternshipSession(ctx, sessionId);
      await showUserInternshipMenu(ctx, admin, userId);
    } catch (err) {
      logError("admin_internship_cancel_x", err);
    }
  });

  // документ части (пользовательская часть)
  bot.action(/^admin_internship_part_doc_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      const res = await pool.query(
        "SELECT title, doc_file_id FROM internship_parts WHERE id = $1",
        [partId]
      );
      if (!res.rows.length || !res.rows[0].doc_file_id) {
        await ctx.reply("Для этой части пока не прикреплён документ.");
        return;
      }

      const part = res.rows[0];
      await ctx.replyWithDocument(part.doc_file_id, {
        caption: `Описание части: ${part.title}`,
      });
    } catch (err) {
      logError("admin_internship_part_doc_x", err);
    }
  });

  // ===== НАСТРОЙКА В АДМИН‑ПАНЕЛИ =====

  bot.action("admin_internship_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      configStates.delete(ctx.from.id);
      await showInternshipConfigMenu(ctx);
    } catch (err) {
      logError("admin_internship_menu_x", err);
    }
  });

  bot.action("admin_internship_part_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      configStates.set(ctx.from.id, { mode: "new_part" });

      await ctx.reply(
        "Отправь название новой части стажировки одним сообщением."
      );
    } catch (err) {
      logError("admin_internship_part_new_x", err);
    }
  });

  bot.action(/^admin_internship_part_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      configStates.delete(ctx.from.id);

      const partId = parseInt(ctx.match[1], 10);
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_part_x", err);
    }
  });

  bot.action(/^admin_internship_part_up_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      await pool.query(
        `
        UPDATE internship_parts
        SET order_index = order_index - 1
        WHERE id = $1
      `,
        [partId]
      );
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_part_up_x", err);
    }
  });

  bot.action(/^admin_internship_part_down_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      await pool.query(
        `
        UPDATE internship_parts
        SET order_index = order_index + 1
        WHERE id = $1
      `,
        [partId]
      );
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_part_down_x", err);
    }
  });

  bot.action(/^admin_internship_part_del_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      await pool.query("DELETE FROM internship_parts WHERE id = $1", [partId]);
      configStates.delete(ctx.from.id);
      await showInternshipConfigMenu(ctx);
    } catch (err) {
      logError("admin_internship_part_del_x", err);
    }
  });

  bot.action(/^admin_internship_part_doc_edit_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      configStates.set(ctx.from.id, {
        mode: "part_doc",
        partId,
      });

      await ctx.reply(
        "Отправь Word‑документ (.doc / .docx) с описанием этой части стажировки."
      );
    } catch (err) {
      logError("admin_internship_part_doc_edit_x", err);
    }
  });

  bot.action(/^admin_internship_step_new_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      configStates.set(ctx.from.id, {
        mode: "new_step_title",
        partId,
      });

      await ctx.reply(
        "Отправь название нового этапа стажировки одним сообщением."
      );
    } catch (err) {
      logError("admin_internship_step_new_x", err);
    }
  });

  bot.action(/^admin_internship_step_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const stepId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const sRes = await pool.query(
        `
        SELECT id, title, step_type, order_index
        FROM internship_steps
        WHERE id = $1
      `,
        [stepId]
      );
      if (!sRes.rows.length) {
        await ctx.reply("Этап не найден.");
        return;
      }
      const step = sRes.rows[0];

      let typeLabel =
        step.step_type === "video"
          ? "Видео"
          : step.step_type === "photo"
          ? "Фото"
          : "Обычная кнопка";

      let text =
        `Этап стажировки:\n` +
        `Название: ${step.title}\n` +
        `Тип: ${typeLabel}\n` +
        `Порядок: ${step.order_index}`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✏️ Переименовать",
            `admin_internship_step_rename_${step.id}_${partId}`
          ),
        ],
        [
          Markup.button.callback(
            "🔁 Изменить тип",
            `admin_internship_step_type_${step.id}_${partId}`
          ),
        ],
        [
          Markup.button.callback(
            "⬆️ Вверх",
            `admin_internship_step_up_${step.id}_${partId}`
          ),
          Markup.button.callback(
            "⬇️ Вниз",
            `admin_internship_step_down_${step.id}_${partId}`
          ),
        ],
        [
          Markup.button.callback(
            "🗑 Удалить этап",
            `admin_internship_step_del_${step.id}_${partId}`
          ),
        ],
        [
          Markup.button.callback(
            "🔙 К части",
            `admin_internship_part_${partId}`
          ),
        ],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_internship_step_x", err);
    }
  });

  bot.action(/^admin_internship_step_rename_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const stepId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      configStates.set(ctx.from.id, {
        mode: "rename_step",
        stepId,
        partId,
      });

      await ctx.reply("Отправь новое название этапа одним сообщением.");
    } catch (err) {
      logError("admin_internship_step_rename_x", err);
    }
  });

  bot.action(/^admin_internship_step_type_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const stepId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔘 Обычная кнопка",
            `admin_internship_step_type_set_${stepId}_${partId}_simple`
          ),
        ],
        [
          Markup.button.callback(
            "🎥 Видео",
            `admin_internship_step_type_set_${stepId}_${partId}_video`
          ),
        ],
        [
          Markup.button.callback(
            "📷 Фото",
            `admin_internship_step_type_set_${stepId}_${partId}_photo`
          ),
        ],
      ]);

      await deliver(
        ctx,
        { text: "Выбери новый тип этапа:", extra: keyboard },
        { edit: true }
      );
    } catch (err) {
      logError("admin_internship_step_type_x", err);
    }
  });

  bot.action(
    /^admin_internship_step_type_set_(\d+)_(\d+)_(simple|video|photo)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const admin = await ensureUser(ctx);
        if (!isAdmin(admin)) return;

        const stepId = parseInt(ctx.match[1], 10);
        const partId = parseInt(ctx.match[2], 10);
        const type = ctx.match[3];

        await pool.query(
          "UPDATE internship_steps SET step_type = $1 WHERE id = $2",
          [type, stepId]
        );
        await showInternshipPart(ctx, partId);
      } catch (err) {
        logError("admin_internship_step_type_set_x", err);
      }
    }
  );

  bot.action(/^admin_internship_step_up_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const stepId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      await pool.query(
        `
        UPDATE internship_steps
        SET order_index = order_index - 1
        WHERE id = $1
      `,
        [stepId]
      );
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_step_up_x", err);
    }
  });

  bot.action(/^admin_internship_step_down_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const stepId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      await pool.query(
        `
        UPDATE internship_steps
        SET order_index = order_index + 1
        WHERE id = $1
      `,
        [stepId]
      );
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_step_down_x", err);
    }
  });

  bot.action(/^admin_internship_step_del_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const stepId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      await pool.query("DELETE FROM internship_steps WHERE id = $1", [stepId]);
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_step_del_x", err);
    }
  });

  // документы для части
  bot.on("document", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const state = configStates.get(ctx.from.id);
      if (!state || state.mode !== "part_doc") return next();

      const doc = ctx.message.document;
      if (!doc) return next();

      const name = (doc.file_name || "").toLowerCase();
      if (!name.endsWith(".doc") && !name.endsWith(".docx")) {
        await ctx.reply("Пожалуйста, отправь Word-файл (.doc или .docx).");
        return;
      }

      const fileId = doc.file_id;
      await pool.query(
        "UPDATE internship_parts SET doc_file_id = $1 WHERE id = $2",
        [fileId, state.partId]
      );

      configStates.delete(ctx.from.id);

      await ctx.reply("Документ для части стажировки обновлён.");
      await showInternshipPart(ctx, state.partId);
    } catch (err) {
      logError("internship_part_doc_document_x", err);
      return next();
    }
  });

  // текстовые шаги конфигурации
  bot.on("text", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const state = configStates.get(ctx.from.id);
      if (!state) return next();

      const text = (ctx.message.text || "").trim();
      if (!text) return next();

      if (state.mode === "new_part") {
        const maxRes = await pool.query(
          "SELECT COALESCE(MAX(order_index), 0) AS max FROM internship_parts"
        );
        const nextIndex = Number(maxRes.rows[0].max || 0) + 1;
        const ins = await pool.query(
          `
          INSERT INTO internship_parts (title, order_index)
          VALUES ($1, $2)
          RETURNING id
        `,
          [text, nextIndex]
        );
        configStates.delete(ctx.from.id);
        await ctx.reply(`Часть стажировки создана (id: ${ins.rows[0].id}).`);
        await showInternshipConfigMenu(ctx);
        return;
      }

      if (state.mode === "new_step_title") {
        configStates.set(ctx.from.id, {
          mode: "new_step_type",
          partId: state.partId,
          title: text,
        });

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔘 Обычная кнопка",
              "internship_new_step_type_simple"
            ),
          ],
          [
            Markup.button.callback(
              "🎥 Видео",
              "internship_new_step_type_video"
            ),
          ],
          [Markup.button.callback("📷 Фото", "internship_new_step_type_photo")],
        ]);

        await ctx.reply("Выбери тип нового этапа:", keyboard);
        return;
      }

      if (state.mode === "rename_step") {
        await pool.query(
          "UPDATE internship_steps SET title = $1 WHERE id = $2",
          [text, state.stepId]
        );
        configStates.delete(ctx.from.id);
        await ctx.reply("Название этапа обновлено.");
        await showInternshipPart(ctx, state.partId);
        return;
      }

      return next();
    } catch (err) {
      logError("internship_text_handler", err);
      return next();
    }
  });

  bot.action(/internship_new_step_type_(simple|video|photo)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const state = configStates.get(ctx.from.id);
      if (!state || state.mode !== "new_step_type") return;

      const type = ctx.match[1];
      const { partId, title } = state;

      const maxRes = await pool.query(
        "SELECT COALESCE(MAX(order_index), 0) AS max FROM internship_steps WHERE part_id = $1",
        [partId]
      );
      const nextIndex = Number(maxRes.rows[0].max || 0) + 1;

      await pool.query(
        `
          INSERT INTO internship_steps (part_id, title, step_type, order_index)
          VALUES ($1, $2, $3, $4)
        `,
        [partId, title, type, nextIndex]
      );

      configStates.delete(ctx.from.id);

      await ctx.reply("Этап добавлен.");
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("internship_new_step_type_x", err);
    }
  });

  // медиа (фото/видео) для этапов
  bot.on(["video", "photo"], async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const state = mediaStates.get(ctx.from.id);
      if (!state) return next();

      const { sessionId, stepId, type, partId, userId } = state;

      let fileId = null;
      if (type === "video" && ctx.message.video) {
        fileId = ctx.message.video.file_id;
      } else if (type === "photo" && ctx.message.photo?.length) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      }

      if (!fileId) {
        await ctx.reply(
          `Ожидалось ${type === "video" ? "видео" : "фото"}. Попробуй ещё раз.`
        );
        return;
      }

      await setMediaStepPassed(sessionId, stepId, user.id, fileId);
      mediaStates.delete(ctx.from.id);

      await ctx.reply("Этап отмечен как выполненный ✅.");
      await showSessionPart(ctx, sessionId, partId, userId);
    } catch (err) {
      logError("internship_media_handler_x", err);
      return next();
    }
  });

  // кнопка в главном меню: процесс стажировки
  bot.action("internship_active_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const res = await pool.query(
        `
        SELECT s.*, u.full_name AS intern_name
        FROM internship_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.started_by = $1
          AND s.finished_at IS NULL
          AND s.is_canceled = FALSE
        ORDER BY s.started_at DESC
        LIMIT 1
      `,
        [admin.id]
      );

      if (!res.rows.length) {
        await ctx.reply("У тебя сейчас нет активной стажировки.");
        await showMainMenu(ctx);
        return;
      }

      const session = res.rows[0];

      const text =
        `🧑‍🏫 Активная стажировка\n\n` +
        `Стажёр: ${session.intern_name || "Без имени"}\n` +
        `День: ${session.day_number}\n` +
        `Начата: ${session.started_at.toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })}`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⏹ Закончить стажировку",
            `admin_internship_finish_${session.id}_${session.user_id}`
          ),
        ],
        [
          Markup.button.callback(
            "❌ Отменить стажировку",
            `admin_internship_cancel_${session.id}_${session.user_id}`
          ),
        ],
        [Markup.button.callback("🔙 В меню", "back_main")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("internship_active_menu_x", err);
    }
  });
}

module.exports = {
  registerInternship,
  hasActiveInternshipSessionForTrainer,
};
