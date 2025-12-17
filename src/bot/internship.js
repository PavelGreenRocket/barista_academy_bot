// const pool = require("../db/pool");
// const { Markup } = require("telegraf");
// const { deliver } = require("../utils/renderHelpers");

// // состояние для настройки (ожидание названия / документа)
// const configStates = new Map(); // key: adminTelegramId → { mode, partId?, stepId?, title? }
// // состояние ожидания медиа по этапам
// const mediaStates = new Map(); // key: adminTelegramId → { sessionId, stepId, type, partId, userId }
// // состояние для завершения стажировки (замечания и комментарий)
// const finishSessionStates = new Map(); // key: adminTelegramId → { mode, sessionId, userId, issuesText? }

// function isAdmin(user) {
//   return user && user.role === "admin";
// }

// function isTelegraphUrl(url) {
//   if (!url) return false;
//   const s = String(url).trim();
//   // допускаем telegraph / telegra.ph
//   return /^https?:\/\/(telegra\.ph|telegraph\.ph)\/[^\s]+$/i.test(s);
// }

// // ---------- HELPERS БАЗЫ ----------

// // активная сессия стажировки по тренеру (для кнопки в главном меню)
// async function hasActiveInternshipSessionForTrainer(trainerUserId) {
//   const res = await pool.query(
//     `
//     SELECT 1
//     FROM internship_sessions
//     WHERE started_by = $1
//       AND finished_at IS NULL
//       AND is_canceled = FALSE
//     LIMIT 1
//   `,
//     [trainerUserId]
//   );
//   return res.rows.length > 0;
// }

// // активная сессия по пользователю
// async function getActiveSessionForUser(userId) {
//   const res = await pool.query(
//     `
//     SELECT *
//     FROM internship_sessions
//     WHERE user_id = $1
//       AND finished_at IS NULL
//       AND is_canceled = FALSE
//     ORDER BY started_at DESC
//     LIMIT 1
//   `,
//     [userId]
//   );
//   return res.rows[0] || null;
// }

// // части + разделы + этапы (этапы строго внутри разделов)
// async function getPartsWithSteps() {
//   const res = await pool.query(
//     `
//     SELECT
//       p.id AS part_id,
//       p.title AS part_title,
//       p.order_index AS part_order,
//       p.doc_file_id,

//       sec.id AS section_id,
//       sec.title AS section_title,
//       sec.order_index AS section_order,
//       sec.telegraph_url AS section_telegraph_url,
//       sec.duration_days AS section_duration_days,

//       st.id AS step_id,
//       st.title AS step_title,
//       st.step_type,
//       st.order_index AS step_order,
//       st.planned_duration_min
//     FROM internship_parts p
//     LEFT JOIN internship_sections sec
//       ON sec.part_id = p.id
//     LEFT JOIN internship_steps st
//       ON st.section_id = sec.id
//     ORDER BY
//       p.order_index, p.id,
//       sec.order_index, sec.id,
//       st.order_index, st.id
//   `
//   );

//   const partsMap = new Map();

//   for (const row of res.rows) {
//     let part = partsMap.get(row.part_id);
//     if (!part) {
//       part = {
//         id: row.part_id,
//         title: row.part_title,
//         order_index: row.part_order,
//         doc_file_id: row.doc_file_id,
//         // новый источник истины
//         sections: [],
//         // для обратной совместимости по коду ниже: плоский список этапов части
//         steps: [],
//       };
//       partsMap.set(row.part_id, part);
//     }

//     // section
//     if (row.section_id) {
//       let sec = part.sections.find((s) => s.id === row.section_id);
//       if (!sec) {
//         sec = {
//           id: row.section_id,
//           title: row.section_title,
//           order_index: row.section_order,
//           telegraph_url: row.section_telegraph_url,
//           duration_days: row.section_duration_days,
//           steps: [],
//         };
//         part.sections.push(sec);
//       }

//       // step
//       if (row.step_id) {
//         const stepObj = {
//           id: row.step_id,
//           title: row.step_title,
//           type: row.step_type,
//           step_type: row.step_type,
//           order_index: row.step_order,
//           planned_duration_min: row.planned_duration_min,
//           section_id: row.section_id,
//         };
//         sec.steps.push(stepObj);
//         part.steps.push(stepObj);
//       }
//     }
//   }

//   // на всякий случай сортируем внутри JS (если в БД где-то NULL order_index)
//   for (const part of partsMap.values()) {
//     part.sections.sort(
//       (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id
//     );
//     for (const sec of part.sections) {
//       sec.steps.sort(
//         (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id
//       );
//     }
//     part.steps.sort(
//       (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id
//     );
//   }

//   return [...partsMap.values()];
// }

// // мапа step_id → состояние по сессии
// async function getSessionStepMap(sessionId) {
//   const res = await pool.query(
//     `
//     SELECT
//       r.step_id,
//       r.is_passed,
//       r.checked_at,
//       u.full_name AS checked_by_name
//     FROM internship_step_results r
//     LEFT JOIN users u ON u.id = r.checked_by
//     WHERE r.session_id = $1
//   `,
//     [sessionId]
//   );

//   const map = new Map();
//   for (const row of res.rows) {
//     map.set(row.step_id, {
//       is_passed: row.is_passed,
//       checked_at: row.checked_at,
//       checked_by_name: row.checked_by_name,
//     });
//   }
//   return map;
// }

// // мапа step_id → самое "свежее" состояние по ВСЕМ неотменённым сессиям пользователя
// async function getUserOverallStepMap(userId) {
//   const res = await pool.query(
//     `
//     SELECT DISTINCT ON (r.step_id)
//       r.step_id,
//       r.is_passed,
//       r.checked_at,
//       r.session_id,
//       u.full_name AS checked_by_name
//     FROM internship_step_results r
//     JOIN internship_sessions s ON s.id = r.session_id
//     LEFT JOIN users u ON u.id = r.checked_by
//     WHERE s.user_id = $1
//       AND (s.is_canceled IS NULL OR s.is_canceled = FALSE)
//     ORDER BY r.step_id, r.is_passed DESC, r.checked_at DESC
//   `,
//     [userId]
//   );

//   const map = new Map();
//   for (const row of res.rows) {
//     map.set(row.step_id, {
//       is_passed: row.is_passed,
//       checked_at: row.checked_at,
//       checked_by_name: row.checked_by_name,
//       session_id: row.session_id,
//     });
//   }
//   return map;
// }

// // прогресс по этапам стажировки по всем неотменённым дням пользователя
// async function getUserStepProgressAcrossSessions(userId) {
//   // Берём только неотменённые дни
//   const sessRes = await pool.query(
//     `
//     SELECT id
//     FROM internship_sessions
//     WHERE user_id = $1 AND (is_canceled IS NULL OR is_canceled = FALSE)
//   `,
//     [userId]
//   );
//   const sessionIds = sessRes.rows.map((r) => r.id);

//   const map = new Map();
//   if (!sessionIds.length) {
//     return map;
//   }

//   const res = await pool.query(
//     `
//     SELECT step_id, bool_or(is_passed) AS is_passed
//     FROM internship_step_results
//     WHERE session_id = ANY($1::int[])
//     GROUP BY step_id
//   `,
//     [sessionIds]
//   );

//   for (const row of res.rows) {
//     map.set(row.step_id, row.is_passed);
//   }

//   return map;
// }

// function formatDurationMs(ms) {
//   if (!ms || ms <= 0) return "-";
//   const totalSec = Math.floor(ms / 1000);
//   const hours = Math.floor(totalSec / 3600);
//   const minutes = Math.floor((totalSec % 3600) / 60);
//   if (!hours && !minutes) return "< 1 мин";
//   if (!hours) return `${minutes} мин`;
//   return `${hours} ч ${minutes} мин`;
// }

// // ---------- МЕНЮ СТАЖИРОВКИ ПО ПОЛЬЗОВАТЕЛЮ ----------

// async function showUserInternshipMenu(ctx, admin, targetUserId) {
//   const uRes = await pool.query(
//     "SELECT id, full_name, role, staff_status, intern_days_completed FROM users WHERE id = $1",
//     [targetUserId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];
//   const name = user.full_name || "Без имени";

//   const activeSession = await getActiveSessionForUser(user.id);

//   const isIntern = user.staff_status === "intern";
//   const nextDay = (user.intern_days_completed || 0) + 1;

//   let text =
//     `👤 ${name}\n` +
//     `Роль: ${user.role}\n` +
//     (isIntern ? `Статус: стажёр\n\n` : `Статус: работник\n\n`);

//   const buttons = [];

//   if (!activeSession) {
//     if (isIntern) {
//       text +=
//         "Здесь можно запустить стажировку по дням и смотреть прогресс.\n\nВыбери действие:";

//       buttons.push([
//         Markup.button.callback(
//           "▶️ Приступить к стажировке",
//           `admin_internship_start_${user.id}`
//         ),
//       ]);
//     } else {
//       text +=
//         "Этот сотрудник уже работник. Новую стажировку запустить нельзя, но можно посмотреть историю.\n\nВыбери действие:";
//     }

//     buttons.push([
//       Markup.button.callback(
//         "🌱 Данные о стажировке",
//         `admin_internship_data_${user.id}`
//       ),
//     ]);
//     buttons.push([
//       Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//     ]);
//   } else {
//     text +=
//       `Сейчас идёт стажировка.\n` +
//       "Нажмите на часть, чтобы начать/продолжить обучение.\n\n";

//     const parts = await getPartsWithSteps();
//     const stepMap = await getSessionStepMap(activeSession.id);

//     for (const part of parts) {
//       if (!part.steps.length) continue;
//       const total = part.steps.length;
//       const done = part.steps.filter(
//         (s) => stepMap.get(s.id)?.is_passed === true
//       ).length;

//       let label;
//       if (total > 0 && done === total) {
//         label = `✅ ${part.title}`;
//       } else {
//         const percent = total === 0 ? 0 : Math.round((done / total) * 100);
//         label = `${part.title} (${percent}%)`;
//       }

//       buttons.push([
//         Markup.button.callback(
//           label,
//           `admin_internship_session_part_sections_${activeSession.id}_${part.id}_${user.id}`
//         ),
//       ]);
//     }

//     buttons.push([
//       Markup.button.callback(
//         "⏹ Закончить стажировку",
//         `admin_internship_finish_${activeSession.id}_${user.id}`
//       ),
//     ]);
//     buttons.push([
//       Markup.button.callback(
//         "❌ Отменить стажировку",
//         `admin_internship_cancel_${activeSession.id}_${user.id}`
//       ),
//     ]);
//     buttons.push([
//       Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//     ]);
//   }

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // выбор торговой точки перед стартом дня
// async function askStartInternshipTradePoint(ctx, admin, targetUserId) {
//   const uRes = await pool.query(
//     "SELECT id, full_name, staff_status, intern_days_completed FROM users WHERE id = $1",
//     [targetUserId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];

//   if (user.staff_status !== "intern") {
//     await ctx.reply(
//       "Этот сотрудник уже работник. Новую стажировку для него запустить нельзя."
//     );
//     return;
//   }

//   const active = await getActiveSessionForUser(user.id);
//   if (active) {
//     await ctx.reply(
//       "У этого стажёра уже есть незавершённая стажировка. Сначала завершите или отмените её."
//     );
//     return;
//   }

//   const tpRes = await pool.query(
//     `
//     SELECT id, title
//     FROM trade_points
//     WHERE is_active = TRUE
//     ORDER BY id
//     `
//   );
//   const points = tpRes.rows;

//   if (!points.length) {
//     const keyboard = Markup.inlineKeyboard([
//       [Markup.button.callback("🔧 Торговые точки", "admin_trade_points")],
//       [
//         Markup.button.callback(
//           "🔙 К стажировке пользователя",
//           `admin_user_internship_${user.id}`
//         ),
//       ],
//     ]);

//     await deliver(
//       ctx,
//       {
//         text:
//           "Пока не добавлено ни одной торговой точки.\n" +
//           "Сначала добавьте её в разделе «🔧 Торговые точки».",
//         extra: keyboard,
//       },
//       { edit: true }
//     );
//     return;
//   }

//   let text =
//     `Стажёр: ${user.full_name || "Без имени"}\n\n` +
//     "Выберите торговую точку для этого дня стажировки:";

//   const buttons = [];

//   for (const tp of points) {
//     buttons.push([
//       Markup.button.callback(
//         `🏬 ${tp.title}`,
//         `admin_internship_start_tp_${user.id}_${tp.id}`
//       ),
//     ]);
//   }

//   buttons.push([
//     Markup.button.callback(
//       "🔙 К стажировке пользователя",
//       `admin_user_internship_${user.id}`
//     ),
//   ]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // вопрос "пришёл вовремя?"
// async function askStartInternshipLate(ctx, admin, userId, tradePointId) {
//   const uRes = await pool.query(
//     "SELECT id, full_name FROM users WHERE id = $1",
//     [userId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];

//   const tpRes = await pool.query(
//     "SELECT id, title FROM trade_points WHERE id = $1",
//     [tradePointId]
//   );
//   if (!tpRes.rows.length) {
//     await ctx.reply("Торговая точка не найдена.");
//     return;
//   }
//   const tp = tpRes.rows[0];

//   const text =
//     `Стажёр: ${user.full_name || "Без имени"}\n` +
//     `Торговая точка: ${tp.title}\n\n` +
//     "Стажёр пришёл вовремя?";

//   const keyboard = Markup.inlineKeyboard([
//     [
//       Markup.button.callback(
//         "✅ Да, вовремя",
//         `admin_internship_start_late_yes_${user.id}_${tp.id}`
//       ),
//     ],
//     [
//       Markup.button.callback(
//         "⚠️ Нет, с опозданием",
//         `admin_internship_start_late_no_${user.id}_${tp.id}`
//       ),
//     ],
//     [
//       Markup.button.callback(
//         "🔙 Выбрать другую точку",
//         `admin_internship_start_${user.id}`
//       ),
//     ],
//   ]);

