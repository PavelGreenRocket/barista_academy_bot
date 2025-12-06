// // src/bot/adminUsers.js

// const pool = require("../db/pool");
// const { Markup } = require("telegraf");
// const { deliver } = require("../utils/renderHelpers");
// const {
//   registerAdminAiLogs,
//   getNewAiLogsCount,
//   getPendingOfftopicCount,
// } = require("./adminUsers/aiLogs");

// const SUPER_ADMIN_TELEGRAM_ID = "925270231"; // твой tg id
// const ADMIN_THEORY_PASS_PERCENT = 90; // порог зачёта по теме для теории (в %)
// const AI_LOGS_PAGE_SIZE = 10;
// const PAGE_SIZE = 10; // количество пользователей на странице

// function isAdmin(user) {
//   return user && user.role === "admin";
// }

// // состояния для создания пользователя админом
// // key: telegram_id админа, value: { step, tmpTelegramId? }
// const userCreateStates = new Map();

// // состояния поиска пользователя
// // key: telegram_id админа, value: { step: "await_query" }
// const userSearchStates = new Map();

// // состояние вида экрана "Обращения к ИИ" (фильтр и т.п.)
// // key: telegram_id админа, value: { aiFilter: 'all' | 'offtopic' }
// const adminAiViewStates = new Map();

// // состояния для изменения имени пользователя
// // key: telegram_id админа, value: { userId }
// const userRenameStates = new Map();

// // состояния админских тестов по "теории база" / "полной теории"
// // key: telegram_id админа, value: { userId, itemId, type, topicId, topicTitle, sessionId, cards, index, showAnswer, correctCount }
// const adminTheorySessions = new Map();

// // ---------- state helpers ----------

// function setUserCreateState(adminId, state) {
//   userCreateStates.set(adminId, state);
// }
// function clearUserCreateState(adminId) {
//   userCreateStates.delete(adminId);
// }

// function setUserRenameState(adminId, state) {
//   userRenameStates.set(adminId, state);
// }
// function clearUserRenameState(adminId) {
//   userRenameStates.delete(adminId);
// }

// function setAdminTheorySession(adminId, state) {
//   adminTheorySessions.set(adminId, state);
// }
// function getAdminTheorySession(adminId) {
//   return adminTheorySessions.get(adminId);
// }
// function clearAdminTheorySession(adminId) {
//   adminTheorySessions.delete(adminId);
// }

// const adminUsersViewStates = new Map();

// function getAdminAiViewState(adminTelegramId) {
//   const st = adminAiViewStates.get(adminTelegramId);
//   if (!st) return { aiFilter: "all" };
//   return { aiFilter: st.aiFilter || "all" };
// }

// function setAdminAiViewState(adminTelegramId, patch) {
//   const current = getAdminAiViewState(adminTelegramId);
//   adminAiViewStates.set(adminTelegramId, { ...current, ...patch });
// }

// function setAdminUsersViewState(adminId, patch) {
//   const prev = adminUsersViewStates.get(adminId) || {};
//   adminUsersViewStates.set(adminId, { ...prev, ...patch });
// }

// function getAdminUsersViewState(adminId) {
//   return adminUsersViewStates.get(adminId) || {};
// }
// // -----------------------------------------------------------------------------
// // СПИСОК ПОЛЬЗОВАТЕЛЕЙ
// // -----------------------------------------------------------------------------

// async function showAdminUsers(ctx, options = {}) {
//   let page = Number(options.page) || 1;

//   const viewState = getAdminUsersViewState(ctx.from.id) || {};

//   // ---- читаем state фильтров ----
//   let {
//     filterItemId,
//     showFilters,
//     expanded,
//     statusFilter, // 'intern' | 'employee' | undefined
//     roleFilter, // 'admin' | 'user' | undefined
//     statusSectionOpen,
//     roleSectionOpen,
//     perfSectionOpen,
//     perfByItemOpen,
//   } = viewState;

//   // --- применяем опции (если переданы) ---
//   if (typeof options.filterItemId === "number") {
//     filterItemId = options.filterItemId;
//   } else if (typeof filterItemId !== "number") {
//     filterItemId = 0;
//   }

//   if (typeof options.showFilters === "boolean") {
//     showFilters = options.showFilters;
//   } else if (typeof showFilters !== "boolean") {
//     showFilters = false;
//   }

//   // expanded уже управляется отдельными хендлерами
//   expanded = !!viewState.expanded;

//   // сохраняем актуальное состояние
//   setAdminUsersViewState(ctx.from.id, {
//     page,
//     filterItemId,
//     showFilters,
//     expanded,
//     statusFilter: statusFilter || null,
//     roleFilter: roleFilter || null,
//     statusSectionOpen: !!statusSectionOpen,
//     roleSectionOpen: !!roleSectionOpen,
//     perfSectionOpen: !!perfSectionOpen,
//     perfByItemOpen: !!perfByItemOpen,
//   });

//   // ещё раз берём state (на случай, если setAdminUsersViewState что-то добавил)
//   const state = getAdminUsersViewState(ctx.from.id) || {};
//   filterItemId =
//     typeof state.filterItemId === "number" ? state.filterItemId : 0;
//   showFilters = !!state.showFilters;
//   expanded = !!state.expanded;
//   statusFilter = state.statusFilter || null;
//   roleFilter = state.roleFilter || null;
//   statusSectionOpen = !!state.statusSectionOpen;
//   roleSectionOpen = !!state.roleSectionOpen;
//   perfSectionOpen = !!state.perfSectionOpen;
//   perfByItemOpen = !!state.perfByItemOpen;

//   // --- элементы аттестации для фильтра "по элементам" ---
//   const filtersRes = await pool.query(
//     `SELECT id, title
//      FROM attestation_items
//      WHERE is_active = TRUE
//      ORDER BY order_index, id`
//   );
//   const filterItems = filtersRes.rows;

//   // фильтр по элементу аттестации (для текста)
//   let activeFilter = null;
//   if (filterItemId) {
//     const fRes = await pool.query(
//       "SELECT id, title FROM attestation_items WHERE id = $1",
//       [filterItemId]
//     );
//     if (fRes.rows.length) {
//       activeFilter = fRes.rows[0];
//     } else {
//       filterItemId = 0;
//     }
//   }

//   // --- считаем пользователей с учётом ВСЕХ фильтров ---
//   const offset = (page - 1) * PAGE_SIZE;

//   let totalUsers = 0;
//   let usersRes;

//   // собираем where-условия (статус / роль)
//   const baseWhereClauses = [];
//   const baseParams = [];

//   if (statusFilter === "intern" || statusFilter === "employee") {
//     baseWhereClauses.push(`u.staff_status = $${baseParams.length + 1}`);
//     baseParams.push(statusFilter);
//   }

//   if (roleFilter === "admin" || roleFilter === "user") {
//     baseWhereClauses.push(`u.role = $${baseParams.length + 1}`);
//     baseParams.push(roleFilter);
//   }

//   if (!filterItemId) {
//     // БЕЗ фильтра по элементу аттестации
//     const whereSql =
//       baseWhereClauses.length > 0
//         ? "WHERE " + baseWhereClauses.join(" AND ")
//         : "";

//     const countRes = await pool.query(
//       `SELECT COUNT(*) FROM users u ${whereSql}`,
//       baseParams
//     );
//     totalUsers = Number(countRes.rows[0].count) || 0;

//     usersRes = await pool.query(
//       `
//       SELECT id, telegram_id, role, full_name, staff_status, intern_days_completed
//       FROM users u
//       ${whereSql}
//       ORDER BY id ASC
//       LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}
//       `,
//       [...baseParams, PAGE_SIZE, offset]
//     );
//   } else {
//     // С фильтром по элементу аттестации (кто НЕ сдал этот элемент)
//     const params = [filterItemId, ...baseParams];

//     const whereSql =
//       baseWhereClauses.length > 0
//         ? "AND " +
//           baseWhereClauses
//             .map((clause, idx) =>
//               clause.replace(/\$(\d+)/g, () => `$${idx + 2}`)
//             )
//             .join(" AND ")
//         : "";

//     const countRes = await pool.query(
//       `
//       SELECT COUNT(*)
//       FROM users u
//       LEFT JOIN user_attestation_status uas
//         ON uas.user_id = u.id AND uas.item_id = $1
//       WHERE COALESCE(uas.status, 'not_passed') <> 'passed'
//       ${whereSql}
//       `,
//       params
//     );
//     totalUsers = Number(countRes.rows[0].count) || 0;

//     const listParams = [...params, PAGE_SIZE, offset];

//     usersRes = await pool.query(
//       `
//       SELECT u.id, u.telegram_id, u.role, u.full_name, u.staff_status, u.intern_days_completed
//       FROM users u
//       LEFT JOIN user_attestation_status uas
//         ON uas.user_id = u.id AND uas.item_id = $1
//       WHERE COALESCE(uas.status, 'not_passed') <> 'passed'
//       ${whereSql}
//       ORDER BY u.id ASC
//       LIMIT $${params.length + 1} OFFSET $${params.length + 2}
//       `,
//       listParams
//     );
//   }

//   const users = usersRes.rows;
//   const totalPages = totalUsers > 0 ? Math.ceil(totalUsers / PAGE_SIZE) : 1;
//   if (page > totalPages) page = totalPages;

//   // --- шапка текста ---
//   let text = "👥 Пользователи";

//   const filterLines = [];

//   if (statusFilter === "intern") {
//     filterLines.push("• Фильтр по статусу: 🎓 стажёр");
//   } else if (statusFilter === "employee") {
//     filterLines.push("• Фильтр по статусу: 🧠 работник");
//   }

//   if (roleFilter === "admin") {
//     filterLines.push("• Фильтр по роли: 🛠️ администратор");
//   } else if (roleFilter === "user") {
//     filterLines.push("• Фильтр по роли: 👤 пользователь");
//   }

//   if (activeFilter) {
//     filterLines.push(
//       `• По элементу аттестации: ❌ ${activeFilter.title} — не сдали`
//     );
//   }

//   if (filterLines.length) {
//     text += "\n\nАктивные фильтры:\n" + filterLines.join("\n");
//   }

//   if (!totalUsers) {
//     text += `\n\nПо выбранным условиям пока нет пользователей.`;
//   } else {
//     text += `\n\nВсего: ${totalUsers}`;
//     if (totalPages > 1) {
//       text += `\nСтраница ${page} из ${totalPages}`;
//     }
//   }

//   const buttons = [];

//   // --- сами пользователи ---
//   for (const row of users) {
//     const name = row.full_name || "Без имени";
//     const status = row.staff_status === "intern" ? "intern" : "employee";
//     const icon = status === "intern" ? "🎓" : "🧠";
//     const label = `${icon} ${name}`;
//     buttons.push([Markup.button.callback(label, `admin_user_${row.id}`)]);
//   }

