// src/bot/interviews/index.js

const pool = require("../../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");

const { registerInterviewCreate } = require("./create");
const { registerInterviewList, showCandidatesList } = require("./list");
const { registerInterviewCard } = require("./card");
const { registerInterviewSettings } = require("./settings");
const { registerInterviewHistory } = require("./history");

const {
  getCandidateCreateState,
  setCandidateCreateState,
  clearCandidateCreateState,

  getCandidateEditState,
  setCandidateEditState,
  clearCandidateEditState,

  getInterviewViewState,
  setInterviewViewState,
  clearInterviewViewState,

  getInterviewResultState,
  setInterviewResultState,
  clearInterviewResultState,

  getDeclineReasonState,
  setDeclineReasonState,
  clearDeclineReasonState,
} = require("./state");

/**
 * Регистрация модуля "Собеседования"
 */
function registerInterviewModule(bot, ensureUser, logError, showMainMenu) {
  // подключаем подмодули
  registerInterviewCreate(bot, ensureUser, logError);
  registerInterviewList(bot, ensureUser, logError);
  registerInterviewCard(bot, ensureUser, logError);
  registerInterviewSettings(bot, ensureUser, logError);
  registerInterviewHistory(bot, ensureUser, logError);

  // Кнопка "ℹ️ не указано" для возраста кандидата
  bot.action("candidate_age_not_specified", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_age") return;

      state.data.age = null;
      state.step = "await_phone";
      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text: "📞 Введи контактный телефон кандидата:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_age_not_specified", err);
    }
  });

  // Дата собеседования: "сегодня"
  bot.action("candidate_date_today", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_date") return;

      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");

      state.data.interviewDate = `${yyyy}-${mm}-${dd}`;
      state.step = "await_time";
      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "⏰ Укажите время собеседования в формате ЧЧ:ММ (например, 12:30).\n" +
            "Если точное время пока неизвестно — напишите «не указано».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_date_today", err);
    }
  });

  // Дата собеседования: "завтра"
  bot.action("candidate_date_tomorrow", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_date") return;

      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      state.data.interviewDate = `${yyyy}-${mm}-${dd}`;

      state.step = "await_time";
      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "⏰ Укажите время собеседования в формате ЧЧ:ММ (например, 12:30).\n" +
            "Если точное время пока неизвестно — напишите «не указано».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_date_tomorrow", err);
    }
  });

  // Выбор ответственного администратора и создание кандидата в БД
  bot.action(/^candidate_admin_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_admin") {
        return;
      }

      const selectedAdminId = parseInt(ctx.match[1], 10);
      const data = state.data || {};

      const name = data.name || "Без имени";
      const age = data.age || null;
      const phone = data.phone || null;
      const pointId = data.pointId || null;
      const desiredPointId = data.desiredPointId || null;
      const salary = data.salary || null;
      const schedule = data.schedule || null;
      const questionnaire = data.questionnaire || null;
      const interviewDate = data.interviewDate || null; // <-- добавили
      const interviewTime = data.interviewTime || null;
      const comment = data.comment || null;

      if (!phone) {
        await ctx.reply(
          "Не удалось сохранить кандидата: не указан телефон. Попробуйте начать заново."
        );
        clearCandidateCreateState(tgId);
        return;
      }

      const insertRes = await pool.query(
        `
        INSERT INTO candidates
          (name, age, phone, point_id, desired_point_id, admin_id, status,
           salary, schedule, questionnaire, interview_date, interview_time, comment)
        VALUES
          ($1,   $2,  $3,   $4,      $5,             $6,      $7,
           $8,     $9,      $10,           $11,           $12,          $13)
        RETURNING id
        `,
        [
          name,
          age,
          phone,
          pointId,
          desiredPointId,
          selectedAdminId,
          "invited",
          salary,
          schedule,
          questionnaire,
          interviewDate,
          interviewTime,
          comment,
        ]
      );

      const candidateId = insertRes.rows[0]?.id;

      // очищаем состояние создания
      clearCandidateCreateState(tgId);

      if (!candidateId) {
        await ctx.reply(
          "Кандидат не был сохранён из-за внутренней ошибки. Попробуйте ещё раз позже."
        );
        return;
      }

      // показываем карточку созданного кандидата
      const { showCandidateCard } = require("./card");
      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("candidate_admin_create_candidate", err);
      await ctx.reply(
        "Произошла ошибка при сохранении кандидата. Попробуйте ещё раз позже."
      );
    }
  });

  // Создание кандидата без назначенного администратора ("назначу позже")
  bot.action("candidate_admin_later", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_admin") {
        return;
      }

      const data = state.data || {};

      const name = data.name || "Без имени";
      const age = data.age || null;
      const phone = data.phone || null;
      const pointId = data.pointId || null;
      const desiredPointId = data.desiredPointId || null;
      const salary = data.salary || null;
      const schedule = data.schedule || null;
      const questionnaire = data.questionnaire || null;
      const interviewDate = data.interviewDate || null;
      const interviewTime = data.interviewTime || null;
      const comment = data.comment || null;

      if (!phone) {
        await ctx.reply(
          "Не удалось сохранить кандидата: не указан телефон. Попробуйте начать заново."
        );
        clearCandidateCreateState(tgId);
        return;
      }

      const insertRes = await pool.query(
        `
        INSERT INTO candidates
          (name, age, phone, point_id, desired_point_id, admin_id, status,
           salary, schedule, questionnaire, interview_date, interview_time, comment)
        VALUES
          ($1,   $2,  $3,   $4,      $5,             $6,      $7,
           $8,     $9,      $10,           $11,           $12,          $13)
        RETURNING id
        `,
        [
          name,
          age,
          phone,
          pointId,
          desiredPointId,
          null, // 🔹 администратор не назначен
          "invited",
          salary,
          schedule,
          questionnaire,
          interviewDate,
          interviewTime,
          comment,
        ]
      );

      const candidateId = insertRes.rows[0]?.id;

      clearCandidateCreateState(tgId);

      if (!candidateId) {
        await ctx.reply(
          "Кандидат не был сохранён из-за внутренней ошибки. Попробуйте ещё раз позже."
        );
        return;
      }

      const { showCandidateCard } = require("./card");
      await showCandidateCard(ctx, candidateId);
    } catch (err) {
      logError("candidate_admin_later_create_candidate", err);
      await ctx.reply(
        "Произошла ошибка при сохранении кандидата. Попробуйте ещё раз позже."
      );
    }
  });

  /**
   * Команда /interview — быстрый вход в список собеседований
   * По умолчанию — ЛИЧНЫЕ кандидаты этого админа
   */

  // Быстрый выбор типового графика работы
  bot.action("candidate_schedule_2_2", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_schedule") return;

      state.data.schedule = "2/2";
      state.step = "await_questionnaire";

      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "ℹ️ не указано",
            "candidate_questionnaire_not_specified"
          ),
        ],
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "📝 Отправьте краткое резюме кандидата (прошлый опыт и т.д.).\n" +
            "Если резюме нет — нажмите «ℹ️ не указано».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_schedule_2_2", err);
    }
  });

  bot.action("candidate_schedule_3_3", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_schedule") return;

      state.data.schedule = "3/3";
      state.step = "await_questionnaire";

      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "ℹ️ не указано",
            "candidate_questionnaire_not_specified"
          ),
        ],
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "📝 Отправьте краткое резюме кандидата (прошлый опыт и т.д.).\n" +
            "Если резюме нет — нажмите «ℹ️ не указано».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_schedule_3_3", err);
    }
  });

  bot.action("candidate_schedule_5_2", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_schedule") return;

      state.data.schedule = "5/2";
      state.step = "await_questionnaire";

      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "ℹ️ не указано",
            "candidate_questionnaire_not_specified"
          ),
        ],
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "📝 Отправьте краткое резюме кандидата (прошлый опыт и т.д.).\n" +
            "Если резюме нет — нажмите «ℹ️ не указано».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_schedule_5_2", err);
    }
  });

  bot.action("candidate_schedule_not_specified", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_schedule") return;

      state.data.schedule = null;
      state.step = "await_questionnaire";

      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "ℹ️ не указано",
            "candidate_questionnaire_not_specified"
          ),
        ],
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "📝 Отправьте краткое резюме кандидата (прошлый опыт и т.д.).\n" +
            "Если резюме нет — нажмите «ℹ️ не указано».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_schedule_not_specified", err);
    }
  });

  // Быстрый выбор "резюме не указано"
  bot.action("candidate_questionnaire_not_specified", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      const tgId = ctx.from.id;
      const state = getCandidateCreateState(tgId);
      if (!state || state.step !== "await_questionnaire") return;

      // Анкета не указана
      state.data.questionnaire = null;
      // Переходим на шаг комментария, как и при текстовом вводе
      state.step = "await_comment";

      setCandidateCreateState(tgId, state);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Отмена", "admin_interviews")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "💬 Напишите комментарий по кандидату (например, от кого рекомендация).\n" +
            "Если комментария нет — введите «—».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("candidate_questionnaire_not_specified", err);
    }
  });

  bot.command("interview", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") {
        return ctx.reply("У тебя нет прав доступа к собеседованиям.");
      }

      setInterviewViewState(ctx.from.id, {
        adminId: user.id,
        pointId: null,
      });

      await showCandidatesList(ctx);
    } catch (err) {
      logError("/interview", err);
      await ctx.reply("Ошибка при открытии списка собеседований.");
    }
  });

  /**
   * Глобальный обработчик text для шагов:
   * - создание кандидата
   * - редактирование кандидата
   *
   * Если state не наш — пробрасываем дальше через next()
   */
  bot.on("text", async (ctx, next) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return next();

      const tgId = ctx.from.id;
      const text = (ctx.message.text || "").trim(); // <-- ОДИН раз
      if (!text) return next();

      const declineState = getDeclineReasonState(tgId);
      const interviewState = getInterviewResultState(tgId);
      const createState = getCandidateCreateState(tgId);
      const editState = getCandidateEditState(tgId);

      // ----- 1) Свободный ввод причины отказа/отмены -----
      if (declineState) {
        const { candidateId, mode } = declineState;
        if (!candidateId) {
          clearDeclineReasonState(tgId);
          return next();
        }

        const newStatus = mode === "cancel" ? "cancelled" : "declined";
        const reasonText = text;

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

        clearDeclineReasonState(tgId);

        const { showCandidateCard } = require("./card");
        await showCandidateCard(ctx, candidateId);
        return;
      }

      /** ---------- ОПРОС ПО РЕЗУЛЬТАТУ СОБЕСЕДОВАНИЯ ---------- */

      if (interviewState) {
        const step = interviewState.step;

        // Шаг: ввод минут опоздания
        if (step === "late_minutes") {
          const minutes = parseInt(text, 10);
          if (!Number.isFinite(minutes) || minutes < 0 || minutes > 600) {
            await ctx.reply(
              "Нужно ввести количество минут опоздания числом (от 0 до 600). Попробуй ещё раз."
            );
            return;
          }

          interviewState.lateMinutes = minutes;
          interviewState.wasOnTime = false;
          interviewState.step = "comment";
          setInterviewResultState(tgId, interviewState);

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "ℹ️ замечаний нет",
                `admin_candidate_no_notes_${interviewState.candidateId}`
              ),
            ],
            [
              Markup.button.callback(
                "🔙 Назад к кандидату",
                `admin_candidate_${interviewState.candidateId}`
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
          return;
        }

        // Шаг: ввод замечаний текстом
        if (step === "comment") {
          const lower = text.toLowerCase();
          let comment = text;
          if (
            lower === "нет" ||
            lower.startsWith("не указ") ||
            lower.includes("замечаний нет") ||
            text === "—" ||
            text === "-"
          ) {
            comment = null;
          }

          const candidateId = interviewState.candidateId;
          const wasOnTime = interviewState.wasOnTime === false ? false : true;
          const lateMinutes =
            typeof interviewState.lateMinutes === "number"
              ? interviewState.lateMinutes
              : null;

          await pool.query(
            `
          UPDATE candidates
          SET status = 'interviewed',
              was_on_time = $2,
              late_minutes = $3,
              interview_comment = $4
          WHERE id = $1
          `,
            [candidateId, wasOnTime, lateMinutes, comment]
          );

          clearInterviewResultState(tgId);
          const { showCandidateCard } = require("./card");
          await showCandidateCard(ctx, candidateId);
          return;
        }
      }

      /** ---------- СОЗДАНИЕ КАНДИДАТА ---------- */

      if (createState) {
        const step = createState.step;

        // 1) Имя
        if (step === "await_name") {
          createState.data.name = text;
          createState.step = "await_age";

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "ℹ️ не указано",
                "candidate_age_not_specified"
              ),
            ],
            [Markup.button.callback("🔙 Отмена", "admin_interviews")],
          ]);

          await deliver(
            ctx,
            {
              text:
                "🎂 Укажите возраст кандидата числом.\n" +
                "Если возраст неизвестен — нажмите «ℹ️ не указано».",
              extra: keyboard,
            },
            { edit: true }
          );
          return;
        }

        // 2) Возраст
        if (step === "await_age") {
          const ageNum = parseInt(text, 10);
          if (isNaN(ageNum) || ageNum <= 0) {
            await ctx.reply(
              "Возраст должен быть положительным числом. Попробуй ещё раз."
            );
            return;
          }

          createState.data.age = ageNum;
          createState.step = "await_phone";

          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Отмена", "admin_interviews")],
          ]);

          await deliver(
            ctx,
            {
              text: "📞 Введи контактный телефон кандидата:",
              extra: keyboard,
            },
            { edit: true }
          );
          return;
        }

        // 3) Телефон
        if (step === "await_phone") {
          if (!text) {
            await ctx.reply(
              "Телефон не должен быть пустым. Введи номер или напиши 'нет'."
            );
            return;
          }

          createState.data.phone = text;
          createState.step = "await_point";

          const res = await pool.query(
            "SELECT id, title FROM trade_points WHERE is_active = TRUE ORDER BY id"
          );
          if (!res.rows.length) {
            await ctx.reply(
              "Нет доступных торговых точек. Добавь точку в настройках и попробуй снова."
            );
            const { clearCandidateCreateState } = require("./state");
            clearCandidateCreateState(tgId);
            return;
          }

          const buttons = res.rows.map((row) => [
            Markup.button.callback(row.title, `candidate_point_${row.id}`),
          ]);
          buttons.push([
            Markup.button.callback("🔙 Отмена", "admin_interviews"),
          ]);

          await deliver(
            ctx,
            {
              text: "📍 Выберите место собеседования (торговую точку):",
              extra: Markup.inlineKeyboard(buttons),
            },
            { edit: true }
          );
          return;
        }

        // 4) ждём выбор места собеседования кнопкой
        if (step === "await_point") {
          await ctx.reply("Выбери место собеседования из кнопок ниже.");
          return;
        }

        // 5) ждём выбор желаемой точки кнопкой
        if (step === "await_desired_point") {
          await ctx.reply("Выбери желаемую точку из кнопок ниже.");
          return;
        }

        // Шаг 5 — зарплата
        if (step === "await_salary") {
          // период, выбранный на клавиатуре: month | day
          const period = createState.data.salaryPeriod || "month";
          const lower = text.toLowerCase();

          // если админ вручную написал "не указано" / "нет" — трактуем как пустую ЗП
          if (lower === "нет" || lower.startsWith("не указ")) {
            createState.data.salary = null;
          } else {
            const suffix = period === "day" ? " в день" : " в месяц";
            createState.data.salary = `${text} ${suffix}`;
          }

          createState.step = "await_schedule";

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback("2/2", "candidate_schedule_2_2"),
              Markup.button.callback("3/3", "candidate_schedule_3_3"),
              Markup.button.callback("5/2", "candidate_schedule_5_2"),
            ],
            [
              Markup.button.callback(
                "ℹ️ не указано",
                "candidate_schedule_not_specified"
              ),
            ],
            [Markup.button.callback("🔙 Отмена", "admin_interviews")],
          ]);

          await deliver(
            ctx,
            {
              text:
                "⌛ Выберите желаемый график работы кандидата.\n\n" +
                "Если нет подходящего варианта — введите его текстом.\n" +
                "Если график не указан, нажмите «ℹ️ не указано».",
              extra: keyboard,
            },
            { edit: true }
          );
          return;
        }

        // 6) График
        if (step === "await_schedule") {
          const lower = text.toLowerCase();
          if (lower === "нет" || lower.startsWith("не указ")) {
            createState.data.schedule = null;
          } else {
            createState.data.schedule = text;
          }
          createState.step = "await_questionnaire";

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "ℹ️ не указано",
                "candidate_questionnaire_not_specified"
              ),
            ],
            [Markup.button.callback("🔙 Отмена", "admin_interviews")],
          ]);

          await deliver(
            ctx,
            {
              text:
                "📝 Отправьте краткое резюме кандидата (прошлый опыт и т.д.).\n" +
                "Если резюме нет — нажмите «ℹ️ не указано».",
              extra: keyboard,
            },
            { edit: true }
          );
          return;
        }

        // 7) Анкета / резюме
        if (step === "await_questionnaire") {
          const lowerQ = text.toLowerCase();
          if (lowerQ === "нет" || lowerQ.startsWith("не указ")) {
            createState.data.questionnaire = null;
          } else {
            createState.data.questionnaire = text;
          }

          // Переходим на шаг комментария
          createState.step = "await_comment";

          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Отмена", "admin_interviews")],
          ]);

          await deliver(
            ctx,
            {
              text:
                "💬 Напишите комментарий по кандидату (например, от кого рекомендация).\n" +
                "Если комментария нет — введите «—».",
              extra: keyboard,
            },
            { edit: true }
          );
          return;
        }

        // 8) Комментарий
        if (step === "await_comment") {
          const lowerC = text.toLowerCase();
          if (
            lowerC === "нет" ||
            lowerC.startsWith("не указ") ||
            text === "—" ||
            text === "-"
          ) {
            createState.data.comment = null;
          } else {
            createState.data.comment = text;
          }

          // Переход к дате собеседования
          createState.step = "await_date";

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback("сегодня", "candidate_date_today"),
              Markup.button.callback("завтра", "candidate_date_tomorrow"),
            ],
            [Markup.button.callback("🔙 Отмена", "admin_interviews")],
          ]);

          await deliver(
            ctx,
            {
              text:
                "📅 Укажите дату собеседования в формате ДД.ММ (например, 03.12).\n" +
                "Или выберите «сегодня» / «завтра» кнопками ниже.",
              extra: keyboard,
            },
            { edit: true }
          );
          return;
        }

        // 9) Дата собеседования
        if (step === "await_date") {
          const raw = text.trim().toLowerCase();

          // Поддержим на всякий случай текстом "сегодня"/"завтра"
          const now = new Date();
          let dateObj = null;

          if (raw === "сегодня") {
            dateObj = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate()
            );
          } else if (raw === "завтра") {
            dateObj = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate() + 1
            );
          } else {
            const m = raw.match(/^(\d{1,2})\.(\d{1,2})$/);
            if (!m) {
              await ctx.reply(
                "Дата должна быть в формате ДД.ММ (например, 03.12) или нажмите кнопку «сегодня» / «завтра»."
              );
              return;
            }
            const day = parseInt(m[1], 10);
            const month = parseInt(m[2], 10); // 1..12
            const year = now.getFullYear();

            const d = new Date(year, month - 1, day);
            // проверяем, что дата реально существует
            if (
              d.getFullYear() !== year ||
              d.getMonth() !== month - 1 ||
              d.getDate() !== day
            ) {
              await ctx.reply(
                "Такой даты в этом году нет. Попробуйте ещё раз."
              );
              return;
            }
            dateObj = d;
          }

          const yyyy = dateObj.getFullYear();
          const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
          const dd = String(dateObj.getDate()).padStart(2, "0");
          createState.data.interviewDate = `${yyyy}-${mm}-${dd}`;
          createState.step = "await_time";

          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Отмена", "admin_interviews")],
          ]);

          await deliver(
            ctx,
            {
              text:
                "⏰ Укажите время собеседования в формате ЧЧ:ММ (например, 12:30).\n" +
                "Если точное время пока неизвестно — напишите «не указано».",
              extra: keyboard,
            },
            { edit: true }
          );
          return;
        }

        // 8) Время собеседования
        if (step === "await_time") {
          const lowerTime = text.toLowerCase();
          if (lowerTime === "нет" || lowerTime.startsWith("не указ")) {
            createState.data.interviewTime = null;
          } else {
            const match = text.match(/^(\d{1,2}):(\d{2})$/);
            if (!match) {
              await ctx.reply(
                "Время должно быть в формате ЧЧ:ММ (например, 12:30). Попробуй ещё раз."
              );
              return;
            }
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            if (
              Number.isNaN(hours) ||
              Number.isNaN(minutes) ||
              hours < 0 ||
              hours > 23 ||
              minutes < 0 ||
              minutes > 59
            ) {
              await ctx.reply(
                "Время должно быть в формате ЧЧ:ММ (например, 12:30). Попробуй ещё раз."
              );
              return;
            }
            const hh = String(hours).padStart(2, "0");
            const mm = String(minutes).padStart(2, "0");
            createState.data.interviewTime = `${hh}:${mm}`;
          }

          createState.step = "await_admin";

          const adminsRes = await pool.query(
            "SELECT id, full_name FROM users WHERE role = 'admin' ORDER BY full_name"
          );

          const adminButtons = adminsRes.rows.map((row) => [
            Markup.button.callback(
              row.full_name || "Без имени",
              `candidate_admin_${row.id}`
            ),
          ]);

          // 🔹 новая кнопка "назначу позже"
          adminButtons.push([
            Markup.button.callback("назначу позже", "candidate_admin_later"),
          ]);

          adminButtons.push([
            Markup.button.callback("🔙 Отмена", "admin_interviews"),
          ]);

          await deliver(
            ctx,
            {
              text: "👤 Выбери администратора, который будет проводить собеседование:",
              extra: Markup.inlineKeyboard(adminButtons),
            },
            { edit: true }
          );
          return;
        }

        // 8) ждём выбор админа кнопкой
        if (step === "await_admin") {
          await ctx.reply("Выбери администратора из списка кнопок выше.");
          return;
        }
      }

      /** ---------- РЕДАКТИРОВАНИЕ КАНДИДАТА ---------- */

      if (editState) {
        const candidateId = editState.candidateId;
        const field = editState.field;

        if (field === "name") {
          if (!text) {
            await ctx.reply("Имя не может быть пустым. Попробуй ещё раз.");
            return;
          }
          await pool.query("UPDATE candidates SET name = $1 WHERE id = $2", [
            text,
            candidateId,
          ]);
        }

        if (field === "age") {
          const ageNum = parseInt(text, 10);
          if (isNaN(ageNum) || ageNum <= 0) {
            await ctx.reply(
              "Возраст должен быть положительным числом. Попробуй ещё раз."
            );
            return;
          }
          await pool.query("UPDATE candidates SET age = $1 WHERE id = $2", [
            ageNum,
            candidateId,
          ]);
        }

        if (field === "phone") {
          if (!text) {
            await ctx.reply("Телефон не может быть пустым. Попробуй ещё раз.");
            return;
          }
          await pool.query("UPDATE candidates SET phone = $1 WHERE id = $2", [
            text,
            candidateId,
          ]);
        }

        if (field === "salary") {
          await pool.query("UPDATE candidates SET salary = $1 WHERE id = $2", [
            text,
            candidateId,
          ]);
        }

        if (field === "schedule") {
          await pool.query(
            "UPDATE candidates SET schedule = $1 WHERE id = $2",
            [text, candidateId]
          );
        }

        if (field === "questionnaire") {
          await pool.query(
            "UPDATE candidates SET questionnaire = $1 WHERE id = $2",
            [text, candidateId]
          );
        }

        clearCandidateEditState(tgId);
        const { showCandidateCard } = require("./card");
        await showCandidateCard(ctx, candidateId);
        return;
      }

      return next();
    } catch (err) {
      logError("interview_text_handler", err);
      return next();
    }
  });
}

module.exports = { registerInterviewModule };
