// src/bot/interviews/list.js

const pool = require("../../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");
const {
  getInterviewViewState,
  setInterviewViewState,
  clearInterviewViewState,
  clearCandidateCreateState,
  clearCandidateEditState,
} = require("./state");

// Маппинг статуса на смайлик
function getStatusIcon(status) {
  switch (status) {
    case "interviewed": // пришёл на собес, ждёт решения
      return "✔️";
    case "internship_invited": // приглашён на стажировку
      return "☑️";
    case "cancelled": // собес отменён
      return "❌";
    case "invited": // приглашён, ожидание
    default:
      return "🕒";
  }
}

// Человеческие названия статусов для фильтра
const STATUS_LABELS = {
  invited: "🕒 приглашены на собеседование",
  interviewed: "✔️ пришли на собеседование, ожидают решения",
  internship_invited: "☑️ приглашены на стажировку",
  cancelled: "❌ отменённые",
};

// Показ списка кандидатов с учётом фильтров
async function showCandidatesList(ctx) {
  const tgId = ctx.from.id;
  const state = getInterviewViewState(tgId) || {};

  const statusFilter = state.statusFilter || null; // invited | interviewed | internship_invited | cancelled | null
  const personalOnly = state.personalOnly !== false; // по умолчанию true
  const filterOpen = !!state.filterOpen;
  const extraOpen = !!state.extraOpen;

  const params = [];
  let query = `
    SELECT c.id,
           c.name,
           c.age,
           c.status,
           c.interview_time,
           COALESCE(t.title, 'не указано') AS point_title,
           COALESCE(u.full_name, 'Без имени') AS admin_name
    FROM candidates c
    LEFT JOIN trade_points t ON c.point_id = t.id
    LEFT JOIN users u ON c.admin_id = u.id
    WHERE c.status != 'declined'
  `;

  // По умолчанию не показываем отменённые, но даём включить их отдельным фильтром
  if (!statusFilter || statusFilter !== "cancelled") {
    query += " AND c.status != 'cancelled'";
  }

  if (statusFilter) {
    params.push(statusFilter);
    query += ` AND c.status = $${params.length}`;
  }

  if (personalOnly && state.currentAdminId) {
    params.push(state.currentAdminId);
    query += ` AND c.admin_id = $${params.length}`;
  }

  // Сначала ожидание, затем "прошёл собес", затем "приглашён на стажировку".
  // Внутри группы — по времени собеседования (если есть), потом по id.
  query += `
    ORDER BY
      CASE c.status
        WHEN 'invited' THEN 1
        WHEN 'interviewed' THEN 2
        WHEN 'internship_invited' THEN 3
        WHEN 'cancelled' THEN 4
        ELSE 5
      END,
      COALESCE(c.interview_time, '99:99'),
      c.id DESC
  `;

  const res = await pool.query(query, params);
  const candidates = res.rows;

  // Заголовок
  let text = "🧑‍💻 Собеседования\n\n";

  text += "🕒 приглашены на собеседование\n";
  text += "✔️ пришли на собеседование, ожидают решения\n";
  text += "☑️ приглашены на стажировку\n\n";

  if (personalOnly) {
    text += "Показаны только твои кандидаты.\n";
  } else {
    text += "Показаны все кандидаты.\n";
  }

  if (statusFilter) {
    text += `Фильтр по статусу: ${
      STATUS_LABELS[statusFilter] || statusFilter
    }\n`;
  }

  text += "\n";

  if (!candidates.length) {
    text += "⚠️ Нет кандидатов по текущему фильтру.\n\n";
  } else {
    text += "Выбери кандидата:\n\n";
  }

  const buttons = [];

  candidates.forEach((cand) => {
    const icon = getStatusIcon(cand.status);
    let label;

    if (personalOnly) {
      // Формат: 🕒 Настя (22) - БХ2 на 18:00
      let main = cand.name || "Без имени";
      if (cand.age) {
        main += ` (${cand.age})`;
      }

      const tailParts = [];
      if (cand.point_title && cand.point_title !== "не указано") {
        tailParts.push(cand.point_title);
      }
      if (cand.interview_time) {
        tailParts.push(`на ${cand.interview_time}`);
      }

      const tail = tailParts.length ? ` - ${tailParts.join(" ")}` : "";
      label = `${icon} ${main}${tail}`;
    } else {
      // Общий список: показываем и "к кому"
      const infoParts = [];

      if (cand.age) {
        infoParts.push(`${cand.age}`);
      }
      if (cand.point_title && cand.point_title !== "не указано") {
        infoParts.push(cand.point_title);
      }
      if (cand.admin_name) {
        infoParts.push(`к "${cand.admin_name}"`);
      }

      const suffix = infoParts.length ? ` — ${infoParts.join(", ")}` : "";
      label = `${icon} ${cand.name}${suffix}`;
    }

    buttons.push([Markup.button.callback(label, `admin_candidate_${cand.id}`)]);
  });

  // --- строка "Фильтр | Раскрыть" ---
  const filterLabel = filterOpen ? "🔼 Фильтр 🔼" : "🔽 Фильтр 🔽";
  const expandLabel = extraOpen ? "🔼 скрыть 🔼" : "🔽 раскрыть 🔽";

  buttons.push([
    Markup.button.callback(filterLabel, "admin_interviews_toggle_filter"),
    Markup.button.callback(expandLabel, "admin_interviews_toggle_expand"),
  ]);

  // --- Блок фильтров (если открыт) ---
  if (filterOpen) {
    // Статусные фильтры
    buttons.push([
      Markup.button.callback(
        "❌ отменённые",
        "admin_interviews_status_cancelled"
      ),
      Markup.button.callback(
        "✔️ пришёл на собес",
        "admin_interviews_status_interviewed"
      ),
    ]);
    buttons.push([
      Markup.button.callback(
        "☑️ приглашены (стаж)",
        "admin_interviews_status_internship"
      ),
      Markup.button.callback("🕒 ожидание", "admin_interviews_status_invited"),
    ]);

    // Личные / все
    const personalLabel = personalOnly ? "👤 личные ✅" : "👤 личные";
    const allLabel = !personalOnly
      ? "👥 все собеседования ✅"
      : "👥 все собеседования";

    buttons.push([
      Markup.button.callback(personalLabel, "admin_interviews_personal"),
      Markup.button.callback(allLabel, "admin_interviews_all"),
    ]);

    // Сброс фильтра
    buttons.push([
      Markup.button.callback(
        "🔄 снять фильтр",
        "admin_interviews_clear_filters"
      ),
    ]);
  }

  // --- Блок "Раскрыть" (если открыт) ---
  if (extraOpen) {
    buttons.push([
      Markup.button.callback(
        "📜 история кандидатов",
        "admin_interviews_history"
      ),
    ]);
  }

  // Остальные кнопки
  buttons.push([
    Markup.button.callback("➕ Новый кандидат", "admin_new_candidate"),
  ]);

  buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

function registerInterviewList(bot, ensureUser, logError) {
  // Вход в раздел "Собеседования"
  bot.action("admin_interviews", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      clearCandidateCreateState(ctx.from.id);
      clearCandidateEditState(ctx.from.id);
      clearInterviewViewState(ctx.from.id);

      // По умолчанию: личные собеседования этого админа, без статус-фильтра
      setInterviewViewState(ctx.from.id, {
        currentAdminId: user.id,
        personalOnly: true,
        statusFilter: null,
        filterOpen: false,
        extraOpen: false,
      });

      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews", err);
    }
  });

  // Переключатель "Фильтр"
  bot.action("admin_interviews_toggle_filter", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const state = getInterviewViewState(ctx.from.id) || {};
      const newFilterOpen = !state.filterOpen;

      setInterviewViewState(ctx.from.id, {
        filterOpen: newFilterOpen,
        // если открываем фильтр — можно автоматически свернуть "раскрыть"
        extraOpen: newFilterOpen ? false : state.extraOpen,
      });

      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_toggle_filter", err);
    }
  });

  // Переключатель "Раскрыть"
  bot.action("admin_interviews_toggle_expand", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const state = getInterviewViewState(ctx.from.id) || {};
      const newExtraOpen = !state.extraOpen;

      setInterviewViewState(ctx.from.id, {
        extraOpen: newExtraOpen,
        // если раскрываем "ещё" — можем свернуть фильтр
        filterOpen: newExtraOpen ? false : state.filterOpen,
      });

      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_toggle_expand", err);
    }
  });

  // Фильтры по статусу
  bot.action("admin_interviews_status_cancelled", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      setInterviewViewState(ctx.from.id, { statusFilter: "cancelled" });
      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_status_cancelled", err);
    }
  });

  bot.action("admin_interviews_status_interviewed", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      setInterviewViewState(ctx.from.id, { statusFilter: "interviewed" });
      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_status_interviewed", err);
    }
  });

  bot.action("admin_interviews_status_internship", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      setInterviewViewState(ctx.from.id, {
        statusFilter: "internship_invited",
      });
      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_status_internship", err);
    }
  });

  bot.action("admin_interviews_status_invited", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      setInterviewViewState(ctx.from.id, { statusFilter: "invited" });
      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_status_invited", err);
    }
  });

  // Личные / все
  bot.action("admin_interviews_personal", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      setInterviewViewState(ctx.from.id, {
        personalOnly: true,
        currentAdminId: user.id,
      });
      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_personal", err);
    }
  });

  bot.action("admin_interviews_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      setInterviewViewState(ctx.from.id, {
        personalOnly: false,
      });
      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_all", err);
    }
  });

  // Сброс фильтров
  bot.action("admin_interviews_clear_filters", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const state = getInterviewViewState(ctx.from.id) || {};

      setInterviewViewState(ctx.from.id, {
        statusFilter: null,
        personalOnly: true,
        currentAdminId: user.id,
        filterOpen: state.filterOpen,
      });

      await showCandidatesList(ctx);
    } catch (err) {
      logError("admin_interviews_clear_filters", err);
    }
  });
}

module.exports = { registerInterviewList, showCandidatesList };