//   // --- пагинация ---
//   if (totalPages > 1) {
//     const panelFlag = showFilters ? 1 : 0;
//     const filt = filterItemId || 0;

//     const navRow = [];
//     if (page > 1) {
//       navRow.push(
//         Markup.button.callback(
//           "⬅️ Назад",
//           `admin_users_list_${page - 1}_${filt}_${panelFlag}`
//         )
//       );
//     }
//     if (page < totalPages) {
//       navRow.push(
//         Markup.button.callback(
//           "➡️ Далее",
//           `admin_users_list_${page + 1}_${filt}_${panelFlag}`
//         )
//       );
//     }
//     if (navRow.length) {
//       buttons.push(navRow);
//     }
//   }

//   // ===== НИЖНЯЯ ПАНЕЛЬ =====

//   const panelFlag = showFilters ? 1 : 0;
//   const filt = filterItemId || 0;

//   // 1) к собеседованиям
//   buttons.push([
//     Markup.button.callback("====> к собеседованиям", "admin_interviews_menu"),
//   ]);

//   // 2) строка "Фильтр | Раскрыть"
//   const panelFlagNext = showFilters ? 0 : 1;

//   const filterBtn = Markup.button.callback(
//     showFilters ? "🔼 Фильтр 🔼" : "🔽 Фильтр 🔽",
//     `admin_users_list_${page}_${filt}_${panelFlagNext}`
//   );

//   let expandLabel;
//   let expandAction;
//   if (expanded) {
//     expandLabel = "🔼 Скрыть 🔼";
//     expandAction = `admin_users_collapse_${page}_${filt}_${panelFlag}`;
//   } else {
//     expandLabel = "🔽 Раскрыть 🔽";
//     expandAction = `admin_users_expand_${page}_${filt}_${panelFlag}`;
//   }
//   const expandBtn = Markup.button.callback(expandLabel, expandAction);

//   buttons.push([filterBtn, expandBtn]);

//   // 3) ПАНЕЛЬ ФИЛЬТРОВ
//   if (showFilters) {
//     // --- заголовок + содержимое секции "по статусу" ---
//     const statusLabel = statusSectionOpen
//       ? "🔼 по статусу 🔼"
//       : "🔽 по статусу 🔽";
//     buttons.push([
//       Markup.button.callback(statusLabel, "admin_users_filter_status_toggle"),
//     ]);

//     if (statusSectionOpen) {
//       const internActive = statusFilter === "intern";
//       const employeeActive = statusFilter === "employee";

//       const internLabel = internActive ? "✅ 🎓 стажёр" : "🎓 стажёр";
//       const employeeLabel = employeeActive ? "✅ 🧠 работник" : "🧠 работник";

//       buttons.push([
//         Markup.button.callback(internLabel, "admin_users_filter_status_intern"),
//         Markup.button.callback(
//           employeeLabel,
//           "admin_users_filter_status_employee"
//         ),
//       ]);
//     }

//     // --- заголовок + содержимое секции "по роли" ---
//     const roleLabel = roleSectionOpen ? "🔼 по роли 🔼" : "🔽 по роли 🔽";
//     buttons.push([
//       Markup.button.callback(roleLabel, "admin_users_filter_role_toggle"),
//     ]);

//     if (roleSectionOpen) {
//       const adminActive = roleFilter === "admin";
//       const userActive = roleFilter === "user";

//       const adminLabel = adminActive
//         ? "✅ 🛠️ администратор"
//         : "🛠️ администратор";
//       const userLabel = userActive ? "✅ 👤 пользователь" : "👤 пользователь";

//       buttons.push([
//         Markup.button.callback(adminLabel, "admin_users_filter_role_admin"),
//         Markup.button.callback(userLabel, "admin_users_filter_role_user"),
//       ]);
//     }

//     // --- заголовок + содержимое секции "по успеваемости" ---
//     const perfLabel = perfSectionOpen
//       ? "🔼 по успеваемости 🔼"
//       : "🔽 по успеваемости 🔽";
//     buttons.push([
//       Markup.button.callback(perfLabel, "admin_users_filter_perf_toggle"),
//     ]);

//     if (perfSectionOpen) {
//       const byItemLabel = perfByItemOpen
//         ? "🔼 по элементам аттестации 🔼"
//         : "🔽 по элементам аттестации 🔽";
//       const byDeadlineLabel = "🔽 по дедлайн 🔽";

//       buttons.push([
//         Markup.button.callback(
//           byItemLabel,
//           "admin_users_filter_perf_item_toggle"
//         ),
//       ]);

//       buttons.push([
//         Markup.button.callback(byDeadlineLabel, "admin_users_perf_deadline"),
//       ]);

//       if (perfByItemOpen) {
//         for (const item of filterItems) {
//           buttons.push([
//             Markup.button.callback(
//               `❌ ${item.title}`,
//               `admin_users_list_1_${item.id}_1`
//             ),
//           ]);
//         }

//         buttons.push([
//           Markup.button.callback(
//             "Показать всех по элементу",
//             "admin_users_list_1_0_1"
//           ),
//         ]);
//       }
//     }

//     // --- в самом конце: снять все фильтры + поиск ---
//     buttons.push([
//       Markup.button.callback(
//         "🔄 снять все фильтры 🔄",
//         "admin_users_filter_clear_all"
//       ),
//     ]);

//     buttons.push([
//       Markup.button.callback(
//         "🔍 Найти пользователя",
//         "admin_users_search_start"
//       ),
//     ]);
//   }

//   // 4) раскрытая панель действий (как и раньше)
//   if (expanded) {
//     buttons.push([
//       Markup.button.callback("➕ Добавить пользователя", "admin_add_user"),
//     ]);

//     buttons.push([
//       Markup.button.callback(
//         "➕ Пригласить на собеседование",
//         "admin_invite_candidate"
//       ),
//     ]);

//     let aiLabel;
//     const newAiLogsCount = await getNewAiLogsCount();
//     const pendingOfftopicCount = await getPendingOfftopicCount();

//     if (newAiLogsCount > 0) {
//       aiLabel = `🔮 Общение с ИИ (${newAiLogsCount} новых)`;
//     } else {
//       aiLabel = "🔮 Общение с ИИ (0 новых)";
//     }

//     if (pendingOfftopicCount > 0) {
//       aiLabel += " ❗";
//     }

//     buttons.push([Markup.button.callback(aiLabel, "admin_ai_logs_1")]);

//     buttons.push([Markup.button.callback(" ", "noop")]);
//   }

//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // -----------------------------------------------------------------------------
// // ПРОГРЕСС ПО ТЕОРИИ (БЛОКИ) – пока только для внутреннего использования
// // -----------------------------------------------------------------------------

// async function getTopicsProgressForUser(userId) {
//   const res = await pool.query(
//     `
//         SELECT
//         t.id,
//         t.title,
//         t.order_index,
//         COUNT(b.id) AS total_blocks,
//         COALESCE(
//             SUM(
//             CASE WHEN ubs.status = 'passed' THEN 1 ELSE 0 END
//             ),
//             0
//         ) AS passed_blocks
//         FROM topics t
//         LEFT JOIN blocks b
//         ON b.topic_id = t.id
//         LEFT JOIN user_block_status ubs
//         ON ubs.block_id = b.id AND ubs.user_id = $1
//         GROUP BY t.id, t.title, t.order_index
//         ORDER BY t.order_index, t.id
//     `,
//     [userId]
//   );

//   return res.rows.map((row) => {
//     const total = Number(row.total_blocks) || 0;
//     const passed = Number(row.passed_blocks) || 0;
//     const percent = total > 0 ? Math.round((passed * 100) / total) : 0;
//     const isDone = total > 0 && passed === total;
//     return {
//       id: row.id,
//       title: row.title,
//       totalBlocks: total,
//       passedBlocks: passed,
//       percent,
//       isDone,
//     };
//   });
// }

// async function getTopicBlocksProgressForUser(userId, topicId) {
//   const res = await pool.query(
//     `
//         SELECT
//         b.id,
//         b.title,
//         COALESCE(ubs.status, 'not_passed') AS status
//         FROM blocks b
//         LEFT JOIN user_block_status ubs
//         ON ubs.block_id = b.id AND ubs.user_id = $1
//         WHERE b.topic_id = $2
//         ORDER BY b.order_index, b.id
//     `,
//     [userId, topicId]
//   );

//   return res.rows.map((row) => ({
//     id: row.id,
//     title: row.title,
//     status: row.status,
//     isPassed: row.status === "passed",
//   }));
// }

// async function toggleUserBlockStatus(userId, blockId) {
//   const statusRes = await pool.query(
//     `SELECT status
//         FROM user_block_status
//         WHERE user_id = $1 AND block_id = $2`,
//     [userId, blockId]
//   );

//   let newStatus;
//   if (!statusRes.rows.length || statusRes.rows[0].status !== "passed") {
//     newStatus = "passed";
//   } else {
//     newStatus = "not_passed";
//   }

//   await pool.query(
//     `
//         INSERT INTO user_block_status (user_id, block_id, status)
//         VALUES ($1, $2, $3)
//         ON CONFLICT (user_id, block_id) DO UPDATE
//         SET status = EXCLUDED.status
//         `,
//     [userId, blockId, newStatus]
//   );
// }

// async function showUserTopicsProgress(ctx, userId) {
//   const topics = await getTopicsProgressForUser(userId);

//   const uRes = await pool.query("SELECT full_name FROM users WHERE id = $1", [
//     userId,
//   ]);
//   const userName =
//     uRes.rows.length && uRes.rows[0].full_name
//       ? uRes.rows[0].full_name
//       : "Без имени";

//   if (!topics.length) {
//     await deliver(
//       ctx,
//       {
//         text: `Для ${userName} пока нет ни одной темы теории.`,
//         extra: Markup.inlineKeyboard([
//           [Markup.button.callback("🔙 К пользователям", "admin_users")],
//           [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
//         ]),
//       },
//       { edit: true }
//     );
//     return;
//   }

//   let text =
//     `👤 ${userName}\n\n` +
//     "📚 Темы теории.\n" +
//     "Нажимай на тему, чтобы посмотреть статусы блоков.";

//   const buttons = topics.map((t) => {
//     const label =
//       t.totalBlocks > 0
//         ? `${t.title} (${t.passedBlocks}/${t.totalBlocks}, ${t.percent}%)`
//         : `${t.title} (0 блоков)`;

//     return [
//       Markup.button.callback(label, `admin_user_topic_${userId}_${t.id}`),
//     ];
//   });

