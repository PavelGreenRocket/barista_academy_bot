// src/bot/interviews/card.js

const pool = require("../../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");
const {
  setInterviewResultState,
  getInterviewResultState,
  clearInterviewResultState,
  setDeclineReasonState,
  clearDeclineReasonState,
} = require("./state");

// Иконка статуса для шапки
function getStatusIcon(status) {
  switch (status) {
    case "invited":
    default:
      return "🕒";
    case "interviewed":
      return "✔️";
    case "internship_invited":
      return "☑️";
    case "cancelled":
      return "❌";
    case "declined":
      return "❌";
  }
}

function getHeaderStatusLabel(status) {
  switch (status) {
    case "cancelled":
      return "СОБЕСЕДОВАНИЕ ОТМЕНЕНО (❌)";
    case "internship_invited":
      return "ПРИГЛАШЁН НА СТАЖИРОВКУ (✅)";
    case "interviewed":
      return "СОБЕСЕДОВАНИЕ ПРОВЕДЕНО (✔️)";
    case "declined":
      return "КАНДИДАТ ОТКЛОНЁН (❌)";
    case "invited":
    default:
      return "ОЖИДАНИЕ СОБЕСЕДОВАНИЯ (🕒)";
  }
}

function getDeclineReasonLabel(reasonText) {
  if (!reasonText || !reasonText.trim()) return "не указана";
  return reasonText.trim();
}

function formatInterviewDateTime(dateValue, timeStr) {
  // Если нет ни даты, ни времени — считаем, что не указано
  if (!dateValue && !timeStr) return "не указана";

  let datePart = "";
  let weekdayPart = "";

  if (dateValue) {
    // dateValue у нас из БД в формате "YYYY-MM-DD"
    if (typeof dateValue === "string") {
      const parts = dateValue.split("-");
      if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        const day = parseInt(parts[2], 10);

        if (
          Number.isFinite(year) &&
          Number.isFinite(month) &&
          Number.isFinite(day)
        ) {
          // Саму дату рисуем руками, без таймзоны
          const dd = String(day).padStart(2, "0");
          const mm = String(month).padStart(2, "0");
          datePart = `${dd}.${mm}`;

          // День недели считаем в UTC, чтобы не было сдвига
          const d = new Date(Date.UTC(year, month - 1, day));
          weekdayPart = d.toLocaleDateString("ru-RU", {
            weekday: "short",
            timeZone: "UTC",
          });
        }
      }
    } else if (dateValue instanceof Date) {
      // На всякий случай, если когда-то передадут Date
      const d = dateValue;
      datePart = d.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
      });
      weekdayPart = d.toLocaleDateString("ru-RU", {
        weekday: "short",
      });
    }
  }

  // Если по какой-то причине дату всё-таки не смогли собрать —
  // хотя бы покажем время
  if (!datePart) {
    return timeStr || "не указана";
  }

  // Дата + время + день недели
  if (timeStr) {
    return `${datePart} (${timeStr}) ${weekdayPart}`.trim();
  }

  // Только дата + день недели
  return `${datePart} ${weekdayPart}`.trim();
}

function formatInterviewSummary(cand) {
  const hasAny =
    cand.was_on_time !== null ||
    cand.late_minutes !== null ||
    (cand.interview_comment && cand.interview_comment.trim() !== "");

  if (!hasAny) return null;

  let latenessPart;

  if (cand.was_on_time === false && typeof cand.late_minutes === "number") {
    latenessPart = `Опоздание: опоздал на ${cand.late_minutes} мин`;
  } else if (cand.was_on_time === false) {
    latenessPart = "Опоздание: опоздал";
  } else {
    latenessPart = "Опоздание: пришёл вовремя";
  }

  let otherPart;
  if (!cand.interview_comment || !cand.interview_comment.trim()) {
    otherPart = "Другие: отсутствуют";
  } else {
    otherPart = `Другие: ${cand.interview_comment.trim()}`;
  }

  return `Замечания: ${latenessPart}. ${otherPart}.`;
}

