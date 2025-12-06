// src/bot/interviews/history.js

const pool = require("../../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");

// Этап, на котором кандидат выбыл, -> иконка
function getStageIcon(stage) {
  switch (stage) {
    case "interviewed":
      return "✔️";
    case "internship_invited":
      return "☑️";
    case "invited":
    default:
      return "🕒";
  }
}

function formatShortDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
  });
}

async function showDeletedCandidates(ctx, stageFilter) {
  const params = [];
  let query = `
    SELECT
      c.id,
      c.name,
      c.age,
      c.declined_at,
      c.closed_from_status
    FROM candidates c
    WHERE c.status IN ('declined', 'cancelled')
      AND c.is_deferred = FALSE
  `;

  if (stageFilter) {
    params.push(stageFilter);
    query += ` AND c.closed_from_status = $${params.length}`;
  }

  query += " ORDER BY c.declined_at DESC NULLS LAST, c.id DESC";

  const res = await pool.query(query, params);
  const candidates = res.rows;

  let text = "❌ Кандидаты на удалении\n\n";
  text +=
    "Эти кандидаты находятся в списке на удаление и будут автоматически удалены через 30 дней после отказа или отмены.\n\n";
  text +=
    "Фильтры по этапу, на котором кандидат выбыл:\n" +
    "✔️ — после собеседования\n" +
    "☑️ — после приглашения на стажировку\n" +
    "🕒 — до собеседования\n" +
    "🔄 — снять фильтр\n\n";

  if (!candidates.length) {
    text += "ℹ️ Пока нет кандидатов на удалении.";
  } else {
    text += `Найдено: ${candidates.length}\n\nВыбери кандидата:\n`;
  }

  const buttons = [];

  for (const cand of candidates) {
    const stageIcon = getStageIcon(cand.closed_from_status);
    let label = `${stageIcon} ${cand.name || "Без имени"}`;
    if (cand.age) label += ` (${cand.age})`;
    const dateLabel = formatShortDate(cand.declined_at);
    label += ` - ${dateLabel}`;

    buttons.push([Markup.button.callback(label, `admin_candidate_${cand.id}`)]);
  }

  // строка фильтров
  buttons.push([
    Markup.button.callback("✔️", "admin_archive_deleted_stage_interviewed"),
    Markup.button.callback("☑️", "admin_archive_deleted_stage_internship"),
    Markup.button.callback("🕒", "admin_archive_deleted_stage_invited"),
    Markup.button.callback("🔄", "admin_archive_deleted_stage_all"),
  ]);

  // навигация
  buttons.push([
    Markup.button.callback(
      "🔙 Назад к выбору раздела",
      "admin_interviews_history"
    ),
  ]);
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

async function showDeferredCandidates(ctx, stageFilter) {
  const params = [];
  let query = `
    SELECT
      c.id,
      c.name,
      c.age,
      c.declined_at,
      c.closed_from_status
    FROM candidates c
    WHERE c.status IN ('declined', 'cancelled')
      AND c.is_deferred = TRUE
  `;

  if (stageFilter) {
    params.push(stageFilter);
    query += ` AND c.closed_from_status = $${params.length}`;
  }

  query += " ORDER BY c.declined_at DESC NULLS LAST, c.id DESC";

  const res = await pool.query(query, params);
  const candidates = res.rows;

  let text = "🗑️ Отложенные кандидаты\n\n";
  text +=
    "Такие кандидаты сохранены, чтобы к ним можно было вернуться позже. Они не удаляются автоматически.\n\n";
  text +=
    "Фильтры по этапу, на котором кандидат выбыл:\n" +
    "✔️ — после собеседования\n" +
    "☑️ — после приглашения на стажировку\n" +
    "🕒 — до собеседования\n" +
    "🔄 — снять фильтр\n\n";

  if (!candidates.length) {
    text += "ℹ️ Пока нет отложенных кандидатов.";
  } else {
    text += `Найдено: ${candidates.length}\n\nВыбери кандидата:\n`;
  }

  const buttons = [];

  for (const cand of candidates) {
    const stageIcon = getStageIcon(cand.closed_from_status);
    let label = `${stageIcon} ${cand.name || "Без имени"}`;
    if (cand.age) label += ` (${cand.age})`;
    const dateLabel = formatShortDate(cand.declined_at);
    label += ` - ${dateLabel}`;

    buttons.push([Markup.button.callback(label, `admin_candidate_${cand.id}`)]);
  }

  // строка фильтров
  buttons.push([
    Markup.button.callback("✔️", "admin_archive_deferred_stage_interviewed"),
    Markup.button.callback("☑️", "admin_archive_deferred_stage_internship"),
    Markup.button.callback("🕒", "admin_archive_deferred_stage_invited"),
    Markup.button.callback("🔄", "admin_archive_deferred_stage_all"),
  ]);

  // навигация
  buttons.push([
    Markup.button.callback(
      "🔙 Назад к выбору раздела",
      "admin_interviews_history"
    ),
  ]);
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

function registerInterviewHistory(bot, ensureUser, logError) {
  // Главное меню истории
  bot.action("admin_interviews_history", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const buttons = [
        [
          Markup.button.callback(
            "❌ Кандидаты на удалении",
            "admin_archive_deleted"
          ),
        ],
        [
          Markup.button.callback(
            "🗑️ Отложенные кандидаты",
            "admin_archive_deferred"
          ),
        ],
        [Markup.button.callback("🔙 К собеседованиям", "admin_interviews")],
        [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
      ];

      await deliver(
        ctx,
        {
          text:
            "📜 История кандидатов\n\n" +
            "Выбери раздел:\n" +
            "1) ❌ Кандидаты на удалении — будут удалены через 30 дней после отказа или отмены.\n" +
            "2) 🗑️ Отложенные кандидаты — остаются в базе без автоудаления.",
          extra: Markup.inlineKeyboard(buttons),
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_interviews_history", err);
    }
  });

  // Кандидаты на удалении
  bot.action("admin_archive_deleted", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeletedCandidates(ctx, null);
    } catch (err) {
      logError("admin_archive_deleted", err);
    }
  });

  // Отложенные
  bot.action("admin_archive_deferred", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeferredCandidates(ctx, null);
    } catch (err) {
      logError("admin_archive_deferred", err);
    }
  });

  // Фильтры для "на удалении"
  bot.action("admin_archive_deleted_stage_interviewed", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeletedCandidates(ctx, "interviewed");
    } catch (err) {
      logError("admin_archive_deleted_stage_interviewed", err);
    }
  });

  bot.action("admin_archive_deleted_stage_internship", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeletedCandidates(ctx, "internship_invited");
    } catch (err) {
      logError("admin_archive_deleted_stage_internship", err);
    }
  });

  bot.action("admin_archive_deleted_stage_invited", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeletedCandidates(ctx, "invited");
    } catch (err) {
      logError("admin_archive_deleted_stage_invited", err);
    }
  });

  bot.action("admin_archive_deleted_stage_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeletedCandidates(ctx, null);
    } catch (err) {
      logError("admin_archive_deleted_stage_all", err);
    }
  });

  // Фильтры для "отложенные"
  bot.action("admin_archive_deferred_stage_interviewed", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeferredCandidates(ctx, "interviewed");
    } catch (err) {
      logError("admin_archive_deferred_stage_interviewed", err);
    }
  });

  bot.action("admin_archive_deferred_stage_internship", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeferredCandidates(ctx, "internship_invited");
    } catch (err) {
      logError("admin_archive_deferred_stage_internship", err);
    }
  });

  bot.action("admin_archive_deferred_stage_invited", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeferredCandidates(ctx, "invited");
    } catch (err) {
      logError("admin_archive_deferred_stage_invited", err);
    }
  });

  bot.action("admin_archive_deferred_stage_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      await showDeferredCandidates(ctx, null);
    } catch (err) {
      logError("admin_archive_deferred_stage_all", err);
    }
  });
}

module.exports = { registerInterviewHistory };