//   buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// async function showUserTopicBlocksProgress(ctx, userId, topicId) {
//   const blocks = await getTopicBlocksProgressForUser(userId, topicId);

//   const uRes = await pool.query("SELECT full_name FROM users WHERE id = $1", [
//     userId,
//   ]);
//   const userName =
//     uRes.rows.length && uRes.rows[0].full_name
//       ? uRes.rows[0].full_name
//       : "Без имени";

//   const topicRes = await pool.query("SELECT title FROM topics WHERE id = $1", [
//     topicId,
//   ]);

//   const topicTitle = topicRes.rows.length
//     ? topicRes.rows[0].title
//     : "Без названия";

//   if (!blocks.length) {
//     const text =
//       `👤 ${userName}\n` +
//       `Тема: ${topicTitle}\n\n` +
//       "В этой теме пока нет блоков.";

//     const keyboard = Markup.inlineKeyboard([
//       [
//         Markup.button.callback(
//           "🔙 Ко всем темам",
//           `admin_user_topics_${userId}`
//         ),
//       ],
//       [Markup.button.callback("🔙 К пользователям", "admin_users")],
//     ]);

//     await deliver(ctx, { text, extra: keyboard }, { edit: true });
//     return;
//   }

//   const text =
//     `👤 ${userName}\n` +
//     `Тема: ${topicTitle}\n\n` +
//     "Выбери блок, чтобы поставить / снять галочку.";

//   const buttons = blocks.map((b) => {
//     const icon = b.isPassed ? "✅" : "⚪️";
//     return [
//       Markup.button.callback(
//         `${icon} ${b.title}`,
//         `admin_user_block_${userId}_${b.id}`
//       ),
//     ];
//   });

//   buttons.push([
//     Markup.button.callback("📚 Ко всем темам", `admin_user_topics_${userId}`),
//   ]);
//   buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // -----------------------------------------------------------------------------
// // ТЕОРИЯ БАЗА / ПОЛНАЯ ТЕОРИЯ – прогресс и админские тесты
// // -----------------------------------------------------------------------------

// async function getTheoryTopics(type) {
//   if (type === "base") {
//     const res = await pool.query(
//       `
//         SELECT DISTINCT t.id, t.title, t.order_index
//         FROM topics t
//         JOIN blocks b ON b.topic_id = t.id
//         JOIN cards c ON c.block_id = b.id
//         WHERE COALESCE(c.difficulty, 1) = 1
//         ORDER BY t.order_index, t.id
//         `
//     );
//     return res.rows;
//   } else {
//     const res = await pool.query(
//       `
//         SELECT DISTINCT t.id, t.title, t.order_index
//         FROM topics t
//         JOIN blocks b ON b.topic_id = t.id
//         JOIN cards c ON c.block_id = b.id
//         ORDER BY t.order_index, t.id
//         `
//     );
//     return res.rows;
//   }
// }

// // прогресс по элементу "теория база" / "полная теория"
// async function getUserTheoryElementProgress(userId, type) {
//   const topics = await getTheoryTopics(type);
//   const totalTopics = topics.length;
//   if (!totalTopics) {
//     return { totalTopics: 0, passedTopics: 0, percent: 0 };
//   }

//   const mode = type === "base" ? "admin_base" : "admin_full";

//   const sessionsRes = await pool.query(
//     `
//         SELECT topic_id, question_count, correct_count, created_at
//         FROM test_sessions
//         WHERE user_id = $1
//         AND mode = $2
//         ORDER BY created_at DESC
//         `,
//     [userId, mode]
//   );

//   const lastByTopic = new Map();
//   for (const row of sessionsRes.rows) {
//     if (!row.topic_id) continue;
//     if (!lastByTopic.has(row.topic_id)) {
//       lastByTopic.set(row.topic_id, row);
//     }
//   }

//   let passedTopics = 0;
//   for (const t of topics) {
//     const s = lastByTopic.get(t.id);
//     if (!s) continue;
//     const total = Number(s.question_count) || 0;
//     const correct = Number(s.correct_count) || 0;
//     const perc = total > 0 ? Math.round((correct * 100) / total) : 0;
//     if (perc >= ADMIN_THEORY_PASS_PERCENT) {
//       passedTopics += 1;
//     }
//   }

//   const percent = Math.round((passedTopics * 100) / totalTopics);
//   return { totalTopics, passedTopics, percent };
// }

// // синхронизация статуса элемента аттестации по проценту
// async function syncUserTheoryItemStatus(userId, itemId, percent) {
//   const status = percent >= 100 ? "passed" : "not_passed";

//   await pool.query(
//     `
//         INSERT INTO user_attestation_status (user_id, item_id, status)
//         VALUES ($1, $2, $3)
//         ON CONFLICT (user_id, item_id) DO UPDATE
//         SET status = EXCLUDED.status
//         `,
//     [userId, itemId, status]
//   );
// }

// // экран выбора темы для теории база / полной теории
// async function showUserTheoryTopics(ctx, userId, itemId, type) {
//   const topics = await getTheoryTopics(type);

//   const uRes = await pool.query("SELECT full_name FROM users WHERE id = $1", [
//     userId,
//   ]);
//   const userName =
//     uRes.rows.length && uRes.rows[0].full_name
//       ? uRes.rows[0].full_name
//       : "Без имени";

//   const title = type === "base" ? "Теория база" : "Полная теория";

//   if (!topics.length) {
//     await deliver(
//       ctx,
//       {
//         text:
//           `👤 ${userName}\n\n` +
//           `${title}.\n\n` +
//           "Пока нет ни одной темы с карточками подходящего уровня.",
//         extra: Markup.inlineKeyboard([
//           [
//             Markup.button.callback(
//               "🔙 К аттестации",
//               `admin_user_attest_${userId}`
//             ),
//           ],
//           [Markup.button.callback("🔙 К пользователям", "admin_users")],
//         ]),
//       },
//       { edit: true }
//     );
//     return;
//   }

//   let text = `👤 ${userName}\n\n` + `${title}.\n\n` + "Выбери тему для теста:";

//   const buttons = topics.map((t) => {
//     const cb =
//       type === "base"
//         ? `admin_user_theory_base_topic_${userId}_${itemId}_${t.id}`
//         : `admin_user_theory_full_topic_${userId}_${itemId}_${t.id}`;
//     return [Markup.button.callback(t.title, cb)];
//   });

//   buttons.push([
//     Markup.button.callback("🔙 К аттестации", `admin_user_attest_${userId}`),
//   ]);
//   buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// // запуск админского теста по теме для конкретного пользователя
// async function startAdminTheoryTest(
//   ctx,
//   adminId,
//   userId,
//   itemId,
//   type,
//   topicId
// ) {
//   const topicRes = await pool.query("SELECT title FROM topics WHERE id = $1", [
//     topicId,
//   ]);
//   if (!topicRes.rows.length) {
//     await ctx.reply("Тема не найдена.");
//     return;
//   }
//   const topicTitle = topicRes.rows[0].title || "Без названия";

//   // берём все карточки нужного уровня по этой теме
//   const cardsRes = await pool.query(
//     `
//         SELECT c.id, c.question, c.answer, COALESCE(c.difficulty, 1) AS difficulty
//         FROM blocks b
//         JOIN cards c ON c.block_id = b.id
//         WHERE b.topic_id = $1
//         ${type === "base" ? "AND COALESCE(c.difficulty, 1) = 1" : ""}
//         ORDER BY b.order_index, b.id, c.id
//         `,
//     [topicId]
//   );

//   const cards = cardsRes.rows;
//   if (!cards.length) {
//     await ctx.reply("В этой теме пока нет карточек для теста.");
//     return;
//   }

//   const mode = type === "base" ? "admin_base" : "admin_full";

//   const sessionRes = await pool.query(
//     `
//         INSERT INTO test_sessions (user_id, admin_id, mode, topic_id, question_count, correct_count)
//         VALUES ($1, $2, $3, $4, $5, 0)
//         RETURNING id
//         `,
//     [userId, adminId, mode, topicId, cards.length]
//   );

//   const sessionId = sessionRes.rows[0].id;

//   setAdminTheorySession(adminId, {
//     adminId,
//     userId,
//     itemId,
//     type,
//     topicId,
//     topicTitle,
//     sessionId,
//     cards,
//     index: 0,
//     showAnswer: false,
//     correctCount: 0,
//   });

//   await renderAdminTheoryQuestion(ctx, adminId);
// }

// async function renderAdminTheoryQuestion(ctx, adminId) {
//   const session = getAdminTheorySession(adminId);
//   if (!session) {
//     await ctx.reply(
//       "Сессия теста не найдена. Вернись в аттестацию пользователя и начни снова."
//     );
//     return;
//   }

//   const { cards, index, showAnswer, type, topicTitle, userId, itemId } =
//     session;

//   if (!cards.length) {
//     await ctx.reply("В этой теме пока нет карточек.");
//     clearAdminTheorySession(adminId);
//     return;
//   }

//   if (index < 0 || index >= cards.length) {
//     await ctx.reply("Вопросы закончились.");
//     clearAdminTheorySession(adminId);
//     return;
//   }

//   const card = cards[index];
//   const total = cards.length;
//   const humanIndex = index + 1;

//   const level = card.difficulty || 1;
//   const levelIcon = level === 1 ? "⭐" : level === 2 ? "⭐⭐" : "⭐⭐⭐";

//   const title = type === "base" ? "Теория база" : "Полная теория";

//   let text =
//     `${levelIcon} Вопрос ${humanIndex}/${total}\n` +
//     `Тема: ${topicTitle}\n` +
//     `Тип: ${title}\n\n` +
//     `❓ ${card.question}`;

//   const buttons = [];

//   if (!showAnswer) {
//     buttons.push([
//       Markup.button.callback("👁 Показать ответ", "admin_theory_show_answer"),
//     ]);
//   } else {
//     text += `\n\n💡 Ответ:\n${card.answer}\n\nОтметь, как ответил сотрудник:`;
//     buttons.push([
//       Markup.button.callback("✅ Верно", "admin_theory_mark_correct"),
//       Markup.button.callback("❌ Не вспомнил", "admin_theory_mark_wrong"),
//     ]);
//   }

//   const topicsCallback =
//     type === "base"
//       ? `admin_user_theory_base_topics_${userId}_${itemId}`
//       : `admin_user_theory_full_topics_${userId}_${itemId}`;

//   buttons.push([Markup.button.callback("🔙 К темам", topicsCallback)]);
//   buttons.push([
//     Markup.button.callback("🔙 К аттестации", `admin_user_attest_${userId}`),
//   ]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// async function handleAdminTheoryMark(ctx, isCorrect, logError) {
//   const adminId = ctx.from.id;
//   const session = getAdminTheorySession(adminId);
//   if (!session) {
//     await ctx.reply(
//       "Сессия теста не найдена. Вернись в аттестацию пользователя и начни снова."
//     );
//     return;
//   }