//   await deliver(ctx, { text, extra: keyboard }, { edit: true });
// }

// // фактический старт дня стажировки
// async function startInternshipSession(
//   ctx,
//   admin,
//   targetUserId,
//   tradePointId,
//   wasLate
// ) {
//   const uRes = await pool.query(
//     "SELECT id, full_name, staff_status, intern_days_completed FROM users WHERE id = $1",
//     [targetUserId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];

//   if (user.staff_status !== "intern") {
//     await ctx.reply(
//       "Этот сотрудник уже работник. Новую стажировку для него запустить нельзя."
//     );
//     return;
//   }

//   const active = await getActiveSessionForUser(user.id);
//   if (active) {
//     await ctx.reply(
//       "У этого стажёра уже есть незавершённая стажировка. Сначала завершите или отмените её."
//     );
//     return;
//   }

//   const nextDay = (user.intern_days_completed || 0) + 1;

//   const ins = await pool.query(
//     `
//     INSERT INTO internship_sessions (user_id, day_number, started_by, trade_point_id, was_late)
//     VALUES ($1, $2, $3, $4, $5)
//     RETURNING id
//     `,
//     [user.id, nextDay, admin.id, tradePointId, wasLate]
//   );
//   const sessionId = ins.rows[0].id;

//   const tpRes = await pool.query(
//     "SELECT title FROM trade_points WHERE id = $1",
//     [tradePointId]
//   );
//   const tpTitle = tpRes.rows.length ? tpRes.rows[0].title : "не указана";

//   let lateText = "";
//   if (wasLate === true) lateText = " (стажёр пришёл с опозданием)";
//   else if (wasLate === false) lateText = " (без опоздания)";

//   await ctx.reply(
//     `Стажировка начата. День ${nextDay}. Стажёр: ${
//       user.full_name || "Без имени"
//     }.\n` + `Торговая точка: ${tpTitle}${lateText}.`
//   );

//   await showUserInternshipMenu(ctx, admin, user.id);
// }

// // показать часть (для действующей сессии) — теперь всегда показываем РАЗДЕЛЫ, а не плоский список этапов
// async function showSessionPart(ctx, sessionId, partId, userId) {
//   return showSessionPartSections(ctx, sessionId, partId, userId, {
//     edit: true,
//   });
// }

// async function showSessionPartSections(
//   ctx,
//   sessionId,
//   partId,
//   userId,
//   opts = {}
// ) {
//   const sRes = await pool.query(
//     `SELECT id, day_number FROM internship_sessions WHERE id = $1 LIMIT 1`,
//     [sessionId]
//   );
//   if (!sRes.rows.length) {
//     await ctx.reply("Сессия не найдена");
//     return;
//   }
//   const session = sRes.rows[0];

//   const pRes = await pool.query(
//     `SELECT id, title, order_index FROM internship_parts WHERE id = $1 LIMIT 1`,
//     [partId]
//   );
//   if (!pRes.rows.length) {
//     await ctx.reply("Часть не найдена");
//     return;
//   }
//   const part = pRes.rows[0];

//   const secRes = await pool.query(
//     `
//     SELECT id, title, order_index
//     FROM internship_sections
//     WHERE part_id = $1
//     ORDER BY order_index ASC
//     `,
//     [partId]
//   );

//   const sections = secRes.rows;
//   const sectionIds = sections.map((s) => s.id);

//   // карта результатов по сессии
//   const stepMap = await getSessionStepMap(sessionId);

//   // достанем все steps для этих sections одним запросом (этапы строго внутри разделов)
//   const stRes = sectionIds.length
//     ? await pool.query(
//         `
//         SELECT id, section_id
//         FROM internship_steps
//         WHERE section_id = ANY($1::int[])
//         ORDER BY order_index ASC, id ASC
//         `,
//         [sectionIds]
//       )
//     : { rows: [] };

//   const stepsBySection = new Map();
//   for (const r of stRes.rows) {
//     if (!stepsBySection.has(r.section_id)) stepsBySection.set(r.section_id, []);
//     stepsBySection.get(r.section_id).push(r.id);
//   }

//   let text =
//     `🎓 Стажировка — день ${session.day_number}\n` +
//     `Часть: ${part.title}\n\n` +
//     `Выберите раздел:\n`;

//   const buttons = [];

//   for (const sec of sections) {
//     const stepIds = stepsBySection.get(sec.id) || [];
//     const total = stepIds.length;
//     const done = stepIds.filter(
//       (id) => stepMap.get(id)?.is_passed === true
//     ).length;

//     let label;
//     if (total > 0 && done === total) {
//       label = `✅ ${sec.title}`;
//     } else {
//       const percent = total === 0 ? 0 : Math.round((done / total) * 100);
//       label = `${sec.title} (${percent}%)`;
//     }

//     buttons.push([
//       Markup.button.callback(
//         label,
//         `admin_internship_session_section_${sessionId}_${sec.id}_${userId}`
//       ),
//     ]);
//   }

//   buttons.push([
//     Markup.button.callback("🔙 К частям", `admin_user_internship_${userId}`),
//   ]);

//   const keyboard = Markup.inlineKeyboard(buttons);
//   await deliver(ctx, { text, extra: keyboard }, { edit: true });
// }

// // переключение обычного этапа
// async function toggleSimpleStep(sessionId, stepId, adminId) {
//   const res = await pool.query(
//     `
//     SELECT is_passed
//     FROM internship_step_results
//     WHERE session_id = $1 AND step_id = $2
//   `,
//     [sessionId, stepId]
//   );

//   if (!res.rows.length) {
//     await pool.query(
//       `
//       INSERT INTO internship_step_results (session_id, step_id, is_passed, checked_by, checked_at)
//       VALUES ($1, $2, TRUE, $3, NOW())
//     `,
//       [sessionId, stepId, adminId]
//     );
//   } else {
//     const current = res.rows[0].is_passed;
//     const newVal = !current;
//     await pool.query(
//       `
//       UPDATE internship_step_results
//       SET is_passed = $3,
//           checked_by = CASE WHEN $3 THEN $4 ELSE checked_by END,
//           checked_at = CASE WHEN $3 THEN NOW() ELSE checked_at END
//       WHERE session_id = $1 AND step_id = $2
//     `,
//       [sessionId, stepId, newVal, adminId]
//     );
//   }
// }

// // установить медиа‑этап как выполненный
// async function setMediaStepPassed(sessionId, stepId, adminId, fileId) {
//   const res = await pool.query(
//     `
//     SELECT 1
//     FROM internship_step_results
//     WHERE session_id = $1 AND step_id = $2
//   `,
//     [sessionId, stepId]
//   );

//   if (!res.rows.length) {
//     await pool.query(
//       `
//       INSERT INTO internship_step_results (session_id, step_id, is_passed, checked_by, checked_at, media_file_id)
//       VALUES ($1, $2, TRUE, $3, NOW(), $4)
//     `,
//       [sessionId, stepId, adminId, fileId]
//     );
//   } else {
//     await pool.query(
//       `
//       UPDATE internship_step_results
//       SET is_passed = TRUE,
//           checked_by = $3,
//           checked_at = NOW(),
//           media_file_id = $4
//       WHERE session_id = $1 AND step_id = $2
//     `,
//       [sessionId, stepId, adminId, fileId]
//     );
//   }
// }

// // завершить день стажировки (с учётом замечаний и комментария)
// async function finishInternshipSession(
//   ctx,
//   sessionId,
//   userId,
//   issuesText,
//   commentText
// ) {
//   const sRes = await pool.query(
//     "SELECT * FROM internship_sessions WHERE id = $1",
//     [sessionId]
//   );
//   if (!sRes.rows.length) {
//     await ctx.reply("Сессия стажировки не найдена.");
//     return;
//   }
//   const session = sRes.rows[0];
//   if (session.finished_at || session.is_canceled) {
//     await ctx.reply("Эта стажировка уже завершена или отменена.");
//     return;
//   }

//   const end = new Date();
//   const start = new Date(session.started_at);
//   const durationMs = end - start;

//   await pool.query(
//     `
//     UPDATE internship_sessions
//     SET finished_at = NOW(),
//         is_canceled = FALSE,
//         issues = $2,
//         comment = $3
//     WHERE id = $1
//   `,
//     [sessionId, issuesText || null, commentText || null]
//   );

//   await pool.query(
//     `
//     UPDATE users
//     SET intern_days_completed = intern_days_completed + 1
//     WHERE id = $1
//   `,
//     [session.user_id]
//   );

//   const durText = formatDurationMs(durationMs);

//   await ctx.reply(
//     `Стажировка (день ${session.day_number}) завершена. Длительность: ${durText}.`
//   );
// }

// // отменить день
// async function cancelInternshipSession(ctx, sessionId) {
//   const sRes = await pool.query(
//     "SELECT * FROM internship_sessions WHERE id = $1",
//     [sessionId]
//   );
//   if (!sRes.rows.length) {
//     await ctx.reply("Сессия стажировки не найдена.");
//     return;
//   }
//   const session = sRes.rows[0];
//   if (session.finished_at || session.is_canceled) {
//     await ctx.reply("Эта стажировка уже завершена или отменена.");
//     return;
//   }

//   await pool.query(
//     `
//     UPDATE internship_sessions
//     SET finished_at = NOW(),
//         is_canceled = TRUE
//     WHERE id = $1
//   `,
//     [sessionId]
//   );

//   await ctx.reply(
//     `Стажировка (день ${session.day_number}) отменена. День не засчитан.`
//   );
// }

// // ---------- ИСТОРИЯ ПО ПОЛЬЗОВАТЕЛЮ ----------

// async function showUserInternshipData(ctx, userId) {
//   const uRes = await pool.query(
//     `
//     SELECT id, full_name, role, staff_status, intern_days_completed
//     FROM users
//     WHERE id = $1
//   `,
//     [userId]
//   );

//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }

//   const user = uRes.rows[0];
//   const name = user.full_name || "Без имени";

//   const sRes = await pool.query(
//     `
//     SELECT
//       s.id,
//       s.day_number,
//       s.started_at,
//       s.finished_at,
//       s.is_canceled,
//       u.full_name AS trainer_name
//     FROM internship_sessions s
//     LEFT JOIN users u ON u.id = s.started_by
//     WHERE s.user_id = $1
//     ORDER BY s.day_number, s.started_at
//   `,
//     [userId]
//   );
//   const sessions = sRes.rows;

//   const finishedDays = sessions.filter(
//     (s) => s.finished_at && !s.is_canceled
//   ).length;

//   const isIntern = user.staff_status === "intern";
//   const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
//   const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

//   let text =
//     `🌱 Стажировка: ${name}\n` +
//     `Роль: ${user.role}\n` +
//     `Статус: ${statusLine}\n\n` +
//     `Всего завершённых стажировок (дней): ${finishedDays}\n\n` +
//     `Выбери раздел:\n`;

//   const buttons = [];

//   buttons.push([
//     Markup.button.callback(
//       "📊 Успеваемость",
//       `admin_internship_perf_${user.id}`
//     ),
//   ]);

//   buttons.push([
//     Markup.button.callback(
//       "ℹ️ Детали стажировки",
//       `admin_internship_details_${user.id}`
//     ),
//   ]);

//   buttons.push([
//     Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//   ]);

//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // 📊 Общая успеваемость по частям (без разбивки по дням)
// async function showUserInternshipPerformance(ctx, userId) {
//   const uRes = await pool.query(
//     `
//     SELECT id, full_name, role, staff_status, intern_days_completed
//     FROM users
//     WHERE id = $1
//   `,
//     [userId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }

//   const user = uRes.rows[0];
//   const name = user.full_name || "Без имени";

//   // все сессии (для подсчёта завершённых дней)
//   const sessRes = await pool.query(
//     `
//     SELECT *
//     FROM internship_sessions
//     WHERE user_id = $1
//   `,
//     [userId]
//   );
//   const sessions = sessRes.rows;
//   const finishedDays = sessions.filter(
//     (s) => s.finished_at && !s.is_canceled
//   ).length;

//   const isIntern = user.staff_status === "intern";
//   const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
//   const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

//   const parts = await getPartsWithSteps();
//   const overallMap = await getUserOverallStepMap(userId);

//   let text =
//     `🌱 Стажировка: ${name}\n` +
//     `Роль: ${user.role}\n` +
//     `Статус: ${statusLine}\n\n` +
//     `📊 Успеваемость\n\n` +
//     `Всего завершённых стажировок (дней): ${finishedDays}\n\n` +
//     `Выбери часть, чтобы посмотреть этапы:\n`;

//   const buttons = [];

//   for (const part of parts) {
//     if (!part.steps.length) continue;

//     let total = part.steps.length;
//     let passed = 0;

//     for (const step of part.steps) {
//       const state = overallMap.get(step.id);
//       if (state?.is_passed) passed++;
//     }

//     const percent = total ? Math.round((passed * 100) / total) : 0;

//     let icon = "⚪️";
//     if (passed === 0) icon = "❌";
//     else if (passed === total) icon = "✅";
//     else icon = "🟡";

//     const label = `${icon} Часть: ${part.title} — ${passed}/${total} этапов (${percent}%)`;

//     buttons.push([
//       Markup.button.callback(
//         label,
//         `admin_internship_perf_part_${user.id}_${part.id}`
//       ),
//     ]);
//   }

//   if (!buttons.length) {
//     text += `\n(Пока нет ни одной части с этапами.)`;
//   }