// Показ карточки кандидата
async function showCandidateCard(ctx, candidateId) {
  const res = await pool.query(
    `
    SELECT
      c.id,
      c.name,
      c.age,
      c.phone,
      c.status,
      c.salary,
      c.schedule,
      c.questionnaire,
      c.interview_date,
      c.interview_time,
      c.comment,
      c.was_on_time,
      c.late_minutes,
      c.interview_comment,
      c.decline_reason,
      c.declined_at,
      c.is_deferred,
      c.closed_from_status,
      COALESCE(tp_place.title, 'не указано')   AS place_title,
      COALESCE(tp_desired.title, 'не указано') AS desired_point_title,
      COALESCE(u.full_name, 'Без имени')       AS admin_name
    FROM candidates c
      LEFT JOIN trade_points tp_place   ON c.point_id         = tp_place.id
      LEFT JOIN trade_points tp_desired ON c.desired_point_id = tp_desired.id
      LEFT JOIN users u                 ON c.admin_id         = u.id
    WHERE c.id = $1
    `,
    [candidateId]
  );

  if (!res.rows.length) {
    await ctx.reply("Кандидат не найден.");
    return;
  }

  const cand = res.rows[0];

  const headerStatus = getHeaderStatusLabel(cand.status);

  let text = `🔻 КАНДИДАТ — ${headerStatus}\n`;
  text += `────────────────────────────────\n`;

  // Имя и возраст
  text += `👤 Имя: ${cand.name || "не указано"}`;
  if (cand.age) text += ` (${cand.age})`;
  text += `\n`;

  // Дата и время собеседования
  const dtLabel = formatInterviewDateTime(
    cand.interview_date,
    cand.interview_time
  );
  text += `🕒 Дата собеседования: ${dtLabel}\n\n`;

  // Место / желаемая точка
  const placeTitle = cand.place_title || "не указано";
  const desiredTitle = cand.desired_point_title || "не указано";
  text += `📍 Место собеседования: ${placeTitle}\n`;
  text += `📌 Желаемая точка: ${desiredTitle}\n\n`;

  // Ответственный и телефон кандидата
  text += `👤 Ответственный: ${cand.admin_name || "не указано"}\n`;
  text += `📞 Телефон кандидата: ${cand.phone || "не указан"}\n\n`;

  // ЗП, график, анкета
  text += `💵 Желаемая ЗП: ${cand.salary || "не указана"}\n`;
  text += `📆 Желаемый график: ${cand.schedule || "не указан"}\n`;
  if (cand.questionnaire) {
    text += `📎 Анкета: ${cand.questionnaire}\n`;
  } else {
    text += `📎 Анкета: не указана\n`;
  }

  // Общий комментарий
  text += `\n💬 Комментарий: ${cand.comment || "—"}\n`;

  // Итоги собеседования
  if (
    cand.status === "interviewed" ||
    cand.status === "internship_invited" ||
    cand.status === "declined"
  ) {
    const summary = formatInterviewSummary(cand);
    if (summary) {
      text += "\n────────────────────────────────\n";
      text += "📊 ИТОГИ СОБЕСЕДОВАНИЯ\n";
      text += `${summary}\n`;
    }
  }

  // Причина отказа / отмены + объяснение по удалению/отложенным
  if (cand.status === "declined" || cand.status === "cancelled") {
    const reasonLabel = getDeclineReasonLabel(cand.decline_reason);
    text += `\nПричина: ${reasonLabel}\n`;

    if (cand.is_deferred) {
      text +=
        "\n🗑️ Этот кандидат отложен — данные сохраняются, чтобы к нему можно было вернуться позже. Автоматического удаления нет.\n";
    } else {
      text +=
        "\n❌ Этот кандидат находится в списке на удаление и будет автоматически удалён через 30 дней после отказа/отмены.\n";
    }
  }

  const buttons = [];

  // --- Кнопки по статусам ---

  if (cand.status === "invited") {
    buttons.push([
      Markup.button.callback(
        "✅👤 Собеседование пройдено",
        `admin_candidate_interview_done_${cand.id}`
      ),
    ]);
    buttons.push([
      Markup.button.callback(
        "❌👤 Отменить собеседование",
        `admin_candidate_cancel_${cand.id}`
      ),
    ]);
  } else if (cand.status === "cancelled") {
    // отменённое собеседование: отложить/вернуть + восстановить
    if (cand.is_deferred) {
      buttons.push([
        Markup.button.callback(
          "↩️🗑️ убрать из отложенных",
          `admin_candidate_unmark_deferred_${cand.id}`
        ),
      ]);
    } else {
      buttons.push([
        Markup.button.callback(
          "🗑️ перенести в отложенные",
          `admin_candidate_mark_deferred_${cand.id}`
        ),
      ]);
    }
    buttons.push([
      Markup.button.callback(
        "🔄 восстановить собеседование",
        `admin_candidate_restore_${cand.id}`
      ),
    ]);
  } else if (cand.status === "interviewed") {
    buttons.push([
      Markup.button.callback(
        "✅ Пригласить на стажировку",
        `admin_candidate_invite_internship_${cand.id}`
      ),
    ]);
    buttons.push([
      Markup.button.callback(
        "❌ отказать кандидату",
        `admin_candidate_decline_${cand.id}`
      ),
    ]);
  } else if (cand.status === "internship_invited") {
    buttons.push([
      Markup.button.callback(
        "❌ отказать кандидату",
        `admin_candidate_decline_${cand.id}`
      ),
    ]);
  } else if (cand.status === "declined") {
    if (cand.is_deferred) {
      buttons.push([
        Markup.button.callback(
          "↩️🗑️ убрать из отложенных",
          `admin_candidate_unmark_deferred_${cand.id}`
        ),
      ]);
    } else {
      buttons.push([
        Markup.button.callback(
          "🗑️ перенести в отложенные",
          `admin_candidate_mark_deferred_${cand.id}`
        ),
      ]);
    }

    buttons.push([
      Markup.button.callback(
        "🔄 восстановить кандидата",
        `admin_candidate_restore_declined_${cand.id}`
      ),
    ]);
  }

  // Настройки
  buttons.push([
    Markup.button.callback("⚙️ Настройки", `admin_candidate_edit_${cand.id}`),
  ]);

  // Навигация
  buttons.push([
    Markup.button.callback("🔙 К собеседованиям", "admin_interviews"),
  ]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

function registerInterviewCard(bot, ensureUser, logError) {
  // Открыть карточку
  bot.action(/^admin_candidate_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      clearInterviewResultState(ctx.from.id);
      clearDeclineReasonState(ctx.from.id);

      const candidateId = parseInt(ctx.match[1], 10);
      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("admin_candidate_open", err);
    }
  });

  // ✅ Собеседование пройдено
  bot.action(/^admin_candidate_interview_done_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);
      const tgId = ctx.from.id;

      setInterviewResultState(tgId, {
        candidateId,
        step: "on_time",
        wasOnTime: null,
        lateMinutes: null,
      });

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да",
            `admin_candidate_on_time_yes_${candidateId}`
          ),
          Markup.button.callback(
            "⏰ Опоздал",
            `admin_candidate_on_time_late_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "🔙 Назад к кандидату",
            `admin_candidate_${candidateId}`
          ),
        ],
      ]);

      await deliver(
        ctx,
        {
          text: "Кандидат пришёл вовремя?",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_interview_done", err);
    }
  });

  // Пришёл вовремя
  bot.action(/^admin_candidate_on_time_yes_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);
      const tgId = ctx.from.id;

      setInterviewResultState(tgId, {
        candidateId,
        step: "comment",
        wasOnTime: true,
        lateMinutes: null,
      });

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "ℹ️ замечаний нет",
            `admin_candidate_no_notes_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "🔙 Назад к кандидату",
            `admin_candidate_${candidateId}`
          ),
        ],
      ]);

      await deliver(
        ctx,
        {
          text:
            "Оставьте замечания по собеседованию одним сообщением.\n" +
            "Если замечаний нет — нажмите «ℹ️ замечаний нет».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_on_time_yes", err);
    }
  });

  // Опоздал
  bot.action(/^admin_candidate_on_time_late_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);
      const tgId = ctx.from.id;

      setInterviewResultState(tgId, {
        candidateId,
        step: "late_minutes",
        wasOnTime: false,
        lateMinutes: null,
      });

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔙 Назад к кандидату",
            `admin_candidate_${candidateId}`
          ),
        ],
      ]);

      await deliver(
        ctx,
        {
          text: "На сколько минут кандидат опоздал? Введите число.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_on_time_late", err);
    }
  });

  // Замечаний нет
  bot.action(/^admin_candidate_no_notes_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Сохранено").catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);
      const tgId = ctx.from.id;
      const state = getInterviewResultState(tgId);

      const wasOnTime = state && state.wasOnTime === false ? false : true;
      const lateMinutes =
        state && typeof state.lateMinutes === "number"
          ? state.lateMinutes
          : null;

      await pool.query(
        `
        UPDATE candidates
        SET status = 'interviewed',
            was_on_time = $2,
            late_minutes = $3,
            interview_comment = NULL
        WHERE id = $1
        `,
        [candidateId, wasOnTime, lateMinutes]
      );

      clearInterviewResultState(tgId);
      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("admin_candidate_no_notes", err);
    }
  });

  // 🔄 восстановить собеседование из cancelled
  bot.action(/^admin_candidate_restore_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Собеседование восстановлено.").catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);

      await pool.query(
        `
        UPDATE candidates
        SET status = 'invited',
            is_deferred = FALSE,
            closed_from_status = NULL,
            decline_reason = NULL,
            declined_at = NULL,
            closed_by_admin_id = NULL
        WHERE id = $1
        `,
        [candidateId]
      );

      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("admin_candidate_restore", err);
      await ctx.reply("Не удалось восстановить собеседование.");
    }
  });

  // 🔄 восстановить кандидата из declined
  bot.action(/^admin_candidate_restore_declined_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Кандидат восстановлен.").catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);

      await pool.query(
        `
        UPDATE candidates
        SET status = 'interviewed',
            is_deferred = FALSE,
            closed_from_status = NULL,
            decline_reason = NULL,
            declined_at = NULL,
            closed_by_admin_id = NULL
        WHERE id = $1
        `,
        [candidateId]
      );

      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("admin_candidate_restore_declined", err);
      await ctx.reply("Не удалось восстановить кандидата.");
    }
  });

  // ✅ Пригласить на стажировку
  bot.action(/^admin_candidate_invite_internship_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);

      await pool.query(
        "UPDATE candidates SET status = 'internship_invited' WHERE id = $1",
        [candidateId]
      );

      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("admin_candidate_invite_internship", err);
      await ctx.reply("Не удалось пригласить кандидата на стажировку.");
    }
  });

  // ❌ отказать кандидату (меню причин)
  bot.action(/^admin_candidate_decline_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);

      setDeclineReasonState(ctx.from.id, {
        candidateId,
        mode: "decline",
      });

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "❌    Не подходит",
            `admin_candidate_decline_not_fit_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "👥✓ Команда была набрана",
            `admin_candidate_decline_team_full_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "📅 Не подходит график",
            `admin_candidate_decline_schedule_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "💬 ввести причину вручную",
            `admin_candidate_decline_custom_${candidateId}`
          ),
        ],
        [Markup.button.callback("🔙 Назад", `admin_candidate_${candidateId}`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            "Выбери причину отказа кнопкой ниже\n" +
            "или напиши свою причину одним сообщением.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_decline_menu", err);
    }
  });

  async function declineWithReason(ctx, candidateId, reasonText, mode, tag) {
    try {
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const newStatus = mode === "cancel" ? "cancelled" : "declined";

      await pool.query(
        `
        UPDATE candidates
        SET closed_from_status = status,
            status = $2,
            decline_reason = $3,
            declined_at = NOW(),
            is_deferred = FALSE,
            closed_by_admin_id = $4
        WHERE id = $1
        `,
        [candidateId, newStatus, reasonText, admin.id]
      );

      clearDeclineReasonState(ctx.from.id);
      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError(tag, err);
      await ctx.reply("Не удалось сохранить причину.");
    }
  }

  // Кнопки причин отказа
  bot.action(/^admin_candidate_decline_not_fit_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отказ: Не подходит.").catch(() => {});
    const candidateId = parseInt(ctx.match[1], 10);
    await declineWithReason(
      ctx,
      candidateId,
      "❌    Не подходит",
      "decline",
      "candidate_decline_not_fit"
    );
  });

  bot.action(/^admin_candidate_decline_team_full_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отказ: Команда была набрана.").catch(() => {});
    const candidateId = parseInt(ctx.match[1], 10);
    await declineWithReason(
      ctx,
      candidateId,
      "👥✓ Команда была набрана",
      "decline",
      "candidate_decline_team_full"
    );
  });

  bot.action(/^admin_candidate_decline_schedule_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отказ: Не подходит график.").catch(() => {});
    const candidateId = parseInt(ctx.match[1], 10);
    await declineWithReason(
      ctx,
      candidateId,
      "📅 Не подходит график",
      "decline",
      "candidate_decline_schedule"
    );
  });

  // Кнопка "ввести причину вручную" (отказ)
  bot.action(/^admin_candidate_decline_custom_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);
      setDeclineReasonState(ctx.from.id, {
        candidateId,
        mode: "decline",
      });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Назад", `admin_candidate_${candidateId}`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            "💬 Введи причину отказа одним сообщением.\n" +
            "Например: «Не подошёл по уровню сервиса».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_decline_custom", err);
    }
  });

  // ❌👤 Отменить собеседование (меню причин)
  bot.action(/^admin_candidate_cancel_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);

      setDeclineReasonState(ctx.from.id, {
        candidateId,
        mode: "cancel",
      });

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🚫👤 Не пришёл на собеседование",
            `admin_candidate_cancel_reason_no_show_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "📅 Не подходит график",
            `admin_candidate_cancel_reason_schedule_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "✈️ Далеко живёт",
            `admin_candidate_cancel_reason_far_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "😒💵  Не устраивает ЗП",
            `admin_candidate_cancel_reason_salary_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "❌ Не подходит",
            `admin_candidate_cancel_reason_not_fit_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "💬 ввести причину вручную",
            `admin_candidate_cancel_reason_custom_${candidateId}`
          ),
        ],
        [Markup.button.callback("🔙 Назад", `admin_candidate_${candidateId}`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            "Укажи причину отмены собеседования.\n" +
            "Можешь выбрать кнопку или написать причину вручную одним сообщением.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_cancel_menu", err);
    }
  });

  // Кнопки причин отмены
  bot.action(/^admin_candidate_cancel_reason_no_show_(\d+)$/, async (ctx) => {
    await ctx
      .answerCbQuery("Отменено: не пришёл на собеседование.")
      .catch(() => {});
    const candidateId = parseInt(ctx.match[1], 10);
    await declineWithReason(
      ctx,
      candidateId,
      "🚫👤 Не пришёл на собеседование",
      "cancel",
      "candidate_cancel_no_show"
    );
  });

  bot.action(/^admin_candidate_cancel_reason_schedule_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отменено: не подходит график.").catch(() => {});
    const candidateId = parseInt(ctx.match[1], 10);
    await declineWithReason(
      ctx,
      candidateId,
      "📅 Не подходит график",
      "cancel",
      "candidate_cancel_schedule"
    );
  });

  bot.action(/^admin_candidate_cancel_reason_far_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отменено: далеко живёт.").catch(() => {});
    const candidateId = parseInt(ctx.match[1], 10);
    await declineWithReason(
      ctx,
      candidateId,
      "✈️ Далеко живёт",
      "cancel",
      "candidate_cancel_far"
    );
  });

  bot.action(/^admin_candidate_cancel_reason_salary_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отменено: не устраивает ЗП.").catch(() => {});
    const candidateId = parseInt(ctx.match[1], 10);
    await declineWithReason(
      ctx,
      candidateId,
      "😒💵  Не устраивает ЗП",
      "cancel",
      "candidate_cancel_salary"
    );
  });

  bot.action(/^admin_candidate_cancel_reason_not_fit_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отменено: не подходит.").catch(() => {});
    const candidateId = parseInt(ctx.match[1], 10);
    await declineWithReason(
      ctx,
      candidateId,
      "❌ Не подходит",
      "cancel",
      "candidate_cancel_not_fit"
    );
  });

  // Кнопка "ввести причину вручную" (отмена)
  bot.action(/^admin_candidate_cancel_reason_custom_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const candidateId = parseInt(ctx.match[1], 10);
      setDeclineReasonState(ctx.from.id, {
        candidateId,
        mode: "cancel",
      });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Назад", `admin_candidate_${candidateId}`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            "💬 Введи причину отмены собеседования одним сообщением.\n" +
            "Например: «Не смог приехать, перенесли на другой день».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_cancel_custom", err);
    }
  });

  // Отложенные: пометить
  bot.action(/^admin_candidate_mark_deferred_(\d+)$/, async (ctx) => {
    try {
      await ctx
        .answerCbQuery("Кандидат перенесён в отложенные.")
        .catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      const candidateId = parseInt(ctx.match[1], 10);

      await pool.query(
        "UPDATE candidates SET is_deferred = TRUE WHERE id = $1",
        [candidateId]
      );

      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("admin_candidate_mark_deferred", err);
      await ctx.reply("Не удалось перенести кандидата в отложенные.");
    }
  });

  // Отложенные: убрать
  bot.action(/^admin_candidate_unmark_deferred_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Кандидат убран из отложенных.").catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      const candidateId = parseInt(ctx.match[1], 10);

      await pool.query(
        "UPDATE candidates SET is_deferred = FALSE WHERE id = $1",
        [candidateId]
      );

      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("admin_candidate_unmark_deferred", err);
      await ctx.reply("Не удалось убрать кандидата из отложенных.");
    }
  });
}

module.exports = { registerInterviewCard, showCandidateCard };