//   const { cards, index, sessionId, userId, type, topicId, itemId } = session;

//   if (index < 0 || index >= cards.length) {
//     await ctx.reply("Вопросы уже закончились.");
//     clearAdminTheorySession(adminId);
//     return;
//   }

//   const card = cards[index];
//   const position = index + 1;

//   try {
//     await pool.query(
//       `
//         INSERT INTO test_session_answers (session_id, card_id, position, is_correct)
//         VALUES ($1, $2, $3, $4)
//         `,
//       [sessionId, card.id, position, isCorrect]
//     );

//     if (isCorrect) {
//       session.correctCount += 1;
//       await pool.query(
//         "UPDATE test_sessions SET correct_count = correct_count + 1 WHERE id = $1",
//         [sessionId]
//       );
//     }

//     // следующий вопрос или завершение
//     if (index < cards.length - 1) {
//       session.index += 1;
//       session.showAnswer = false;
//       setAdminTheorySession(adminId, session);
//       await renderAdminTheoryQuestion(ctx, adminId);
//     } else {
//       const total = cards.length;
//       const correct = session.correctCount;
//       const percent = total > 0 ? Math.round((correct * 100) / total) : 0;

//       // зачёт / не зачёт по теме
//       let statusText;
//       if (percent >= ADMIN_THEORY_PASS_PERCENT) {
//         statusText = "✅ Тема зачтена по этому виду теории.";

//         // для "теория база" помечаем все блоки темы как passed
//         if (type === "base") {
//           await pool.query(
//             `
//                 INSERT INTO user_block_status (user_id, block_id, status)
//                 SELECT $1, b.id, 'passed'
//                 FROM blocks b
//                 WHERE b.topic_id = $2
//                 ON CONFLICT (user_id, block_id) DO UPDATE
//                 SET status = EXCLUDED.status
//                 `,
//             [userId, topicId]
//           );
//         }
//       } else {
//         statusText = `❌ Этого недостаточно для зачёта (нужно ${ADMIN_THEORY_PASS_PERCENT}% и выше).`;
//       }

//       clearAdminTheorySession(adminId);

//       // обновляем общий прогресс по элементу и статус галочки
//       const typeKey = type === "base" ? "base" : "full";
//       const progress = await getUserTheoryElementProgress(userId, typeKey);
//       await syncUserTheoryItemStatus(userId, itemId, progress.percent);

//       const title = type === "base" ? "Теория база" : "Полная теория";

//       let text =
//         `✅ Тест по теме "${session.topicTitle}" завершён.\n\n` +
//         `Результат: ${correct}/${total} (${percent}%).\n` +
//         `${statusText}\n\n` +
//         `${title}: общий прогресс — ${progress.percent}% ` +
//         `(${progress.passedTopics}/${progress.totalTopics} тем).`;

//       const topicsCallback =
//         type === "base"
//           ? `admin_user_theory_base_topics_${userId}_${itemId}`
//           : `admin_user_theory_full_topics_${userId}_${itemId}`;

//       const keyboard = Markup.inlineKeyboard([
//         [Markup.button.callback("📚 К темам", topicsCallback)],
//         [
//           Markup.button.callback(
//             "🔙 К аттестации",
//             `admin_user_attest_${userId}`
//           ),
//         ],
//       ]);

//       await deliver(ctx, { text, extra: keyboard }, { edit: true });
//     }
//   } catch (err) {
//     logError("admin_theory_mark_answer", err);
//     await ctx.reply("Не удалось сохранить результат ответа.");
//   }
// }

// // -----------------------------------------------------------------------------
// // АТТЕСТАЦИЯ ДЛЯ КОНКРЕТНОГО ПОЛЬЗОВАТЕЛЯ
// // -----------------------------------------------------------------------------

// async function showUserAttestation(ctx, userId) {
//   const userRes = await pool.query(
//     "SELECT id, telegram_id, role, full_name, staff_status, intern_days_completed FROM users WHERE id = $1",
//     [userId]
//   );

//   if (!userRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }

//   const user = userRes.rows[0];

//   const res = await pool.query(
//     `
//         SELECT
//         ai.id,
//         ai.title,
//         uas.status,
//         uas.updated_by_admin_id,
//         ua.full_name AS updated_by_admin_name
//         FROM attestation_items ai
//         LEFT JOIN user_attestation_status uas
//         ON uas.item_id = ai.id AND uas.user_id = $1
//         LEFT JOIN users ua
//         ON ua.id = uas.updated_by_admin_id
//         WHERE ai.is_active = TRUE
//         ORDER BY ai.order_index, ai.id
//         `,
//     [userId]
//   );

//   let text =
//     `👤 ${user.full_name || "Без имени"}\n` +
//     `Роль: ${user.role}\n\n` +
//     "Выбери раздел:\n";

//   const buttons = [];

//   if (!res.rows.length) {
//     text +=
//       "Элементы аттестации ещё не созданы. Добавь их в разделе «✅ Аттестация».";
//   } else {
//     for (const row of res.rows) {
//       const rawTitle = row.title || "";
//       const lower = rawTitle.trim().toLowerCase();

//       // спец-элементы: теория база / полная теория
//       if (lower === "теория база" || lower === "база теория") {
//         const progress = await getUserTheoryElementProgress(userId, "base");
//         await syncUserTheoryItemStatus(userId, row.id, progress.percent);

//         const passed = progress.totalTopics > 0 && progress.percent >= 100;
//         const icon = passed ? "✅" : "⚪";
//         const percentLabel =
//           progress.totalTopics > 0 ? `${progress.percent}%` : "0%";

//         const label = `${icon} Теория база (${percentLabel})`;

//         text += `${label}\n`;
//         buttons.push([
//           Markup.button.callback(
//             label,
//             `admin_user_theory_base_topics_${userId}_${row.id}`
//           ),
//         ]);
//         continue;
//       }

//       if (lower === "полная теория" || lower === "теория полная") {
//         const progress = await getUserTheoryElementProgress(userId, "full");
//         await syncUserTheoryItemStatus(userId, row.id, progress.percent);

//         const passed = progress.totalTopics > 0 && progress.percent >= 100;
//         const icon = passed ? "✅" : "⚪";
//         const percentLabel =
//           progress.totalTopics > 0 ? `${progress.percent}%` : "0%";

//         const label = `${icon} Полная теория (${percentLabel})`;

//         text += `${label}\n`;
//         buttons.push([
//           Markup.button.callback(
//             label,
//             `admin_user_theory_full_topics_${userId}_${row.id}`
//           ),
//         ]);
//         continue;
//       }

//       // обычные элементы аттестации
//       const passed = row.status === "passed";
//       const icon = passed ? "✅" : "⚪";

//       let line = `${icon} ${rawTitle}`;
//       // если зачёт и известен админ — показываем в скобках
//       if (passed && row.updated_by_admin_name) {
//         line += ` (${row.updated_by_admin_name})`;
//       }

//       text += `${line}\n`;
//       buttons.push([
//         Markup.button.callback(line, `admin_user_item_${userId}_${row.id}`),
//       ]);
//     }
//   }

//   // кнопку «📚 Блоки теории» по твоей просьбе пока не показываем

//   buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// async function toggleUserItemStatus(userId, itemId, adminId) {
//   const statusRes = await pool.query(
//     `
//         SELECT status
//         FROM user_attestation_status
//         WHERE user_id = $1 AND item_id = $2
//         `,
//     [userId, itemId]
//   );

//   let newStatus;
//   if (!statusRes.rows.length || statusRes.rows[0].status !== "passed") {
//     newStatus = "passed";
//   } else {
//     newStatus = "not_passed";
//   }

//   if (newStatus === "passed") {
//     // при зачёте сохраняем, КТО поставил галочку
//     await pool.query(
//       `
//         INSERT INTO user_attestation_status (user_id, item_id, status, updated_by_admin_id)
//         VALUES ($1, $2, $3, $4)
//         ON CONFLICT (user_id, item_id) DO UPDATE
//         SET status = EXCLUDED.status,
//             updated_by_admin_id = EXCLUDED.updated_by_admin_id
//         `,
//       [userId, itemId, newStatus, adminId]
//     );
//   } else {
//     // при снятии зачёта просто меняем статус, admin_id не трогаем
//     await pool.query(
//       `
//         INSERT INTO user_attestation_status (user_id, item_id, status)
//         VALUES ($1, $2, $3)
//         ON CONFLICT (user_id, item_id) DO UPDATE
//         SET status = EXCLUDED.status
//         `,
//       [userId, itemId, newStatus]
//     );
//   }
// }

// // -----------------------------------------------------------------------------
// // КАРТОЧКА ПОЛЬЗОВАТЕЛЯ (c настройками, аттестацией и тестами)
// // -----------------------------------------------------------------------------

// async function showAdminUserCard(
//   ctx,
//   userId,
//   settingsOpen = false,
//   showActivity = false
// ) {
//   const userRes = await pool.query(
//     "SELECT id, telegram_id, role, full_name, staff_status, intern_days_completed FROM users WHERE id = $1",
//     [userId]
//   );
//   if (!userRes.rows.length) {
//     await ctx.reply("Пользователь не найден.");
//     return;
//   }

//   const user = userRes.rows[0];
//   const name = user.full_name || "Без имени";

//   // элементы аттестации (для краткой сводки)
//   const attestRes = await pool.query(
//     `
//         SELECT
//         ai.id,
//         ai.title,
//         uas.status,
//         uas.updated_by_admin_id,
//         ua.full_name AS updated_by_admin_name
//         FROM attestation_items ai
//         LEFT JOIN user_attestation_status uas
//         ON uas.item_id = ai.id AND uas.user_id = $1
//         LEFT JOIN users ua
//         ON ua.id = uas.updated_by_admin_id
//         WHERE ai.is_active = TRUE
//         ORDER BY ai.order_index, ai.id
//         `,
//     [userId]
//   );

//   // последние тесты / тренировки
//   const testsRes = await pool.query(
//     `
//         SELECT
//         ts.created_at,
//         ts.mode,
//         ts.question_count,
//         ts.correct_count,
//         t.title AS topic_title,
//         ua.full_name AS admin_full_name
//         FROM test_sessions ts
//         LEFT JOIN topics t ON t.id = ts.topic_id
//         LEFT JOIN users ua ON ua.id = COALESCE(ts.conducted_by, ts.admin_id)
//         WHERE ts.user_id = $1
//         ORDER BY ts.created_at DESC
//         LIMIT 5
//         `,
//     [user.id]
//   );

