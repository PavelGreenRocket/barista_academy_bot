// src/internship/actions.js
"use strict";

const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");

const {
  configStates,
  mediaStates,
  finishSessionStates,
  isAdmin,
  isTelegraphUrl,
} = require("./state");

const {
  pool,

  // sessions
  hasActiveInternshipSessionForTrainer,
  getActiveSessionForUser,

  // structure
  getPartsWithSteps,

  // maps / progress
  getSessionStepMap,
  getUserOverallStepMap,
  getUserStepProgressAcrossSessions,

  // schema + ordering
  columnExists,
  swapOrderIndex,
  getNextSectionOrderIndex,
  getNextStepOrderIndex,
} = require("./db");

const {
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

  // reorder & steps screens
  showInternshipPartSectionsReorder,
  showInternshipSectionSteps,
  showInternshipSectionStepsReorder,
  showInternshipStepSettings,
} = require("./render");

/**
 * В render.js (модуль 3) мы не унесли один экран из монолита:
 * showUserInternshipHistoryDay — он нужен для ветки "история дня".
 * Чтобы функционал остался 1-в-1, оставляем его тут.
 * Потом (если захочешь) вынесем его в render.js отдельным маленьким коммитом.
 */
async function showUserInternshipHistoryDay(ctx, admin, userId, sessionId) {
  const uRes = await pool.query(
    `
    SELECT id, full_name, role, staff_status, intern_days_completed
    FROM users
    WHERE id = $1
  `,
    [userId]
  );
  if (!uRes.rows.length) return ctx.reply("Пользователь не найден.");
  const user = uRes.rows[0];

  const sRes = await pool.query(
    `
    SELECT
      s.*,
      tp.title AS trade_point_title,
      u.full_name AS trainer_name
    FROM internship_sessions s
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
    LEFT JOIN users u ON u.id = s.started_by
    WHERE s.id = $1 AND s.user_id = $2
    LIMIT 1
  `,
    [sessionId, userId]
  );
  if (!sRes.rows.length) return ctx.reply("День стажировки не найден.");
  const session = sRes.rows[0];

  const parts = await getPartsWithSteps();
  const stepMap = await getSessionStepMap(sessionId);

  let totalSteps = 0;
  let passedSteps = 0;
  for (const part of parts) {
    for (const step of part.steps || []) {
      totalSteps++;
      if (stepMap.get(step.id)?.is_passed) passedSteps++;
    }
  }

  let perfText = "нет данных";
  if (totalSteps > 0) {
    const percent = Math.round((passedSteps * 100) / totalSteps);
    perfText = `${passedSteps}/${totalSteps} этапов (${percent}%)`;
  }

  const tradePointText = session.trade_point_title || "не указана";
  const trainerName = session.trainer_name || "Без имени";

  const startStr = session.started_at
    ? new Date(session.started_at).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

  const endStr = session.finished_at
    ? new Date(session.finished_at).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

  const commentText = session.comment || "комментариев нет";
  const issuesText = session.issues || "не было";

  let lateText;
  if (session.was_late === true) lateText = "было (стажёр пришёл с опозданием)";
  else if (session.was_late === false) lateText = "не было";
  else lateText = "данные не указаны";

  const isIntern = user.staff_status === "intern";
  const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
  const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

  const text =
    `🌱 Стажировка: ${user.full_name || "Без имени"}\n` +
    `Роль: ${user.role}\n` +
    `Статус: ${statusLine}\n\n` +
    `📅 День ${session.day_number}\n` +
    `🏬 Точка: ${tradePointText}\n` +
    `🧑‍💼 Тренер: ${trainerName}\n` +
    `🕒 Старт: ${startStr}\n` +
    `🕒 Финиш: ${endStr}\n` +
    `⏳ Опоздание: ${lateText}\n` +
    `📊 Успеваемость: ${perfText}\n` +
    `────────────\n` +
    `Комментарии: ${commentText}\n` +
    `⚠️ Замечания: ${issuesText}\n`;

  const buttons = [];
  buttons.push([
    Markup.button.callback(
      "🔙 К дням (детали)",
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

/**
 * Регистрирует ВСЮ логику стажировки в bot:
 * - bot.action(...)
 * - bot.on("text"...)
 * - bot.on(["video","photo"]...)
 *
 * Сигнатура — как в монолите, чтобы подключение было без боли.
 */
function registerInternship(bot, ensureUser, logError, showMainMenu) {
  // заглушка для кнопок без действия (чтобы Telegram не крутил "часики")
  bot.action("noop", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
  });
  // ✅ Главное меню → "🧑‍🏫 Процесс стажировки"
  bot.action("internship_active_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      // все активные сессии, которые запустил этот тренер (админ)
      const res = await pool.query(
        `
        SELECT s.id, s.user_id, s.day_number, s.started_at,
               u.full_name
        FROM internship_sessions s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.started_by = $1
          AND s.finished_at IS NULL
          AND s.is_canceled = FALSE
        ORDER BY s.started_at DESC
        `,
        [me.id]
      );

      if (!res.rows.length) {
        // на всякий случай (если кнопка показалась, но сессий уже нет)
        const kb = Markup.inlineKeyboard([
          [Markup.button.callback("🔙 В главное меню", "back_main")],
        ]);
        await deliver(
          ctx,
          { text: "Активных стажировок сейчас нет.", extra: kb },
          { edit: true }
        );
        return;
      }

      // если одна — сразу открываем меню стажировки этого стажёра
      if (res.rows.length === 1) {
        await showUserInternshipMenu(ctx, me, res.rows[0].user_id);
        return;
      }

      // если несколько — покажем список, кого выбрать
      const buttons = res.rows.map((row) => {
        const name = row.full_name || `ID ${row.user_id}`;
        return [
          Markup.button.callback(
            `👤 ${name} — день ${row.day_number}`,
            `admin_user_internship_${row.user_id}`
          ),
        ];
      });

      buttons.push([Markup.button.callback("🔙 В главное меню", "back_main")]);

      await deliver(
        ctx,
        {
          text: "Выбери стажёра (активные сессии):",
          extra: Markup.inlineKeyboard(buttons),
        },
        { edit: true }
      );
    } catch (err) {
      logError("internship_active_menu", err);
    }
  });

  // ==========================
  // НАВИГАЦИЯ ПО СЕССИИ (prev/next раздел)
  // ==========================

  bot.action(
    /^admin_internship_section_prev_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sessionId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const userId = parseInt(ctx.match[3], 10);

        const secRes = await pool.query(
          "SELECT id, part_id, order_index FROM internship_sections WHERE id=$1",
          [sectionId]
        );
        if (!secRes.rows.length) return;
        const sec = secRes.rows[0];

        const allRes = await pool.query(
          "SELECT id FROM internship_sections WHERE part_id=$1 ORDER BY order_index ASC, id ASC",
          [sec.part_id]
        );
        const list = allRes.rows.map((r) => r.id);
        const idx = list.indexOf(sectionId);
        if (idx <= 0) return;

        const prevId = list[idx - 1];
        await showSessionSection(ctx, sessionId, prevId, userId, {
          edit: true,
        });
      } catch (err) {
        logError("admin_internship_section_prev", err);
      }
    }
  );

  bot.action(
    /^admin_internship_section_next_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sessionId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const userId = parseInt(ctx.match[3], 10);

        const secRes = await pool.query(
          "SELECT id, part_id, order_index FROM internship_sections WHERE id=$1",
          [sectionId]
        );
        if (!secRes.rows.length) return;
        const sec = secRes.rows[0];

        const allRes = await pool.query(
          "SELECT id FROM internship_sections WHERE part_id=$1 ORDER BY order_index ASC, id ASC",
          [sec.part_id]
        );
        const list = allRes.rows.map((r) => r.id);
        const idx = list.indexOf(sectionId);
        if (idx < 0 || idx >= list.length - 1) return;

        const nextId = list[idx + 1];
        await showSessionSection(ctx, sessionId, nextId, userId, {
          edit: true,
        });
      } catch (err) {
        logError("admin_internship_section_next", err);
      }
    }
  );

  // ==========================
  // ПЕРЕХОД В РАЗДЕЛ/ЧАСТЬ В СЕССИИ
  // ==========================

  bot.action(
    /^admin_internship_session_section_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sessionId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const userId = parseInt(ctx.match[3], 10);

        await showSessionSection(ctx, sessionId, sectionId, userId, {
          edit: true,
        });
      } catch (err) {
        logError("admin_internship_session_section", err);
      }
    }
  );

  bot.action(
    /^admin_internship_session_part_sections_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sessionId = parseInt(ctx.match[1], 10);
        const partId = parseInt(ctx.match[2], 10);
        const userId = parseInt(ctx.match[3], 10);

        await showSessionPartSections(ctx, sessionId, partId, userId, {
          edit: true,
        });
      } catch (err) {
        logError("admin_internship_session_part_sections", err);
      }
    }
  );

  // ==========================
  // ТУМБЛЕР ВЫПОЛНЕНИЯ ЭТАПА (simple)
  // ==========================

  bot.action(
    /^admin_internship_step_toggle_(\d+)_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sessionId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const stepId = parseInt(ctx.match[3], 10);
        const userId = parseInt(ctx.match[4], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        const curRes = await pool.query(
          "SELECT is_passed FROM internship_step_results WHERE session_id=$1 AND step_id=$2 LIMIT 1",
          [sessionId, stepId]
        );

        if (!curRes.rows.length) {
          await pool.query(
            `
            INSERT INTO internship_step_results(session_id, step_id, is_passed, checked_at, checked_by)
            VALUES ($1,$2,TRUE,NOW(),$3)
          `,
            [sessionId, stepId, me.id]
          );
        } else {
          const cur = curRes.rows[0].is_passed === true;
          const next = !cur;
          await pool.query(
            `
            UPDATE internship_step_results
            SET is_passed=$1,
                checked_at = CASE WHEN $1=TRUE THEN NOW() ELSE NULL END,
                checked_by = CASE WHEN $1=TRUE THEN $2 ELSE NULL END
            WHERE session_id=$3 AND step_id=$4
          `,
            [next, me.id, sessionId, stepId]
          );
        }

        await showSessionSection(ctx, sessionId, sectionId, userId, {
          edit: true,
        });
      } catch (err) {
        logError("admin_internship_step_toggle", err);
      }
    }
  );

  // ==========================
  // МЕДИА ЭТАП (video/photo)
  // ==========================

  bot.action(
    /^admin_internship_step_media_(\d+)_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sessionId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const stepId = parseInt(ctx.match[3], 10);
        const userId = parseInt(ctx.match[4], 10);

        const stRes = await pool.query(
          "SELECT id, title, step_type FROM internship_steps WHERE id=$1 LIMIT 1",
          [stepId]
        );
        if (!stRes.rows.length) return;

        const st = stRes.rows[0];

        mediaStates.set(ctx.from.id, {
          sessionId,
          sectionId,
          stepId,
          type: st.step_type,
          userId,
        });

        const label = st.step_type === "video" ? "видео" : "фото";

        await ctx.reply(
          `Отправьте ${label} одним сообщением для этапа:\n\n${st.title}`
        );
      } catch (err) {
        logError("admin_internship_step_media", err);
      }
    }
  );

  // ==========================
  // СТАРТ СТАЖИРОВКИ (выбор точки -> опоздание)
  // ==========================

  bot.action(/^admin_internship_start_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await askStartInternshipTradePoint(ctx, me, userId);
    } catch (err) {
      logError("admin_internship_start", err);
    }
  });

  bot.action(/^admin_internship_start_tp_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);
      const tpId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await askStartInternshipLate(ctx, me, userId, tpId);
    } catch (err) {
      logError("admin_internship_start_tp", err);
    }
  });

  bot.action(/^admin_internship_start_late_yes_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);
      const tpId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      // создаём сессию
      const dayNumberRes = await pool.query(
        "SELECT COALESCE(intern_days_completed,0) AS d FROM users WHERE id=$1",
        [userId]
      );
      const nextDay = Number(dayNumberRes.rows[0]?.d || 0) + 1;

      const insRes = await pool.query(
        `
        INSERT INTO internship_sessions(user_id, day_number, started_at, started_by, trade_point_id, was_late, is_canceled)
        VALUES ($1,$2,NOW(),$3,$4,FALSE,FALSE)
        RETURNING id
      `,
        [userId, nextDay, me.id, tpId]
      );
      const sessionId = insRes.rows[0].id;

      await showUserInternshipMenu(ctx, me, userId);
    } catch (err) {
      logError("admin_internship_start_late_yes", err);
    }
  });

  bot.action(/^admin_internship_start_late_no_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);
      const tpId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      const dayNumberRes = await pool.query(
        "SELECT COALESCE(intern_days_completed,0) AS d FROM users WHERE id=$1",
        [userId]
      );
      const nextDay = Number(dayNumberRes.rows[0]?.d || 0) + 1;

      const insRes = await pool.query(
        `
        INSERT INTO internship_sessions(user_id, day_number, started_at, started_by, trade_point_id, was_late, is_canceled)
        VALUES ($1,$2,NOW(),$3,$4,TRUE,FALSE)
        RETURNING id
      `,
        [userId, nextDay, me.id, tpId]
      );
      const sessionId = insRes.rows[0].id;

      await showUserInternshipMenu(ctx, me, userId);
    } catch (err) {
      logError("admin_internship_start_late_no", err);
    }
  });

  // ==========================
  // МЕНЮ СТАЖИРОВКИ ПОЛЬЗОВАТЕЛЯ / ДАННЫЕ / УСПЕВАЕМОСТЬ / ДЕТАЛИ
  // ==========================

  bot.action(/^admin_user_internship_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showUserInternshipMenu(ctx, me, userId);
    } catch (err) {
      logError("admin_user_internship", err);
    }
  });

  bot.action(/^admin_internship_data_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showUserInternshipData(ctx, userId);
    } catch (err) {
      logError("admin_internship_data", err);
    }
  });

  bot.action(/^admin_internship_perf_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showUserInternshipPerformance(ctx, userId);
    } catch (err) {
      logError("admin_internship_perf", err);
    }
  });

  bot.action(/^admin_internship_perf_part_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showUserInternshipPerformancePart(ctx, userId, partId);
    } catch (err) {
      logError("admin_internship_perf_part", err);
    }
  });

  bot.action(/^admin_internship_details_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const userId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showUserInternshipDetails(ctx, userId);
    } catch (err) {
      logError("admin_internship_details", err);
    }
  });

  bot.action(/^admin_internship_details_day_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = parseInt(ctx.match[1], 10);
      const userId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showUserInternshipDetailsDay(ctx, me, userId, sessionId);
    } catch (err) {
      logError("admin_internship_details_day", err);
    }
  });

  bot.action(/^admin_internship_history_day_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = parseInt(ctx.match[1], 10);
      const userId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showUserInternshipHistoryDay(ctx, me, userId, sessionId);
    } catch (err) {
      logError("admin_internship_history_day", err);
    }
  });

  // ==========================
  // ЗАВЕРШЕНИЕ / ОТМЕНА СЕССИИ
  // ==========================

  bot.action(/^admin_internship_finish_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = parseInt(ctx.match[1], 10);
      const userId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      finishSessionStates.set(ctx.from.id, {
        mode: "issues",
        sessionId,
        userId,
      });

      await ctx.reply(
        "Опишите замечания по стажировке одним сообщением.\n" +
          "Если замечаний нет — отправьте «-»."
      );
    } catch (err) {
      logError("admin_internship_finish", err);
    }
  });

  bot.action(/^admin_internship_cancel_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = parseInt(ctx.match[1], 10);
      const userId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, отменить",
            `admin_internship_cancel_confirm_${sessionId}_${userId}`
          ),
        ],
        [Markup.button.callback("❌ Нет", `admin_user_internship_${userId}`)],
      ]);

      await deliver(
        ctx,
        {
          text: "Точно отменить стажировку? Данные по дню останутся в истории как отменённые.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_internship_cancel", err);
    }
  });

  bot.action(/^admin_internship_cancel_confirm_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = parseInt(ctx.match[1], 10);
      const userId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await pool.query(
        `UPDATE internship_sessions SET is_canceled = TRUE, finished_at = NOW() WHERE id = $1`,
        [sessionId]
      );

      await showUserInternshipMenu(ctx, me, userId);
    } catch (err) {
      logError("admin_internship_cancel_confirm", err);
    }
  });

  // ==========================
  // НАСТРОЙКА СТАЖИРОВКИ (АДМИН): меню/часть/раздел/этапы/этап
  // ==========================

  bot.action("admin_internship_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showInternshipConfigMenu(ctx);
    } catch (err) {
      logError("admin_internship_menu", err);
    }
  });

  bot.action(/^admin_internship_part_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const partId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_part", err);
    }
  });

  bot.action(/^admin_internship_section_edit_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showInternshipSection(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_section_edit", err);
    }
  });

  bot.action(/^admin_internship_section_steps_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showInternshipSectionSteps(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_section_steps", err);
    }
  });

  bot.action(/^admin_internship_step_edit_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const stepId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);
      const partId = parseInt(ctx.match[3], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showInternshipStepSettings(ctx, stepId, sectionId, partId);
    } catch (err) {
      logError("admin_internship_step_edit", err);
    }
  });

  // reorder sections (внутри части)
  bot.action(/^admin_internship_part_sections_reorder_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const partId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showInternshipPartSectionsReorder(ctx, partId);
    } catch (err) {
      logError("admin_internship_part_sections_reorder", err);
    }
  });

  bot.action(/^admin_internship_section_move_up_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const partId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await swapOrderIndex({
        table: "internship_sections",
        id: sectionId,
        scopeWhereSql: "part_id = $1",
        scopeParams: [partId],
        dir: "up",
      });

      await showInternshipPartSectionsReorder(ctx, partId);
    } catch (err) {
      logError("admin_internship_section_move_up", err);
    }
  });

  bot.action(
    /^admin_internship_section_move_down_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const partId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        await swapOrderIndex({
          table: "internship_sections",
          id: sectionId,
          scopeWhereSql: "part_id = $1",
          scopeParams: [partId],
          dir: "down",
        });

        await showInternshipPartSectionsReorder(ctx, partId);
      } catch (err) {
        logError("admin_internship_section_move_down", err);
      }
    }
  );

  bot.action(
    /^admin_internship_part_sections_reorder_done_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const partId = parseInt(ctx.match[1], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        await showInternshipPart(ctx, partId);
      } catch (err) {
        logError("admin_internship_part_sections_reorder_done", err);
      }
    }
  );

  // reorder steps (внутри раздела)
  bot.action(/^admin_internship_steps_reorder_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await showInternshipSectionStepsReorder(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_steps_reorder", err);
    }
  });

  bot.action(
    /^admin_internship_step_move_up_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sectionId = parseInt(ctx.match[1], 10);
        const stepId = parseInt(ctx.match[2], 10);
        const partId = parseInt(ctx.match[3], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        await swapOrderIndex({
          table: "internship_steps",
          id: stepId,
          scopeWhereSql: "section_id = $1",
          scopeParams: [sectionId],
          dir: "up",
        });

        await showInternshipSectionStepsReorder(ctx, sectionId, partId);
      } catch (err) {
        logError("admin_internship_step_move_up", err);
      }
    }
  );

  bot.action(
    /^admin_internship_step_move_down_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sectionId = parseInt(ctx.match[1], 10);
        const stepId = parseInt(ctx.match[2], 10);
        const partId = parseInt(ctx.match[3], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        await swapOrderIndex({
          table: "internship_steps",
          id: stepId,
          scopeWhereSql: "section_id = $1",
          scopeParams: [sectionId],
          dir: "down",
        });

        await showInternshipSectionStepsReorder(ctx, sectionId, partId);
      } catch (err) {
        logError("admin_internship_step_move_down", err);
      }
    }
  );

  bot.action(
    /^admin_internship_steps_reorder_done_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sectionId = parseInt(ctx.match[1], 10);
        const partId = parseInt(ctx.match[2], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        await showInternshipSectionSteps(ctx, sectionId, partId);
      } catch (err) {
        logError("admin_internship_steps_reorder_done", err);
      }
    }
  );

  // ==========================
  // TEXT HANDLERS (rename/telegraph/duration/new entities/finish session)
  // ==========================

  bot.on("text", async (ctx, next) => {
    try {
      const me = await ensureUser(ctx);
      if (!me) return next && next();
      if (!isAdmin(me)) return next && next();

      const text = (ctx.message?.text || "").trim();
      if (!text) return next && next();

      // ====== FINISH SESSION FLOW ======
      const finishState = finishSessionStates.get(ctx.from.id);
      if (finishState) {
        const { mode, sessionId, userId } = finishState;

        if (mode === "issues") {
          finishState.issuesText = text === "-" ? null : text;
          finishState.mode = "comment";
          finishSessionStates.set(ctx.from.id, finishState);

          await ctx.reply(
            "Теперь оставьте комментарий по стажировке одним сообщением.\n" +
              "Если комментария нет — отправьте «-»."
          );
          return;
        }

        if (mode === "comment") {
          const commentText = text === "-" ? null : text;
          const issuesText = finishState.issuesText || null;

          await pool.query(
            `
            UPDATE internship_sessions
            SET finished_at = NOW(),
                comment = $1,
                issues = $2
            WHERE id = $3
          `,
            [commentText, issuesText, sessionId]
          );

          // инкремент intern_days_completed
          const sRes = await pool.query(
            "SELECT user_id, day_number FROM internship_sessions WHERE id=$1 LIMIT 1",
            [sessionId]
          );
          if (sRes.rows.length) {
            const dayNumber = Number(sRes.rows[0].day_number || 0);
            await pool.query(
              "UPDATE users SET intern_days_completed = GREATEST(COALESCE(intern_days_completed,0), $1) WHERE id=$2",
              [dayNumber, sRes.rows[0].user_id]
            );
          }

          finishSessionStates.delete(ctx.from.id);

          await showUserInternshipMenu(ctx, me, userId);
          return;
        }
      }

      // ====== CONFIG FLOW ======
      const state = configStates.get(ctx.from.id);
      if (!state) return next && next();

      // ЧАСТЬ: новое название
      if (state.mode === "new_part") {
        await pool.query(
          "INSERT INTO internship_parts(title, order_index) VALUES ($1, (SELECT COALESCE(MAX(order_index),0)+1 FROM internship_parts))",
          [text]
        );
        configStates.delete(ctx.from.id);
        await showInternshipConfigMenu(ctx);
        return;
      }

      // ЧАСТЬ: переименование
      if (state.mode === "rename_part") {
        await pool.query("UPDATE internship_parts SET title=$1 WHERE id=$2", [
          text,
          state.partId,
        ]);
        configStates.delete(ctx.from.id);
        await showInternshipPart(ctx, state.partId);
        return;
      }

      // РАЗДЕЛ: новый
      if (state.mode === "new_section") {
        const nextIdx = await getNextSectionOrderIndex(state.partId);
        await pool.query(
          "INSERT INTO internship_sections(part_id, title, order_index) VALUES ($1,$2,$3)",
          [state.partId, text, nextIdx]
        );
        configStates.delete(ctx.from.id);
        await showInternshipPart(ctx, state.partId);
        return;
      }

      // РАЗДЕЛ: rename
      if (state.mode === "rename_section") {
        await pool.query(
          "UPDATE internship_sections SET title=$1 WHERE id=$2",
          [text, state.sectionId]
        );
        configStates.delete(ctx.from.id);
        await showInternshipSection(ctx, state.sectionId, state.partId);
        return;
      }

      // РАЗДЕЛ: telegraph
      if (state.mode === "await_section_telegraph") {
        if (text !== "-" && !isTelegraphUrl(text)) {
          await ctx.reply("Нужна ссылка telegra.ph (или «-» чтобы убрать).");
          return;
        }
        await pool.query(
          "UPDATE internship_sections SET telegraph_url=$1 WHERE id=$2",
          [text === "-" ? null : text, state.sectionId]
        );
        configStates.delete(ctx.from.id);
        await showInternshipSection(ctx, state.sectionId, state.partId);
        return;
      }

      // РАЗДЕЛ: duration_days
      if (state.mode === "await_section_duration") {
        if (text === "-") {
          await pool.query(
            "UPDATE internship_sections SET duration_days=NULL WHERE id=$1",
            [state.sectionId]
          );
          configStates.delete(ctx.from.id);
          await showInternshipSection(ctx, state.sectionId, state.partId);
          return;
        }
        const n = parseInt(text, 10);
        if (!Number.isFinite(n) || n <= 0) {
          await ctx.reply(
            "Введите число дней (например 1, 2, 3) или «-» чтобы убрать срок."
          );
          return;
        }
        await pool.query(
          "UPDATE internship_sections SET duration_days=$1 WHERE id=$2",
          [n, state.sectionId]
        );
        configStates.delete(ctx.from.id);
        await showInternshipSection(ctx, state.sectionId, state.partId);
        return;
      }

      // ЭТАП: новый
      if (state.mode === "new_step") {
        const nextIdx = await getNextStepOrderIndex(state.sectionId);
        await pool.query(
          "INSERT INTO internship_steps(section_id, title, step_type, order_index) VALUES ($1,$2,'simple',$3)",
          [state.sectionId, text, nextIdx]
        );
        configStates.delete(ctx.from.id);
        await showInternshipSectionSteps(ctx, state.sectionId, state.partId);
        return;
      }

      // ЭТАП: rename
      if (state.mode === "rename_step2") {
        await pool.query("UPDATE internship_steps SET title=$1 WHERE id=$2", [
          text,
          state.stepId,
        ]);
        configStates.delete(ctx.from.id);
        await showInternshipStepSettings(
          ctx,
          state.stepId,
          state.sectionId,
          state.partId
        );
        return;
      }

      // ЭТАП: telegraph_url (если есть колонка)
      if (state.mode === "await_step_telegraph") {
        const ok = await columnExists("internship_steps", "telegraph_url");
        if (!ok) {
          configStates.delete(ctx.from.id);
          await ctx.reply(
            "В таблице internship_steps нет колонки telegraph_url."
          );
          await showInternshipStepSettings(
            ctx,
            state.stepId,
            state.sectionId,
            state.partId
          );
          return;
        }

        if (text !== "-" && !isTelegraphUrl(text)) {
          await ctx.reply("Нужна ссылка telegra.ph (или «-» чтобы убрать).");
          return;
        }

        await pool.query(
          "UPDATE internship_steps SET telegraph_url=$1 WHERE id=$2",
          [text === "-" ? null : text, state.stepId]
        );

        configStates.delete(ctx.from.id);
        await showInternshipStepSettings(
          ctx,
          state.stepId,
          state.sectionId,
          state.partId
        );
        return;
      }

      // ЭТАП: planned_duration_min (если есть колонка)
      if (state.mode === "await_step_duration") {
        const ok = await columnExists(
          "internship_steps",
          "planned_duration_min"
        );
        if (!ok) {
          configStates.delete(ctx.from.id);
          await ctx.reply(
            "В таблице internship_steps нет колонки planned_duration_min."
          );
          await showInternshipStepSettings(
            ctx,
            state.stepId,
            state.sectionId,
            state.partId
          );
          return;
        }

        if (text === "-") {
          await pool.query(
            "UPDATE internship_steps SET planned_duration_min=NULL WHERE id=$1",
            [state.stepId]
          );
          configStates.delete(ctx.from.id);
          await showInternshipStepSettings(
            ctx,
            state.stepId,
            state.sectionId,
            state.partId
          );
          return;
        }

        const n = parseInt(text, 10);
        if (!Number.isFinite(n) || n <= 0) {
          await ctx.reply(
            "Введите срок в минутах (например 10, 30, 60) или «-» чтобы убрать."
          );
          return;
        }

        await pool.query(
          "UPDATE internship_steps SET planned_duration_min=$1 WHERE id=$2",
          [n, state.stepId]
        );

        configStates.delete(ctx.from.id);
        await showInternshipStepSettings(
          ctx,
          state.stepId,
          state.sectionId,
          state.partId
        );
        return;
      }

      // если дошли сюда — неизвестный режим
      return next && next();
    } catch (err) {
      logError("admin_internship_text", err);
      return next && next();
    }
  });

  // ==========================
  // MEDIA HANDLERS (video/photo) для этапов
  // ==========================

  bot.on(["video", "photo"], async (ctx, next) => {
    try {
      const me = await ensureUser(ctx);
      if (!me) return next && next();
      if (!isAdmin(me)) return next && next();

      const state = mediaStates.get(ctx.from.id);
      if (!state) return next && next();

      const { sessionId, sectionId, stepId, type, userId } = state;

      let fileId = null;

      if (type === "video") {
        fileId = ctx.message?.video?.file_id || null;
      } else if (type === "photo") {
        const arr = ctx.message?.photo || [];
        fileId = arr.length ? arr[arr.length - 1].file_id : null;
      }

      if (!fileId) {
        await ctx.reply(
          "Не удалось получить файл. Отправьте медиа одним сообщением."
        );
        return;
      }

      await pool.query(
        `
        INSERT INTO internship_step_results(session_id, step_id, is_passed, checked_at, checked_by, file_id)
        VALUES ($1,$2,TRUE,NOW(),$3,$4)
        ON CONFLICT (session_id, step_id)
        DO UPDATE SET
          is_passed=TRUE,
          checked_at=NOW(),
          checked_by=$3,
          file_id=$4
      `,
        [sessionId, stepId, me.id, fileId]
      );

      mediaStates.delete(ctx.from.id);

      await showSessionSection(ctx, sessionId, sectionId, userId, {
        edit: false,
      });
    } catch (err) {
      logError("admin_internship_media", err);
      return next && next();
    }
  });

  // ==========================
  // ADMIN CONFIG: создание/удаление/поля (actions)
  // ==========================

  bot.action("admin_internship_part_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      configStates.set(ctx.from.id, { mode: "new_part" });
      await ctx.reply(
        "Введите название новой части стажировки одним сообщением."
      );
    } catch (err) {
      logError("admin_internship_part_new", err);
    }
  });

  bot.action(/^admin_internship_part_del_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const partId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, удалить",
            `admin_internship_part_del_confirm_${partId}`
          ),
        ],
        [Markup.button.callback("❌ Нет", `admin_internship_part_${partId}`)],
      ]);

      await deliver(
        ctx,
        {
          text: "Точно удалить часть? Разделы и этапы внутри тоже удалятся.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_internship_part_del", err);
    }
  });

  bot.action(/^admin_internship_part_del_confirm_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const partId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      await pool.query("DELETE FROM internship_parts WHERE id=$1", [partId]);
      await showInternshipConfigMenu(ctx);
    } catch (err) {
      logError("admin_internship_part_del_confirm", err);
    }
  });

  bot.action(/^admin_internship_part_rename_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const partId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      configStates.set(ctx.from.id, { mode: "rename_part", partId });
      await ctx.reply("Введите новое название части одним сообщением.");
    } catch (err) {
      logError("admin_internship_part_rename", err);
    }
  });

  bot.action(/^admin_internship_section_new_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const partId = parseInt(ctx.match[1], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      configStates.set(ctx.from.id, { mode: "new_section", partId });
      await ctx.reply(
        "Введите название нового раздела одним сообщением (например «День 1»)."
      );
    } catch (err) {
      logError("admin_internship_section_new", err);
    }
  });

  bot.action(/^admin_internship_section_rename_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      configStates.set(ctx.from.id, {
        mode: "rename_section",
        sectionId,
        partId,
      });
      await ctx.reply("Введите новое название раздела одним сообщением.");
    } catch (err) {
      logError("admin_internship_section_rename", err);
    }
  });

  bot.action(
    /^admin_internship_section_telegraph_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sectionId = parseInt(ctx.match[1], 10);
        const partId = parseInt(ctx.match[2], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        configStates.set(ctx.from.id, {
          mode: "await_section_telegraph",
          sectionId,
          partId,
        });
        await ctx.reply(
          "Отправьте ссылку telegra.ph одним сообщением (или «-» чтобы убрать)."
        );
      } catch (err) {
        logError("admin_internship_section_telegraph", err);
      }
    }
  );

  bot.action(/^admin_internship_section_duration_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      configStates.set(ctx.from.id, {
        mode: "await_section_duration",
        sectionId,
        partId,
      });
      await ctx.reply(
        "Введите срок раздела в днях (число) или «-» чтобы убрать срок."
      );
    } catch (err) {
      logError("admin_internship_section_duration", err);
    }
  });

  bot.action(/^admin_internship_section_del_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, удалить",
            `admin_internship_section_del_confirm_${sectionId}_${partId}`
          ),
        ],
        [
          Markup.button.callback(
            "❌ Нет",
            `admin_internship_section_edit_${sectionId}_${partId}`
          ),
        ],
      ]);

      await deliver(
        ctx,
        {
          text: "Точно удалить раздел? Этапы внутри тоже удалятся.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_internship_section_del", err);
    }
  });

  bot.action(
    /^admin_internship_section_del_confirm_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const sectionId = parseInt(ctx.match[1], 10);
        const partId = parseInt(ctx.match[2], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        await pool.query("DELETE FROM internship_sections WHERE id=$1", [
          sectionId,
        ]);
        await showInternshipPart(ctx, partId);
      } catch (err) {
        logError("admin_internship_section_del_confirm", err);
      }
    }
  );

  bot.action(/^admin_internship_step_new_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      configStates.set(ctx.from.id, { mode: "new_step", sectionId, partId });
      await ctx.reply(
        "Введите название нового этапа стажировки одним сообщением."
      );
    } catch (err) {
      logError("admin_internship_step_new", err);
    }
  });

  bot.action(
    /^admin_internship_step_rename2_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const stepId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const partId = parseInt(ctx.match[3], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        configStates.set(ctx.from.id, {
          mode: "rename_step2",
          stepId,
          sectionId,
          partId,
        });
        await ctx.reply("Введите новое название этапа одним сообщением.");
      } catch (err) {
        logError("admin_internship_step_rename2", err);
      }
    }
  );

  bot.action(
    /^admin_internship_step_telegraph_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const stepId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const partId = parseInt(ctx.match[3], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        configStates.set(ctx.from.id, {
          mode: "await_step_telegraph",
          stepId,
          sectionId,
          partId,
        });
        await ctx.reply(
          "Отправьте ссылку telegra.ph одним сообщением (или «-» чтобы убрать)."
        );
      } catch (err) {
        logError("admin_internship_step_telegraph", err);
      }
    }
  );

  bot.action(
    /^admin_internship_step_duration_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const stepId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const partId = parseInt(ctx.match[3], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        configStates.set(ctx.from.id, {
          mode: "await_step_duration",
          stepId,
          sectionId,
          partId,
        });
        await ctx.reply(
          "Введите срок этапа в минутах (число) или «-» чтобы убрать срок."
        );
      } catch (err) {
        logError("admin_internship_step_duration", err);
      }
    }
  );

  bot.action(/^admin_internship_step_del2_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const stepId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);
      const partId = parseInt(ctx.match[3], 10);

      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, удалить",
            `admin_internship_step_del2_confirm_${stepId}_${sectionId}_${partId}`
          ),
        ],
        [
          Markup.button.callback(
            "❌ Нет",
            `admin_internship_step_edit_${stepId}_${sectionId}_${partId}`
          ),
        ],
      ]);

      await deliver(
        ctx,
        { text: "Точно удалить этап?", extra: keyboard },
        { edit: true }
      );
    } catch (err) {
      logError("admin_internship_step_del2", err);
    }
  });

  bot.action(
    /^admin_internship_step_del2_confirm_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const stepId = parseInt(ctx.match[1], 10);
        const sectionId = parseInt(ctx.match[2], 10);
        const partId = parseInt(ctx.match[3], 10);

        const me = await ensureUser(ctx);
        if (!me || !isAdmin(me)) return;

        await pool.query("DELETE FROM internship_steps WHERE id=$1", [stepId]);
        await showInternshipSectionSteps(ctx, sectionId, partId);
      } catch (err) {
        logError("admin_internship_step_del2_confirm", err);
      }
    }
  );

  // ==========================
  // Возврат в главное меню бота (если у тебя есть showMainMenu)
  // ==========================
  bot.action("admin_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const me = await ensureUser(ctx);
      if (!me || !isAdmin(me)) return;
      if (typeof showMainMenu === "function") await showMainMenu(ctx);
    } catch (err) {
      logError("admin_menu", err);
    }
  });
}

module.exports = {
  registerInternship,
  hasActiveInternshipSessionForTrainer, // удобно реэкспортнуть как было
};