//   buttons.push([
//     Markup.button.callback(
//       "ℹ️ Детали стажировки",
//       `admin_internship_details_${user.id}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback(
//       "🔙 К разделам стажировки",
//       `admin_internship_data_${user.id}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//   ]);
//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // 📊 Успеваемость: просмотр конкретной части (этапы по всем дням)
// async function showUserInternshipPerformancePart(ctx, userId, partId) {
//   const uRes = await pool.query(
//     `
//     SELECT id, full_name, role, staff_status, intern_days_completed
//     FROM users
//     WHERE id = $1
//   `,
//     [userId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];

//   const isIntern = user.staff_status === "intern";
//   const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
//   const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

//   const parts = await getPartsWithSteps();
//   const part = parts.find((p) => p.id === partId);
//   if (!part) {
//     await ctx.reply("Часть стажировки не найдена.");
//     return;
//   }

//   const overallMap = await getUserOverallStepMap(userId);

//   let text =
//     `🌱 Стажировка: ${user.full_name || "Без имени"}\n` +
//     `Роль: ${user.role}\n` +
//     `Статус: ${statusLine}\n\n` +
//     `📊 Успеваемость — часть: ${part.title}\n\n` +
//     `Этапы:\n`;

//   const buttons = [];

//   if (!part.steps.length) {
//     text += "(В этой части пока нет этапов.)";
//   } else {
//     for (const step of part.steps) {
//       const state = overallMap.get(step.id);
//       const passed = state?.is_passed === true;
//       const icon = passed ? "✅" : "❌";

//       let typeIcon = "🔘";
//       if (step.type === "video" || step.step_type === "video") typeIcon = "🎥";
//       else if (step.type === "photo" || step.step_type === "photo")
//         typeIcon = "📷";

//       let label = `${icon} ${typeIcon} ${step.title}`;

//       if (passed && state.checked_by_name && state.checked_at) {
//         const dt = new Date(state.checked_at).toLocaleString("ru-RU", {
//           day: "2-digit",
//           month: "2-digit",
//           hour: "2-digit",
//           minute: "2-digit",
//         });
//         label += ` (${state.checked_by_name}, ${dt})`;
//       }

//       // строим callback так, чтобы:
//       //  - для простых этапов можно было при желании менять галочку
//       //  - для медиа — открывать фото/видео и менять его
//       const sessionId = state?.session_id;

//       if (sessionId) {
//         if (step.type === "simple" || step.step_type === "simple") {
//           buttons.push([
//             Markup.button.callback(
//               label,
//               `admin_internship_step_toggle_${sessionId}_${step.id}_${part.id}_${user.id}`
//             ),
//           ]);
//         } else {
//           buttons.push([
//             Markup.button.callback(
//               label,
//               `admin_internship_step_media_${sessionId}_${step.id}_${part.id}_${user.id}`
//             ),
//           ]);
//         }
//       } else {
//         // если ещё ни разу не делали этот этап — просто текстовая кнопка без действий
//         buttons.push([Markup.button.callback(label, "noop")]);
//       }
//     }
//   }

//   buttons.push([
//     Markup.button.callback(
//       "🔙 К частям (успеваемость)",
//       `admin_internship_perf_${user.id}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//   ]);
//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // просмотр конкретного дня в режиме "📊 Успеваемость":
// // показываем части, дальше — те же этапы и медиа, что в процессе
// async function showUserInternshipHistoryDay(ctx, admin, userId, sessionId) {
//   const uRes = await pool.query(
//     `
//     SELECT id, full_name, role, staff_status, intern_days_completed
//     FROM users
//     WHERE id = $1
//   `,
//     [userId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];

//   const sRes = await pool.query(
//     `
//     SELECT s.*,
//            t.full_name AS trainer_name
//     FROM internship_sessions s
//     LEFT JOIN users t ON t.id = s.started_by
//     WHERE s.id = $1 AND s.user_id = $2
//   `,
//     [sessionId, userId]
//   );
//   if (!sRes.rows.length) {
//     await ctx.reply("День стажировки не найден.");
//     return;
//   }
//   const session = sRes.rows[0];

//   const parts = await getPartsWithSteps();
//   const stepMap = await getSessionStepMap(sessionId);

//   let userStatus;
//   if (user.staff_status === "intern") {
//     const currentDay = (user.intern_days_completed || 0) + 1;
//     userStatus = `стажёр (день ${currentDay})`;
//   } else {
//     userStatus = "работник";
//   }

//   const sessionStatus = session.is_canceled
//     ? "отменена"
//     : session.finished_at
//     ? "завершена"
//     : "в процессе";

//   const startedStr = session.started_at
//     ? new Date(session.started_at).toLocaleString("ru-RU", {
//         day: "2-digit",
//         month: "2-digit",
//         hour: "2-digit",
//         minute: "2-digit",
//       })
//     : "—";

//   let text =
//     `🌱 Стажировка: ${user.full_name || "Без имени"}\n` +
//     `Роль: ${user.role}\n` +
//     `Статус: ${userStatus}\n\n` +
//     `📊 Успеваемость — день ${session.day_number}\n` +
//     `Стажировал: ${
//       session.trainer_name || "Без имени"
//     }, статус: ${sessionStatus}, начало: ${startedStr}\n\n` +
//     `Части стажировки:\n`;

//   const buttons = [];

//   for (const part of parts) {
//     const partSteps = part.steps || [];
//     const total = partSteps.length;
//     let done = 0;

//     for (const st of partSteps) {
//       const stInfo = stepMap.get(st.id);
//       if (stInfo?.is_passed) done++;
//     }

//     let icon = "⚪️";
//     if (total > 0 && done === total) icon = "✅";
//     else if (done > 0) icon = "🟡";

//     const label = `${icon} Часть: ${part.title}`;

//     buttons.push([
//       Markup.button.callback(
//         label,
//         `admin_internship_session_part_${session.id}_${part.id}_${user.id}`
//       ),
//     ]);
//   }

//   buttons.push([
//     Markup.button.callback(
//       "🔙 К дням (успеваемость)",
//       `admin_internship_perf_${user.id}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//   ]);
//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // экран "ℹ️ Детали стажировки": общая сводка + кнопки по дням
// async function showUserInternshipDetails(ctx, userId) {
//   const uRes = await pool.query(
//     `
//     SELECT id, full_name, role, staff_status, intern_days_completed
//     FROM users
//     WHERE id = $1
//   `,
//     [userId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];
//   const name = user.full_name || "Без имени";

//   const sRes = await pool.query(
//     `
//     SELECT
//       s.id,
//       s.day_number,
//       s.started_at,
//       s.finished_at,
//       s.is_canceled,
//       s.trade_point_id,
//       tp.title AS trade_point_title,
//       u.full_name AS trainer_name
//     FROM internship_sessions s
//     LEFT JOIN users u ON u.id = s.started_by
//     LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
//     WHERE s.user_id = $1
//     ORDER BY s.day_number, s.started_at
//   `,
//     [userId]
//   );

//   const sessions = sRes.rows;

//   // используем только неотменённые дни
//   const validSessions = sessions.filter((s) => !s.is_canceled);

//   const finishedDays = validSessions.filter((s) => s.finished_at).length;

//   const isIntern = user.staff_status === "intern";
//   const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
//   const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

//   let text =
//     `🌱 Стажировка: ${name}\n` +
//     `Роль: ${user.role}\n` +
//     `Статус: ${statusLine}\n\n` +
//     `Всего завершённых стажировок (дней): ${finishedDays}\n` +
//     `────────────\n`;

//   if (validSessions.length) {
//     text += "Кто стажировал по дням:\n";
//     for (const s of validSessions) {
//       const trainer = s.trainer_name || "Без имени";
//       text += `• день ${s.day_number} — ${trainer}\n`;
//     }
//   } else {
//     text += "Кто стажировал по дням: данных пока нет.\n";
//   }

//   text += "\n────────────\n";

//   // опоздания пока не храним — заглушка
//   text += "Опоздания:\nданные пока не внесены (добавим позже).\n";

//   text += "\n────────────\n";

//   if (validSessions.length) {
//     text += "Выбери день стажировки, чтобы посмотреть детали дня:\n";
//   } else {
//     text += "Деталей по дням пока нет.\n";
//   }

//   const buttons = [];

//   for (const s of validSessions) {
//     const startStr = s.started_at
//       ? new Date(s.started_at).toLocaleString("ru-RU", {
//           day: "2-digit",
//           month: "2-digit",
//           hour: "2-digit",
//           minute: "2-digit",
//         })
//       : "—";

//     const trainerName = s.trainer_name || "без тренера";
//     const tpTitle = s.trade_point_title || "не указана";

//     const label = `День ${s.day_number} — "${tpTitle}", ${trainerName}, ${startStr}`;

//     buttons.push([
//       Markup.button.callback(
//         label,
//         `admin_internship_details_day_${s.id}_${user.id}`
//       ),
//     ]);
//   }

//   buttons.push([
//     Markup.button.callback(
//       "🔙 К разделам стажировки",
//       `admin_internship_data_${user.id}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//   ]);
//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // карточка "ДЕТАЛИ ДЕНЬ N"
// async function showUserInternshipDetailsDay(ctx, admin, userId, sessionId) {
//   const uRes = await pool.query(
//     `
//     SELECT id, full_name, role, staff_status, intern_days_completed
//     FROM users
//     WHERE id = $1
//   `,
//     [userId]
//   );
//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];

//   const sRes = await pool.query(
//     `
//     SELECT s.*,
//            t.full_name AS trainer_name,
//            tp.title AS trade_point_title
//     FROM internship_sessions s
//     LEFT JOIN users t ON t.id = s.started_by
//     LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
//     WHERE s.id = $1 AND s.user_id = $2
//   `,
//     [sessionId, userId]
//   );

//   if (!sRes.rows.length) {
//     await ctx.reply("День стажировки не найден.");
//     return;
//   }
//   const session = sRes.rows[0];

//   // для краткой "успеваемости" — считаем выполненные этапы
//   const parts = await getPartsWithSteps();
//   const stepMap = await getSessionStepMap(sessionId);

//   let totalSteps = 0;
//   let passedSteps = 0;
//   for (const part of parts) {
//     for (const step of part.steps || []) {
//       totalSteps++;
//       const st = stepMap.get(step.id);
//       if (st?.is_passed) passedSteps++;
//     }
//   }

//   let perfText = "нет данных";
//   if (totalSteps > 0) {
//     const percent = Math.round((passedSteps * 100) / totalSteps);
//     perfText = `${passedSteps}/${totalSteps} этапов (${percent}%)`;
//   }

//   const isIntern = user.staff_status === "intern";
//   const currentDay = isIntern ? (user.intern_days_completed || 0) + 1 : null;
//   const statusLine = isIntern ? `стажёр (день ${currentDay})` : "работник";

//   const start = session.started_at ? new Date(session.started_at) : null;
//   const end = session.finished_at ? new Date(session.finished_at) : null;

//   let timeRange = "нет данных";
//   let durationText = "-";
//   if (start && end) {
//     const startStr = start.toLocaleTimeString("ru-RU", {
//       hour: "2-digit",
//       minute: "2-digit",
//     });
//     const endStr = end.toLocaleTimeString("ru-RU", {
//       hour: "2-digit",
//       minute: "2-digit",
//     });
//     timeRange = `с ${startStr} до ${endStr}`;
//     durationText = formatDurationMs(end.getTime() - start.getTime());
//   }

//   let lateText;
//   if (session.was_late === true) {
//     lateText = "было (стажёр пришёл с опозданием)";
//   } else if (session.was_late === false) {
//     lateText = "не было";
//   } else {
//     lateText = "данные не указаны";
//   }

//   const tradePointText = session.trade_point_title || "не указана";
//   const commentText = session.comment || "комментариев нет";
//   const issuesText = session.issues || "не было";

//   let text =
//     `🌱 Стажировка: ${user.full_name || "Без имени"}\n` +
//     `Роль: ${user.role}\n` +
//     `Статус: ${statusLine}\n\n` +
//     `☑️ ДЕТАЛИ ДЕНЬ ${session.day_number}:\n` +
//     `────────────\n` +
//     `🕒 Длительность: ${timeRange} (${durationText})\n\n` +
//     `⏳ Опоздание: ${lateText}\n` +
//     `🏬 Торговая точка: ${tradePointText}\n` +
//     `🧑‍💼 Кто стажировал: ${session.trainer_name || "Без имени"}\n` +
//     `📊 Успеваемость: ${perfText}\n` +
//     `────────────\n` +
//     `Комментарии по стажировке: ${commentText}\n` +
//     `⚠️ Замечания: ${issuesText}\n`;

//   const buttons = [];

//   buttons.push([
//     Markup.button.callback(
//       "🔙 К дням (детали)",
//       `admin_internship_details_${user.id}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//   ]);
//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // показ конкретного дня стажировки в режиме "история",
// // но с той же кнопочной структурой, что и в процессе стажировки
// async function showUserInternshipHistoryDay(ctx, admin, userId, sessionId) {
//   // проверим, что пользователь существует
//   const uRes = await pool.query(
//     `
//     SELECT id, full_name, role, staff_status, intern_days_completed
//     FROM users
//     WHERE id = $1
//   `,
//     [userId]
//   );

//   if (!uRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }
//   const user = uRes.rows[0];

//   // сам день стажировки
//   const sRes = await pool.query(
//     `
//     SELECT s.*,
//            t.full_name AS trainer_name
//     FROM internship_sessions s
//     LEFT JOIN users t ON t.id = s.started_by
//     WHERE s.id = $1 AND s.user_id = $2
//   `,
//     [sessionId, userId]
//   );

//   if (!sRes.rows.length) {
//     await ctx.reply("День стажировки не найден.");
//     return;
//   }

//   const session = sRes.rows[0];

//   // части + этапы
//   const parts = await getPartsWithSteps();

//   // статусы этапов по этому дню (map: step_id -> { is_passed, ... })
//   const stepMap = await getSessionStepMap(sessionId);