//   const isIntern = user.staff_status === "intern";
//   const dayNumber = (user.intern_days_completed || 0) + 1;

//   let text =
//     `👤 ${name}\n` +
//     `Роль: ${user.role}\n` +
//     (isIntern ? `Статус: стажёр (день ${dayNumber})\n` : `Статус: работник\n`);

//   // краткая сводка по аттестации
//   if (attestRes.rows.length) {
//     text += `\n────────────\n`;
//     for (const row of attestRes.rows) {
//       const rawTitle = row.title || "";
//       const lower = rawTitle.trim().toLowerCase();
//       const passed = row.status === "passed";
//       const icon = passed ? "✅" : "❌";

//       let line = `${icon} ${rawTitle}`;

//       if (
//         passed &&
//         row.updated_by_admin_name &&
//         lower !== "теория база" &&
//         lower !== "полная теория"
//       ) {
//         line += ` (${row.updated_by_admin_name})`;
//       }

//       text += `${line}\n`;
//     }
//     text += `────────────\n`;
//   }

//   // блок "Активность пользователя" показываем ТОЛЬКО если явно запросили
//   if (showActivity) {
//     text += `\n📊 Последние тесты / тренировки:\n`;

//     if (!testsRes.rows.length) {
//       text += "Пока нет ни одного теста.\n";
//     } else {
//       for (const row of testsRes.rows) {
//         const date = new Date(row.created_at.getTime() + 7 * 60 * 60 * 1000);
//         const dateStr = date.toLocaleString("ru-RU", {
//           day: "2-digit",
//           month: "2-digit",
//           hour: "2-digit",
//           minute: "2-digit",
//         });

//         let modeLabel;
//         if (row.mode === "topic") {
//           modeLabel = `по теме: "${row.topic_title || "Без названия"}"`;
//         } else if (row.mode === "all") {
//           modeLabel = "по всем темам";
//         } else if (row.mode === "admin_base") {
//           modeLabel = `админ-тест «Теория база» по теме: "${
//             row.topic_title || "Без названия"
//           }"`;
//         } else if (row.mode === "admin_full") {
//           modeLabel = `админ-тест «Полная теория» по теме: "${
//             row.topic_title || "Без названия"
//           }"`;
//         } else {
//           modeLabel = row.mode || "неизвестный режим";
//         }

//         const total = row.question_count;
//         const correct = row.correct_count;
//         const percent = total > 0 ? Math.round((correct * 100) / total) : 0;

//         let testerSuffix = "";
//         if (row.admin_full_name) {
//           testerSuffix = ` (${row.admin_full_name})`;
//         }

//         text +=
//           `• ${dateStr} — ${modeLabel}${testerSuffix}\n` +
//           `  Результат: ${correct}/${total} (${percent}%)\n`;
//       }
//     }
//   }

//   text += `\nВыбери раздел:`;

//   const buttons = [];

//   // настройки
//   if (!settingsOpen) {
//     buttons.push([
//       Markup.button.callback(
//         "⚙️ Настройки",
//         `admin_user_settings_open_${user.id}`
//       ),
//     ]);
//   } else {
//     buttons.push([
//       Markup.button.callback(
//         "⚙️ Скрыть настройки",
//         `admin_user_settings_close_${user.id}`
//       ),
//     ]);

//     buttons.push([
//       Markup.button.callback("✏️ Изменить имя", `admin_user_rename_${user.id}`),
//     ]);

//     buttons.push([
//       Markup.button.callback(
//         user.role === "admin" ? "⬇ Сделать пользователем" : "⬆ Сделать админом",
//         `admin_user_toggle_role_${user.id}`
//       ),
//     ]);

//     // новая кнопка: стажёр/работник
//     const staffLabel =
//       user.staff_status === "intern"
//         ? "Сделать работником"
//         : "Сделать стажёром";
//     buttons.push([
//       Markup.button.callback(staffLabel, `admin_user_toggle_staff_${user.id}`),
//     ]);

//     buttons.push([
//       Markup.button.callback(
//         "🗑 Удалить пользователя",
//         `admin_user_delete_${user.id}`
//       ),
//     ]);
//   }

//   // основные разделы
//   buttons.push([
//     Markup.button.callback("✅ Аттестация", `admin_user_attest_${user.id}`),
//   ]);

//   buttons.push([
//     Markup.button.callback("🎓 Стажировка", `admin_user_internship_${user.id}`),
//   ]);

//   // пока стажировку мы ещё не подключили — эту кнопку можно добавить позже
//   // buttons.push([
//   //   Markup.button.callback("🌱 Стажировка", `admin_user_internship_${user.id}`),
//   // ]);

//   buttons.push([
//     Markup.button.callback(
//       "📊 Активность пользователя",
//       `admin_user_activity_${user.id}`
//     ),
//   ]);

//   buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
//   buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

//   await deliver(
//     ctx,
//     { text, extra: Markup.inlineKeyboard(buttons) },
//     { edit: true }
//   );
// }

// async function getAiStats(period = "month") {
//   let interval;
//   if (period === "day") interval = "1 day";
//   else if (period === "week") interval = "7 days";
//   else if (period === "year") interval = "1 year";
//   else interval = "1 month";

//   const res = await pool.query(
//     `
//         SELECT
//         COUNT(*) AS total,
//         COUNT(DISTINCT user_id) AS users,
//         COUNT(*) FILTER (WHERE is_offtopic_confirmed IS TRUE) AS offtopic
//         FROM ai_chat_logs
//         WHERE created_at >= now() - INTERVAL '${interval}'
//         `
//   );

//   return {
//     total: Number(res.rows[0].total) || 0,
//     users: Number(res.rows[0].users) || 0,
//     offtopic: Number(res.rows[0].offtopic) || 0,
//   };
// }

// // -----------------------------------------------------------------------------
// // РЕГИСТРАЦИЯ ХЕНДЛЕРОВ
// // -----------------------------------------------------------------------------

// function registerAdminUsers(bot, ensureUser, logError) {
//   // список пользователей
//   bot.action("admin_users", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       await showAdminUsers(ctx);
//     } catch (err) {
//       logError("admin_users", err);
//     }
//   });

//   // список пользователей: пагинация / фильтр
//   bot.action(/^admin_users_list_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const page = parseInt(ctx.match[1], 10) || 1;
//       const filterItemId = parseInt(ctx.match[2], 10) || 0;
//       const panelFlag = ctx.match[3] === "1"; // показывать ли блок фильтров

//       if (panelFlag) {
//         // если включаем фильтры — сворачиваем панель "Раскрыть"
//         setAdminUsersViewState(ctx.from.id, { expanded: false });
//       }

//       await showAdminUsers(ctx, {
//         page,
//         filterItemId,
//         showFilters: panelFlag,
//       });
//     } catch (err) {
//       logError("admin_users_list_x", err);
//     }
//   });

//   // переключение секции "по статусу"
//   bot.action("admin_users_filter_status_toggle", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};
//       const now = !!st.statusSectionOpen;

//       setAdminUsersViewState(ctx.from.id, {
//         showFilters: true,
//         expanded: false,
//         statusSectionOpen: !now,
//         roleSectionOpen: false,
//         perfSectionOpen: false,
//         perfByItemOpen: false,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_status_toggle_x", err);
//     }
//   });

//   // переключение секции "по роли"
//   bot.action("admin_users_filter_role_toggle", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};
//       const now = !!st.roleSectionOpen;

//       setAdminUsersViewState(ctx.from.id, {
//         showFilters: true,
//         expanded: false,
//         statusSectionOpen: false,
//         roleSectionOpen: !now,
//         perfSectionOpen: false,
//         perfByItemOpen: false,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_role_toggle_x", err);
//     }
//   });

//   // переключение секции "по успеваемости"
//   bot.action("admin_users_filter_perf_toggle", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};
//       const now = !!st.perfSectionOpen;

//       setAdminUsersViewState(ctx.from.id, {
//         showFilters: true,
//         expanded: false,
//         statusSectionOpen: false,
//         roleSectionOpen: false,
//         perfSectionOpen: !now,
//         perfByItemOpen: false,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_perf_toggle_x", err);
//     }
//   });

//   // фильтр по статусу: стажёр
//   bot.action("admin_users_filter_status_intern", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};
//       const current = st.statusFilter || null;
//       const next = current === "intern" ? null : "intern";

//       setAdminUsersViewState(ctx.from.id, {
//         statusFilter: next,
//         showFilters: true,
//         expanded: false,
//         statusSectionOpen: true,
//         roleSectionOpen: false,
//         perfSectionOpen: false,
//         perfByItemOpen: false,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_status_intern_x", err);
//     }
//   });

//   // фильтр по статусу: работник
//   bot.action("admin_users_filter_status_employee", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};
//       const current = st.statusFilter || null;
//       const next = current === "employee" ? null : "employee";

//       setAdminUsersViewState(ctx.from.id, {
//         statusFilter: next,
//         showFilters: true,
//         expanded: false,
//         statusSectionOpen: true,
//         roleSectionOpen: false,
//         perfSectionOpen: false,
//         perfByItemOpen: false,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_status_employee_x", err);
//     }
//   });

//   // фильтр по роли: админ
//   bot.action("admin_users_filter_role_admin", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};
//       const current = st.roleFilter || null;
//       const next = current === "admin" ? null : "admin";

//       setAdminUsersViewState(ctx.from.id, {
//         roleFilter: next,
//         showFilters: true,
//         expanded: false,
//         statusSectionOpen: false,
//         roleSectionOpen: true,
//         perfSectionOpen: false,
//         perfByItemOpen: false,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_role_admin_x", err);
//     }
//   });

//   // фильтр по роли: пользователь
//   bot.action("admin_users_filter_role_user", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};
//       const current = st.roleFilter || null;
//       const next = current === "user" ? null : "user";

//       setAdminUsersViewState(ctx.from.id, {
//         roleFilter: next,
//         showFilters: true,
//         expanded: false,
//         statusSectionOpen: false,
//         roleSectionOpen: true,
//         perfSectionOpen: false,
//         perfByItemOpen: false,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_role_user_x", err);
//     }
//   });

//   // переключить вложенную секцию "по элементам аттестации"
//   bot.action("admin_users_filter_perf_item_toggle", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};
//       const now = !!st.perfByItemOpen;

//       setAdminUsersViewState(ctx.from.id, {
//         showFilters: true,
//         expanded: false,
//         statusSectionOpen: false,
//         roleSectionOpen: false,
//         perfSectionOpen: true,
//         perfByItemOpen: !now,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_perf_item_toggle_x", err);
//     }
//   });

//   // "снять все фильтры"
//   bot.action("admin_users_filter_clear_all", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getAdminUsersViewState(ctx.from.id) || {};

