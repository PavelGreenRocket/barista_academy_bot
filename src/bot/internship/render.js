// src/internship/render.js
"use strict";

const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");

const {
  pool,
  // sessions
  getActiveSessionForUser,

  // structure
  getPartsWithSteps,

  // maps / progress
  getSessionStepMap,
  getUserOverallStepMap,

  // utils
  formatDurationMs,

  // schema + ordering
  columnExists,
} = require("./db");

/**
 * Здесь лежат "экраны" (render-функции).
 * registerInternship будет тонким роутером: достал args -> вызвал render().
 */

// ---------- МЕНЮ СТАЖИРОВКИ ПО ПОЛЬЗОВАТЕЛЮ ----------

async function showUserInternshipMenu(ctx, admin, targetUserId) {
  const uRes = await pool.query(
    "SELECT id, full_name, role, staff_status, intern_days_completed, training_completed_at, training_total_steps_at_completion FROM users WHERE id = $1",
    [targetUserId]
  );

  if (!uRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = uRes.rows[0];
  const name = user.full_name || "Без имени";

  const activeSession = await getActiveSessionForUser(user.id);

  // В академии ориентируемся на ЛК: если есть активная сессия — значит сейчас статус "стажёр"
  const isInternByStatus = user.staff_status === "intern";
  const isIntern = Boolean(activeSession) || isInternByStatus;

  const nextDay = (user.intern_days_completed || 0) + 1;
  const dayNumber = activeSession?.day_number || (isIntern ? nextDay : null);

  let text =
    `👤 ${name}\n` +
    `Роль: ${user.role}\n` +
    `Статус: ${isIntern ? "стажёр" : "работник"}\n` +
    (dayNumber ? `День стажировки: ${dayNumber}\n\n` : `\n`);

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
      `Сейчас идёт стажировка.\n` +
      "Нажмите на часть, чтобы начать/продолжить обучение.\n\n";

    const parts = await getPartsWithSteps();

    // ✅ прогресс должен быть накопительным: считаем по пользователю (overall),
    // чтобы на новой стажировке не было “с нуля”.
    const stepMap = await getUserOverallStepMap(user.id);

    // общий процент по всем этапам (нужен для "Завершить обучение")
    // parts уже содержит steps, поэтому считаем от него (без stepsRes)
    const totalStepsAll = parts.reduce(
      (acc, p) => acc + (p.steps?.length || 0),
      0
    );

    let passedStepsAll = 0;
    for (const p of parts) {
      for (const s of p.steps || []) {
        if (stepMap.get(s.id)?.is_passed === true) passedStepsAll += 1;
      }
    }

    const overallPercent =
      totalStepsAll === 0
        ? 0
        : Math.round((passedStepsAll / totalStepsAll) * 100);

    for (const part of parts) {
      if (!part.steps.length) continue;

      const total = part.steps.length;
      const done = part.steps.filter(
        (s) => stepMap.get(s.id)?.is_passed === true
      ).length;

      let label;
      if (total > 0 && done === total) {
        label = `✅ ${part.title}`;
      } else {
        const percent = total === 0 ? 0 : Math.round((done / total) * 100);
        label = `${part.title} (${percent}%)`;
      }

      buttons.push([
        Markup.button.callback(
          label,
          `admin_internship_session_part_sections_${activeSession.id}_${part.id}_${user.id}`
        ),
      ]);
    }
    buttons.push([
      Markup.button.callback(
        "📝 комментарий по стажировке",
        `admin_internship_comment_${activeSession.id}_${user.id}`
      ),
    ]);

    // если общий % = 100 — показываем "Завершить обучение" (оно авто-закроет активную сессию)
    if (overallPercent >= 100) {
      buttons.push([
        Markup.button.callback(
          "🏁 Завершить обучение",
          `admin_training_complete_${activeSession.id}_${user.id}`
        ),
      ]);
    } else {
      buttons.push([
        Markup.button.callback(
          "⏹ Закончить стажировку",
          `admin_internship_finish_${activeSession.id}_${user.id}`
        ),
      ]);
    }

    buttons.push([
      Markup.button.callback(
        "❌ Отменить стажировку",
        `admin_internship_cancel_${activeSession.id}_${user.id}`
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

// ---------- СТАРТ ДНЯ: ТОРГОВАЯ ТОЧКА / ОПОЗДАНИЕ ----------

async function askStartInternshipTradePoint(ctx, admin, targetUserId) {
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

  const tpRes = await pool.query(
    `
    SELECT id, title
    FROM trade_points
    WHERE is_active = TRUE
    ORDER BY id
    `
  );
  const points = tpRes.rows;

  if (!points.length) {
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🔙 К стажировке пользователя",
          `admin_user_internship_${user.id}`
        ),
      ],
    ]);

    await deliver(
      ctx,
      {
        text:
          "Пока не добавлено ни одной торговой точки.\n" +
          "Сначала добавьте её в разделе «🔧 Торговые точки».",
        extra: keyboard,
      },
      { edit: true }
    );
    return;
  }

  let text =
    `Стажёр: ${user.full_name || "Без имени"}\n\n` +
    "Выберите торговую точку для этого дня стажировки:";

  const buttons = [];
  for (const tp of points) {
    buttons.push([
      Markup.button.callback(
        `🏬 ${tp.title}`,
        `admin_internship_start_tp_${user.id}_${tp.id}`
      ),
    ]);
  }
  buttons.push([
    Markup.button.callback(
      "🔙 К стажировке пользователя",
      `admin_user_internship_${user.id}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function askStartInternshipLate(ctx, admin, userId, tradePointId) {
  const uRes = await pool.query(
    "SELECT id, full_name FROM users WHERE id = $1",
    [userId]
  );
  if (!uRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = uRes.rows[0];

  const tpRes = await pool.query(
    "SELECT id, title FROM trade_points WHERE id = $1",
    [tradePointId]
  );
  if (!tpRes.rows.length) {
    await ctx.reply("Торговая точка не найдена.");
    return;
  }
  const tp = tpRes.rows[0];

  const text =
    `Стажёр: ${user.full_name || "Без имени"}\n` +
    `Торговая точка: ${tp.title}\n\n` +
    "Стажёр пришёл вовремя?";

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✅ Да, вовремя",
        `admin_internship_start_late_yes_${user.id}_${tp.id}`
      ),
    ],
    [
      Markup.button.callback(
        "⚠️ Нет, с опозданием",
        `admin_internship_start_late_no_${user.id}_${tp.id}`
      ),
    ],
    [
      Markup.button.callback(
        "🔙 Выбрать другую точку",
        `admin_internship_start_${user.id}`
      ),
    ],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

// ---------- СЕССИЯ: ЧАСТЬ -> СПИСОК РАЗДЕЛОВ ----------

async function showSessionPartSections(
  ctx,
  sessionId,
  partId,
  userId,
  opts = {}
) {
  const sRes = await pool.query(
    `SELECT id, day_number FROM internship_sessions WHERE id = $1 LIMIT 1`,
    [sessionId]
  );
  if (!sRes.rows.length) {
    await ctx.reply("Сессия не найдена");
    return;
  }
  const session = sRes.rows[0];

  const pRes = await pool.query(
    `SELECT id, title, order_index FROM internship_parts WHERE id = $1 LIMIT 1`,
    [partId]
  );
  if (!pRes.rows.length) {
    await ctx.reply("Часть не найдена");
    return;
  }
  const part = pRes.rows[0];

  const secRes = await pool.query(
    `
    SELECT id, title, order_index
    FROM internship_sections
    WHERE part_id = $1
    ORDER BY order_index ASC
    `,
    [partId]
  );

  const sections = secRes.rows;
  const sectionIds = sections.map((s) => s.id);

  // ✅ накопительный прогресс по пользователю (не сбрасывается на новой сессии)
  const stepMap = await getUserOverallStepMap(userId);

  const stRes = sectionIds.length
    ? await pool.query(
        `
        SELECT id, section_id
        FROM internship_steps
        WHERE section_id = ANY($1::int[])
        ORDER BY order_index ASC, id ASC
        `,
        [sectionIds]
      )
    : { rows: [] };

  const stepsBySection = new Map();
  for (const r of stRes.rows) {
    if (!stepsBySection.has(r.section_id)) stepsBySection.set(r.section_id, []);
    stepsBySection.get(r.section_id).push(r.id);
  }

  let text =
    `🎓 Стажировка — день ${session.day_number}\n` +
    `Часть: ${part.title}\n\n` +
    `Выберите раздел:\n`;

  const buttons = [];
  for (const sec of sections) {
    const stepIds = stepsBySection.get(sec.id) || [];
    const total = stepIds.length;
    const done = stepIds.filter(
      (id) => stepMap.get(id)?.is_passed === true
    ).length;

    let label;
    if (total > 0 && done === total) {
      label = `✅ ${sec.title}`;
    } else {
      const percent = total === 0 ? 0 : Math.round((done / total) * 100);
      label = `${sec.title} (${percent}%)`;
    }

    buttons.push([
      Markup.button.callback(
        label,
        `admin_internship_session_section_${sessionId}_${sec.id}_${userId}`
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

// ---------- СЕССИЯ: РАЗДЕЛ -> СПИСОК ЭТАПОВ + НАВИГАЦИЯ ----------

async function showSessionSection(
  ctx,
  sessionId,
  sectionId,
  userId,
  opts = {}
) {
  const sRes = await pool.query(
    `SELECT id, day_number FROM internship_sessions WHERE id = $1 LIMIT 1`,
    [sessionId]
  );
  if (!sRes.rows.length) return ctx.reply("Сессия не найдена");
  const session = sRes.rows[0];

  const secRes = await pool.query(
    `
    SELECT s.id, s.title, s.order_index, s.telegraph_url, s.part_id, s.duration_days,
           p.title AS part_title
    FROM internship_sections s
    JOIN internship_parts p ON p.id = s.part_id
    WHERE s.id = $1
    LIMIT 1
    `,
    [sectionId]
  );
  if (!secRes.rows.length) return ctx.reply("Раздел не найден");
  const sec = secRes.rows[0];

  const allSecRes = await pool.query(
    `SELECT id, order_index FROM internship_sections WHERE part_id = $1 ORDER BY order_index ASC`,
    [sec.part_id]
  );
  const allSecs = allSecRes.rows;
  const totalSecs = allSecs.length;
  const currentPos = allSecs.findIndex((x) => x.id === sectionId) + 1;

  const stepRes = await pool.query(
    `
    SELECT id, title, step_type, order_index
    FROM internship_steps
    WHERE section_id = $1
    ORDER BY order_index ASC
    `,
    [sectionId]
  );
  const steps = stepRes.rows;

  // ✅ накопительный прогресс: если шаг уже был выполнен в любой прошлой стажировке,
  // он должен оставаться ✅ и в новой.
  const stepMap = await getUserOverallStepMap(userId);

  let text =
    `🎓 Стажировка — день ${session.day_number}\n` +
    `Часть: ${sec.part_title}\n` +
    `Раздел ${currentPos}/${totalSecs}\n` +
    `Изучение в день: ${sec.duration_days ?? "не указан"}\n\n`;

  // короткая инструкция
  text += `Ниже (кнопки) этапы этого раздела— нажми, чтобы отметить выполнение.\n`;

  const buttons = [];

  for (const st of steps) {
    const passed = stepMap.get(st.id)?.is_passed === true;
    const icon = passed ? "✅" : "❌";

    const cb =
      st.step_type === "simple"
        ? `admin_internship_step_toggle_${sessionId}_${sectionId}_${st.id}_${userId}`
        : `admin_internship_step_media_${sessionId}_${sectionId}_${st.id}_${userId}`;

    buttons.push([Markup.button.callback(`${icon} ${st.title}`, cb)]);
  }

  const navRow = [];
  if (currentPos > 1) {
    navRow.push(
      Markup.button.callback(
        "⬅️",
        `admin_internship_section_prev_${sessionId}_${sectionId}_${userId}`
      )
    );
  }
  if (currentPos < totalSecs) {
    navRow.push(
      Markup.button.callback(
        "➡️",
        `admin_internship_section_next_${sessionId}_${sectionId}_${userId}`
      )
    );
  }
  if (navRow.length) buttons.push(navRow);

  buttons.push([
    Markup.button.callback(
      "🔙 К разделам",
      `admin_internship_session_part_sections_${sessionId}_${sec.part_id}_${userId}`
    ),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  const extra = {
    ...keyboard,
    ...(sec.telegraph_url
      ? { link_preview_options: { url: sec.telegraph_url } }
      : {}),
  };

  await deliver(ctx, { text, extra }, { edit: true });
}

// ---------- ИСТОРИЯ/ДАННЫЕ/УСПЕВАЕМОСТЬ ----------

async function showUserInternshipData(ctx, userId) {
  const uRes = await pool.query(
    `
    SELECT id, full_name, role, staff_status, intern_days_completed
    FROM users
    WHERE id = $1
  `,
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
    [userId]
  );
  const sessions = sRes.rows;

  const finishedDays = sessions.filter(
    (s) => s.finished_at && !s.is_canceled
  ).length;

  const isIntern = user.staff_status === "intern";
  const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
  const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

  let text =
    `🌱 Стажировка: ${name}\n` +
    `Роль: ${user.role}\n` +
    `Статус: ${statusLine}\n\n` +
    `Всего завершённых стажировок (дней): ${finishedDays}\n\n` +
    `Выбери раздел:\n`;

  const buttons = [];

  buttons.push([
    Markup.button.callback(
      "📊 Успеваемость",
      `admin_internship_perf_${user.id}`
    ),
  ]);

  buttons.push([
    Markup.button.callback(
      "ℹ️ Детали стажировки",
      `admin_internship_details_${user.id}`
    ),
  ]);

  buttons.push([
    Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
  ]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showUserInternshipPerformance(ctx, userId) {
  const uRes = await pool.query(
    `
    SELECT id, full_name, role, staff_status, intern_days_completed
    FROM users
    WHERE id = $1
  `,
    [userId]
  );
  if (!uRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }

  const user = uRes.rows[0];
  const name = user.full_name || "Без имени";

  const sessRes = await pool.query(
    `
    SELECT *
    FROM internship_sessions
    WHERE user_id = $1
  `,
    [userId]
  );
  const sessions = sessRes.rows;
  const finishedDays = sessions.filter(
    (s) => s.finished_at && !s.is_canceled
  ).length;

  const isIntern = user.staff_status === "intern";
  const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
  const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

  const parts = await getPartsWithSteps();
  const overallMap = await getUserOverallStepMap(userId);

  let text =
    `🌱 Стажировка: ${name}\n` +
    `Роль: ${user.role}\n` +
    `Статус: ${statusLine}\n\n` +
    `📊 Успеваемость\n\n` +
    `Всего завершённых стажировок (дней): ${finishedDays}\n\n` +
    `Выбери часть, чтобы посмотреть этапы:\n`;

  const buttons = [];

  for (const part of parts) {
    if (!part.steps.length) continue;

    const total = part.steps.length;
    let passed = 0;

    for (const step of part.steps) {
      const state = overallMap.get(step.id);
      if (state?.is_passed) passed++;
    }

    const percent = total ? Math.round((passed * 100) / total) : 0;

    let icon = "⚪️";
    if (passed === 0) icon = "❌";
    else if (passed === total) icon = "✅";
    else icon = "🟡";

    const label = `${icon} Часть: ${part.title} — ${passed}/${total} этапов (${percent}%)`;

    buttons.push([
      Markup.button.callback(
        label,
        `admin_internship_perf_part_${user.id}_${part.id}`
      ),
    ]);
  }

  if (!buttons.length) text += `\n(Пока нет ни одной части с этапами.)`;

  buttons.push([
    Markup.button.callback(
      "ℹ️ Детали стажировки",
      `admin_internship_details_${user.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback(
      "🔙 К разделам стажировки",
      `admin_internship_data_${user.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
  ]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showUserInternshipPerformancePart(ctx, userId, partId) {
  const uRes = await pool.query(
    `
    SELECT id, full_name, role, staff_status, intern_days_completed
    FROM users
    WHERE id = $1
  `,
    [userId]
  );
  if (!uRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = uRes.rows[0];

  const isIntern = user.staff_status === "intern";
  const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
  const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

  const parts = await getPartsWithSteps();
  const part = parts.find((p) => p.id === partId);
  if (!part) {
    await ctx.reply("Часть стажировки не найдена.");
    return;
  }

  const overallMap = await getUserOverallStepMap(userId);

  let text =
    `🌱 Стажировка: ${user.full_name || "Без имени"}\n` +
    `Роль: ${user.role}\n` +
    `Статус: ${statusLine}\n\n` +
    `📊 Успеваемость — часть: ${part.title}\n\n` +
    `Этапы:\n`;

  const buttons = [];

  if (!part.steps.length) {
    text += "(В этой части пока нет этапов.)";
  } else {
    for (const step of part.steps) {
      const state = overallMap.get(step.id);
      const passed = state?.is_passed === true;
      const icon = passed ? "✅" : "❌";

      let typeIcon = "🔘";
      if (step.type === "video" || step.step_type === "video") typeIcon = "🎥";
      else if (step.type === "photo" || step.step_type === "photo")
        typeIcon = "📷";

      let label = `${icon} ${typeIcon} ${step.title}`;

      if (passed && state.checked_by_name && state.checked_at) {
        const dt = new Date(state.checked_at).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        label += ` (${state.checked_by_name}, ${dt})`;
      }

      const sessionId = state?.session_id;
      if (sessionId) {
        if (step.type === "simple" || step.step_type === "simple") {
          buttons.push([
            Markup.button.callback(
              label,
              `admin_internship_step_toggle_${sessionId}_${step.id}_${part.id}_${user.id}`
            ),
          ]);
        } else {
          buttons.push([
            Markup.button.callback(
              label,
              `admin_internship_step_media_${sessionId}_${step.id}_${part.id}_${user.id}`
            ),
          ]);
        }
      } else {
        buttons.push([Markup.button.callback(label, "noop")]);
      }
    }
  }

  buttons.push([
    Markup.button.callback(
      "🔙 К частям (успеваемость)",
      `admin_internship_perf_${user.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
  ]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showUserInternshipDetails(ctx, userId) {
  const uRes = await pool.query(
    `
    SELECT id, full_name, role, staff_status, intern_days_completed
    FROM users
    WHERE id = $1
  `,
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
      s.trade_point_id,
      tp.title AS trade_point_title,
      u.full_name AS trainer_name
    FROM internship_sessions s
    LEFT JOIN users u ON u.id = s.started_by
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
    WHERE s.user_id = $1
    ORDER BY s.day_number, s.started_at
  `,
    [userId]
  );

  const sessions = sRes.rows;
  const validSessions = sessions.filter((s) => !s.is_canceled);
  const finishedDays = validSessions.filter((s) => s.finished_at).length;

  const isIntern = user.staff_status === "intern";
  const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
  const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

  let text =
    `🌱 Стажировка: ${name}\n` +
    `Роль: ${user.role}\n` +
    `Статус: ${statusLine}\n\n` +
    `Всего завершённых стажировок (дней): ${finishedDays}\n` +
    `────────────\n`;

  if (validSessions.length) {
    text += "Кто стажировал по дням:\n";
    for (const s of validSessions) {
      const trainer = s.trainer_name || "Без имени";
      text += `• день ${s.day_number} — ${trainer}\n`;
    }
  } else {
    text += "Кто стажировал по дням: данных пока нет.\n";
  }

  text += "\n────────────\n";
  text += "Опоздания:\nданные пока не внесены (добавим позже).\n";
  text += "\n────────────\n";

  if (validSessions.length) {
    text += "Выбери день стажировки, чтобы посмотреть детали дня:\n";
  } else {
    text += "Деталей по дням пока нет.\n";
  }

  const buttons = [];

  for (const s of validSessions) {
    const startStr = s.started_at
      ? new Date(s.started_at).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

    const trainerName = s.trainer_name || "без тренера";
    const tpTitle = s.trade_point_title || "не указана";

    const label = `День ${s.day_number} — "${tpTitle}", ${trainerName}, ${startStr}`;

    buttons.push([
      Markup.button.callback(
        label,
        `admin_internship_details_day_${s.id}_${user.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "🔙 К разделам стажировки",
      `admin_internship_data_${user.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
  ]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showUserInternshipDetailsDay(ctx, admin, userId, sessionId) {
  const uRes = await pool.query(
    `
    SELECT id, full_name, role, staff_status, intern_days_completed
    FROM users
    WHERE id = $1
  `,
    [userId]
  );
  if (!uRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = uRes.rows[0];

  const sRes = await pool.query(
    `
    SELECT s.*,
           t.full_name AS trainer_name,
           tp.title AS trade_point_title
    FROM internship_sessions s
    LEFT JOIN users t ON t.id = s.started_by
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
    WHERE s.id = $1 AND s.user_id = $2
  `,
    [sessionId, userId]
  );

  if (!sRes.rows.length) {
    await ctx.reply("День стажировки не найден.");
    return;
  }
  const session = sRes.rows[0];

  const parts = await getPartsWithSteps();
  const stepMap = await getSessionStepMap(sessionId);

  let totalSteps = 0;
  let passedSteps = 0;

  for (const part of parts) {
    for (const step of part.steps || []) {
      totalSteps++;
      const st = stepMap.get(step.id);
      if (st?.is_passed) passedSteps++;
    }
  }

  let perfText = "нет данных";
  if (totalSteps > 0) {
    const percent = Math.round((passedSteps * 100) / totalSteps);
    perfText = `${passedSteps}/${totalSteps} этапов (${percent}%)`;
  }

  const isIntern = user.staff_status === "intern";
  const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
  const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

  const start = session.started_at ? new Date(session.started_at) : null;
  const end = session.finished_at ? new Date(session.finished_at) : null;

  let timeRange = "нет данных";
  let durationText = "-";
  if (start && end) {
    const startStr = start.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const endStr = end.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    timeRange = `с ${startStr} до ${endStr}`;
    durationText = formatDurationMs(end.getTime() - start.getTime());
  }

  let lateText;
  if (session.was_late === true) lateText = "было (стажёр пришёл с опозданием)";
  else if (session.was_late === false) lateText = "не было";
  else lateText = "данные не указаны";

  const tradePointText = session.trade_point_title || "не указана";
  const commentText = session.comment || "комментариев нет";
  const issuesText = session.issues || "не было";

  let text =
    `🌱 Стажировка: ${user.full_name || "Без имени"}\n` +
    `Роль: ${user.role}\n` +
    `Статус: ${statusLine}\n\n` +
    `☑️ ДЕТАЛИ ДЕНЬ ${session.day_number}:\n` +
    `────────────\n` +
    `🕒 Длительность: ${timeRange} (${durationText})\n\n` +
    `⏳ Опоздание: ${lateText}\n` +
    `🏬 Торговая точка: ${tradePointText}\n` +
    `🧑‍💼 Кто стажировал: ${session.trainer_name || "Без имени"}\n` +
    `📊 Успеваемость: ${perfText}\n` +
    `────────────\n` +
    `Комментарии по стажировке: ${commentText}\n` +
    `⚠️ Замечания: ${issuesText}\n`;

  const buttons = [
    [
      Markup.button.callback(
        "🔙 К дням (детали)",
        `admin_internship_details_${user.id}`
      ),
    ],
    [Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`)],
    [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
  ];

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// ---------- НАСТРОЙКА СТАЖИРОВКИ: ЧАСТИ/РАЗДЕЛЫ/ЭТАПЫ ----------

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

  const secRes = await pool.query(
    `
    SELECT id, title, order_index, telegraph_url, duration_days
    FROM internship_sections
    WHERE part_id = $1
    ORDER BY order_index ASC, id ASC
    `,
    [partId]
  );
  const sections = secRes.rows;

  let text =
    `Часть стажировки:\n` +
    `Название: ${part.title}\n` +
    `Порядок: ${part.order_index}\n\n` +
    `Разделы (нажмите, чтобы редактировать):\n`;

  if (!sections.length) {
    text += "(пока нет разделов)";
  } else {
    for (const sec of sections) {
      const tg = sec.telegraph_url ? "✅" : "❌";
      const dur =
        sec.duration_days != null ? `, срок: ${sec.duration_days} дн.` : "";
      text += `• [${sec.order_index}] ${sec.title} ${tg}${dur}\n`;
    }
  }

  const buttons = [];

  for (const sec of sections) {
    buttons.push([
      Markup.button.callback(
        `📚 ${sec.title}`,
        `admin_internship_section_edit_${sec.id}_${part.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "➕ Добавить раздел",
      `admin_internship_section_new_${part.id}`
    ),
  ]);
  buttons.push([
    Markup.button.callback(
      "🔁 Изменить последовательность",
      `admin_internship_part_sections_reorder_${part.id}`
    ),
  ]);

  // важно: здесь НЕ должно быть "Часть вверх/вниз" (по твоему ТЗ)

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

async function showInternshipSection(ctx, sectionId, partId) {
  const hasTelegraphMentor = await columnExists(
    "internship_sections",
    "telegraph_url"
  );
  const hasTelegraphIntern = await columnExists(
    "internship_sections",
    "telegraph_url_intern"
  );

  const cols = ["id", "title", "order_index", "duration_days"];
  if (hasTelegraphMentor) cols.push("telegraph_url");
  if (hasTelegraphIntern) cols.push("telegraph_url_intern");

  const sRes = await pool.query(
    `SELECT ${cols.join(", ")} FROM internship_sections WHERE id=$1`,
    [sectionId]
  );
  if (!sRes.rows.length) {
    await ctx.reply("Раздел не найден.");
    return;
  }
  const sec = sRes.rows[0];

  let text =
    `Раздел стажировки:
` +
    `Название: ${sec.title}
` +
    `Порядок: ${sec.order_index}
`;

  if (hasTelegraphMentor) {
    text += `Telegraph (для наставника): ${
      sec.telegraph_url ? "✅ прикреплён" : "❌ нет"
    }
`;
  }
  if (hasTelegraphIntern) {
    text += `Telegraph (для стажёра): ${
      sec.telegraph_url_intern ? "✅ прикреплён" : "❌ нет"
    }
`;
  }

  text += `Срок: ${
    sec.duration_days ? `${sec.duration_days} дн.` : "не указан"
  }
`;

  const rows = [];

  rows.push([
    Markup.button.callback(
      "✏️ Переименовать раздел",
      `admin_internship_section_rename_${sec.id}_${partId}`
    ),
  ]);

  // Telegraph buttons: показываем только если колонка есть
  if (hasTelegraphMentor || hasTelegraphIntern) {
    const tRow = [];
    if (hasTelegraphMentor) {
      tRow.push(
        Markup.button.callback(
          "📝 Telegraph (для наставника)",
          `admin_internship_section_telegraph_mentor_${sec.id}_${partId}`
        )
      );
    }
    if (hasTelegraphIntern) {
      tRow.push(
        Markup.button.callback(
          "📝 Telegraph (для стажёра)",
          `admin_internship_section_telegraph_intern_${sec.id}_${partId}`
        )
      );
    }
    rows.push(tRow);
  }

  rows.push([
    Markup.button.callback(
      sec.duration_days
        ? `📅 Изменить срок для раздела (${sec.duration_days} дн.)`
        : "📅 Добавить срок для раздела",
      `admin_internship_section_duration_${sec.id}_${partId}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "📋 Этапы раздела",
      `admin_internship_section_steps_${sec.id}_${partId}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "🗑 Удалить раздел",
      `admin_internship_section_del_${sec.id}_${partId}`
    ),
  ]);

  rows.push([
    Markup.button.callback("🔙 К части", `admin_internship_part_${partId}`),
  ]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(rows) }, { edit: true });
}

async function showInternshipSectionTelegraphView(
  ctx,
  sectionId,
  partId,
  target // "mentor" | "intern"
) {
  const hasTelegraphMentor = await columnExists(
    "internship_sections",
    "telegraph_url"
  );
  const hasTelegraphIntern = await columnExists(
    "internship_sections",
    "telegraph_url_intern"
  );

  if (target === "mentor" && !hasTelegraphMentor) {
    await ctx.reply("В таблице internship_sections нет колонки telegraph_url.");
    return;
  }
  if (target === "intern" && !hasTelegraphIntern) {
    await ctx.reply(
      "В таблице internship_sections нет колонки telegraph_url_intern."
    );
    return;
  }

  const cols = ["id", "title"];
  if (hasTelegraphMentor) cols.push("telegraph_url");
  if (hasTelegraphIntern) cols.push("telegraph_url_intern");

  const sRes = await pool.query(
    `SELECT ${cols.join(", ")} FROM internship_sections WHERE id=$1 LIMIT 1`,
    [sectionId]
  );
  if (!sRes.rows.length) return ctx.reply("Раздел не найден.");
  const sec = sRes.rows[0];

  const url =
    target === "mentor" ? sec.telegraph_url : sec.telegraph_url_intern;

  const who = target === "mentor" ? "наставника" : "стажёра";

  let text =
    `📝 Telegraph (для ${who})

` +
    `Раздел: ${sec.title}

` +
    (url ? `Текущая ссылка:
${url}
` : `Ссылка ещё не прикреплена.
`);

  const buttons = [];

  if (url) {
    buttons.push([
      Markup.button.callback(
        "🔁 Заменить",
        `admin_internship_section_telegraph_replace_${target}_${sectionId}_${partId}`
      ),
    ]);
  } else {
    buttons.push([
      Markup.button.callback(
        "➕ Прикрепить",
        `admin_internship_section_telegraph_replace_${target}_${sectionId}_${partId}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "🔙 Назад",
      `admin_internship_section_edit_${sectionId}_${partId}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}


// ---------- reorder screens ----------

async function showInternshipPartSectionsReorder(ctx, partId) {
  const pRes = await pool.query(
    "SELECT id, title, order_index FROM internship_parts WHERE id = $1",
    [partId]
  );
  if (!pRes.rows.length) return ctx.reply("Часть стажировки не найдена.");
  const part = pRes.rows[0];

  const secRes = await pool.query(
    `
      SELECT id, title, order_index
      FROM internship_sections
      WHERE part_id = $1
      ORDER BY order_index ASC, id ASC
    `,
    [partId]
  );
  const sections = secRes.rows;

  let text =
    `📚 Разделы (режим изменения порядка)\n\n` +
    `Часть: ${part.title}\n\n` +
    `Нажимай стрелки ⬆️ / ⬇️ рядом с разделами, затем нажми «✅ Закончить».\n`;

  const buttons = [];

  for (const sec of sections) {
    const row = [];
    row.push(Markup.button.callback(`${sec.title}`, "noop"));
    row.push(
      Markup.button.callback(
        "⬆️",
        `admin_internship_section_move_up_${partId}_${sec.id}`
      )
    );
    row.push(
      Markup.button.callback(
        "⬇️",
        `admin_internship_section_move_down_${partId}_${sec.id}`
      )
    );
    buttons.push(row);
  }

  buttons.push([
    Markup.button.callback(
      "✅ Закончить изменение порядка",
      `admin_internship_part_sections_reorder_done_${partId}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("🔙 К части", `admin_internship_part_${partId}`),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showInternshipSectionSteps(ctx, sectionId, partId) {
  const secRes = await pool.query(
    `SELECT id, title FROM internship_sections WHERE id = $1 LIMIT 1`,
    [sectionId]
  );
  if (!secRes.rows.length) return ctx.reply("Раздел не найден.");
  const sec = secRes.rows[0];

  const stepRes = await pool.query(
    `
      SELECT id, title, order_index
      FROM internship_steps
      WHERE section_id = $1
      ORDER BY order_index ASC, id ASC
    `,
    [sectionId]
  );
  const steps = stepRes.rows;

  let text = `🎯 Этапы раздела: ${sec.title}\n\n`;

  const buttons = [];
  for (const st of steps) {
    buttons.push([
      Markup.button.callback(
        st.title,
        `admin_internship_step_edit_${st.id}_${sectionId}_${partId}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "➕ Добавить этап",
      `admin_internship_step_new_${sectionId}_${partId}`
    ),
  ]);
  buttons.push([
    Markup.button.callback(
      "🔁 Изменить последовательность",
      `admin_internship_steps_reorder_${sectionId}_${partId}`
    ),
  ]);
  buttons.push([
    Markup.button.callback(
      "🔙 К разделу",
      `admin_internship_section_edit_${sectionId}_${partId}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showInternshipSectionStepsReorder(ctx, sectionId, partId) {
  const secRes = await pool.query(
    `SELECT id, title FROM internship_sections WHERE id = $1 LIMIT 1`,
    [sectionId]
  );
  if (!secRes.rows.length) return ctx.reply("Раздел не найден.");
  const sec = secRes.rows[0];

  const stepRes = await pool.query(
    `
      SELECT id, title, order_index
      FROM internship_steps
      WHERE section_id = $1
      ORDER BY order_index ASC, id ASC
    `,
    [sectionId]
  );
  const steps = stepRes.rows;

  let text =
    `🎯 Этапы (режим изменения порядка)\n\n` +
    `Раздел: ${sec.title}\n\n` +
    `Нажимай стрелки ⬆️ / ⬇️ рядом с этапами, затем нажми «✅ Закончить».\n`;

  const buttons = [];
  for (const st of steps) {
    const row = [];
    row.push(Markup.button.callback(`${st.title}`, "noop"));
    row.push(
      Markup.button.callback(
        "⬆️",
        `admin_internship_step_move_up_${sectionId}_${st.id}_${partId}`
      )
    );
    row.push(
      Markup.button.callback(
        "⬇️",
        `admin_internship_step_move_down_${sectionId}_${st.id}_${partId}`
      )
    );
    buttons.push(row);
  }

  buttons.push([
    Markup.button.callback(
      "✅ Закончить изменение порядка",
      `admin_internship_steps_reorder_done_${sectionId}_${partId}`
    ),
  ]);
  buttons.push([
    Markup.button.callback(
      "🔙 К этапам",
      `admin_internship_section_steps_${sectionId}_${partId}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// ---------- настройки ЭТАПА (новый экран) ----------

async function showInternshipStepSettings(ctx, stepId, sectionId, partId) {
  const hasStepTelegraph = await columnExists(
    "internship_steps",
    "telegraph_url"
  );
  const hasStepDuration = await columnExists(
    "internship_steps",
    "planned_duration_min"
  );

  const cols = ["id", "title", "step_type", "order_index"];
  if (hasStepTelegraph) cols.push("telegraph_url");
  if (hasStepDuration) cols.push("planned_duration_min");

  const sRes = await pool.query(
    `SELECT ${cols.join(", ")} FROM internship_steps WHERE id = $1 LIMIT 1`,
    [stepId]
  );
  if (!sRes.rows.length) return ctx.reply("Этап не найден.");
  const st = sRes.rows[0];

  const typeLabel =
    st.step_type === "video"
      ? "Видео"
      : st.step_type === "photo"
      ? "Фото"
      : "Обычная кнопка";

  let text =
    `Этап стажировки:\n` + `Название: ${st.title}\n` + `Тип: ${typeLabel}\n`;

  if (hasStepTelegraph) {
    text += `Telegraph: ${st.telegraph_url ? "✅ прикреплён" : "❌ нет"}\n`;
  }
  if (hasStepDuration) {
    text += `Срок: ${
      st.planned_duration_min ? `${st.planned_duration_min} мин.` : "не указан"
    }\n`;
  }

  const rows = [];

  rows.push([
    Markup.button.callback(
      "✏️ Переименовать этап",
      `admin_internship_step_rename2_${st.id}_${sectionId}_${partId}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "🔘 Изменить тип",
      `admin_internship_step_type_${st.id}_${sectionId}_${partId}`
    ),
  ]);

  if (hasStepTelegraph) {
    rows.push([
      Markup.button.callback(
        "📝 Telegraph (для этапа)",
        `admin_internship_step_telegraph_${st.id}_${sectionId}_${partId}`
      ),
    ]);
  }

  if (hasStepDuration) {
    rows.push([
      Markup.button.callback(
        st.planned_duration_min
          ? `⏱ Изменить срок этапа (${st.planned_duration_min} мин.)`
          : "⏱ Добавить срок этапа",
        `admin_internship_step_duration_${st.id}_${sectionId}_${partId}`
      ),
    ]);
  }

  rows.push([
    Markup.button.callback(
      "🗑 Удалить этап",
      `admin_internship_step_del2_${st.id}_${sectionId}_${partId}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "🔙 К этапам раздела",
      `admin_internship_section_steps_${sectionId}_${partId}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

module.exports = {
  // user screens
  showUserInternshipMenu,
  showUserInternshipData,
  showUserInternshipPerformance,
  showUserInternshipPerformancePart,
  showUserInternshipDetails,
  showUserInternshipDetailsDay,

  // start session screens
  askStartInternshipTradePoint,
  askStartInternshipLate,

  // active session screens
  showSessionPartSections,
  showSessionSection,

  // config screens
  showInternshipConfigMenu,
  showInternshipPart,
  showInternshipSection,
  showInternshipSectionTelegraphView,

  // reorder & steps screens
  showInternshipPartSectionsReorder,
  showInternshipSectionSteps,
  showInternshipSectionStepsReorder,
  showInternshipStepSettings,
};