//   let userStatus;
//   if (user.staff_status === "intern") {
//     const currentDay = (user.intern_days_completed || 0) + 1;
//     userStatus = `стажёр (день ${currentDay})`;
//   } else {
//     userStatus = "работник";
//   }

//   const sessionStatus = session.is_canceled
//     ? "отменена"
//     : session.finished_at
//     ? "завершена"
//     : "в процессе";

//   const startedStr = session.started_at
//     ? session.started_at.toLocaleString("ru-RU", {
//         day: "2-digit",
//         month: "2-digit",
//         hour: "2-digit",
//         minute: "2-digit",
//       })
//     : "—";

//   let durationStr = "";
//   if (session.finished_at) {
//     const diffMs = session.finished_at - session.started_at;
//     const mins = Math.max(1, Math.round(diffMs / 60000));
//     durationStr = `${mins} мин`;
//   }

//   let text =
//     `🌱 Стажировка: ${user.full_name || "Без имени"}\n` +
//     `Роль: ${user.role}\n` +
//     `Статус: ${userStatus}\n\n` +
//     `День ${session.day_number} (стажировал: ${
//       session.trainer_name || "Без имени"
//     }, статус: ${sessionStatus}` +
//     (durationStr ? `, длительность: ${durationStr}` : "") +
//     `, начало: ${startedStr})\n\n` +
//     `Части стажировки:\n`;

//   const buttons = [];

//   for (const part of parts) {
//     const partSteps = part.steps || [];
//     const total = partSteps.length;
//     let done = 0;

//     for (const st of partSteps) {
//       const stInfo = stepMap.get(st.id);
//       if (stInfo?.is_passed) done++;
//     }

//     let icon = "⚪️";
//     if (total > 0 && done === total) icon = "✅";
//     else if (done > 0) icon = "🟡";

//     const label = `${icon} Часть: ${part.title}`;

//     // тот же callback, что и в процессе стажировки
//     buttons.push([
//       Markup.button.callback(
//         label,
//         `admin_internship_session_part_${session.id}_${part.id}_${user.id}`
//       ),
//     ]);
//   }

//   buttons.push([
//     Markup.button.callback(
//       "🔙 К дням стажировки",
//       `admin_internship_data_${user.id}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback("🔙 К пользователю", `admin_user_${user.id}`),
//   ]);
//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // ---------- НАСТРОЙКА СТАЖИРОВКИ В АДМИН‑ПАНЕЛИ ----------

// async function showInternshipConfigMenu(ctx) {
//   const parts = await getPartsWithSteps();

//   let text = "🎓 Настройка стажировки\n\nЧасти:\n";

//   const buttons = [];

//   if (!parts.length) {
//     text += "Пока нет ни одной части.\n";
//   } else {
//     for (const part of parts) {
//       text += `• [${part.order_index}] ${part.title}\n`;
//       buttons.push([
//         Markup.button.callback(part.title, `admin_internship_part_${part.id}`),
//       ]);
//     }
//   }

//   buttons.push([
//     Markup.button.callback("➕ Новая часть", "admin_internship_part_new"),
//   ]);
//   buttons.push([Markup.button.callback("🔙 Назад", "admin_settings")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// async function showSessionSection(
//   ctx,
//   sessionId,
//   sectionId,
//   userId,
//   opts = {}
// ) {
//   const sRes = await pool.query(
//     `SELECT id, day_number FROM internship_sessions WHERE id = $1 LIMIT 1`,
//     [sessionId]
//   );
//   if (!sRes.rows.length) return ctx.reply("Сессия не найдена");
//   const session = sRes.rows[0];

//   const secRes = await pool.query(
//     `
//     SELECT s.id, s.title, s.order_index, s.telegraph_url, s.part_id,
//            p.title AS part_title
//     FROM internship_sections s
//     JOIN internship_parts p ON p.id = s.part_id
//     WHERE s.id = $1
//     LIMIT 1
//     `,
//     [sectionId]
//   );
//   if (!secRes.rows.length) return ctx.reply("Раздел не найден");
//   const sec = secRes.rows[0];

//   const allSecRes = await pool.query(
//     `SELECT id, order_index FROM internship_sections WHERE part_id = $1 ORDER BY order_index ASC`,
//     [sec.part_id]
//   );
//   const allSecs = allSecRes.rows;
//   const totalSecs = allSecs.length;
//   const currentPos = allSecs.findIndex((x) => x.id === sectionId) + 1;

//   const stepRes = await pool.query(
//     `
//     SELECT id, title, step_type, order_index
//     FROM internship_steps
//     WHERE section_id = $1
//     ORDER BY order_index ASC
//     `,
//     [sectionId]
//   );
//   const steps = stepRes.rows;

//   const stepMap = await getSessionStepMap(sessionId);

//   let text =
//     `🎓 Стажировка — день ${session.day_number}\n` +
//     `Часть: ${sec.part_title}\n` +
//     `Раздел ${currentPos}/${totalSecs}\n\n`;

//   // короткая инструкция прямо под ссылкой (как ты просил)
//   text += `Ниже (кнопки) этапы — нажми, чтобы отметить выполнение.\n`;

//   const buttons = [];

//   // кнопки этапов (логика старая)
//   for (const st of steps) {
//     const passed = stepMap.get(st.id)?.is_passed === true;
//     const icon = passed ? "✅" : "❌";

//     const cb =
//       st.step_type === "simple"
//         ? `admin_internship_step_toggle_${sessionId}_${sectionId}_${st.id}_${userId}`
//         : `admin_internship_step_media_${sessionId}_${sectionId}_${st.id}_${userId}`;

//     buttons.push([Markup.button.callback(`${icon} ${st.title}`, cb)]);
//   }

//   // стрелки навигации
//   const navRow = [];
//   if (currentPos > 1) {
//     navRow.push(
//       Markup.button.callback(
//         "⬅️",
//         `admin_internship_section_prev_${sessionId}_${sectionId}_${userId}`
//       )
//     );
//   }
//   if (currentPos < totalSecs) {
//     navRow.push(
//       Markup.button.callback(
//         "➡️",
//         `admin_internship_section_next_${sessionId}_${sectionId}_${userId}`
//       )
//     );
//   }
//   if (navRow.length) buttons.push(navRow);

//   // назад к разделам (можно оставить, но навигация стрелками работает и без него)
//   buttons.push([
//     Markup.button.callback(
//       "🔙 К разделам",
//       `admin_internship_session_part_sections_${sessionId}_${sec.part_id}_${userId}`
//     ),
//   ]);

//   const keyboard = Markup.inlineKeyboard(buttons);

//   const extra = {
//     ...keyboard,
//     ...(sec.telegraph_url
//       ? { link_preview_options: { url: sec.telegraph_url } }
//       : {}),
//   };

//   await deliver(ctx, { text, extra }, { edit: true });
// }

// async function showInternshipPart(ctx, partId) {
//   const pRes = await pool.query(
//     "SELECT id, title, order_index, doc_file_id FROM internship_parts WHERE id = $1",
//     [partId]
//   );
//   if (!pRes.rows.length) {
//     await ctx.reply("Часть стажировки не найдена.");
//     return;
//   }
//   const part = pRes.rows[0];

//   const secRes = await pool.query(
//     `
//     SELECT id, title, order_index, telegraph_url, duration_days
//     FROM internship_sections
//     WHERE part_id = $1
//     ORDER BY order_index ASC, id ASC
//     `,
//     [partId]
//   );
//   const sections = secRes.rows;

//   let text =
//     `Часть стажировки:
// ` +
//     `Название: ${part.title}
// ` +
//     `Порядок: ${part.order_index}

// ` +
//     `Разделы (нажмите, чтобы редактировать):
// `;

//   if (!sections.length) {
//     text += "(пока нет разделов)";
//   } else {
//     for (const sec of sections) {
//       const tg = sec.telegraph_url ? "✅" : "❌";
//       const dur =
//         sec.duration_days != null ? `, срок: ${sec.duration_days} дн.` : "";
//       text += `• [${sec.order_index}] ${sec.title} ${tg}${dur}
// `;
//     }
//   }

//   const buttons = [];

//   for (const sec of sections) {
//     buttons.push([
//       Markup.button.callback(
//         `📚 ${sec.title}`,
//         `admin_internship_section_edit_${sec.id}_${part.id}`
//       ),
//     ]);
//   }

//   buttons.push([
//     Markup.button.callback(
//       "➕ Добавить раздел",
//       `admin_internship_section_new_${part.id}`
//     ),
//   ]);

//   buttons.push([
//     Markup.button.callback(
//       "🔁 Изменить последовательность",
//       `admin_internship_part_sections_reorder_${part.id}`
//     ),
//   ]);

//   // Управление частью (без перемещения вверх/вниз).
//   buttons.push([
//     Markup.button.callback(
//       "🗑 Удалить часть",
//       `admin_internship_part_del_${part.id}`
//     ),
//   ]);

//   buttons.push([
//     Markup.button.callback("🔙 К частям", "admin_internship_menu"),
//   ]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // ---------- РЕГИСТРАЦИЯ ВСЕГО В БОТЕ ----------

// async function showInternshipSection(ctx, sectionId, partId) {
//   const sRes = await pool.query(
//     `SELECT id, title, order_index, telegraph_url, duration_days FROM internship_sections WHERE id=$1`,
//     [sectionId]
//   );
//   if (!sRes.rows.length) {
//     await ctx.reply("Раздел не найден.");
//     return;
//   }
//   const sec = sRes.rows[0];

//   let text =
//     `Раздел стажировки:\n` +
//     `Название: ${sec.title}\n` +
//     `Порядок: ${sec.order_index}\n` +
//     `Telegraph: ${sec.telegraph_url ? "✅ прикреплён" : "❌ нет"}\n` +
//     `Срок: ${sec.duration_days ? `${sec.duration_days} дн.` : "не указан"}\n`;

//   const keyboard = Markup.inlineKeyboard([
//     [
//       Markup.button.callback(
//         "✏️ Переименовать раздел",
//         `admin_internship_section_rename_${sec.id}_${partId}`
//       ),
//     ],
//     [
//       Markup.button.callback(
//         "📝 Telegraph (теория)",
//         `admin_internship_section_telegraph_${sec.id}_${partId}`
//       ),
//     ],
//     [
//       Markup.button.callback(
//         sec.duration_days
//           ? `📅 Изменить срок для раздела (${sec.duration_days} дн.)`
//           : "📅 Добавить срок для раздела",
//         `admin_internship_section_duration_${sec.id}_${partId}`
//       ),
//     ],

//     [
//       Markup.button.callback(
//         "📋 Этапы раздела",
//         `admin_internship_section_steps_${sec.id}_${partId}`
//       ),
//     ],

//     [
//       Markup.button.callback(
//         "🗑 Удалить раздел",
//         `admin_internship_section_del_${sec.id}_${partId}`
//       ),
//     ],
//     [Markup.button.callback("🔙 К части", `admin_internship_part_${partId}`)],
//   ]);

//   await deliver(ctx, { text, extra: keyboard }, { edit: true });
// }

// // ---------- ПОРЯДОК (СЕКЦИИ/ЭТАПЫ) + ЭКРАНЫ ЭТАПОВ В АДМИНКЕ ----------

// // кэш наличия колонок (чтобы не падать, если колонка ещё не добавлена)
// const __colExistsCache = new Map(); // key: "table.column" -> boolean
// async function columnExists(tableName, columnName) {
//   const key = `${tableName}.${columnName}`;
//   if (__colExistsCache.has(key)) return __colExistsCache.get(key);

//   const res = await pool.query(
//     `
//       SELECT 1
//       FROM information_schema.columns
//       WHERE table_schema = 'public'
//         AND table_name = $1
//         AND column_name = $2
//       LIMIT 1
//     `,
//     [tableName, columnName]
//   );

//   const ok = res.rows.length > 0;
//   __colExistsCache.set(key, ok);
//   return ok;
// }

// // swap order_index между текущим и соседом (надежнее, чем +/- 1)
// async function swapOrderIndex({ table, id, scopeWhereSql, scopeParams, dir }) {
//   // dir: "up" => ищем соседа с меньшим order_index, "down" => с большим
//   const curRes = await pool.query(
//     `SELECT id, order_index FROM ${table} WHERE id = $1 LIMIT 1`,
//     [id]
//   );
//   if (!curRes.rows.length) return false;
//   const cur = curRes.rows[0];
//   const curIdx = Number(cur.order_index ?? 0);

//   const op = dir === "up" ? "<" : ">";
//   const order = dir === "up" ? "DESC" : "ASC";

//   const neighborRes = await pool.query(
//     `
//       SELECT id, order_index
//       FROM ${table}
//       WHERE ${scopeWhereSql}
//         AND order_index ${op} $${scopeParams.length + 1}
//       ORDER BY order_index ${order}, id ${order}
//       LIMIT 1
//     `,
//     [...scopeParams, curIdx]
//   );

//   if (!neighborRes.rows.length) return false;
//   const nb = neighborRes.rows[0];

//   // swap
//   await pool.query(`UPDATE ${table} SET order_index = $1 WHERE id = $2`, [
//     nb.order_index,
//     cur.id,
//   ]);
//   await pool.query(`UPDATE ${table} SET order_index = $1 WHERE id = $2`, [
//     cur.order_index,
//     nb.id,
//   ]);

//   return true;
// }

// // режим изменения порядка РАЗДЕЛОВ внутри ЧАСТИ
// async function showInternshipPartSectionsReorder(ctx, partId) {
//   const pRes = await pool.query(
//     "SELECT id, title, order_index FROM internship_parts WHERE id = $1",
//     [partId]
//   );
//   if (!pRes.rows.length) return ctx.reply("Часть стажировки не найдена.");
//   const part = pRes.rows[0];