//       setAdminUsersViewState(ctx.from.id, {
//         statusFilter: null,
//         roleFilter: null,
//         filterItemId: 0,
//         statusSectionOpen: false,
//         roleSectionOpen: false,
//         perfSectionOpen: false,
//         perfByItemOpen: false,
//         showFilters: true,
//         expanded: false,
//       });

//       const page = st.page || 1;
//       await showAdminUsers(ctx, { page, showFilters: true });
//     } catch (err) {
//       logError("admin_users_filter_clear_all_x", err);
//     }
//   });

//   // запустить поиск пользователя
//   bot.action("admin_users_search_start", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       userSearchStates.set(ctx.from.id, { step: "await_query" });

//       const keyboard = Markup.inlineKeyboard([
//         [Markup.button.callback("👥 Список пользователей", "admin_users")],
//         [Markup.button.callback("🔙 К фильтрам", "admin_users_list_1_0_1")],
//         [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text:
//             "🔍 Поиск пользователя\n\n" +
//             "Введи любую часть имени, ID пользователя или перешли его сообщение — я покажу подходящих пользователей.",
//           extra: keyboard,
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_users_search_start_x", err);
//     }
//   });

//   // меню "📈 Фильтр по успеваемости"
//   bot.action("admin_users_perf_menu", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const text =
//         "📈 Фильтр по успеваемости\n\n" +
//         "Здесь будут дополнительные фильтры по обученности сотрудников.\n" +
//         "Выбери, что хочешь посмотреть:";

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "📘❌ По элементам аттестации",
//             "admin_users_perf_by_item"
//           ),
//         ],
//         [
//           Markup.button.callback(
//             "⏰ Дедлайн (в разработке)",
//             "admin_users_perf_deadline"
//           ),
//         ],
//         [Markup.button.callback("👥 Список пользователей", "admin_users")],
//         [Markup.button.callback("🔙 К фильтрам", "admin_users_list_1_0_1")],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text,
//           extra: keyboard,
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_users_perf_menu_x", err);
//     }
//   });

//   // раскрыть панель действий под списком пользователей
//   bot.action(/^admin_users_expand_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const page = parseInt(ctx.match[1], 10) || 1;
//       const filterItemId = parseInt(ctx.match[2], 10) || 0;
//       // panelFlag тут не нужен — при раскрытии всегда выключаем фильтры

//       setAdminUsersViewState(ctx.from.id, { expanded: true });

//       await showAdminUsers(ctx, {
//         page,
//         filterItemId,
//         showFilters: false, // фильтр панель свёрнута
//       });
//     } catch (err) {
//       logError("admin_users_expand_x", err);
//     }
//   });

//   // скрыть панель действий
//   bot.action(/^admin_users_collapse_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const page = parseInt(ctx.match[1], 10) || 1;
//       const filterItemId = parseInt(ctx.match[2], 10) || 0;
//       const panelFlag = ctx.match[3] === "1";

//       setAdminUsersViewState(ctx.from.id, { expanded: false });

//       await showAdminUsers(ctx, {
//         page,
//         filterItemId,
//         showFilters: panelFlag,
//       });
//     } catch (err) {
//       logError("admin_users_collapse_x", err);
//     }
//   });

//   // заглушка: экран собеседований (позже добавим полноценный функционал)
//   bot.action("admin_interviews_menu", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const keyboard = Markup.inlineKeyboard([
//         [Markup.button.callback("👥 К пользователям", "admin_users")],
//         [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text:
//             "Экран собеседований пока в разработке.\n" +
//             "Чуть позже здесь появятся кандидаты и фильтры.",
//           extra: keyboard,
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_interviews_menu_x", err);
//     }
//   });

//   // заглушка: приглашение на собеседование
//   bot.action("admin_invite_candidate", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const keyboard = Markup.inlineKeyboard([
//         [Markup.button.callback("👥 К пользователям", "admin_users")],
//         [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text:
//             "Функция «➕ пригласить на собеседование» пока не реализована.\n" +
//             "На следующих шагах мы добавим анкету кандидата и уведомления.",
//           extra: keyboard,
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_invite_candidate_x", err);
//     }
//   });

//   // заглушка для пустых разделителей
//   bot.action("noop", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//     } catch (err) {
//       logError("noop_x", err);
//     }
//   });

//   // карточка пользователя
//   bot.action(/^admin_user_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       await showAdminUserCard(ctx, userId, false);
//     } catch (err) {
//       logError("admin_user_open_x", err);
//     }
//   });

//   // настройки: открыть / закрыть
//   bot.action(/^admin_user_settings_open_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;
//       const userId = parseInt(ctx.match[1], 10);
//       await showAdminUserCard(ctx, userId, true);
//     } catch (err) {
//       logError("admin_user_settings_open_x", err);
//     }
//   });

//   bot.action(/^admin_user_settings_close_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;
//       const userId = parseInt(ctx.match[1], 10);
//       await showAdminUserCard(ctx, userId, false);
//     } catch (err) {
//       logError("admin_user_settings_close_x", err);
//     }
//   });

//   // начало изменения имени
//   bot.action(/^admin_user_rename_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       setUserRenameState(ctx.from.id, { userId });

//       await ctx.reply(
//         `Введи новое имя для пользователя #${userId} одним сообщением.\n` +
//           `Если хочешь очистить имя, отправь просто "-" (дефис).`
//       );
//     } catch (err) {
//       logError("admin_user_rename_start_x", err);
//       await ctx.reply("Не удалось начать изменение имени.");
//     }
//   });

//   // переключение роли
//   bot.action(/^admin_user_toggle_role_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);

//       const userRes = await pool.query(
//         "SELECT id, telegram_id, role, full_name FROM users WHERE id = $1",
//         [userId]
//       );
//       if (!userRes.rows.length) {
//         await ctx.reply("Пользователь не найден.");
//         return;
//       }
//       const user = userRes.rows[0];

//       // нельзя менять роль главного админа
//       if (
//         user.telegram_id &&
//         String(user.telegram_id) === SUPER_ADMIN_TELEGRAM_ID
//       ) {
//         await ctx.reply("Нельзя менять роль этого пользователя.");
//         return;
//       }

//       let newRole;
//       if (user.role === "admin") {
//         // понизить админа может только главный админ
//         if (
//           !admin.telegram_id ||
//           String(admin.telegram_id) !== SUPER_ADMIN_TELEGRAM_ID
//         ) {
//           await ctx.reply(
//             "Понижать администраторов до обычных пользователей может только главный админ."
//           );
//           return;
//         }
//         newRole = "user";
//       } else {
//         newRole = "admin";
//       }

//       await pool.query("UPDATE users SET role = $1 WHERE id = $2", [
//         newRole,
//         userId,
//       ]);

//       await showAdminUserCard(ctx, userId, true);
//     } catch (err) {
//       logError("admin_user_toggle_role_x", err);
//     }
//   });

//   // создание нового пользователя
//   bot.action("admin_add_user", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       setUserCreateState(ctx.from.id, { step: "await_new_user_telegram" });

//       const keyboard = Markup.inlineKeyboard([
//         [Markup.button.callback("🔙 К пользователям", "admin_users")],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text:
//             "✏ Отправь *telegram id* пользователя числом.\n" +
//             "Если id пока неизвестен — отправь любой текст, и пользователь будет создан без привязки к Telegram.",
//           extra: keyboard,
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_add_user", err);
//     }
//   });

//   // запрос на удаление пользователя
//   bot.action(/^admin_user_delete_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);

//       const userRes = await pool.query(
//         "SELECT id, telegram_id, full_name FROM users WHERE id = $1",
//         [userId]
//       );

//       if (!userRes.rows.length) {
//         await ctx.reply("Пользователь не найден.");
//         return;
//       }
//       const user = userRes.rows[0];
//       const name = user.full_name || "Без имени";

//       if (
//         user.telegram_id &&
//         String(user.telegram_id) === SUPER_ADMIN_TELEGRAM_ID
//       ) {
//         await ctx.reply("Нельзя удалить этого пользователя.");
//         return;
//       }

//       const text =
//         `⚠️ Удалить ${name} (id: ${user.id}, tg: ${
//           user.telegram_id || "—"
//         })?\n\n` +
//         "Все связанные с ним данные могут быть удалены в соответствии с настройками БД.";
//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback("❌ Отмена", `admin_user_${user.id}`),
//           Markup.button.callback(
//             "🗑 Да, удалить",
//             `admin_user_delete_confirm_${user.id}`
//           ),
//         ],
//       ]);

//       await deliver(ctx, { text, extra: keyboard }, { edit: true });
//     } catch (err) {
//       logError("admin_user_delete_x", err);
//     }
//   });

//   // подтверждение удаления
//   bot.action(/^admin_user_delete_confirm_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);

//       const userRes = await pool.query(
//         "SELECT id, telegram_id FROM users WHERE id = $1",
//         [userId]
//       );
//       if (!userRes.rows.length) {
//         await ctx.reply("Пользователь не найден.");
//         return;
//       }
//       const user = userRes.rows[0];

//       if (
//         user.telegram_id &&
//         String(user.telegram_id) === SUPER_ADMIN_TELEGRAM_ID
//       ) {
//         await ctx.reply("Нельзя удалить этого пользователя.");
//         return;
//       }

//       await pool.query("DELETE FROM users WHERE id = $1", [userId]);

//       const keyboard = Markup.inlineKeyboard([
//         [Markup.button.callback("🔙 К пользователям", "admin_users")],
//         [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text: "🗑 Пользователь удалён.",
//           extra: keyboard,
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_user_delete_confirm_x", err);
//       await ctx.reply("Не удалось удалить пользователя (ошибка БД).");
//     }
//   });

//   // 📘❌ По элементам аттестации — далее будем делать реальные фильтры по % прохождения
//   bot.action("admin_users_perf_by_item", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const text =
//         "📘❌ Фильтр по успеваемости по элементам аттестации\n\n" +
//         "На этом экране позже можно будет:\n" +
//         "• выбирать элемент аттестации;\n" +
//         "• задавать порог в % по темам/блокам;\n" +
//         "• смотреть только тех, кто не дотягивает до порога.\n\n" +
//         "Пока пользуйся обычными фильтрами по элементам сверху.";

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "📈 Назад к выбору фильтра",
//             "admin_users_perf_menu"
//           ),
//         ],
//         [Markup.button.callback("🔙 К фильтрам", "admin_users_list_1_0_1")],
//       ]);

//       await deliver(ctx, { text, extra: keyboard }, { edit: true });
//     } catch (err) {
//       logError("admin_users_perf_by_item_x", err);
//     }
//   });

