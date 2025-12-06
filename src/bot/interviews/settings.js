// src/bot/interviews/settings.js

const pool = require("../../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");
const { setCandidateEditState } = require("./state");
const { showCandidateCard } = require("./card");

function registerInterviewSettings(bot, ensureUser, logError) {
  // Открыть меню редактирования полей кандидата (нажатие ⚙️ на карточке)
  bot.action(/^admin_candidate_edit_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      const candId = parseInt(ctx.match[1], 10);
      // Клавиатура: список полей для изменения

      const buttons = [
        [
          Markup.button.callback("Имя", `admin_candidate_edit_name_${candId}`),
          Markup.button.callback(
            "Возраст",
            `admin_candidate_edit_age_${candId}`
          ),
        ],
        [
          Markup.button.callback(
            "Телефон",
            `admin_candidate_edit_phone_${candId}`
          ),
          // Место собеседования (point_id)
          Markup.button.callback("Место", `admin_candidate_point_${candId}`),
        ],
        [
          // Отдельно желаемая точка (desired_point_id)
          Markup.button.callback(
            "Жел. точка",
            `admin_candidate_desired_point_${candId}`
          ),
          Markup.button.callback(
            "Зарплата",
            `admin_candidate_edit_salary_${candId}`
          ),
        ],
        [
          Markup.button.callback(
            "График",
            `admin_candidate_edit_schedule_${candId}`
          ),
          Markup.button.callback(
            "Анкета",
            `admin_candidate_edit_questionnaire_${candId}`
          ),
        ],
        [Markup.button.callback("Админ", `admin_candidate_admin_${candId}`)],
        [Markup.button.callback("🔙 Назад", `admin_candidate_${candId}`)],
      ];

      await deliver(
        ctx,
        {
          text: "⚙️ Изменить данные кандидата:\nВыбери поле для редактирования:",
          extra: Markup.inlineKeyboard(buttons),
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_edit_menu", err);
    }
  });

  // Начать редактирование текстового поля (имя, возраст, телефон, зарплата, график, анкета)
  bot.action(
    /^admin_candidate_edit_(name|age|phone|salary|schedule|questionnaire)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const admin = await ensureUser(ctx);
        if (!admin || admin.role !== "admin") return;
        const field = ctx.match[1]; // какое поле редактируется
        const candId = parseInt(ctx.match[2], 10);
        // Устанавливаем состояние редактирования и запрашиваем новое значение у админа
        setCandidateEditState(ctx.from.id, { candidateId: candId, field });
        let promptText = "";
        if (field === "name") promptText = "✏️ Введи новое имя кандидата:";
        if (field === "age")
          promptText = "✏️ Введи новый возраст кандидата (числом):";
        if (field === "phone") promptText = "✏️ Введи новый телефон кандидата:";
        if (field === "salary")
          promptText = "✏️ Введи новую желаемую зарплату кандидата:";
        if (field === "schedule")
          promptText = "✏️ Введи новый желаемый график работы:";
        if (field === "questionnaire")
          promptText =
            "✏️ Введи новое резюме кандидата (краткий опыт и т.п.).\n" +
            "Если резюме не нужно — напиши «не указано».";
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Отмена", `admin_candidate_${candId}`)],
        ]);
        await deliver(
          ctx,
          { text: promptText, extra: keyboard },
          { edit: true }
        );
      } catch (err) {
        logError("admin_candidate_edit_field", err);
      }
    }
  );

  // Выбор новой торговой точки для кандидата
  bot.action(/^admin_candidate_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      const candId = parseInt(ctx.match[1], 10);
      const res = await pool.query(
        "SELECT id, title FROM trade_points WHERE is_active = TRUE ORDER BY id"
      );
      if (!res.rows.length) {
        await ctx.reply("Список торговых точек пуст.");
        return;
      }
      const pointButtons = res.rows.map((row) => [
        Markup.button.callback(
          row.title,
          `admin_candidate_point_${candId}_${row.id}`
        ),
      ]);
      pointButtons.push([
        Markup.button.callback("🔙 Отмена", `admin_candidate_${candId}`),
      ]);
      await deliver(
        ctx,
        {
          text: "🏬 Выбери новую торговую точку для кандидата:",
          extra: Markup.inlineKeyboard(pointButtons),
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_point_select_menu", err);
    }
  });

  // Обработка выбора новой точки (обновление в БД)
  bot.action(/^admin_candidate_point_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Обновлено").catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      const candId = parseInt(ctx.match[1], 10);
      const newPointId = parseInt(ctx.match[2], 10);
      await pool.query("UPDATE candidates SET point_id = $1 WHERE id = $2", [
        newPointId,
        candId,
      ]);
      await showCandidateCard(ctx, candId); // показываем карточку с обновлёнными данными
    } catch (err) {
      logError("admin_candidate_point_update", err);
      await ctx.reply("Не удалось изменить торговую точку кандидата.");
    }
  });

  // Обработка выбора новой точки (обновление в БД)
  bot.action(/^admin_candidate_point_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Обновлено").catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      const candId = parseInt(ctx.match[1], 10);
      const newPointId = parseInt(ctx.match[2], 10);
      await pool.query("UPDATE candidates SET point_id = $1 WHERE id = $2", [
        newPointId,
        candId,
      ]);
      await showCandidateCard(ctx, candId); // показываем карточку с обновлёнными данными
    } catch (err) {
      logError("admin_candidate_point_update", err);
      await ctx.reply("Не удалось изменить торговую точку кандидата.");
    }
  });

  // Выбор нового администратора для кандидата
  bot.action(/^admin_candidate_admin_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      const candId = parseInt(ctx.match[1], 10);
      const res = await pool.query(
        "SELECT id, full_name FROM users WHERE role = 'admin' ORDER BY full_name"
      );
      const adminButtons = res.rows.map((row) => [
        Markup.button.callback(
          row.full_name || "Без имени",
          `admin_candidate_admin_${candId}_${row.id}`
        ),
      ]);
      adminButtons.push([
        Markup.button.callback("🔙 Отмена", `admin_candidate_${candId}`),
      ]);
      await deliver(
        ctx,
        {
          text: "👤 Выбери нового администратора для кандидата:",
          extra: Markup.inlineKeyboard(adminButtons),
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_candidate_admin_select_menu", err);
    }
  });

  // Обработка выбора нового администратора (обновление admin_id в БД)
  bot.action(/^admin_candidate_admin_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Обновлено").catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      const candId = parseInt(ctx.match[1], 10);
      const newAdminId = parseInt(ctx.match[2], 10);
      await pool.query("UPDATE candidates SET admin_id = $1 WHERE id = $2", [
        newAdminId,
        candId,
      ]);
      await showCandidateCard(ctx, candId);
    } catch (err) {
      logError("admin_candidate_admin_update", err);
      await ctx.reply("Не удалось изменить администратора кандидата.");
    }
  });
}

module.exports = { registerInterviewSettings };