//   const secRes = await pool.query(
//     `
//       SELECT id, title, order_index
//       FROM internship_sections
//       WHERE part_id = $1
//       ORDER BY order_index ASC, id ASC
//     `,
//     [partId]
//   );
//   const sections = secRes.rows;

//   let text =
//     `📚 Разделы (режим изменения порядка)

// ` +
//     `Часть: ${part.title}

// ` +
//     `Нажимай стрелки ⬆️ / ⬇️ рядом с разделами, затем нажми «✅ Закончить».
// `;

//   const buttons = [];

//   for (const sec of sections) {
//     const row = [];
//     row.push(Markup.button.callback(`${sec.title}`, "noop"));
//     row.push(
//       Markup.button.callback(
//         "⬆️",
//         `admin_internship_section_move_up_${partId}_${sec.id}`
//       )
//     );
//     row.push(
//       Markup.button.callback(
//         "⬇️",
//         `admin_internship_section_move_down_${partId}_${sec.id}`
//       )
//     );
//     buttons.push(row);
//   }

//   buttons.push([
//     Markup.button.callback(
//       "✅ Закончить изменение порядка",
//       `admin_internship_part_sections_reorder_done_${partId}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback("🔙 К части", `admin_internship_part_${partId}`),
//   ]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // список ЭТАПОВ раздела
// async function showInternshipSectionSteps(ctx, sectionId, partId) {
//   const secRes = await pool.query(
//     `SELECT id, title FROM internship_sections WHERE id = $1 LIMIT 1`,
//     [sectionId]
//   );
//   if (!secRes.rows.length) return ctx.reply("Раздел не найден.");
//   const sec = secRes.rows[0];

//   const stepRes = await pool.query(
//     `
//       SELECT id, title, order_index
//       FROM internship_steps
//       WHERE section_id = $1
//       ORDER BY order_index ASC, id ASC
//     `,
//     [sectionId]
//   );
//   const steps = stepRes.rows;

//   let text = `🎯 Этапы раздела: ${sec.title}

// `;

//   const buttons = [];

//   for (const st of steps) {
//     buttons.push([
//       Markup.button.callback(
//         st.title,
//         `admin_internship_step_edit_${st.id}_${sectionId}_${partId}`
//       ),
//     ]);
//   }

//   buttons.push([
//     Markup.button.callback(
//       "➕ Добавить этап",
//       `admin_internship_step_new_${sectionId}_${partId}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback(
//       "🔁 Изменить последовательность",
//       `admin_internship_steps_reorder_${sectionId}_${partId}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback(
//       "🔙 К разделу",
//       `admin_internship_section_edit_${sectionId}_${partId}`
//     ),
//   ]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// async function showInternshipSectionStepsReorder(ctx, sectionId, partId) {
//   const secRes = await pool.query(
//     `SELECT id, title FROM internship_sections WHERE id = $1 LIMIT 1`,
//     [sectionId]
//   );
//   if (!secRes.rows.length) return ctx.reply("Раздел не найден.");
//   const sec = secRes.rows[0];

//   const stepRes = await pool.query(
//     `
//       SELECT id, title, order_index
//       FROM internship_steps
//       WHERE section_id = $1
//       ORDER BY order_index ASC, id ASC
//     `,
//     [sectionId]
//   );
//   const steps = stepRes.rows;

//   let text =
//     `🎯 Этапы (режим изменения порядка)

// ` +
//     `Раздел: ${sec.title}

// ` +
//     `Нажимай стрелки ⬆️ / ⬇️ рядом с этапами, затем нажми «✅ Закончить».
// `;

//   const buttons = [];

//   for (const st of steps) {
//     const row = [];
//     row.push(Markup.button.callback(`${st.title}`, "noop"));
//     row.push(
//       Markup.button.callback(
//         "⬆️",
//         `admin_internship_step_move_up_${sectionId}_${st.id}_${partId}`
//       )
//     );
//     row.push(
//       Markup.button.callback(
//         "⬇️",
//         `admin_internship_step_move_down_${sectionId}_${st.id}_${partId}`
//       )
//     );
//     buttons.push(row);
//   }

//   buttons.push([
//     Markup.button.callback(
//       "✅ Закончить изменение порядка",
//       `admin_internship_steps_reorder_done_${sectionId}_${partId}`
//     ),
//   ]);
//   buttons.push([
//     Markup.button.callback(
//       "🔙 К этапам",
//       `admin_internship_section_steps_${sectionId}_${partId}`
//     ),
//   ]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // настройки конкретного ЭТАПА
// async function showInternshipStepSettings(ctx, stepId, sectionId, partId) {
//   const hasStepTelegraph = await columnExists(
//     "internship_steps",
//     "telegraph_url"
//   );
//   const hasStepDuration = await columnExists(
//     "internship_steps",
//     "planned_duration_min"
//   );

//   const cols = ["id", "title", "step_type", "order_index"];
//   if (hasStepTelegraph) cols.push("telegraph_url");
//   if (hasStepDuration) cols.push("planned_duration_min");

//   const sRes = await pool.query(
//     `SELECT ${cols.join(", ")} FROM internship_steps WHERE id = $1 LIMIT 1`,
//     [stepId]
//   );
//   if (!sRes.rows.length) return ctx.reply("Этап не найден.");
//   const st = sRes.rows[0];

//   const typeLabel =
//     st.step_type === "video"
//       ? "Видео"
//       : st.step_type === "photo"
//       ? "Фото"
//       : "Обычная кнопка";

//   let text =
//     `Этап стажировки:
// ` +
//     `Название: ${st.title}
// ` +
//     `Тип: ${typeLabel}
// `;

//   if (hasStepTelegraph) {
//     text += `Telegraph: ${st.telegraph_url ? "✅ прикреплён" : "❌ нет"}
// `;
//   }
//   if (hasStepDuration) {
//     text += `Срок: ${
//       st.planned_duration_min ? `${st.planned_duration_min} мин.` : "не указан"
//     }
// `;
//   }

//   const rows = [];

//   rows.push([
//     Markup.button.callback(
//       "✏️ Переименовать этап",
//       `admin_internship_step_rename2_${st.id}_${sectionId}_${partId}`
//     ),
//   ]);

//   if (hasStepTelegraph) {
//     rows.push([
//       Markup.button.callback(
//         "📝 Telegraph (для этапа)",
//         `admin_internship_step_telegraph_${st.id}_${sectionId}_${partId}`
//       ),
//     ]);
//   }

//   if (hasStepDuration) {
//     rows.push([
//       Markup.button.callback(
//         st.planned_duration_min
//           ? `⏱ Изменить срок этапа (${st.planned_duration_min} мин.)`
//           : "⏱ Добавить срок этапа",
//         `admin_internship_step_duration_${st.id}_${sectionId}_${partId}`
//       ),
//     ]);
//   }

//   rows.push([
//     Markup.button.callback(
//       "🗑 Удалить этап",
//       `admin_internship_step_del2_${st.id}_${sectionId}_${partId}`
//     ),
//   ]);

//   rows.push([
//     Markup.button.callback(
//       "🔙 К этапам раздела",
//       `admin_internship_section_steps_${sectionId}_${partId}`
//     ),
//   ]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(rows) },
//     { edit: true }
//   );
// }

// function registerInternship(bot, ensureUser, logError, showMainMenu) {
//   // заглушка для кнопок без действия (чтобы Telegram не крутил "часики")
//   bot.action("noop", async (ctx) => {
//     await ctx.answerCbQuery().catch(() => {});
//   });

//   bot.action(
//     /^admin_internship_section_prev_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const sessionId = parseInt(ctx.match[1], 10);
//         const sectionId = parseInt(ctx.match[2], 10);
//         const userId = parseInt(ctx.match[3], 10);

//         const cur = await pool.query(
//           `SELECT part_id, order_index FROM internship_sections WHERE id=$1`,
//           [sectionId]
//         );
//         if (!cur.rows.length) return;

//         const prev = await pool.query(
//           `SELECT id FROM internship_sections WHERE part_id=$1 AND order_index < $2 ORDER BY order_index DESC LIMIT 1`,
//           [cur.rows[0].part_id, cur.rows[0].order_index]
//         );
//         if (!prev.rows.length) return;

//         await showSessionSection(ctx, sessionId, prev.rows[0].id, userId, {
//           edit: true,
//         });
//       } catch (err) {
//         logError("admin_internship_section_prev_x", err);
//       }
//     }
//   );

//   bot.action(/^admin_internship_section_duration_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sectionId = parseInt(ctx.match[1], 10);
//       const partId = parseInt(ctx.match[2], 10);

//       configStates.set(ctx.from.id, {
//         mode: "await_section_duration",
//         sectionId,
//         partId,
//       });

//       await deliver(
//         ctx,
//         {
//           text: "📅 Введите срок для раздела в днях (целое число). Чтобы очистить — пришлите: -",
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_internship_section_duration_x", err);
//     }
//   });

//   bot.action(
//     /^admin_internship_section_next_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         const sessionId = parseInt(ctx.match[1], 10);
//         const sectionId = parseInt(ctx.match[2], 10);
//         const userId = parseInt(ctx.match[3], 10);

//         // проверяем, что все этапы секции пройдены
//         const stepsRes = await pool.query(
//           `SELECT id FROM internship_steps WHERE section_id=$1`,
//           [sectionId]
//         );
//         const stepIds = stepsRes.rows.map((r) => r.id);
//         const stepMap = await getSessionStepMap(sessionId);

//         const allDone =
//           stepIds.length > 0 &&
//           stepIds.every((id) => stepMap.get(id)?.is_passed === true);
//         if (!allDone) {
//           await ctx
//             .answerCbQuery("Сначала отметьте выполнение всех этапов", {
//               show_alert: false,
//             })
//             .catch(() => {});
//           return;
//         }

//         await ctx.answerCbQuery().catch(() => {});

//         const cur = await pool.query(
//           `SELECT part_id, order_index FROM internship_sections WHERE id=$1`,
//           [sectionId]
//         );
//         if (!cur.rows.length) return;

//         const next = await pool.query(
//           `SELECT id FROM internship_sections WHERE part_id=$1 AND order_index > $2 ORDER BY order_index ASC LIMIT 1`,
//           [cur.rows[0].part_id, cur.rows[0].order_index]
//         );
//         if (!next.rows.length) return;

//         await showSessionSection(ctx, sessionId, next.rows[0].id, userId, {
//           edit: true,
//         });
//       } catch (err) {
//         logError("admin_internship_section_next_x", err);
//       }
//     }
//   );

//   bot.action(
//     /^admin_internship_session_section_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const sessionId = parseInt(ctx.match[1], 10);
//         const sectionId = parseInt(ctx.match[2], 10);
//         const userId = parseInt(ctx.match[3], 10);
//         await showSessionSection(ctx, sessionId, sectionId, userId, {
//           edit: true,
//         });
//       } catch (err) {
//         logError("admin_internship_session_section_x", err);
//       }
//     }
//   );

//   // кнопка в карточке пользователя
//   bot.action(/^admin_user_internship_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;
//       const userId = parseInt(ctx.match[1], 10);
//       await showUserInternshipMenu(ctx, admin, userId);
//     } catch (err) {
//       logError("admin_user_internship_x", err);
//     }
//   });

//   // данные о стажировке
//   bot.action(/^admin_internship_data_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;
//       const userId = parseInt(ctx.match[1], 10);
//       await showUserInternshipData(ctx, userId);
//     } catch (err) {
//       logError("admin_internship_data_x", err);
//     }
//   });

//   // 📊 Успеваемость
//   bot.action(/^admin_internship_perf_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       await showUserInternshipPerformance(ctx, userId);
//     } catch (err) {
//       logError("admin_internship_perf_x", err);
//     }
//   });

//   // 📊 Успеваемость: открыть часть
//   bot.action(/^admin_internship_perf_part_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       const partId = parseInt(ctx.match[2], 10);

//       await showUserInternshipPerformancePart(ctx, userId, partId);
//     } catch (err) {
//       logError("admin_internship_perf_part_x", err);
//     }
//   });

//   // ℹ️ Детали стажировки
//   bot.action(/^admin_internship_details_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       await showUserInternshipDetails(ctx, userId);
//     } catch (err) {
//       logError("admin_internship_details_x", err);
//     }
//   });

//   // выбор дня в "📊 Успеваемость"
//   bot.action(/^admin_internship_history_day_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sessionId = parseInt(ctx.match[1], 10);
//       const userId = parseInt(ctx.match[2], 10);
//       await showUserInternshipHistoryDay(ctx, admin, userId, sessionId);
//     } catch (err) {
//       logError("admin_internship_history_day_x", err);
//     }
//   });

//   // выбор дня в "ℹ️ Детали стажировки"
//   bot.action(/^admin_internship_details_day_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sessionId = parseInt(ctx.match[1], 10);
//       const userId = parseInt(ctx.match[2], 10);
//       await showUserInternshipDetailsDay(ctx, admin, userId, sessionId);
//     } catch (err) {
//       logError("admin_internship_details_day_x", err);
//     }
//   });

//   // выбор конкретного дня стажировки из истории
//   bot.action(/^admin_internship_history_day_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sessionId = parseInt(ctx.match[1], 10);
//       const userId = parseInt(ctx.match[2], 10);

//       await showUserInternshipHistoryDay(ctx, admin, userId, sessionId);
//     } catch (err) {
//       logError("admin_internship_history_day_x", err);
//     }
//   });

//   // старт дня стажировки: шаг 1 — выбор торговой точки
//   bot.action(/^admin_internship_start_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;
//       const userId = parseInt(ctx.match[1], 10);
//       await askStartInternshipTradePoint(ctx, admin, userId);
//     } catch (err) {
//       logError("admin_internship_start_x", err);
//     }
//   });