//   // ⏰ Дедлайн — по ТЗ функционал позже
//   bot.action("admin_users_perf_deadline", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const text =
//         "⏰ Фильтр по дедлайнам обучения\n\n" +
//         "Этот функционал ещё в разработке.\n" +
//         "Здесь можно будет смотреть, кто не успевает пройти нужные темы/блоки к определённым датам.";

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "📈 Назад к выбору фильтра",
//             "admin_users_perf_menu"
//           ),
//         ],
//         [Markup.button.callback("🔙 К фильтрам", "admin_users_list_1_0_1")],
//       ]);

//       await deliver(ctx, { text, extra: keyboard }, { edit: true });
//     } catch (err) {
//       logError("admin_users_perf_deadline_x", err);
//     }
//   });

//   // прогресс по темам
//   bot.action(/^admin_user_topics_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       await showUserTopicsProgress(ctx, userId);
//     } catch (err) {
//       logError("admin_user_topics_x", err);
//     }
//   });

//   // блоки конкретной темы
//   bot.action(/^admin_user_topic_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       const topicId = parseInt(ctx.match[2], 10);

//       await showUserTopicBlocksProgress(ctx, userId, topicId);
//     } catch (err) {
//       logError("admin_user_topic_x", err);
//     }
//   });

//   // переключение статуса блока
//   bot.action(/^admin_user_block_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       const blockId = parseInt(ctx.match[2], 10);

//       await toggleUserBlockStatus(userId, blockId);
//       const topicId = await getBlockTopicId(blockId);
//       if (topicId) {
//         await showUserTopicBlocksProgress(ctx, userId, topicId);
//       } else {
//         await showUserTopicsProgress(ctx, userId);
//       }
//     } catch (err) {
//       logError("admin_user_block_x", err);
//     }
//   });

//   // переключение статуса обычного элемента аттестации
//   bot.action(/^admin_user_item_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       const itemId = parseInt(ctx.match[2], 10);

//       await toggleUserItemStatus(userId, itemId, admin.id);
//       await showUserAttestation(ctx, userId);
//     } catch (err) {
//       logError("admin_user_item_x", err);
//     }
//   });

//   bot.action(/^admin_user_toggle_staff_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);

//       const userRes = await pool.query(
//         "SELECT id, staff_status FROM users WHERE id = $1",
//         [userId]
//       );
//       if (!userRes.rows.length) {
//         await ctx.reply("Пользователь не найден.");
//         return;
//       }

//       const user = userRes.rows[0];
//       const newStatus = user.staff_status === "intern" ? "employee" : "intern";

//       await pool.query("UPDATE users SET staff_status = $1 WHERE id = $2", [
//         newStatus,
//         userId,
//       ]);

//       await showAdminUserCard(ctx, userId, true, false);
//     } catch (err) {
//       logError("admin_user_toggle_staff_x", err);
//     }
//   });

//   bot.action(/^admin_user_activity_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       await showAdminUserCard(ctx, userId, false, true);
//     } catch (err) {
//       logError("admin_user_activity_x", err);
//     }
//   });

//   // открыть аттестацию пользователя
//   bot.action(/^admin_user_attest_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);

//       // 👉 ВОТ ЭТО ДОБАВЛЯЕМ — теперь train.js знает, что это админ-тест
//       ctx.session = ctx.session || {};
//       ctx.session.adminTestingUser = userId;

//       await showUserAttestation(ctx, userId);
//     } catch (err) {
//       logError("admin_user_attest_x", err);
//     }
//   });

//   // теория база — выбор темы
//   bot.action(/^admin_user_theory_base_topics_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       const itemId = parseInt(ctx.match[2], 10);

//       await showUserTheoryTopics(ctx, userId, itemId, "base");
//     } catch (err) {
//       logError("admin_user_theory_base_topics_x", err);
//     }
//   });

//   // полная теория — выбор темы
//   bot.action(/^admin_user_theory_full_topics_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const userId = parseInt(ctx.match[1], 10);
//       const itemId = parseInt(ctx.match[2], 10);

//       await showUserTheoryTopics(ctx, userId, itemId, "full");
//     } catch (err) {
//       logError("admin_user_theory_full_topics_x", err);
//     }
//   });

//   // старт теста: теория база, конкретная тема
//   bot.action(
//     /^admin_user_theory_base_topic_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const userId = parseInt(ctx.match[1], 10);
//         const itemId = parseInt(ctx.match[2], 10);
//         const topicId = parseInt(ctx.match[3], 10);

//         await startAdminTheoryTest(
//           ctx,
//           admin.id,
//           userId,
//           itemId,
//           "base",
//           topicId
//         );
//       } catch (err) {
//         logError("admin_user_theory_base_topic_x", err);
//       }
//     }
//   );

//   // старт теста: полная теория, конкретная тема
//   bot.action(
//     /^admin_user_theory_full_topic_(\d+)_(\d+)_(\d+)$/,
//     async (ctx) => {
//       try {
//         await ctx.answerCbQuery().catch(() => {});
//         const admin = await ensureUser(ctx);
//         if (!isAdmin(admin)) return;

//         const userId = parseInt(ctx.match[1], 10);
//         const itemId = parseInt(ctx.match[2], 10);
//         const topicId = parseInt(ctx.match[3], 10);

//         await startAdminTheoryTest(
//           ctx,
//           admin.id,
//           userId,
//           itemId,
//           "full",
//           topicId
//         );
//       } catch (err) {
//         logError("admin_user_theory_full_topic_x", err);
//       }
//     }
//   );

//   // показать ответ в админ‑тесте
//   bot.action("admin_theory_show_answer", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const session = getAdminTheorySession(ctx.from.id);
//       if (!session) {
//         await ctx.reply(
//           "Сессия теста не найдена. Вернись в аттестацию пользователя и начни снова."
//         );
//         return;
//       }

//       session.showAnswer = true;
//       setAdminTheorySession(ctx.from.id, session);
//       await renderAdminTheoryQuestion(ctx, ctx.from.id);
//     } catch (err) {
//       logError("admin_theory_show_answer_x", err);
//     }
//   });

//   // отметка ответа
//   bot.action("admin_theory_mark_correct", async (ctx) => {
//     await ctx.answerCbQuery().catch(() => {});
//     await handleAdminTheoryMark(ctx, true, logError);
//   });

//   bot.action("admin_theory_mark_wrong", async (ctx) => {
//     await ctx.answerCbQuery().catch(() => {});
//     await handleAdminTheoryMark(ctx, false, logError);
//   });

//   // список логов общения с ИИ
//   bot.action(/^admin_ai_logs_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const page = parseInt(ctx.match[1], 10) || 1;
//       await showAiLogsList(ctx, page);
//     } catch (err) {
//       logError("admin_ai_logs_x", err);
//     }
//   });

//   // отдельный лог: вопрос + ответ
//   bot.action(/^admin_ai_log_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const logId = parseInt(ctx.match[1], 10);
//       const page = parseInt(ctx.match[2], 10) || 1;

//       await showAiLogDetails(ctx, logId, page);
//     } catch (err) {
//       logError("admin_ai_log_x", err);
//     }
//   });

//   // фильтр: только "не по работе"
//   bot.action(/^admin_ai_logs_filter_offtopic_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const page = parseInt(ctx.match[1], 10) || 1;
//       setAdminAiViewState(ctx.from.id, { aiFilter: "offtopic" });
//       await showAiLogsList(ctx, page);
//     } catch (err) {
//       logError("admin_ai_logs_filter_offtopic_x", err);
//     }
//   });

//   // фильтр: все обращения
//   bot.action(/^admin_ai_logs_filter_all_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const page = parseInt(ctx.match[1], 10) || 1;
//       setAdminAiViewState(ctx.from.id, { aiFilter: "all" });
//       await showAiLogsList(ctx, page);
//     } catch (err) {
//       logError("admin_ai_logs_filter_all_x", err);
//     }
//   });

//   // ❗ Отметить, что обращение было "не по работе"
//   bot.action(/^admin_ai_log_mark_offtopic_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const logId = parseInt(ctx.match[1], 10);
//       const returnPage = parseInt(ctx.match[2], 10) || 1;

//       // берём лог
//       const res = await pool.query(
//         `
//             SELECT id, user_id, is_offtopic_confirmed
//             FROM ai_chat_logs
//             WHERE id = $1
//             `,
//         [logId]
//       );
//       if (!res.rows.length) {
//         await ctx.reply("Запись общения с ИИ не найдена.");
//         return;
//       }
//       const row = res.rows[0];

//       // сколько замечаний было ДО
//       let issuesBefore = 0;
//       if (row.user_id) {
//         const cntRes = await pool.query(
//           `
//                 SELECT COUNT(*) AS cnt
//                 FROM ai_chat_logs
//                 WHERE user_id = $1 AND is_offtopic_confirmed = TRUE
//             `,
//           [row.user_id]
//         );
//         issuesBefore = Number(cntRes.rows[0]?.cnt || 0);
//       }

//       // помечаем как "не по работе"
//       await pool.query(
//         `
//             UPDATE ai_chat_logs
//             SET
//                 is_offtopic_suspected = TRUE,
//                 is_offtopic_confirmed = TRUE
//             WHERE id = $1
//             `,
//         [logId]
//       );

//       // лог действия админа
//       if (row.user_id) {
//         await pool.query(
//           `
//                 INSERT INTO admin_action_logs (admin_id, target_user_id, action_type, details)
//                 VALUES ($1, $2, $3, $4)
//             `,
//           [admin.id, row.user_id, "ai_offtopic_confirmed", { logId }]
//         );
//       }

//       // создаём уведомление пользователю
//       if (row.user_id) {
//         let notifText;
//         if (issuesBefore === 0) {
//           // первое замечание
//           notifText =
//             "🚫🤖 Обращение к ИИ не по работе.\n" +
//             "Это первое предупреждение. В следующий раз будет штраф 100 ₽.";
//         } else {
//           // повторное замечание
//           notifText =
//             "🚫🤖 Повторное обращение к ИИ не по работе.\n" +
//             "Назначен штраф 100 ₽.";
//         }

//         const notifRes = await pool.query(
//           `
//                 INSERT INTO notifications (text, created_by)
//                 VALUES ($1, $2)
//                 RETURNING id
//             `,
//           [notifText, admin.id]
//         );
//         const notifId = notifRes.rows[0].id;

//         await pool.query(
//           `
//                 INSERT INTO user_notifications (notification_id, user_id)
//                 VALUES ($1, $2)
//             `,
//           [notifId, row.user_id]
//         );

