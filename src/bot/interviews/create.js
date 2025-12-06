// src/bot/interviews/create.js

const pool = require("../../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");
const {
  setCandidateCreateState,
  getCandidateCreateState,
  clearCandidateCreateState,
} = require("./state");

/**
 * Построить клавиатуру для шага "зарплата"
 */
function buildSalaryKeyboard(state) {
  const period = state?.data?.salaryPeriod || "month";

  const monthActive = period === "month";
  const dayActive = period === "day";

  const monthLabel = monthActive ? "✅ в месяц" : "в месяц";
  const dayLabel = dayActive ? "✅ в день" : "в день";

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(monthLabel, "candidate_salary_period_month"),
      Markup.button.callback(dayLabel, "candidate_salary_period_day"),
    ],
    [Markup.button.callback("ℹ️ Не указано", "candidate_salary_not_specified")],
    [Markup.button.callback("🔙 Отмена", "admin_interviews")],
  ]);
}

/**
 * Показ шага "Желаемая ЗП"
 */
async function showSalaryStep(ctx, tgId) {
  const state = getCandidateCreateState(tgId);
  if (!state) return;

  const keyboard = buildSalaryKeyboard(state);

  const text =
    "💰 Укажи желаемую зарплату кандидата.\n\n" +
    "Отправь сумму одним сообщением, например: 60000";

  await deliver(
    ctx,
    {
      text,
      extra: keyboard,
    },
    { edit: true }
  );
}

function registerInterviewCreate(bot, ensureUser, logError) {
  /**
   * Старт сценария: "➕ Новый кандидат"
   */
  bot.action("admin_new_candidate", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;

      setCandidateCreateState(tgId, {
        step: "await_name",
        data: {},
      });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text: "👤 Введи имя кандидата одним сообщением:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_new_candidate", err);
    }
  });

  /**
   * Выбор торговой точки (после телефона)
   */
  /**
   * Выбор места собеседования (после телефона)
   */
  bot.action(/^candidate_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state) return;

      const pointId = parseInt(ctx.match[1], 10);

      // Сохраняем место собеседования
      state.data.pointId = pointId;

      // По умолчанию желаемая точка совпадает с местом
      if (!state.data.desiredPointId) {
        state.data.desiredPointId = pointId;
      }

      // Переходим к выбору желаемой точки
      state.step = "await_desired_point";
      setCandidateCreateState(tgId, state);

      const res = await pool.query(
        "SELECT id, title FROM trade_points WHERE is_active = TRUE ORDER BY id"
      );
      if (!res.rows.length) {
        await ctx.reply(
          "Нет доступных торговых точек. Добавь точку в настройках и попробуй снова."
        );
        clearCandidateCreateState(tgId);
        return;
      }

      const buttons = res.rows.map((row) => [
        Markup.button.callback(row.title, `candidate_desired_point_${row.id}`),
      ]);
      buttons.push([
        Markup.button.callback(
          "ℹ️ не указано",
          "candidate_desired_point_not_specified"
        ),
      ]);
      buttons.push([Markup.button.callback("🔙 Отмена", "admin_interviews")]);

      await deliver(
        ctx,
        {
          text:
            "📌 Выберите желаемую точку для кандидата.\n" +
            "Если желаемая точка не указана — нажмите «ℹ️ не указано».",
          extra: Markup.inlineKeyboard(buttons),
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_point_select", err);
    }
  });

  /**
   * Выбор желаемой точки
   */
  bot.action(/^candidate_desired_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state) return;

      const desiredPointId = parseInt(ctx.match[1], 10);
      state.data.desiredPointId = desiredPointId;

      // по умолчанию считаем, что зарплата "в месяц"
      if (!state.data.salaryPeriod) {
        state.data.salaryPeriod = "month";
      }
      state.step = "await_salary";
      setCandidateCreateState(tgId, state);

      await showSalaryStep(ctx, tgId);
    } catch (err) {
      logError("candidate_desired_point_select", err);
    }
  });

  /**
   * Кнопка "ℹ️ не указано" для желаемой точки
   */
  bot.action("candidate_desired_point_not_specified", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state) return;

      state.data.desiredPointId = null;

      if (!state.data.salaryPeriod) {
        state.data.salaryPeriod = "month";
      }
      state.step = "await_salary";
      setCandidateCreateState(tgId, state);

      await showSalaryStep(ctx, tgId);
    } catch (err) {
      logError("candidate_desired_point_not_specified", err);
    }
  });

  /**
   * Переключатель периода "в месяц"
   */
  bot.action("candidate_salary_period_month", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_salary") return;

      state.data.salaryPeriod = "month";
      setCandidateCreateState(tgId, state);

      await showSalaryStep(ctx, tgId);
    } catch (err) {
      logError("candidate_salary_period_month", err);
    }
  });

  /**
   * Переключатель периода "в день"
   */
  bot.action("candidate_salary_period_day", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_salary") return;

      state.data.salaryPeriod = "day";
      setCandidateCreateState(tgId, state);

      await showSalaryStep(ctx, tgId);
    } catch (err) {
      logError("candidate_salary_period_day", err);
    }
  });

  /**
   * Кнопка "Не указано" на шаге зарплаты
   */
  bot.action("candidate_salary_not_specified", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state) return;

      state.data.salary = null;
      state.step = "await_schedule";
      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "⌛ Введи желаемый график работы кандидата (например, 2/2, 3/3, 5/2).\n\n" +
            "Если не хочешь указывать — напиши «не указано».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_salary_not_specified", err);
    }
  });

  /**
   * Если админ вдруг захочет полностью отменить сценарий из другого места,
   * можно будет вызвать clearCandidateCreateState(tgId).
   */
}

module.exports = { registerInterviewCreate };