//   // старт: шаг 2 — выбрана торговая точка
//   bot.action(/^admin_internship_start_tp_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       const tradePointId = parseInt(ctx.match[2], 10);

//       await askStartInternshipLate(ctx, admin, userId, tradePointId);
//     } catch (err) {
//       logError("admin_internship_start_tp_x", err);
//     }
//   });

//   // старт: шаг 3 — ответ на вопрос об опоздании
//   bot.action(
//     /^admin_internship_start_late_(yes|no)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const answer = ctx.match[1]; // "yes" или "no"
//         const userId = parseInt(ctx.match[2], 10);
//         const tradePointId = parseInt(ctx.match[3], 10);

//         // вопрос: "Стажёр пришёл вовремя?"
//         // yes => опоздания НЕ было; no => опоздание было
//         const wasLate = answer === "no";

//         await startInternshipSession(ctx, admin, userId, tradePointId, wasLate);
//       } catch (err) {
//         logError("admin_internship_start_late_x", err);
//       }
//     }
//   );
//   // часть с этапами
//   bot.action(
//     /^admin_internship_session_part_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;
//         const sessionId = parseInt(ctx.match[1], 10);
//         const partId = parseInt(ctx.match[2], 10);
//         const userId = parseInt(ctx.match[3], 10);
//         await showSessionPartSections(ctx, sessionId, partId, userId, {
//           edit: true,
//         });
//       } catch (err) {
//         logError("admin_internship_session_part_x", err);
//       }
//     }
//   );

//   bot.action(
//     /^admin_internship_session_part_sections_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const sessionId = parseInt(ctx.match[1], 10);
//         const partId = parseInt(ctx.match[2], 10);
//         const userId = parseInt(ctx.match[3], 10);
//         await showSessionPartSections(ctx, sessionId, partId, userId, {
//           edit: true,
//         });
//       } catch (err) {
//         logError("admin_internship_session_part_sections_x", err);
//       }
//     }
//   );

//   // toggle простого этапа
//   // Формат callback (новый): admin_internship_step_toggle_{sessionId}_{sectionId}_{stepId}_{userId}
//   // Старый формат тоже поддерживаем: admin_internship_step_toggle_{sessionId}_{stepId}_{partId}_{userId}
//   bot.action(
//     /^admin_internship_step_toggle_(\d+)_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const sessionId = parseInt(ctx.match[1], 10);
//         const a = parseInt(ctx.match[2], 10);
//         const b = parseInt(ctx.match[3], 10);
//         const userId = parseInt(ctx.match[4], 10);

//         let sectionId = a;
//         let stepId = b;

//         // если это старый формат, то (a=stepId, b=partId)
//         // пробуем понять по данным: у stepId должен быть section_id = sectionId
//         const check = await pool.query(
//           `SELECT id, section_id FROM internship_steps WHERE id = $1 LIMIT 1`,
//           [stepId]
//         );

//         if (!check.rows.length || check.rows[0].section_id !== sectionId) {
//           // старый формат
//           stepId = a;
//           const stepRes = await pool.query(
//             `SELECT section_id FROM internship_steps WHERE id = $1 LIMIT 1`,
//             [stepId]
//           );
//           sectionId = stepRes.rows[0]?.section_id || null;
//         }

//         if (!sectionId) {
//           await ctx.reply(
//             "Не удалось определить раздел для этого этапа (section_id пуст)."
//           );
//           return;
//         }

//         await toggleSimpleStep(sessionId, stepId, admin.id);
//         await showSessionSection(ctx, sessionId, sectionId, userId, {
//           edit: true,
//         });
//       } catch (err) {
//         logError("admin_internship_step_toggle_x", err);
//       }
//     }
//   );

//   // запрос / просмотр медиа для этапа
//   // Формат callback (новый): admin_internship_step_media_{sessionId}_{sectionId}_{stepId}_{userId}
//   // Старый формат тоже поддерживаем: admin_internship_step_media_{sessionId}_{stepId}_{partId}_{userId}
//   bot.action(
//     /^admin_internship_step_media_(\d+)_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const sessionId = parseInt(ctx.match[1], 10);
//         const a = parseInt(ctx.match[2], 10);
//         const b = parseInt(ctx.match[3], 10);
//         const userId = parseInt(ctx.match[4], 10);

//         let sectionId = a;
//         let stepId = b;

//         // определить формат (новый/старый)
//         const check = await pool.query(
//           `SELECT id, section_id, step_type, title FROM internship_steps WHERE id = $1 LIMIT 1`,
//           [stepId]
//         );

//         let stepRow = check.rows[0] || null;

//         if (!stepRow || stepRow.section_id !== sectionId) {
//           // старый формат
//           stepId = a;
//           const stepRes = await pool.query(
//             `SELECT id, section_id, step_type, title FROM internship_steps WHERE id = $1 LIMIT 1`,
//             [stepId]
//           );
//           stepRow = stepRes.rows[0] || null;
//           sectionId = stepRow?.section_id || null;
//         }

//         if (!stepRow) {
//           await ctx.reply("Этап не найден.");
//           return;
//         }
//         if (!sectionId) {
//           await ctx.reply(
//             "Не удалось определить раздел для этого этапа (section_id пуст)."
//           );
//           return;
//         }

//         // если вдруг по ошибке сюда пришёл simple — просто переключим
//         if (stepRow.step_type === "simple") {
//           await toggleSimpleStep(sessionId, stepId, admin.id);
//           await showSessionSection(ctx, sessionId, sectionId, userId, {
//             edit: true,
//           });
//           return;
//         }

//         // проверяем, есть ли уже сохранённое медиа
//         const rRes = await pool.query(
//           `
//         SELECT media_file_id
//         FROM internship_step_results
//         WHERE session_id = $1 AND step_id = $2
//       `,
//           [sessionId, stepId]
//         );
//         const existingFileId = rRes.rows[0]?.media_file_id || null;

//         if (existingFileId) {
//           // показываем текущее медиа и предлагаем заменить
//           if (stepRow.step_type === "video") {
//             await ctx.replyWithVideo(existingFileId, {
//               caption: `Сейчас для этапа "${stepRow.title}" сохранено это видео.`,
//             });
//           } else if (stepRow.step_type === "photo") {
//             await ctx.replyWithPhoto(existingFileId, {
//               caption: `Сейчас для этапа "${stepRow.title}" сохранено это фото.`,
//             });
//           }

//           const keyboard = Markup.inlineKeyboard([
//             [
//               Markup.button.callback(
//                 "🔁 Заменить файл",
//                 `admin_internship_step_media_replace_${sessionId}_${sectionId}_${stepId}_${userId}`
//               ),
//             ],
//             [
//               Markup.button.callback(
//                 "🔙 Назад к этапам",
//                 `admin_internship_session_section_${sessionId}_${sectionId}_${userId}`
//               ),
//             ],
//           ]);

//           await ctx.reply("Ты можешь оставить это медиа или заменить его.", {
//             reply_markup: keyboard.reply_markup,
//           });
//           return;
//         }

//         // если медиа ещё нет — сразу просим отправить
//         const typeText =
//           stepRow.step_type === "video"
//             ? "видео"
//             : stepRow.step_type === "photo"
//             ? "фото"
//             : "медиа";

//         await ctx.reply(
//           `Отправь ${typeText} для этапа:\n"${stepRow.title}"\n\nКак только файл будет получен, этап автоматически отметится как ✅.`
//         );

//         mediaStates.set(ctx.from.id, {
//           sessionId,
//           sectionId,
//           stepId,
//           type: stepRow.step_type,
//           userId,
//         });
//       } catch (err) {
//         logError("admin_internship_step_media_x", err);
//       }
//     }
//   );

//   // завершить день: шаг 1 — спрашиваем про замечания
//   bot.action(/^admin_internship_finish_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sessionId = parseInt(ctx.match[1], 10);
//       const userId = parseInt(ctx.match[2], 10);

//       finishSessionStates.delete(ctx.from.id);

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "Да, были",
//             `admin_internship_finish_issues_yes_${sessionId}_${userId}`
//           ),
//         ],
//         [
//           Markup.button.callback(
//             "Нет",
//             `admin_internship_finish_issues_no_${sessionId}_${userId}`
//           ),
//         ],
//         [
//           Markup.button.callback(
//             "🔙 Отмена",
//             `admin_user_internship_${userId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text: "Были ли замечания по стажёру в этот день стажировки?",
//           extra: keyboard,
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_internship_finish_x", err);
//     }
//   });

//   // шаг 2а — ответ "Да, были": ждём текст замечаний
//   bot.action(
//     /^admin_internship_finish_issues_yes_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const sessionId = parseInt(ctx.match[1], 10);
//         const userId = parseInt(ctx.match[2], 10);

//         finishSessionStates.set(ctx.from.id, {
//           mode: "await_issues_text",
//           sessionId,
//           userId,
//           issuesText: null,
//         });

//         await ctx.reply(
//           "Напиши замечания по стажёру одним сообщением (что именно было не так)."
//         );
//       } catch (err) {
//         logError("admin_internship_finish_issues_yes_x", err);
//       }
//     }
//   );

//   // шаг 2б — ответ "Нет": сразу переходим к комментарию
//   bot.action(/^admin_internship_finish_issues_no_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sessionId = parseInt(ctx.match[1], 10);
//       const userId = parseInt(ctx.match[2], 10);

//       finishSessionStates.set(ctx.from.id, {
//         mode: "await_comment_text",
//         sessionId,
//         userId,
//         issuesText: null,
//       });

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "Комментариев нет",
//             `admin_internship_finish_comment_none_${sessionId}_${userId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text: "Оставьте общий комментарий по стажировке (как прошёл день) или нажмите «Комментариев нет».",
//           extra: keyboard,
//         },
//         { edit: false }
//       );
//     } catch (err) {
//       logError("admin_internship_finish_issues_no_x", err);
//     }
//   });

//   // шаг 3 — выбрано "Комментариев нет"
//   bot.action(
//     /^admin_internship_finish_comment_none_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const sessionId = parseInt(ctx.match[1], 10);
//         const userId = parseInt(ctx.match[2], 10);

//         const state = finishSessionStates.get(ctx.from.id);
//         const issuesText = state?.issuesText || null;

//         finishSessionStates.delete(ctx.from.id);

//         await finishInternshipSession(ctx, sessionId, userId, issuesText, null);
//         await showUserInternshipMenu(ctx, admin, userId);
//       } catch (err) {
//         logError("admin_internship_finish_comment_none_x", err);
//       }
//     }
//   );

//   // режим "заменить файл" для медиа-этапа
//   // Формат callback (новый): admin_internship_step_media_replace_{sessionId}_{sectionId}_{stepId}_{userId}
//   // Старый формат тоже поддерживаем: admin_internship_step_media_replace_{sessionId}_{stepId}_{partId}_{userId}
//   bot.action(
//     /^admin_internship_step_media_replace_(\d+)_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const sessionId = parseInt(ctx.match[1], 10);
//         const a = parseInt(ctx.match[2], 10);
//         const b = parseInt(ctx.match[3], 10);
//         const userId = parseInt(ctx.match[4], 10);

//         let sectionId = a;
//         let stepId = b;

//         // определить формат
//         const chk = await pool.query(
//           `SELECT id, section_id, step_type, title FROM internship_steps WHERE id = $1 LIMIT 1`,
//           [stepId]
//         );
//         let stepRow = chk.rows[0] || null;

//         if (!stepRow || stepRow.section_id !== sectionId) {
//           // старый формат
//           stepId = a;
//           const stepRes = await pool.query(
//             `SELECT id, section_id, step_type, title FROM internship_steps WHERE id = $1 LIMIT 1`,
//             [stepId]
//           );
//           stepRow = stepRes.rows[0] || null;
//           sectionId = stepRow?.section_id || null;
//         }

//         if (!stepRow) {
//           await ctx.reply("Этап не найден.");
//           return;
//         }
//         if (!sectionId) {
//           await ctx.reply(
//             "Не удалось определить раздел для этого этапа (section_id пуст)."
//           );
//           return;
//         }

//         const typeText =
//           stepRow.step_type === "video"
//             ? "видео"
//             : stepRow.step_type === "photo"
//             ? "фото"
//             : "медиа";

//         await ctx.reply(
//           `Отправь новое ${typeText} для этапа:\n"${stepRow.title}"\n\nТекущий файл будет заменён, этап останется отмеченным как ✅.`
//         );

//         mediaStates.set(ctx.from.id, {
//           sessionId,
//           sectionId,
//           stepId,
//           type: stepRow.step_type,
//           userId,
//         });
//       } catch (err) {
//         logError("admin_internship_step_media_replace_x", err);
//       }
//     }
//   );

//   // отменить день — сначала спрашиваем подтверждение
//   bot.action(/^admin_internship_cancel_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sessionId = parseInt(ctx.match[1], 10);
//       const userId = parseInt(ctx.match[2], 10);

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "🗑 Да, отменить день",
//             `admin_internship_cancel_confirm_${sessionId}_${userId}`
//           ),
//         ],
//         [
//           Markup.button.callback(
//             "🔙 Не отменять",
//             `admin_user_internship_${userId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text: "Точно отменить текущий день стажировки? День не будет засчитан.",
//           extra: keyboard,
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_internship_cancel_x", err);
//     }
//   });

//   bot.action(/^admin_internship_cancel_confirm_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sessionId = parseInt(ctx.match[1], 10);
//       const userId = parseInt(ctx.match[2], 10);

//       await cancelInternshipSession(ctx, sessionId);
//       await showUserInternshipMenu(ctx, admin, userId);
//     } catch (err) {
//       logError("admin_internship_cancel_confirm_x", err);
//     }
//   });