//         const uRes = await pool.query(
//           "SELECT telegram_id FROM users WHERE id = $1",
//           [row.user_id]
//         );
//         if (uRes.rows.length && uRes.rows[0].telegram_id) {
//           try {
//             await ctx.telegram.sendMessage(
//               uRes.rows[0].telegram_id,
//               "🚫🤖 НОВОЕ УВЕДОМЛЕНИЕ❗ Нажмите: /notification"
//             );
//           } catch (e) {
//             // игнорируем ошибку отправки конкретному пользователю
//           }
//         }
//       }

//       await showAiLogDetails(ctx, logId, returnPage);
//     } catch (err) {
//       logError("admin_ai_log_mark_offtopic_x", err);
//     }
//   });

//   // ✅ Отметить, что вопрос был по работе (снять/не ставить замечание)
//   bot.action(/^admin_ai_log_mark_ok_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const logId = parseInt(ctx.match[1], 10);
//       const returnPage = parseInt(ctx.match[2], 10) || 1;

//       const res = await pool.query(
//         `
//             SELECT id, user_id
//             FROM ai_chat_logs
//             WHERE id = $1
//             `,
//         [logId]
//       );
//       if (!res.rows.length) {
//         await ctx.reply("Запись общения с ИИ не найдена.");
//         return;
//       }
//       const row = res.rows[0];

//       await pool.query(
//         `
//             UPDATE ai_chat_logs
//             SET
//                 is_offtopic_suspected = FALSE,
//                 is_offtopic_confirmed = FALSE,
//                 off_topic_comment = NULL
//             WHERE id = $1
//             `,
//         [logId]
//       );

//       if (row.user_id) {
//         await pool.query(
//           `
//                 INSERT INTO admin_action_logs (admin_id, target_user_id, action_type, details)
//                 VALUES ($1, $2, $3, $4)
//             `,
//           [admin.id, row.user_id, "ai_marked_as_work", { logId }]
//         );
//       }

//       await showAiLogDetails(ctx, logId, returnPage);
//     } catch (err) {
//       logError("admin_ai_log_mark_ok_x", err);
//     }
//   });

//   // текстовые шаги (создание пользователя + изменение имени)
//   bot.on("text", async (ctx, next) => {
//     try {
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return next();

//       const rawText = (ctx.message.text || "").trim();
//       if (!rawText) return next();

//       // изменение имени
//       const renameState = userRenameStates.get(ctx.from.id);
//       if (renameState) {
//         let newName = rawText;
//         if (newName === "-") newName = null;

//         try {
//           await pool.query("UPDATE users SET full_name = $1 WHERE id = $2", [
//             newName,
//             renameState.userId,
//           ]);

//           clearUserRenameState(ctx.from.id);

//           await ctx.reply(
//             newName
//               ? `Имя пользователя #${renameState.userId} обновлено: ${newName}`
//               : `Имя пользователя #${renameState.userId} очищено.`
//           );
//         } catch (err) {
//           logError("admin_user_rename_save_x", err);
//           await ctx.reply("Не удалось сохранить имя, попробуй ещё раз.");
//         }

//         return;
//       }

//       // поиск пользователя
//       const searchState = userSearchStates.get(ctx.from.id);
//       if (searchState && searchState.step === "await_query") {
//         const text = rawText;
//         userSearchStates.delete(ctx.from.id);

//         let users = [];

//         // 1) если переслали сообщение пользователя
//         const fwd = ctx.message.forward_from;
//         if (fwd && fwd.id) {
//           const tgId = fwd.id;
//           const res = await pool.query(
//             `
//             SELECT id, full_name, staff_status
//             FROM users
//             WHERE telegram_id = $1
//             ORDER BY id ASC
//             `,
//             [tgId]
//           );
//           users = res.rows;
//         } else {
//           // 2) если ввели чисто цифры — пробуем как id / telegram_id
//           const isDigits = /^\d+$/.test(text);
//           if (isDigits) {
//             const num = Number(text);
//             const res = await pool.query(
//               `
//                 SELECT id, full_name, staff_status
//                 FROM users
//                 WHERE id = $1 OR telegram_id = $1
//                 ORDER BY id ASC
//                 `,
//               [num]
//             );
//             users = res.rows;
//           }

//           // 3) если по id/telegram_id не нашли — ищем по части имени
//           if (!users.length) {
//             const pattern = `%${text}%`;
//             const res = await pool.query(
//               `
//                 SELECT id, full_name, staff_status
//                 FROM users
//                 WHERE full_name ILIKE $1
//                 ORDER BY full_name ASC
//                 LIMIT 50
//                 `,
//               [pattern]
//             );
//             users = res.rows;
//           }
//         }

//         if (!users.length) {
//           const keyboard = Markup.inlineKeyboard([
//             [Markup.button.callback("👥 Список пользователей", "admin_users")],
//             [
//               Markup.button.callback(
//                 "🔍 Новый поиск",
//                 "admin_users_search_start"
//               ),
//             ],
//             [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
//           ]);

//           await deliver(
//             ctx,
//             {
//               text:
//                 "Ничего не нашлось.\n\n" +
//                 "Попробуй ввести другую часть имени, ID или перешли сообщение пользователя.",
//               extra: keyboard,
//             },
//             { edit: false }
//           );
//           return;
//         }

//         let msg =
//           "🔍 Результаты поиска пользователей\n\n" +
//           `Найдено: ${users.length}\n\n` +
//           "Выбери пользователя:";

//         const buttons = [];

//         for (const u of users) {
//           const name = u.full_name || "Без имени";
//           const icon = u.staff_status === "intern" ? "🎓" : "🧠";
//           buttons.push([
//             Markup.button.callback(`${icon} ${name}`, `admin_user_${u.id}`),
//           ]);
//         }

//         buttons.push([
//           Markup.button.callback("👥 Список пользователей", "admin_users"),
//         ]);
//         buttons.push([
//           Markup.button.callback("🔍 Новый поиск", "admin_users_search_start"),
//         ]);
//         buttons.push([
//           Markup.button.callback("🔙 В админ-панель", "admin_menu"),
//         ]);

//         await deliver(
//           ctx,
//           { text: msg, extra: Markup.inlineKeyboard(buttons) },
//           { edit: false }
//         );
//         return;
//       }

//       // создание пользователя
//       const state = userCreateStates.get(ctx.from.id);
//       if (!state) return next();

//       const text = rawText;

//       if (state.step === "await_new_user_telegram") {
//         let telegramId = null;
//         if (/^\d+$/.test(text)) {
//           telegramId = text;
//         }

//         setUserCreateState(ctx.from.id, {
//           step: "await_new_user_name",
//           tmpTelegramId: telegramId,
//         });

//         await ctx.reply(
//           "Теперь отправь имя сотрудника (как он будет отображаться в админке) одним сообщением."
//         );
//         return;
//       }

//       if (state.step === "await_new_user_name") {
//         const fullName = text;
//         const telegramId = state.tmpTelegramId || null;

//         try {
//           let userRow = null;

//           if (telegramId) {
//             // пробуем вставить; если такой tg-id уже есть — обновляем имя
//             try {
//               const insertRes = await pool.query(
//                 `
//                     INSERT INTO users (telegram_id, role, full_name)
//                     VALUES ($1, 'user', $2)
//                     RETURNING id
//                     `,
//                 [telegramId, fullName]
//               );
//               userRow = insertRes.rows[0];
//             } catch (err) {
//               if (err.code === "23505") {
//                 const updRes = await pool.query(
//                   `
//                     UPDATE users
//                     SET full_name = $1
//                     WHERE telegram_id = $2
//                     RETURNING id
//                     `,
//                   [fullName, telegramId]
//                 );
//                 if (updRes.rows.length) {
//                   userRow = updRes.rows[0];
//                 } else {
//                   throw err;
//                 }
//               } else {
//                 throw err;
//               }
//             }
//           } else {
//             const insertRes = await pool.query(
//               `
//                 INSERT INTO users (role, full_name)
//                 VALUES ('user', $1)
//                 RETURNING id
//                 `,
//               [fullName]
//             );
//             userRow = insertRes.rows[0];
//           }

//           clearUserCreateState(ctx.from.id);

//           await ctx.reply(
//             `Пользователь создан (id: ${userRow.id}).\n` +
//               "Возвращаю список пользователей..."
//           );
//           await showAdminUsers(ctx);
//         } catch (err) {
//           logError("admin_create_user", err);
//           clearUserCreateState(ctx.from.id);
//           await ctx.reply("Не удалось создать пользователя (ошибка БД).");
//         }

//         return;
//       }

//       return next();
//     } catch (err) {
//       logError("admin_user_text_handler", err);
//       return next();
//     }
//   });

//   bot.action("admin_ai_stats_menu", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const text = "📊 Статистика обращений к ИИ.\n\n" + "Выбери период:";

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback("📅 День", "admin_ai_stats_day"),
//           Markup.button.callback("📆 Неделя", "admin_ai_stats_week"),
//         ],
//         [
//           Markup.button.callback("🗓 Месяц", "admin_ai_stats_month"),
//           Markup.button.callback("📈 Год", "admin_ai_stats_year"),
//         ],
//         [Markup.button.callback("🔙 К списку обращений", "admin_ai_logs_1")],
//       ]);

//       await deliver(ctx, { text, extra: keyboard }, { edit: true });
//     } catch (err) {
//       logError("admin_ai_stats_menu_x", err);
//     }
//   });

//   bot.action(/^admin_ai_stats_(day|week|month|year)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const period = ctx.match[1];
//       const stats = await getAiStats(period);

//       const labels = {
//         day: "за день",
//         week: "за неделю",
//         month: "за месяц",
//         year: "за год",
//       };

//       let text =
//         `📊 Статистика обращений к ИИ ${labels[period]}:\n\n` +
//         `• Всего вопросов: ${stats.total}\n` +
//         `• Пользователей: ${stats.users}\n` +
//         `• Отмечено \"не по работе\": ${stats.offtopic}\n\n` +
//         "Можно выбрать другой период:";

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback("📅 День", "admin_ai_stats_day"),
//           Markup.button.callback("📆 Неделя", "admin_ai_stats_week"),
//         ],
//         [
//           Markup.button.callback("🗓 Месяц", "admin_ai_stats_month"),
//           Markup.button.callback("📈 Год", "admin_ai_stats_year"),
//         ],
//         [Markup.button.callback("🔙 К списку обращений", "admin_ai_logs_1")],
//       ]);

//       await deliver(ctx, { text, extra: keyboard }, { edit: true });
//     } catch (err) {
//       logError("admin_ai_stats_x", err);
//     }
//   });
// }

// // вспомогательная функция: получить topic_id по block_id
// async function getBlockTopicId(blockId) {
//   const res = await pool.query("SELECT topic_id FROM blocks WHERE id = $1", [
//     blockId,
//   ]);
//   if (!res.rows.length) return null;
//   return res.rows[0].topic_id;
// }

// module.exports = registerAdminUsers;