//   // документ части (пользовательская часть)
//   bot.action(/^admin_internship_part_doc_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const partId = parseInt(ctx.match[1], 10);
//       const res = await pool.query(
//         "SELECT title, doc_file_id FROM internship_parts WHERE id = $1",
//         [partId]
//       );
//       if (!res.rows.length || !res.rows[0].doc_file_id) {
//         await ctx.reply("Для этой части пока не прикреплён документ.");
//         return;
//       }

//       const part = res.rows[0];

//       // отправляем ссылку (Telegram покажет превью)
//       await ctx.reply(`📚 Теория (Telegraph):\n${part.doc_file_id}`);

//       // (опционально) кнопка открыть
//       await ctx.reply(
//         "Открыть:",
//         Markup.inlineKeyboard([
//           [Markup.button.url("⚡️ открыть Telegraph", part.doc_file_id)],
//         ])
//       );
//     } catch (err) {
//       logError("admin_internship_part_doc_x", err);
//     }
//   });

//   // ===== НАСТРОЙКА В АДМИН‑ПАНЕЛИ =====

//   bot.action("admin_internship_menu", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;
//       configStates.delete(ctx.from.id);
//       await showInternshipConfigMenu(ctx);
//     } catch (err) {
//       logError("admin_internship_menu_x", err);
//     }
//   });

//   bot.action("admin_internship_part_new", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       configStates.set(ctx.from.id, { mode: "new_part" });

//       await ctx.reply(
//         "Отправь название новой части стажировки одним сообщением."
//       );
//     } catch (err) {
//       logError("admin_internship_part_new_x", err);
//     }
//   });

//   bot.action(/^admin_internship_part_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;
//       configStates.delete(ctx.from.id);

//       const partId = parseInt(ctx.match[1], 10);
//       await showInternshipPart(ctx, partId);
//     } catch (err) {
//       logError("admin_internship_part_x", err);
//     }
//   });

//   // изменить порядок разделов внутри части
//   bot.action(/^admin_internship_part_sections_reorder_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;
//       const partId = parseInt(ctx.match[1], 10);
//       await showInternshipPartSectionsReorder(ctx, partId);
//     } catch (err) {
//       logError("admin_internship_part_sections_reorder_x", err);
//     }
//   });

//   bot.action(
//     /^admin_internship_part_sections_reorder_done_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;
//         const partId = parseInt(ctx.match[1], 10);
//         await showInternshipPart(ctx, partId);
//       } catch (err) {
//         logError("admin_internship_part_sections_reorder_done_x", err);
//       }
//     }
//   );

//   bot.action(
//     /^admin_internship_section_move_(up|down)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const dir = ctx.match[1];
//         const partId = parseInt(ctx.match[2], 10);
//         const sectionId = parseInt(ctx.match[3], 10);

//         await swapOrderIndex({
//           table: "internship_sections",
//           id: sectionId,
//           scopeWhereSql: "part_id = $1",
//           scopeParams: [partId],
//           dir,
//         });

//         await showInternshipPartSectionsReorder(ctx, partId);
//       } catch (err) {
//         logError("admin_internship_section_move_x", err);
//       }
//     }
//   );

//   // список этапов раздела
//   bot.action(/^admin_internship_section_steps_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sectionId = parseInt(ctx.match[1], 10);
//       const partId = parseInt(ctx.match[2], 10);

//       await showInternshipSectionSteps(ctx, sectionId, partId);
//     } catch (err) {
//       logError("admin_internship_section_steps_x", err);
//     }
//   });

//   // режим изменения порядка этапов
//   bot.action(/^admin_internship_steps_reorder_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sectionId = parseInt(ctx.match[1], 10);
//       const partId = parseInt(ctx.match[2], 10);

//       await showInternshipSectionStepsReorder(ctx, sectionId, partId);
//     } catch (err) {
//       logError("admin_internship_steps_reorder_x", err);
//     }
//   });

//   bot.action(
//     /^admin_internship_steps_reorder_done_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const sectionId = parseInt(ctx.match[1], 10);
//         const partId = parseInt(ctx.match[2], 10);

//         await showInternshipSectionSteps(ctx, sectionId, partId);
//       } catch (err) {
//         logError("admin_internship_steps_reorder_done_x", err);
//       }
//     }
//   );

//   bot.action(
//     /^admin_internship_step_move_(up|down)_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const dir = ctx.match[1];
//         const sectionId = parseInt(ctx.match[2], 10);
//         const stepId = parseInt(ctx.match[3], 10);
//         const partId = parseInt(ctx.match[4], 10);

//         await swapOrderIndex({
//           table: "internship_steps",
//           id: stepId,
//           scopeWhereSql: "section_id = $1",
//           scopeParams: [sectionId],
//           dir,
//         });

//         await showInternshipSectionStepsReorder(ctx, sectionId, partId);
//       } catch (err) {
//         logError("admin_internship_step_move_x", err);
//       }
//     }
//   );

//   // настройки этапа
//   bot.action(/^admin_internship_step_edit_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const stepId = parseInt(ctx.match[1], 10);
//       const sectionId = parseInt(ctx.match[2], 10);
//       const partId = parseInt(ctx.match[3], 10);

//       configStates.delete(ctx.from.id);
//       await showInternshipStepSettings(ctx, stepId, sectionId, partId);
//     } catch (err) {
//       logError("admin_internship_step_edit_x", err);
//     }
//   });

//   bot.action(
//     /^admin_internship_step_telegraph_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const stepId = parseInt(ctx.match[1], 10);
//         const sectionId = parseInt(ctx.match[2], 10);
//         const partId = parseInt(ctx.match[3], 10);

//         // если колонки нет — просто не даём включить
//         const ok = await columnExists("internship_steps", "telegraph_url");
//         if (!ok) {
//           await ctx.reply(
//             "В таблице internship_steps нет колонки telegraph_url. Добавь её, если хочешь Telegraph для этапов."
//           );
//           return;
//         }

//         configStates.set(ctx.from.id, {
//           mode: "await_step_telegraph",
//           stepId,
//           sectionId,
//           partId,
//         });

//         await deliver(
//           ctx,
//           {
//             text:
//               "📝 Пришли ссылку Telegraph для этого этапа одним сообщением.\n\n" +
//               "Пример: https://telegra.ph/....\n" +
//               "Чтобы очистить — пришли: -",
//           },
//           { edit: true }
//         );
//       } catch (err) {
//         logError("admin_internship_step_telegraph_x", err);
//       }
//     }
//   );

//   bot.action(
//     /^admin_internship_step_duration_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const stepId = parseInt(ctx.match[1], 10);
//         const sectionId = parseInt(ctx.match[2], 10);
//         const partId = parseInt(ctx.match[3], 10);

//         const ok = await columnExists(
//           "internship_steps",
//           "planned_duration_min"
//         );
//         if (!ok) {
//           await ctx.reply(
//             "В таблице internship_steps нет колонки planned_duration_min."
//           );
//           return;
//         }

//         configStates.set(ctx.from.id, {
//           mode: "await_step_duration",
//           stepId,
//           sectionId,
//           partId,
//         });

//         await deliver(
//           ctx,
//           {
//             text: "⏱ Введите срок этапа в минутах (целое число). Чтобы очистить — пришлите: -",
//           },
//           { edit: true }
//         );
//       } catch (err) {
//         logError("admin_internship_step_duration_x", err);
//       }
//     }
//   );

//   bot.action(
//     /^admin_internship_step_rename2_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const stepId = parseInt(ctx.match[1], 10);
//         const sectionId = parseInt(ctx.match[2], 10);
//         const partId = parseInt(ctx.match[3], 10);

//         configStates.set(ctx.from.id, {
//           mode: "rename_step2",
//           stepId,
//           sectionId,
//           partId,
//         });
//         await ctx.reply("Отправь новое название этапа одним сообщением.");
//       } catch (err) {
//         logError("admin_internship_step_rename2_x", err);
//       }
//     }
//   );

//   bot.action(/^admin_internship_step_del2_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const stepId = parseInt(ctx.match[1], 10);
//       const sectionId = parseInt(ctx.match[2], 10);
//       const partId = parseInt(ctx.match[3], 10);

//       await pool.query("DELETE FROM internship_steps WHERE id = $1", [stepId]);
//       await showInternshipSectionSteps(ctx, sectionId, partId);
//     } catch (err) {
//       logError("admin_internship_step_del2_x", err);
//     }
//   });

//   // ===== РАЗДЕЛЫ (админка настройки стажировки) =====

//   bot.action(/^admin_internship_section_new_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const partId = parseInt(ctx.match[1], 10);
//       configStates.set(ctx.from.id, {
//         mode: "new_section_title",
//         partId,
//       });

//       await ctx.reply("Отправь название нового раздела одним сообщением.");
//     } catch (err) {
//       logError("admin_internship_section_new_x", err);
//     }
//   });

//   bot.action(/^admin_internship_section_edit_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sectionId = parseInt(ctx.match[1], 10);
//       const partId = parseInt(ctx.match[2], 10);
//       configStates.delete(ctx.from.id);

//       await showInternshipSection(ctx, sectionId, partId);
//     } catch (err) {
//       logError("admin_internship_section_edit_x", err);
//     }
//   });

//   bot.action(
//     /^admin_internship_section_telegraph_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const sectionId = parseInt(ctx.match[1], 10);
//         const partId = parseInt(ctx.match[2], 10);

//         configStates.set(ctx.from.id, {
//           mode: "await_section_telegraph",
//           sectionId,
//           partId,
//         });

//         await deliver(
//           ctx,
//           {
//             text:
//               "📝 Пришли ссылку Telegraph для этого раздела одним сообщением.\n\n" +
//               "Пример: https://telegra.ph/....\n" +
//               "Чтобы очистить — пришли: -",
//           },
//           { edit: true }
//         );
//       } catch (err) {
//         logError("admin_internship_section_telegraph_x", err);
//       }
//     }
//   );

//   bot.action(/^admin_internship_section_rename_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sectionId = parseInt(ctx.match[1], 10);
//       const partId = parseInt(ctx.match[2], 10);

//       configStates.set(ctx.from.id, {
//         mode: "rename_section",
//         sectionId,
//         partId,
//       });

//       await ctx.reply("Отправь новое название раздела одним сообщением.");
//     } catch (err) {
//       logError("admin_internship_section_rename_x", err);
//     }
//   });

//   // NOTE: старые admin_internship_section_up/down удалены.
//   // Порядок разделов меняем только через режим "🔁 Изменить последовательность".

//   bot.action(/^admin_internship_section_del_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sectionId = parseInt(ctx.match[1], 10);
//       const partId = parseInt(ctx.match[2], 10);

//       await pool.query(`DELETE FROM internship_sections WHERE id=$1`, [
//         sectionId,
//       ]);
//       await showInternshipPart(ctx, partId);
//     } catch (err) {
//       logError("admin_internship_section_del_x", err);
//     }
//   });

//   bot.action(/^admin_internship_part_del_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const partId = parseInt(ctx.match[1], 10);
//       await pool.query("DELETE FROM internship_parts WHERE id = $1", [partId]);
//       configStates.delete(ctx.from.id);
//       await showInternshipConfigMenu(ctx);
//     } catch (err) {
//       logError("admin_internship_part_del_x", err);
//     }
//   });

//   bot.action(/^admin_internship_part_doc_edit_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const partId = parseInt(ctx.match[1], 10);

//       configStates.set(ctx.from.id, { mode: "await_part_telegraph", partId });

//       await deliver(
//         ctx,
//         {
//           text:
//             "📝 Пришли ссылку Telegraph для этой части одним сообщением.\n\n" +
//             "Пример: https://telegra.ph/....\n" +
//             "Чтобы очистить — пришли: -",
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_internship_part_doc_edit_x", err);
//     }
//   });

//   bot.action(/^admin_internship_step_new_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const sectionId = parseInt(ctx.match[1], 10);
//       const partId = parseInt(ctx.match[2], 10);

//       configStates.set(ctx.from.id, {
//         mode: "new_step_title",
//         partId,
//         sectionId,
//       });

//       await ctx.reply(
//         "Отправь название нового этапа стажировки одним сообщением."
//       );
//     } catch (err) {
//       logError("admin_internship_step_new_x", err);
//     }
//   });

//   // текстовые шаги конфигурации + завершение стажировки
//   bot.on("text", async (ctx, next) => {
//     try {
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return next();

//       const raw = (ctx.message.text || "").trim();
//       if (!raw) return next();

//       // ---------- завершение стажировки (замечания / комментарий) ----------
//       const finishState = finishSessionStates.get(ctx.from.id);
//       if (finishState) {
//         // сначала ждём текст замечаний
//         if (finishState.mode === "await_issues_text") {
//           const issuesText = raw;

//           finishSessionStates.set(ctx.from.id, {
//             ...finishState,
//             issuesText,
//             mode: "await_comment_text",
//           });

//           const keyboard = Markup.inlineKeyboard([
//             [
//               Markup.button.callback(
//                 "Комментариев нет",
//                 `admin_internship_finish_comment_none_${finishState.sessionId}_${finishState.userId}`
//               ),
//             ],
//           ]);

//           await ctx.reply(
//             "Оставьте общий комментарий по стажировке (как прошёл день) или нажмите «Комментариев нет».",
//             keyboard
//           );
//           return;
//         }

//         // затем ждём общий комментарий
//         if (finishState.mode === "await_comment_text") {
//           const { sessionId, userId, issuesText } = finishState;
//           const commentText = raw || null;

//           finishSessionStates.delete(ctx.from.id);

//           await finishInternshipSession(
//             ctx,
//             sessionId,
//             userId,
//             issuesText || null,
//             commentText
//           );
//           await showUserInternshipMenu(ctx, user, userId);
//           return;
//         }
//       }

//       // ---------- конфигурация стажировки (части / этапы) ----------
//       const state = configStates.get(ctx.from.id);
//       if (!state) return next();

//       const text = raw;

//       // === TELEGRAPH ДЛЯ ЧАСТИ ===
//       if (state.mode === "await_part_telegraph") {
//         // очистка
//         if (text === "-") {
//           await pool.query(
//             "UPDATE internship_parts SET doc_file_id = NULL WHERE id = $1",
//             [state.partId]
//           );
//           configStates.delete(ctx.from.id);
//           await ctx.reply("✅ Telegraph очищен.");
//           await showInternshipPart(ctx, state.partId);
//           return;
//         }

//         if (!isTelegraphUrl(text)) {
//           await ctx.reply(
//             "❌ Пришли ссылку Telegraph вида https://telegra.ph/..."
//           );
//           return;
//         }

//         await pool.query(
//           "UPDATE internship_parts SET doc_file_id = $1 WHERE id = $2",
//           [text, state.partId]
//         );

//         configStates.delete(ctx.from.id);
//         await ctx.reply("✅ Ссылка Telegraph сохранена.");
//         await showInternshipPart(ctx, state.partId);
//         return;
//       }

//       // === TELEGRAPH ДЛЯ РАЗДЕЛА ===
//       if (state.mode === "await_section_telegraph") {
//         if (text === "-") {
//           await pool.query(
//             "UPDATE internship_sections SET telegraph_url = NULL WHERE id = $1",
//             [state.sectionId]
//           );
//           configStates.delete(ctx.from.id);
//           await ctx.reply("✅ Telegraph очищен.");
//           await showInternshipPart(ctx, state.partId);
//           return;
//         }

//         if (!isTelegraphUrl(text)) {
//           await ctx.reply(
//             "❌ Пришли ссылку Telegraph вида https://telegra.ph/..."
//           );
//           return;
//         }

//         await pool.query(
//           "UPDATE internship_sections SET telegraph_url = $1 WHERE id = $2",
//           [text, state.sectionId]
//         );

//         configStates.delete(ctx.from.id);
//         await ctx.reply("✅ Ссылка Telegraph сохранена.");
//         await showInternshipPart(ctx, state.partId);
//         return;
//       }

//       // === СОЗДАНИЕ РАЗДЕЛА ===
//       if (state.mode === "new_section") {
//         const maxRes = await pool.query(
//           "SELECT COALESCE(MAX(order_index), 0) AS max FROM internship_sections WHERE part_id = $1",
//           [state.partId]
//         );
//         const nextIndex = Number(maxRes.rows[0].max || 0) + 1;

//         await pool.query(
//           `INSERT INTO internship_sections (part_id, title, order_index) VALUES ($1, $2, $3)`,
//           [state.partId, text, nextIndex]
//         );

//         configStates.delete(ctx.from.id);
//         await ctx.reply("Раздел добавлен.");
//         await showInternshipPart(ctx, state.partId);
//         return;
//       }

//       // === ПЕРЕИМЕНОВАНИЕ РАЗДЕЛА ===
//       if (state.mode === "rename_section") {
//         await pool.query(
//           "UPDATE internship_sections SET title = $1 WHERE id = $2",
//           [text, state.sectionId]
//         );
//         configStates.delete(ctx.from.id);
//         await ctx.reply("Название раздела обновлено.");
//         await showInternshipPart(ctx, state.partId);
//         return;
//       }

//       // === СРОК ДЛЯ РАЗДЕЛА (duration_days) ===
//       if (state.mode === "await_section_duration") {
//         if (text === "-") {
//           await pool.query(
//             "UPDATE internship_sections SET duration_days = NULL WHERE id = $1",
//             [state.sectionId]
//           );
//           configStates.delete(ctx.from.id);
//           await ctx.reply("✅ Срок очищен.");
//           await showInternshipSection(ctx, state.sectionId, state.partId);
//           return;
//         }

//         const days = parseInt(text, 10);
//         if (!Number.isInteger(days) || days <= 0) {
//           await ctx.reply("❌ Введите целое число > 0 (например: 3).");
//           return;
//         }

//         await pool.query(
//           "UPDATE internship_sections SET duration_days = $1 WHERE id = $2",
//           [days, state.sectionId]
//         );

//         configStates.delete(ctx.from.id);
//         await ctx.reply("✅ Срок сохранён.");
//         await showInternshipSection(ctx, state.sectionId, state.partId);
//         return;
//       }

//       // === TELEGRAPH ДЛЯ ЭТАПА ===
//       if (state.mode === "await_step_telegraph") {
//         const ok = await columnExists("internship_steps", "telegraph_url");
//         if (!ok) {
//           configStates.delete(ctx.from.id);
//           await ctx.reply(
//             "В таблице internship_steps нет колонки telegraph_url."
//           );
//           await showInternshipStepSettings(
//             ctx,
//             state.stepId,
//             state.sectionId,
//             state.partId
//           );
//           return;
//         }

//         if (text === "-") {
//           await pool.query(
//             "UPDATE internship_steps SET telegraph_url = NULL WHERE id = $1",
//             [state.stepId]
//           );
//           configStates.delete(ctx.from.id);
//           await ctx.reply("✅ Telegraph очищен.");
//           await showInternshipStepSettings(
//             ctx,
//             state.stepId,
//             state.sectionId,
//             state.partId
//           );
//           return;
//         }

//         if (!isTelegraphUrl(text)) {
//           await ctx.reply(
//             "❌ Пришли ссылку Telegraph вида https://telegra.ph/..."
//           );
//           return;
//         }

//         await pool.query(
//           "UPDATE internship_steps SET telegraph_url = $1 WHERE id = $2",
//           [text, state.stepId]
//         );

//         configStates.delete(ctx.from.id);
//         await ctx.reply("✅ Ссылка Telegraph сохранена.");
//         await showInternshipStepSettings(
//           ctx,
//           state.stepId,
//           state.sectionId,
//           state.partId
//         );
//         return;
//       }

//       // === СРОК ДЛЯ ЭТАПА (planned_duration_min) ===
//       if (state.mode === "await_step_duration") {
//         const ok = await columnExists(
//           "internship_steps",
//           "planned_duration_min"
//         );
//         if (!ok) {
//           configStates.delete(ctx.from.id);
//           await ctx.reply(
//             "В таблице internship_steps нет колонки planned_duration_min."
//           );
//           await showInternshipStepSettings(
//             ctx,
//             state.stepId,
//             state.sectionId,
//             state.partId
//           );
//           return;
//         }

//         if (text === "-") {
//           await pool.query(
//             "UPDATE internship_steps SET planned_duration_min = NULL WHERE id = $1",
//             [state.stepId]
//           );
//           configStates.delete(ctx.from.id);
//           await ctx.reply("✅ Срок очищен.");
//           await showInternshipStepSettings(
//             ctx,
//             state.stepId,
//             state.sectionId,
//             state.partId
//           );
//           return;
//         }

//         const mins = parseInt(text, 10);
//         if (!Number.isInteger(mins) || mins <= 0) {
//           await ctx.reply("❌ Введите целое число > 0 (например: 5).");
//           return;
//         }

//         await pool.query(
//           "UPDATE internship_steps SET planned_duration_min = $1 WHERE id = $2",
//           [mins, state.stepId]
//         );

//         configStates.delete(ctx.from.id);
//         await ctx.reply("✅ Срок сохранён.");
//         await showInternshipStepSettings(
//           ctx,
//           state.stepId,
//           state.sectionId,
//           state.partId
//         );
//         return;
//       }

//       // === ПЕРЕИМЕНОВАНИЕ ЭТАПА (новый экран) ===
//       if (state.mode === "rename_step2") {
//         await pool.query(
//           "UPDATE internship_steps SET title = $1 WHERE id = $2",
//           [text, state.stepId]
//         );
//         configStates.delete(ctx.from.id);
//         await ctx.reply("Название этапа обновлено.");
//         await showInternshipStepSettings(
//           ctx,
//           state.stepId,
//           state.sectionId,
//           state.partId
//         );
//         return;
//       }

//       if (state.mode === "new_part") {
//         const maxRes = await pool.query(
//           "SELECT COALESCE(MAX(order_index), 0) AS max FROM internship_parts"
//         );
//         const nextIndex = Number(maxRes.rows[0].max || 0) + 1;
//         const ins = await pool.query(
//           `
//           INSERT INTO internship_parts (title, order_index)
//           VALUES ($1, $2)
//           RETURNING id
//         `,
//           [text, nextIndex]
//         );
//         configStates.delete(ctx.from.id);
//         await ctx.reply(`Часть стажировки создана (id: ${ins.rows[0].id}).`);
//         await showInternshipConfigMenu(ctx);
//         return;
//       }

//       // 1) получили название этапа -> спрашиваем время в минутах
//       if (state.mode === "new_step_title") {
//         const title = text;
//         configStates.set(ctx.from.id, {
//           mode: "new_step_duration",
//           partId: state.partId,
//           sectionId: state.sectionId,
//           title,
//         });

//         await ctx.reply(
//           "⏳ Введите плановое время прохождения этого этапа (в минутах)."
//         );
//         return;
//       }

//       // 2) получили длительность -> спрашиваем тип этапа
//       if (state.mode === "new_step_duration") {
//         const minutes = parseInt(text, 10);
//         if (!Number.isFinite(minutes) || minutes <= 0) {
//           await ctx.reply(
//             "Пожалуйста, введите время в минутах числом, например: 5"
//           );
//           return;
//         }

//         configStates.set(ctx.from.id, {
//           mode: "new_step_type",
//           partId: state.partId,
//           sectionId: state.sectionId,
//           title: state.title,
//           durationMin: minutes,
//         });

//         const keyboard = Markup.inlineKeyboard([
//           [
//             Markup.button.callback(
//               "🔘 Обычная кнопка",
//               "internship_new_step_type_simple"
//             ),
//           ],
//           [
//             Markup.button.callback(
//               "🎥 Видео",
//               "internship_new_step_type_video"
//             ),
//           ],
//           [Markup.button.callback("📷 Фото", "internship_new_step_type_photo")],
//         ]);

//         await ctx.reply("Выбери тип нового этапа:", keyboard);
//         return;
//       }

//       // Создание нового раздела (админка)
//       if (state.mode === "new_section_title") {
//         const nextIndex = await getNextSectionOrderIndex(state.partId);
//         const ins = await pool.query(
//           `INSERT INTO internship_sections (part_id, title, order_index)
//            VALUES ($1, $2, $3) RETURNING id`,
//           [state.partId, text, nextIndex]
//         );
//         configStates.delete(ctx.from.id);
//         await ctx.reply(`Раздел создан (id: ${ins.rows[0].id}).`);
//         await showInternshipPart(ctx, state.partId);
//         return;
//       }

//       return next();
//     } catch (err) {
//       logError("internship_text_handler", err);
//       return next();
//     }
//   });

//   bot.action(/internship_new_step_type_(simple|video|photo)/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const state = configStates.get(ctx.from.id);
//       if (!state || state.mode !== "new_step_type") return;

//       const type = ctx.match[1];
//       const { partId, sectionId, title, durationMin } = state;

//       const maxRes = await pool.query(
//         "SELECT COALESCE(MAX(order_index), 0) AS max FROM internship_steps WHERE section_id = $1",
//         [sectionId]
//       );
//       const nextIndex = Number(maxRes.rows[0].max || 0) + 1;

//       await pool.query(
//         `
//     INSERT INTO internship_steps (part_id, section_id, title, step_type, order_index, planned_duration_min)
//     VALUES ($1, $2, $3, $4, $5, $6)
//   `,
//         [partId, sectionId, title, type, nextIndex, durationMin || null]
//       );

//       configStates.delete(ctx.from.id);

//       await ctx.reply("Этап добавлен.");
//       await showInternshipSectionSteps(ctx, sectionId, partId);
//     } catch (err) {
//       logError("internship_new_step_type_x", err);
//     }
//   });

//   // медиа (фото/видео) для этапов
//   bot.on(["video", "photo"], async (ctx, next) => {
//     try {
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return next();

//       const state = mediaStates.get(ctx.from.id);
//       if (!state) return next();

//       const { sessionId, sectionId, stepId, type, userId } = state;

//       let fileId = null;
//       if (type === "video" && ctx.message.video) {
//         fileId = ctx.message.video.file_id;
//       } else if (type === "photo" && ctx.message.photo?.length) {
//         fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
//       }

//       if (!fileId) {
//         await ctx.reply(
//           `Ожидалось ${type === "video" ? "видео" : "фото"}. Попробуй ещё раз.`
//         );
//         return;
//       }

//       await setMediaStepPassed(sessionId, stepId, user.id, fileId);
//       mediaStates.delete(ctx.from.id);

//       await ctx.reply("Этап отмечен как выполненный ✅.");
//       await showSessionSection(ctx, sessionId, sectionId, userId, {
//         edit: false,
//       });
//     } catch (err) {
//       logError("internship_media_handler_x", err);
//       return next();
//     }
//   });

//   // кнопка в главном меню: процесс стажировки
//   bot.action("internship_active_menu", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const res = await pool.query(
//         `
//       SELECT s.*
//       FROM internship_sessions s
//       WHERE s.started_by = $1
//         AND s.finished_at IS NULL
//         AND s.is_canceled = FALSE
//       ORDER BY s.started_at DESC
//       LIMIT 1
//       `,
//         [admin.id]
//       );

//       if (!res.rows.length) {
//         await ctx.reply("У тебя сейчас нет активной стажировки.");
//         await showMainMenu(ctx);
//         return;
//       }

//       const session = res.rows[0];

//       // ✅ сразу открываем “экран пользователя” (как твой скрин 3)
//       await showUserInternshipMenu(ctx, admin, session.user_id);
//     } catch (err) {
//       logError("internship_active_menu", err);
//     }
//   });
// }

// module.exports = {
//   registerInternship,
//   hasActiveInternshipSessionForTrainer,
// };
