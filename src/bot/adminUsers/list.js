// src/bot/adminUsers/list.js

const pool = require("../../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");
const { getCandidateCreateState } = require("../interviews/state");

const {
  SUPER_ADMIN_TELEGRAM_ID,
  ADMIN_THEORY_PASS_PERCENT,
  PAGE_SIZE,
  isAdmin,
  getAdminUsersViewState,
  setAdminUsersViewState,
  getUserCreateState,
  setUserCreateState,
  clearUserCreateState,
  getUserRenameState,
  setUserRenameState,
  clearUserRenameState,
  getUserSearchState,
  clearUserSearchState,
  setAdminTheorySession,
  getAdminTheorySession,
  clearAdminTheorySession,
} = require("./state");

// Импорт функций из aiLogs.js для отображения статистики ИИ в меню
const { getNewAiLogsCount, getPendingOfftopicCount } = require("./aiLogs");

// Получение прогресса по темам теории для пользователя (количество пройденных блоков)
async function getTopicsProgressForUser(userId) {
  const res = await pool.query(
    `
        SELECT
        t.id,
        t.title,
        t.order_index,
        COUNT(b.id) AS total_blocks,
        COALESCE(
            SUM(CASE WHEN ubs.status = 'passed' THEN 1 ELSE 0 END),
            0
        ) AS passed_blocks
        FROM topics t
        LEFT JOIN blocks b ON b.topic_id = t.id
        LEFT JOIN user_block_status ubs ON ubs.block_id = b.id AND ubs.user_id = $1
        GROUP BY t.id, t.title, t.order_index
        ORDER BY t.order_index, t.id
    `,
    [userId]
  );
  return res.rows.map((row) => {
    const total = Number(row.total_blocks) || 0;
    const passed = Number(row.passed_blocks) || 0;
    const percent = total > 0 ? Math.round((passed * 100) / total) : 0;
    return {
      id: row.id,
      title: row.title,
      totalBlocks: total,
      passedBlocks: passed,
      percent,
    };
  });
}

// Получение прогресса по блокам конкретной темы для пользователя
async function getTopicBlocksProgressForUser(userId, topicId) {
  const res = await pool.query(
    `
        SELECT
        b.id,
        b.title,
        COALESCE(ubs.status, 'not_passed') AS status
        FROM blocks b
        LEFT JOIN user_block_status ubs ON ubs.block_id = b.id AND ubs.user_id = $1
        WHERE b.topic_id = $2
        ORDER BY b.order_index, b.id
    `,
    [userId, topicId]
  );
  return res.rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    isPassed: row.status === "passed",
  }));
}

// Помощник: получить topic_id блока (для обновления списка блоков после смены статуса)
async function getBlockTopicId(blockId) {
  const res = await pool.query("SELECT topic_id FROM blocks WHERE id = $1", [
    blockId,
  ]);
  return res.rows.length ? res.rows[0].topic_id : null;
}

// Основной экран списка пользователей (с фильтрами и пагинацией)
async function showAdminUsers(ctx, options = {}) {
  let page = Number(options.page) || 1;
  const viewState = getAdminUsersViewState(ctx.from.id) || {};
  // Читаем текущие фильтры
  let {
    filterItemId,
    showFilters,
    expanded,
    statusFilter,
    roleFilter,
    statusSectionOpen,
    roleSectionOpen,
    perfSectionOpen,
    perfByItemOpen,
  } = viewState;
  // Применяем опции (если переданы)
  if (typeof options.filterItemId === "number") {
    filterItemId = options.filterItemId;
  } else if (typeof filterItemId !== "number") {
    filterItemId = 0;
  }
  if (typeof options.showFilters === "boolean") {
    showFilters = options.showFilters;
  } else if (typeof showFilters !== "boolean") {
    showFilters = false;
  }
  expanded = !!viewState.expanded;
  // Сохраняем состояние
  setAdminUsersViewState(ctx.from.id, {
    page,
    filterItemId,
    showFilters,
    expanded,
    statusFilter: statusFilter || null,
    roleFilter: roleFilter || null,
    statusSectionOpen: !!statusSectionOpen,
    roleSectionOpen: !!roleSectionOpen,
    perfSectionOpen: !!perfSectionOpen,
    perfByItemOpen: !!perfByItemOpen,
  });
  // Получаем обновлённый state после сохранения
  const state = getAdminUsersViewState(ctx.from.id) || {};
  filterItemId =
    typeof state.filterItemId === "number" ? state.filterItemId : 0;
  showFilters = !!state.showFilters;
  expanded = !!state.expanded;
  statusFilter = state.statusFilter || null;
  roleFilter = state.roleFilter || null;
  statusSectionOpen = !!state.statusSectionOpen;
  roleSectionOpen = !!state.roleSectionOpen;
  perfSectionOpen = !!state.perfSectionOpen;
  perfByItemOpen = !!state.perfByItemOpen;
  // Получаем список элементов аттестации для фильтра "по элементам"
  const filtersRes = await pool.query(
    `SELECT id, title FROM attestation_items WHERE is_active = TRUE ORDER BY order_index, id`
  );
  const filterItems = filtersRes.rows;
  // Если выбран фильтр по элементу, получаем его название
  let activeFilter = null;
  if (filterItemId) {
    const fRes = await pool.query(
      "SELECT id, title FROM attestation_items WHERE id = $1",
      [filterItemId]
    );
    if (fRes.rows.length) {
      activeFilter = fRes.rows[0];
    } else {
      filterItemId = 0;
    }
  }
  // Получаем список пользователей с учётом фильтров
  const offset = (page - 1) * PAGE_SIZE;
  let totalUsers = 0;
  let usersRes;
  const baseWhereClauses = [];
  const baseParams = [];
  if (statusFilter === "intern" || statusFilter === "employee") {
    baseWhereClauses.push(`u.staff_status = $${baseParams.length + 1}`);
    baseParams.push(statusFilter);
  }
  if (roleFilter === "admin" || roleFilter === "user") {
    baseWhereClauses.push(`u.role = $${baseParams.length + 1}`);
    baseParams.push(roleFilter);
  }
  if (!filterItemId) {
    const whereSql = baseWhereClauses.length
      ? "WHERE " + baseWhereClauses.join(" AND ")
      : "";
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM users u ${whereSql}`,
      baseParams
    );
    totalUsers = Number(countRes.rows[0].count) || 0;
    usersRes = await pool.query(
      `
      SELECT id, telegram_id, role, full_name, staff_status, intern_days_completed
      FROM users u
      ${whereSql}
      ORDER BY id ASC
      LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}
      `,
      [...baseParams, PAGE_SIZE, offset]
    );
  } else {
    const params = [filterItemId, ...baseParams];
    const whereSql =
      baseWhereClauses.length > 0
        ? "AND " +
          baseWhereClauses
            .map((clause, idx) => clause.replace(/\$\d+/g, `$${idx + 2}`))
            .join(" AND ")
        : "";

    const countRes = await pool.query(
      `
      SELECT COUNT(*) 
      FROM users u
      LEFT JOIN user_attestation_status uas ON uas.user_id = u.id AND uas.item_id = $1
      WHERE COALESCE(uas.status, 'not_passed') <> 'passed'
      ${whereSql}
      `,
      params
    );
    totalUsers = Number(countRes.rows[0].count) || 0;
    const listParams = [...params, PAGE_SIZE, offset];
    usersRes = await pool.query(
      `
      SELECT u.id, u.telegram_id, u.role, u.full_name, u.staff_status, u.intern_days_completed
      FROM users u
      LEFT JOIN user_attestation_status uas ON uas.user_id = u.id AND uas.item_id = $1
      WHERE COALESCE(uas.status, 'not_passed') <> 'passed'
      ${whereSql}
      ORDER BY u.id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      listParams
    );
  }
  const users = usersRes.rows;
  const totalPages = totalUsers > 0 ? Math.ceil(totalUsers / PAGE_SIZE) : 1;
  if (page > totalPages) page = totalPages;
  // Формируем текст заголовка списка
  let text = "👥 Пользователи";
  const filterLines = [];
  if (statusFilter === "intern") {
    filterLines.push("• Фильтр по статусу: 🎓 стажёр");
  } else if (statusFilter === "employee") {
    filterLines.push("• Фильтр по статусу: 🧠 работник");
  }
  if (roleFilter === "admin") {
    filterLines.push("• Фильтр по роли: 🛠️ администратор");
  } else if (roleFilter === "user") {
    filterLines.push("• Фильтр по роли: 👤 пользователь");
  }
  if (activeFilter) {
    filterLines.push(
      `• По элементу аттестации: ❌ ${activeFilter.title} — не сдали`
    );
  }
  if (filterLines.length) {
    text += "\n\nАктивные фильтры:\n" + filterLines.join("\n");
  }
  if (!totalUsers) {
    text += `\n\nПо выбранным условиям пока нет пользователей.`;
  } else {
    text += `\n\nВсего: ${totalUsers}`;
    if (totalPages > 1) {
      text += `\nСтраница ${page} из ${totalPages}`;
    }
  }
  // Формируем кнопки списка пользователей
  const buttons = [];
  for (const row of users) {
    const name = row.full_name || "Без имени";
    const status = row.staff_status === "intern" ? "intern" : "employee";
    const icon = status === "intern" ? "🎓" : "🧠";
    const label = `${icon} ${name}`;
    buttons.push([Markup.button.callback(label, `admin_user_${row.id}`)]);
  }
  // Пагинация
  if (totalPages > 1) {
    const panelFlag = showFilters ? 1 : 0;
    const filt = filterItemId || 0;
    const navRow = [];
    if (page > 1) {
      navRow.push(
        Markup.button.callback(
          "⬅️ Назад",
          `admin_users_list_${page - 1}_${filt}_${panelFlag}`
        )
      );
    }
    if (page < totalPages) {
      navRow.push(
        Markup.button.callback(
          "➡️ Далее",
          `admin_users_list_${page + 1}_${filt}_${panelFlag}`
        )
      );
    }
    if (navRow.length) {
      buttons.push(navRow);
    }
  }
  // Нижняя панель действий
  const panelFlag = showFilters ? 1 : 0;
  const filt = filterItemId || 0;

  // Кнопки "Фильтр" и "Раскрыть/Скрыть"
  const panelFlagNext = showFilters ? 0 : 1;
  const filterBtn = Markup.button.callback(
    showFilters ? "🔼 Фильтр 🔼" : "🔽 Фильтр 🔽",
    `admin_users_list_${page}_${filt}_${panelFlagNext}`
  );
  const expandBtn = Markup.button.callback(
    expanded ? "🔼 Скрыть 🔼" : "🔽 Раскрыть 🔽",
    expanded
      ? `admin_users_collapse_${page}_${filt}_${panelFlag}`
      : `admin_users_expand_${page}_${filt}_${panelFlag}`
  );
  buttons.push([filterBtn, expandBtn]);

  // Блок панели фильтров (если включена)
  if (showFilters) {
    // Раздел "по статусу"
    const statusLabel = statusSectionOpen
      ? "🔼 по статусу 🔼"
      : "🔽 по статусу 🔽";
    buttons.push([
      Markup.button.callback(statusLabel, "admin_users_filter_status_toggle"),
    ]);
    if (statusSectionOpen) {
      const internActive = statusFilter === "intern";
      const employeeActive = statusFilter === "employee";
      buttons.push([
        Markup.button.callback(
          internActive ? "✅ 🎓 стажёр" : "🎓 стажёр",
          "admin_users_filter_status_intern"
        ),
        Markup.button.callback(
          employeeActive ? "✅ 🧠 работник" : "🧠 работник",
          "admin_users_filter_status_employee"
        ),
      ]);
    }

    // Раздел "по роли"
    const roleLabel = roleSectionOpen ? "🔼 по роли 🔼" : "🔽 по роли 🔽";
    buttons.push([
      Markup.button.callback(roleLabel, "admin_users_filter_role_toggle"),
    ]);
    if (roleSectionOpen) {
      const adminActive = roleFilter === "admin";
      const userActive = roleFilter === "user";
      buttons.push([
        Markup.button.callback(
          adminActive ? "✅ 🛠️ администратор" : "🛠️ администратор",
          "admin_users_filter_role_admin"
        ),
        Markup.button.callback(
          userActive ? "✅ 👤 пользователь" : "👤 пользователь",
          "admin_users_filter_role_user"
        ),
      ]);
    }

    // Раздел "по успеваемости"
    const perfLabel = perfSectionOpen
      ? "🔼 по успеваемости 🔼"
      : "🔽 по успеваемости 🔽";
    buttons.push([
      Markup.button.callback(perfLabel, "admin_users_filter_perf_toggle"),
    ]);
    if (perfSectionOpen) {
      const byItemLabel = perfByItemOpen
        ? "🔼 по элементам аттестации 🔼"
        : "🔽 по элементам аттестации 🔽";
      const byDeadlineLabel = "🔽 по дедлайн 🔽";

      buttons.push([
        Markup.button.callback(
          byItemLabel,
          "admin_users_filter_perf_item_toggle"
        ),
      ]);
      buttons.push([
        Markup.button.callback(byDeadlineLabel, "admin_users_perf_deadline"),
      ]);

      if (perfByItemOpen) {
        for (const item of filterItems) {
          buttons.push([
            Markup.button.callback(
              `❌ ${item.title}`,
              `admin_users_list_1_${item.id}_1`
            ),
          ]);
        }
        buttons.push([
          Markup.button.callback(
            "Показать всех по элементу",
            "admin_users_list_1_0_1"
          ),
        ]);
      }
    }

    // Кнопки "снять все фильтры" и "поиск"
    buttons.push([
      Markup.button.callback(
        "🔄 снять все фильтры 🔄",
        "admin_users_filter_clear_all"
      ),
    ]);
    buttons.push([
      Markup.button.callback(
        "🔍 Найти пользователя",
        "admin_users_search_start"
      ),
    ]);
  }

  // Расширенная панель действий (если раскрыта)
  if (expanded) {
    // Кнопка перехода к логам общения с ИИ
    let aiLabel;
    const newAiLogsCount = await getNewAiLogsCount();
    const pendingOfftopicCount = await getPendingOfftopicCount();

    aiLabel =
      newAiLogsCount > 0
        ? `🔮 Общение с ИИ (${newAiLogsCount} новых)`
        : `🔮 Общение с ИИ (0 новых)`;

    if (pendingOfftopicCount > 0) {
      aiLabel += " ❗";
    }

    buttons.push([Markup.button.callback(aiLabel, "admin_ai_logs_1")]);

    // Разделитель (пустая кнопка)
    buttons.push([Markup.button.callback(" ", "noop")]);
  }

  // Статичные нижние кнопки (как на экране собеседований)
  buttons.push([
    Markup.button.callback("➕ Добавить пользователя", "admin_add_user"),
  ]);
  buttons.push([
    Markup.button.callback("➡️ к собеседованиям", "admin_interviews"),
  ]);

  // Отправляем сообщение с inline-клавиатурой
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Показ подробной карточки пользователя (профиль, настройки, аттестация)
async function showAdminUserCard(
  ctx,
  userId,
  settingsOpen = false,
  showActivity = false
) {
  const userRes = await pool.query(
    "SELECT id, telegram_id, role, full_name, staff_status, intern_days_completed FROM users WHERE id = $1",
    [userId]
  );
  if (!userRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = userRes.rows[0];
  const name = user.full_name || "Без имени";
  // Получаем информацию для сводки по аттестации
  const attestRes = await pool.query(
    `
    SELECT ai.id, ai.title, uas.status, uas.updated_by_admin_id, ua.full_name AS updated_by_admin_name
    FROM attestation_items ai
    LEFT JOIN user_attestation_status uas ON uas.item_id = ai.id AND uas.user_id = $1
    LEFT JOIN users ua ON ua.id = uas.updated_by_admin_id
    WHERE ai.is_active = TRUE
    ORDER BY ai.order_index, ai.id
    `,
    [userId]
  );
  const testsRes = await pool.query(
    `
    SELECT ts.created_at, ts.mode, ts.question_count, ts.correct_count, t.title AS topic_title,
           ua.full_name AS admin_full_name
    FROM test_sessions ts
    LEFT JOIN topics t ON t.id = ts.topic_id
    LEFT JOIN users ua ON ua.id = COALESCE(ts.conducted_by, ts.admin_id)
    WHERE ts.user_id = $1
    ORDER BY ts.created_at DESC
    LIMIT 5
    `,
    [userId]
  );
  const isIntern = user.staff_status === "intern";
  const dayNumber = (user.intern_days_completed || 0) + 1;
  let text =
    `👤 ${name}\n` +
    `Роль: ${user.role}\n` +
    (isIntern ? `Статус: стажёр (день ${dayNumber})\n` : `Статус: работник\n`);
  // Сводка по элементам аттестации
  if (attestRes.rows.length) {
    text += "\n────────────\n";
    for (const row of attestRes.rows) {
      const rawTitle = row.title || "";
      const lower = rawTitle.trim().toLowerCase();
      const passed = row.status === "passed";
      const icon = passed ? "✅" : "❌";
      let line = `${icon} ${rawTitle}`;
      if (
        passed &&
        row.updated_by_admin_name &&
        lower !== "теория база" &&
        lower !== "полная теория"
      ) {
        line += ` (${row.updated_by_admin_name})`;
      }
      text += line + "\n";
    }
    text += "────────────\n";
  }
  // Если запрошена активность пользователя, добавляем последние тесты/тренировки
  if (showActivity) {
    text += "\n📊 Последние тесты / тренировки:\n";
    const tests = testsRes.rows;
    if (!tests.length) {
      text += "Пока нет ни одного теста.\n";
    } else {
      for (const row of tests) {
        const date = new Date(row.created_at.getTime() + 7 * 60 * 60 * 1000); // приводим к часовому поясу MSK
        const dateStr = date.toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        let modeLabel;
        if (row.mode === "topic") {
          modeLabel = `по теме: "${row.topic_title || "Без названия"}"`;
        } else if (row.mode === "all") {
          modeLabel = "по всем темам";
        } else if (row.mode === "admin_base") {
          modeLabel = `админ-тест «Теория база» по теме: "${
            row.topic_title || "Без названия"
          }"`;
        } else if (row.mode === "admin_full") {
          modeLabel = `админ-тест «Полная теория» по теме: "${
            row.topic_title || "Без названия"
          }"`;
        } else {
          modeLabel = row.mode || "неизвестный режим";
        }
        const total = row.question_count;
        const correct = row.correct_count;
        const percent = total > 0 ? Math.round((correct * 100) / total) : 0;
        const testerSuffix = row.admin_full_name
          ? ` (${row.admin_full_name})`
          : "";
        text += `• ${dateStr} — ${modeLabel}${testerSuffix}\n  Результат: ${correct}/${total} (${percent}%)\n`;
      }
    }
  }
  text += "\nВыбери раздел:";
  const buttons = [];
  if (!settingsOpen) {
    buttons.push([
      Markup.button.callback(
        "⚙️ Настройки",
        `admin_user_settings_open_${user.id}`
      ),
    ]);
  } else {
    buttons.push([
      Markup.button.callback(
        "⚙️ Скрыть настройки",
        `admin_user_settings_close_${user.id}`
      ),
    ]);
    buttons.push([
      Markup.button.callback("✏️ Изменить имя", `admin_user_rename_${user.id}`),
    ]);
    buttons.push([
      Markup.button.callback(
        user.role === "admin" ? "⬇ Сделать пользователем" : "⬆ Сделать админом",
        `admin_user_toggle_role_${user.id}`
      ),
    ]);
    const staffLabel =
      user.staff_status === "intern"
        ? "Сделать работником"
        : "Сделать стажёром";
    buttons.push([
      Markup.button.callback(staffLabel, `admin_user_toggle_staff_${user.id}`),
    ]);
    buttons.push([
      Markup.button.callback(
        "🗑 Удалить пользователя",
        `admin_user_delete_${user.id}`
      ),
    ]);
  }
  // Основные действия: аттестация, (стажировка), активность
  buttons.push([
    Markup.button.callback("✅ Аттестация", `admin_user_attest_${user.id}`),
  ]);
  // Кнопку стажировки можно добавить при реализации модуля стажировки:
  // buttons.push([Markup.button.callback("🌱 Стажировка", `admin_user_internship_${user.id}`)]);
  buttons.push([
    Markup.button.callback(
      "📊 Активность пользователя",
      `admin_user_activity_${user.id}`
    ),
  ]);
  buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Показ экрана прогресса по темам теории для пользователя
async function showUserTopicsProgress(ctx, userId) {
  const topics = await getTopicsProgressForUser(userId);
  const uRes = await pool.query("SELECT full_name FROM users WHERE id = $1", [
    userId,
  ]);
  const userName =
    uRes.rows.length && uRes.rows[0].full_name
      ? uRes.rows[0].full_name
      : "Без имени";
  if (!topics.length) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("👥 Список пользователей", "admin_users")],
      [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
    ]);
    await deliver(
      ctx,
      {
        text: `Для ${userName} пока нет ни одной темы теории.`,
        extra: keyboard,
      },
      { edit: true }
    );
    return;
  }
  let text = `👤 ${userName}\n\n📚 Темы теории.\nНажимай на тему, чтобы посмотреть статусы блоков.`;
  const buttons = topics.map((t) => {
    const label =
      t.totalBlocks > 0
        ? `${t.title} (${t.passedBlocks}/${t.totalBlocks}, ${t.percent}%)`
        : `${t.title} (0 блоков)`;
    return [
      Markup.button.callback(label, `admin_user_topic_${userId}_${t.id}`),
    ];
  });
  buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Показ экрана прогресса по блокам выбранной темы
async function showUserTopicBlocksProgress(ctx, userId, topicId) {
  const blocks = await getTopicBlocksProgressForUser(userId, topicId);
  const uRes = await pool.query("SELECT full_name FROM users WHERE id = $1", [
    userId,
  ]);
  const userName =
    uRes.rows.length && uRes.rows[0].full_name
      ? uRes.rows[0].full_name
      : "Без имени";
  const topicRes = await pool.query("SELECT title FROM topics WHERE id = $1", [
    topicId,
  ]);
  const topicTitle = topicRes.rows.length
    ? topicRes.rows[0].title
    : "Без названия";
  if (!blocks.length) {
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "📚 Ко всем темам",
          `admin_user_topics_${userId}`
        ),
      ],
      [Markup.button.callback("🔙 К пользователям", "admin_users")],
    ]);
    const text = `👤 ${userName}\nТема: ${topicTitle}\n\nВ этой теме пока нет блоков.`;
    await deliver(ctx, { text, extra: keyboard }, { edit: true });
    return;
  }
  const text = `👤 ${userName}\nТема: ${topicTitle}\n\nВыбери блок, чтобы поставить / снять галочку.`;
  const buttons = blocks.map((b) => {
    const icon = b.isPassed ? "✅" : "⚪️";
    return [
      Markup.button.callback(
        `${icon} ${b.title}`,
        `admin_user_block_${userId}_${b.id}`
      ),
    ];
  });
  buttons.push([
    Markup.button.callback("📚 Ко всем темам", `admin_user_topics_${userId}`),
  ]);
  buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Получение списка тем теории (для функций аттестации)
async function getTheoryTopics(type) {
  if (type === "base") {
    const res = await pool.query(
      `
      SELECT DISTINCT t.id, t.title, t.order_index
      FROM topics t
      JOIN blocks b ON b.topic_id = t.id
      JOIN cards c ON c.block_id = b.id
      WHERE COALESCE(c.difficulty, 1) = 1
      ORDER BY t.order_index, t.id
      `
    );
    return res.rows;
  } else {
    const res = await pool.query(
      `
      SELECT DISTINCT t.id, t.title, t.order_index
      FROM topics t
      JOIN blocks b ON b.topic_id = t.id
      JOIN cards c ON c.block_id = b.id
      ORDER BY t.order_index, t.id
      `
    );
    return res.rows;
  }
}

// Вычисление прогресса по теории (база/полная) для пользователя
async function getUserTheoryElementProgress(userId, typeKey) {
  const topics = await getTheoryTopics(typeKey);
  const totalTopics = topics.length;
  if (!totalTopics) {
    return { totalTopics: 0, passedTopics: 0, percent: 0 };
  }
  const mode = typeKey === "base" ? "admin_base" : "admin_full";
  const sessionsRes = await pool.query(
    `
    SELECT topic_id, question_count, correct_count
    FROM test_sessions
    WHERE user_id = $1 AND mode = $2
    ORDER BY created_at DESC
    `,
    [userId, mode]
  );
  const lastByTopic = new Map();
  for (const row of sessionsRes.rows) {
    if (!row.topic_id) continue;
    if (!lastByTopic.has(row.topic_id)) {
      lastByTopic.set(row.topic_id, row);
    }
  }
  let passedTopics = 0;
  for (const t of topics) {
    const s = lastByTopic.get(t.id);
    if (!s) continue;
    const total = Number(s.question_count) || 0;
    const correct = Number(s.correct_count) || 0;
    const perc = total > 0 ? Math.round((correct * 100) / total) : 0;
    if (perc >= ADMIN_THEORY_PASS_PERCENT) {
      passedTopics += 1;
    }
  }
  const percent = Math.round((passedTopics * 100) / totalTopics);
  return { totalTopics, passedTopics, percent };
}

// Синхронизация статуса элемента аттестации на основе процента прогресса
async function syncUserTheoryItemStatus(userId, itemId, percent) {
  const status = percent >= 100 ? "passed" : "not_passed";
  await pool.query(
    `
    INSERT INTO user_attestation_status (user_id, item_id, status)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, item_id) DO UPDATE
    SET status = EXCLUDED.status
    `,
    [userId, itemId, status]
  );
}

// Показ списка тем элемента теории (для запуска теста)
async function showUserTheoryTopics(ctx, userId, itemId, type) {
  const topics = await getTheoryTopics(type);
  const uRes = await pool.query("SELECT full_name FROM users WHERE id = $1", [
    userId,
  ]);
  const userName =
    uRes.rows.length && uRes.rows[0].full_name
      ? uRes.rows[0].full_name
      : "Без имени";
  const title = type === "base" ? "Теория база" : "Полная теория";
  if (!topics.length) {
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🔙 К аттестации",
          `admin_user_attest_${userId}`
        ),
      ],
      [Markup.button.callback("🔙 К пользователям", "admin_users")],
    ]);
    const text =
      `👤 ${userName}\n\n${title}.\n\n` +
      "Пока нет ни одной темы с карточками подходящего уровня.";
    await deliver(ctx, { text, extra: keyboard }, { edit: true });
    return;
  }
  let text = `👤 ${userName}\n\n${title}.\n\nВыбери тему для теста:`;
  const buttons = topics.map((t) => {
    const cb =
      type === "base"
        ? `admin_user_theory_base_topic_${userId}_${itemId}_${t.id}`
        : `admin_user_theory_full_topic_${userId}_${itemId}_${t.id}`;
    return [Markup.button.callback(t.title, cb)];
  });
  buttons.push([
    Markup.button.callback("🔙 К аттестации", `admin_user_attest_${userId}`),
  ]);
  buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Запуск админского теста по выбранной теме теории
async function startAdminTheoryTest(
  ctx,
  adminId,
  userId,
  itemId,
  type,
  topicId
) {
  const topicRes = await pool.query("SELECT title FROM topics WHERE id = $1", [
    topicId,
  ]);
  if (!topicRes.rows.length) {
    await ctx.reply("Тема не найдена.");
    return;
  }
  const topicTitle = topicRes.rows[0].title || "Без названия";
  const cardsRes = await pool.query(
    `
    SELECT c.id, c.question, c.answer, COALESCE(c.difficulty, 1) AS difficulty
    FROM blocks b
    JOIN cards c ON c.block_id = b.id
    WHERE b.topic_id = $1
    ${type === "base" ? "AND COALESCE(c.difficulty, 1) = 1" : ""}
    ORDER BY b.order_index, b.id, c.id
    `,
    [topicId]
  );
  const cards = cardsRes.rows;
  if (!cards.length) {
    await ctx.reply("В этой теме пока нет карточек для теста.");
    return;
  }
  const mode = type === "base" ? "admin_base" : "admin_full";
  const sessionRes = await pool.query(
    `
    INSERT INTO test_sessions (user_id, admin_id, mode, topic_id, question_count, correct_count)
    VALUES ($1, $2, $3, $4, $5, 0)
    RETURNING id
    `,
    [userId, adminId, mode, topicId, cards.length]
  );
  const sessionId = sessionRes.rows[0].id;
  setAdminTheorySession(adminId, {
    adminId,
    userId,
    itemId,
    type,
    topicId,
    topicTitle,
    sessionId,
    cards,
    index: 0,
    showAnswer: false,
    correctCount: 0,
  });
  await renderAdminTheoryQuestion(ctx, adminId);
}

// Показ текущего вопроса админского теста (и кнопок ответа)
async function renderAdminTheoryQuestion(ctx, adminId) {
  const session = getAdminTheorySession(adminId);
  if (!session) {
    await ctx.reply(
      "Сессия теста не найдена. Вернись в аттестацию пользователя и начни снова."
    );
    return;
  }
  const { cards, index, showAnswer, type, topicTitle, userId, itemId } =
    session;
  if (!cards.length) {
    await ctx.reply("В этой теме пока нет карточек.");
    clearAdminTheorySession(adminId);
    return;
  }
  if (index < 0 || index >= cards.length) {
    await ctx.reply("Вопросы закончились.");
    clearAdminTheorySession(adminId);
    return;
  }
  const card = cards[index];
  const total = cards.length;
  const humanIndex = index + 1;
  const level = card.difficulty || 1;
  const levelIcon = level === 1 ? "⭐" : level === 2 ? "⭐⭐" : "⭐⭐⭐";
  const title = type === "base" ? "Теория база" : "Полная теория";
  let text =
    `${levelIcon} Вопрос ${humanIndex}/${total}\n` +
    `Тема: ${topicTitle}\n` +
    `Тип: ${title}\n\n` +
    `❓ ${card.question}`;
  const buttons = [];
  if (!showAnswer) {
    buttons.push([
      Markup.button.callback("👁 Показать ответ", "admin_theory_show_answer"),
    ]);
  } else {
    text += `\n\n💡 Ответ:\n${card.answer}\n\nОтметь, как ответил сотрудник:`;
    buttons.push([
      Markup.button.callback("✅ Верно", "admin_theory_mark_correct"),
      Markup.button.callback("❌ Не вспомнил", "admin_theory_mark_wrong"),
    ]);
  }
  const topicsCallback =
    type === "base"
      ? `admin_user_theory_base_topics_${userId}_${itemId}`
      : `admin_user_theory_full_topics_${userId}_${itemId}`;
  buttons.push([Markup.button.callback("🔙 К темам", topicsCallback)]);
  buttons.push([
    Markup.button.callback("🔙 К аттестации", `admin_user_attest_${userId}`),
  ]);
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Обработка отметки ответа (верно/неверно) в админском тесте
async function handleAdminTheoryMark(ctx, isCorrect, logError) {
  const adminId = ctx.from.id;
  const session = getAdminTheorySession(adminId);
  if (!session) {
    await ctx.reply(
      "Сессия теста не найдена. Вернись в аттестацию пользователя и начни снова."
    );
    return;
  }
  const { cards, index, sessionId, userId, type, topicId, itemId } = session;
  if (index < 0 || index >= cards.length) {
    await ctx.reply("Вопросы уже закончились.");
    clearAdminTheorySession(adminId);
    return;
  }
  const card = cards[index];
  const position = index + 1;
  try {
    await pool.query(
      `
      INSERT INTO test_session_answers (session_id, card_id, position, is_correct)
      VALUES ($1, $2, $3, $4)
      `,
      [sessionId, card.id, position, isCorrect]
    );
    if (isCorrect) {
      session.correctCount += 1;
      await pool.query(
        "UPDATE test_sessions SET correct_count = correct_count + 1 WHERE id = $1",
        [sessionId]
      );
    }
    if (index < cards.length - 1) {
      session.index += 1;
      session.showAnswer = false;
      setAdminTheorySession(adminId, session);
      await renderAdminTheoryQuestion(ctx, adminId);
    } else {
      const total = cards.length;
      const correct = session.correctCount;
      const percent = total > 0 ? Math.round((correct * 100) / total) : 0;
      let statusText;
      if (percent >= ADMIN_THEORY_PASS_PERCENT) {
        statusText = "✅ Тема зачтена по этому виду теории.";
        if (type === "base") {
          await pool.query(
            `
            INSERT INTO user_block_status (user_id, block_id, status)
            SELECT $1, b.id, 'passed'
            FROM blocks b
            WHERE b.topic_id = $2
            ON CONFLICT (user_id, block_id) DO UPDATE
            SET status = EXCLUDED.status
            `,
            [userId, topicId]
          );
        }
      } else {
        statusText = `❌ Этого недостаточно для зачёта (нужно ${ADMIN_THEORY_PASS_PERCENT}% и выше).`;
      }
      clearAdminTheorySession(adminId);
      const progress = await getUserTheoryElementProgress(
        userId,
        type === "base" ? "base" : "full"
      );
      await syncUserTheoryItemStatus(userId, itemId, progress.percent);
      const title = type === "base" ? "Теория база" : "Полная теория";
      let text =
        `✅ Тест по теме "${session.topicTitle}" завершён.\n\n` +
        `Результат: ${correct}/${total} (${percent}%).\n` +
        `${statusText}\n\n` +
        `${title}: общий прогресс — ${progress.percent}% (${progress.passedTopics}/${progress.totalTopics} тем).`;
      const topicsCallback =
        type === "base"
          ? `admin_user_theory_base_topics_${userId}_${itemId}`
          : `admin_user_theory_full_topics_${userId}_${itemId}`;
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("📚 К темам", topicsCallback)],
        [
          Markup.button.callback(
            "🔙 К аттестации",
            `admin_user_attest_${userId}`
          ),
        ],
      ]);
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    }
  } catch (err) {
    logError("admin_theory_mark_answer", err);
    await ctx.reply("Не удалось сохранить результат ответа.");
  }
}

// Показ экрана аттестации конкретного пользователя (список элементов аттестации)
async function showUserAttestation(ctx, userId) {
  const userRes = await pool.query(
    "SELECT id, telegram_id, role, full_name, staff_status, intern_days_completed FROM users WHERE id = $1",
    [userId]
  );
  if (!userRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = userRes.rows[0];
  const res = await pool.query(
    `
    SELECT ai.id, ai.title, uas.status, uas.updated_by_admin_id, ua.full_name AS updated_by_admin_name
    FROM attestation_items ai
    LEFT JOIN user_attestation_status uas ON uas.item_id = ai.id AND uas.user_id = $1
    LEFT JOIN users ua ON ua.id = uas.updated_by_admin_id
    WHERE ai.is_active = TRUE
    ORDER BY ai.order_index, ai.id
    `,
    [userId]
  );
  let text =
    `👤 ${user.full_name || "Без имени"}\n` +
    `Роль: ${user.role}\n\n` +
    "Выбери раздел:\n";
  const buttons = [];
  if (!res.rows.length) {
    text +=
      "Элементы аттестации ещё не созданы. Добавь их в разделе «✅ Аттестация».";
  } else {
    for (const row of res.rows) {
      const rawTitle = row.title || "";
      const lower = rawTitle.trim().toLowerCase();
      if (lower.includes("теория база")) {
        const progress = await getUserTheoryElementProgress(userId, "base");
        await syncUserTheoryItemStatus(userId, row.id, progress.percent);
        const passed = progress.totalTopics > 0 && progress.percent >= 100;
        const icon = passed ? "✅" : "⚪";
        const percentLabel =
          progress.totalTopics > 0 ? `${progress.percent}%` : "0%";
        const label = `${icon} Теория база (${percentLabel})`;
        text += label + "\n";
        buttons.push([
          Markup.button.callback(
            label,
            `admin_user_theory_base_topics_${userId}_${row.id}`
          ),
        ]);
        continue;
      }
      if (lower.includes("полная теория")) {
        const progress = await getUserTheoryElementProgress(userId, "full");
        await syncUserTheoryItemStatus(userId, row.id, progress.percent);
        const passed = progress.totalTopics > 0 && progress.percent >= 100;
        const icon = passed ? "✅" : "⚪";
        const percentLabel =
          progress.totalTopics > 0 ? `${progress.percent}%` : "0%";
        const label = `${icon} Полная теория (${percentLabel})`;
        text += label + "\n";
        buttons.push([
          Markup.button.callback(
            label,
            `admin_user_theory_full_topics_${userId}_${row.id}`
          ),
        ]);
        continue;
      }
      const passed = row.status === "passed";
      const icon = passed ? "✅" : "⚪";
      let line = `${icon} ${row.title}`;
      if (passed && row.updated_by_admin_name) {
        line += ` (${row.updated_by_admin_name})`;
      }
      text += line + "\n";
      buttons.push([
        Markup.button.callback(line, `admin_user_item_${userId}_${row.id}`),
      ]);
    }
  }
  buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Переключение статуса обычного элемента аттестации (галочка)
async function toggleUserItemStatus(userId, itemId, adminId) {
  const statusRes = await pool.query(
    "SELECT status FROM user_attestation_status WHERE user_id = $1 AND item_id = $2",
    [userId, itemId]
  );
  const currentStatus = statusRes.rows.length ? statusRes.rows[0].status : null;
  const newStatus = currentStatus !== "passed" ? "passed" : "not_passed";
  if (newStatus === "passed") {
    await pool.query(
      `
      INSERT INTO user_attestation_status (user_id, item_id, status, updated_by_admin_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, item_id) DO UPDATE
      SET status = EXCLUDED.status, updated_by_admin_id = EXCLUDED.updated_by_admin_id
      `,
      [userId, itemId, newStatus, adminId]
    );
  } else {
    await pool.query(
      `
      INSERT INTO user_attestation_status (user_id, item_id, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, item_id) DO UPDATE
      SET status = EXCLUDED.status
      `,
      [userId, itemId, newStatus]
    );
  }
}

// Переключение статуса блока темы (галочка)
async function toggleUserBlockStatus(userId, blockId) {
  const statusRes = await pool.query(
    "SELECT status FROM user_block_status WHERE user_id = $1 AND block_id = $2",
    [userId, blockId]
  );
  const currentStatus = statusRes.rows.length ? statusRes.rows[0].status : null;
  const newStatus = currentStatus !== "passed" ? "passed" : "not_passed";
  await pool.query(
    `
    INSERT INTO user_block_status (user_id, block_id, status)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, block_id) DO UPDATE
    SET status = EXCLUDED.status
    `,
    [userId, blockId, newStatus]
  );
}

// Регистрация всех action-хендлеров для списка пользователей и управления ими
function registerAdminUsersList(bot, ensureUser, logError) {
  // Открыть список пользователей
  bot.action("admin_users", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showAdminUsers(ctx);
    } catch (err) {
      logError("admin_users", err);
    }
  });
  // Пагинация списка / переключение панели фильтров
  bot.action(/^admin_users_list_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const page = parseInt(ctx.match[1], 10) || 1;
      const filterItemId = parseInt(ctx.match[2], 10) || 0;
      const panelFlag = ctx.match[3] === "1";
      if (panelFlag) {
        setAdminUsersViewState(ctx.from.id, { expanded: false });
      }
      await showAdminUsers(ctx, { page, filterItemId, showFilters: panelFlag });
    } catch (err) {
      logError("admin_users_list_x", err);
    }
  });
  // Раскрыть панель действий
  bot.action(/^admin_users_expand_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const page = parseInt(ctx.match[1], 10) || 1;
      const filterItemId = parseInt(ctx.match[2], 10) || 0;
      setAdminUsersViewState(ctx.from.id, { expanded: true });
      await showAdminUsers(ctx, { page, filterItemId, showFilters: false });
    } catch (err) {
      logError("admin_users_expand_x", err);
    }
  });
  // Скрыть панель действий
  bot.action(/^admin_users_collapse_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const page = parseInt(ctx.match[1], 10) || 1;
      const filterItemId = parseInt(ctx.match[2], 10) || 0;
      const panelFlag = ctx.match[3] === "1";
      setAdminUsersViewState(ctx.from.id, { expanded: false });
      await showAdminUsers(ctx, { page, filterItemId, showFilters: panelFlag });
    } catch (err) {
      logError("admin_users_collapse_x", err);
    }
  });
  // Переключение секции "по статусу"
  bot.action("admin_users_filter_status_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const st = getAdminUsersViewState(ctx.from.id) || {};
      const now = !!st.statusSectionOpen;
      setAdminUsersViewState(ctx.from.id, {
        showFilters: true,
        expanded: false,
        statusSectionOpen: !now,
        roleSectionOpen: false,
        perfSectionOpen: false,
        perfByItemOpen: false,
      });
      const page = st.page || 1;
      await showAdminUsers(ctx, { page, showFilters: true });
    } catch (err) {
      logError("admin_users_filter_status_toggle_x", err);
    }
  });
  // Переключение секции "по роли"
  bot.action("admin_users_filter_role_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const st = getAdminUsersViewState(ctx.from.id) || {};
      const now = !!st.roleSectionOpen;
      setAdminUsersViewState(ctx.from.id, {
        showFilters: true,
        expanded: false,
        statusSectionOpen: false,
        roleSectionOpen: !now,
        perfSectionOpen: false,
        perfByItemOpen: false,
      });
      const page = st.page || 1;
      await showAdminUsers(ctx, { page, showFilters: true });
    } catch (err) {
      logError("admin_users_filter_role_toggle_x", err);
    }
  });
  // Переключение секции "по успеваемости"
  bot.action("admin_users_filter_perf_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const st = getAdminUsersViewState(ctx.from.id) || {};
      const now = !!st.perfSectionOpen;
      setAdminUsersViewState(ctx.from.id, {
        showFilters: true,
        expanded: false,
        statusSectionOpen: false,
        roleSectionOpen: false,
        perfSectionOpen: !now,
        perfByItemOpen: false,
      });
      const page = st.page || 1;
      await showAdminUsers(ctx, { page, showFilters: true });
    } catch (err) {
      logError("admin_users_filter_perf_toggle_x", err);
    }
  });
  // Переключение вложенной секции фильтра "по элементам аттестации"
  bot.action("admin_users_filter_perf_item_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const st = getAdminUsersViewState(ctx.from.id) || {};
      const now = !!st.perfByItemOpen;
      setAdminUsersViewState(ctx.from.id, {
        showFilters: true,
        expanded: false,
        statusSectionOpen: false,
        roleSectionOpen: false,
        perfSectionOpen: true,
        perfByItemOpen: !now,
      });
      const page = st.page || 1;
      await showAdminUsers(ctx, { page, showFilters: true });
    } catch (err) {
      logError("admin_users_filter_perf_item_toggle_x", err);
    }
  });
  // Снять все фильтры
  bot.action("admin_users_filter_clear_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const st = getAdminUsersViewState(ctx.from.id) || {};
      setAdminUsersViewState(ctx.from.id, {
        statusFilter: null,
        roleFilter: null,
        filterItemId: 0,
        statusSectionOpen: false,
        roleSectionOpen: false,
        perfSectionOpen: false,
        perfByItemOpen: false,
        showFilters: true,
        expanded: false,
      });
      const page = st.page || 1;
      await showAdminUsers(ctx, { page, showFilters: true });
    } catch (err) {
      logError("admin_users_filter_clear_all_x", err);
    }
  });

  bot.action("admin_invite_candidate", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("👥 К пользователям", "admin_users")],
        [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
      ]);
      await deliver(
        ctx,
        {
          text: "Функция «➕ пригласить на собеседование» пока не реализована.\nПозже здесь можно будет отправлять приглашения кандидатам.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_invite_candidate_x", err);
    }
  });
  // Открыть карточку пользователя
  bot.action(/^admin_user_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      await showAdminUserCard(ctx, userId, false);
    } catch (err) {
      logError("admin_user_open_x", err);
    }
  });
  // Открыть настройки пользователя
  bot.action(/^admin_user_settings_open_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      await showAdminUserCard(ctx, userId, true);
    } catch (err) {
      logError("admin_user_settings_open_x", err);
    }
  });
  // Закрыть настройки пользователя
  bot.action(/^admin_user_settings_close_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      await showAdminUserCard(ctx, userId, false);
    } catch (err) {
      logError("admin_user_settings_close_x", err);
    }
  });
  // Начать процесс изменения имени пользователя
  bot.action(/^admin_user_rename_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      setUserRenameState(ctx.from.id, { userId });
      await ctx.reply(
        `Введи новое имя для пользователя #${userId} одним сообщением.\n` +
          `Если хочешь очистить имя, отправь просто "-" (дефис).`
      );
    } catch (err) {
      logError("admin_user_rename_start_x", err);
      await ctx.reply("Не удалось начать изменение имени.");
    }
  });
  // Переключение роли пользователя (админ/пользователь)
  bot.action(/^admin_user_toggle_role_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      const userRes = await pool.query(
        "SELECT id, telegram_id, role, full_name FROM users WHERE id = $1",
        [userId]
      );
      if (!userRes.rows.length) {
        await ctx.reply("Пользователь не найден.");
        return;
      }
      const user = userRes.rows[0];
      if (
        user.telegram_id &&
        String(user.telegram_id) === SUPER_ADMIN_TELEGRAM_ID
      ) {
        await ctx.reply("Нельзя менять роль этого пользователя.");
        return;
      }
      let newRole;
      if (user.role === "admin") {
        // Понизить админа может только главный админ
        if (
          !admin.telegram_id ||
          String(admin.telegram_id) !== SUPER_ADMIN_TELEGRAM_ID
        ) {
          await ctx.reply(
            "Понижать администраторов до пользователей может только главный админ."
          );
          return;
        }
        newRole = "user";
      } else {
        newRole = "admin";
      }
      await pool.query("UPDATE users SET role = $1 WHERE id = $2", [
        newRole,
        userId,
      ]);
      await showAdminUserCard(ctx, userId, true);
    } catch (err) {
      logError("admin_user_toggle_role_x", err);
    }
  });
  // Начать процесс добавления нового пользователя
  bot.action("admin_add_user", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      setUserCreateState(ctx.from.id, { step: "await_new_user_telegram" });
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К пользователям", "admin_users")],
      ]);
      const text =
        "✏ Отправь *telegram id* пользователя числом.\n" +
        "Если id пока неизвестен — отправь любой текст, и пользователь будет создан без привязки к Telegram.";
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_add_user", err);
    }
  });
  // Запрос на удаление пользователя (подтверждение)
  bot.action(/^admin_user_delete_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      const userRes = await pool.query(
        "SELECT id, telegram_id, full_name FROM users WHERE id = $1",
        [userId]
      );
      if (!userRes.rows.length) {
        await ctx.reply("Пользователь не найден.");
        return;
      }
      const user = userRes.rows[0];
      const name = user.full_name || "Без имени";
      if (
        user.telegram_id &&
        String(user.telegram_id) === SUPER_ADMIN_TELEGRAM_ID
      ) {
        await ctx.reply("Нельзя удалить этого пользователя.");
        return;
      }
      const text =
        `⚠️ Удалить ${name} (id: ${user.id}, tg: ${
          user.telegram_id || "—"
        })?\n\n` + "Все связанные с ним данные могут быть удалены.";
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("❌ Отмена", `admin_user_${user.id}`),
          Markup.button.callback(
            "🗑 Да, удалить",
            `admin_user_delete_confirm_${user.id}`
          ),
        ],
      ]);
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_user_delete_x", err);
    }
  });
  // Подтверждение удаления пользователя
  bot.action(/^admin_user_delete_confirm_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      const userRes = await pool.query(
        "SELECT id, telegram_id FROM users WHERE id = $1",
        [userId]
      );
      if (!userRes.rows.length) {
        await ctx.reply("Пользователь не найден.");
        return;
      }
      const user = userRes.rows[0];
      if (
        user.telegram_id &&
        String(user.telegram_id) === SUPER_ADMIN_TELEGRAM_ID
      ) {
        await ctx.reply("Нельзя удалить этого пользователя.");
        return;
      }
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К пользователям", "admin_users")],
        [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
      ]);
      await deliver(
        ctx,
        { text: "🗑 Пользователь удалён.", extra: keyboard },
        { edit: true }
      );
    } catch (err) {
      logError("admin_user_delete_confirm_x", err);
      await ctx.reply("Не удалось удалить пользователя (ошибка БД).");
    }
  });
  // Показ прогресса по темам теории
  bot.action(/^admin_user_topics_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      await showUserTopicsProgress(ctx, userId);
    } catch (err) {
      logError("admin_user_topics_x", err);
    }
  });
  // Показ прогресса по блокам выбранной темы
  bot.action(/^admin_user_topic_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      const topicId = parseInt(ctx.match[2], 10);
      await showUserTopicBlocksProgress(ctx, userId, topicId);
    } catch (err) {
      logError("admin_user_topic_x", err);
    }
  });
  // Переключение статуса блока темы
  bot.action(/^admin_user_block_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      const blockId = parseInt(ctx.match[2], 10);
      await toggleUserBlockStatus(userId, blockId);
      const topicId = await getBlockTopicId(blockId);
      if (topicId) {
        await showUserTopicBlocksProgress(ctx, userId, topicId);
      } else {
        await showUserTopicsProgress(ctx, userId);
      }
    } catch (err) {
      logError("admin_user_block_x", err);
    }
  });
  // Переключение статуса элемента аттестации
  bot.action(/^admin_user_item_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      const itemId = parseInt(ctx.match[2], 10);
      await toggleUserItemStatus(userId, itemId, admin.id);
      await showUserAttestation(ctx, userId);
    } catch (err) {
      logError("admin_user_item_x", err);
    }
  });
  // Показ/скрытие активности пользователя (карточка)
  bot.action(/^admin_user_activity_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      await showAdminUserCard(ctx, userId, false, true);
    } catch (err) {
      logError("admin_user_activity_x", err);
    }
  });
  // Открыть экран аттестации пользователя
  bot.action(/^admin_user_attest_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      // Сохраняем контекст для модуля тестирования (если используется)
      ctx.session = ctx.session || {};
      ctx.session.adminTestingUser = userId;
      await showUserAttestation(ctx, userId);
    } catch (err) {
      logError("admin_user_attest_x", err);
    }
  });
  // Выбор темы для "Теория база"
  bot.action(/^admin_user_theory_base_topics_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      const itemId = parseInt(ctx.match[2], 10);
      await showUserTheoryTopics(ctx, userId, itemId, "base");
    } catch (err) {
      logError("admin_user_theory_base_topics_x", err);
    }
  });
  // Выбор темы для "Полная теория"
  bot.action(/^admin_user_theory_full_topics_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const userId = parseInt(ctx.match[1], 10);
      const itemId = parseInt(ctx.match[2], 10);
      await showUserTheoryTopics(ctx, userId, itemId, "full");
    } catch (err) {
      logError("admin_user_theory_full_topics_x", err);
    }
  });
  // Запуск теста: теория база, выбранная тема
  bot.action(
    /^admin_user_theory_base_topic_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const admin = await ensureUser(ctx);
        if (!isAdmin(admin)) return;
        const userId = parseInt(ctx.match[1], 10);
        const itemId = parseInt(ctx.match[2], 10);
        const topicId = parseInt(ctx.match[3], 10);
        await startAdminTheoryTest(
          ctx,
          admin.id,
          userId,
          itemId,
          "base",
          topicId
        );
      } catch (err) {
        logError("admin_user_theory_base_topic_x", err);
      }
    }
  );
  // Запуск теста: полная теория, выбранная тема
  bot.action(
    /^admin_user_theory_full_topic_(\d+)_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const admin = await ensureUser(ctx);
        if (!isAdmin(admin)) return;
        const userId = parseInt(ctx.match[1], 10);
        const itemId = parseInt(ctx.match[2], 10);
        const topicId = parseInt(ctx.match[3], 10);
        await startAdminTheoryTest(
          ctx,
          admin.id,
          userId,
          itemId,
          "full",
          topicId
        );
      } catch (err) {
        logError("admin_user_theory_full_topic_x", err);
      }
    }
  );
  // Показать ответ на вопрос в админ-тесте
  bot.action("admin_theory_show_answer", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const session = getAdminTheorySession(ctx.from.id);
      if (!session) {
        await ctx.reply(
          "Сессия теста не найдена. Вернись в аттестацию пользователя и начни снова."
        );
        return;
      }
      session.showAnswer = true;
      setAdminTheorySession(ctx.from.id, session);
      await renderAdminTheoryQuestion(ctx, ctx.from.id);
    } catch (err) {
      logError("admin_theory_show_answer_x", err);
    }
  });
  // Отметка ответа "верно"
  bot.action("admin_theory_mark_correct", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await handleAdminTheoryMark(ctx, true, logError);
  });
  // Отметка ответа "не вспомнил"
  bot.action("admin_theory_mark_wrong", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await handleAdminTheoryMark(ctx, false, logError);
  });
  // Обработка вводимого текста (переименование, поиск, создание пользователя)
  bot.on("text", async (ctx, next) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin || !isAdmin(admin)) return next();

      // Если сейчас идёт сценарий создания кандидата — не трогаем текст,
      // пусть его обрабатывает модуль собеседований
      const candidateState = getCandidateCreateState(ctx.from.id);
      if (candidateState) {
        return next();
      }

      const rawText = (ctx.message.text || "").trim();
      if (!rawText) return next();
      // Завершение изменения имени пользователя
      const renameState = getUserRenameState(ctx.from.id);

      if (renameState) {
        let newName = rawText;
        if (newName === "-") newName = null;
        try {
          await pool.query("UPDATE users SET full_name = $1 WHERE id = $2", [
            newName,
            renameState.userId,
          ]);
          clearUserRenameState(ctx.from.id);
          await ctx.reply(
            newName
              ? `Имя пользователя #${renameState.userId} обновлено: ${newName}`
              : `Имя пользователя #${renameState.userId} очищено.`
          );
        } catch (err) {
          logError("admin_user_rename_save_x", err);
          await ctx.reply("Не удалось сохранить имя, попробуй ещё раз.");
        }
        return;
      }
      // Если активен режим поиска пользователя – передаем обработку в модуль поиска
      const searchState = getUserSearchState(ctx.from.id);
      if (searchState && searchState.step === "await_query") {
        return next();
      }
      // Создание пользователя (этапы ввода)
      const state = getUserCreateState(ctx.from.id);
      if (!state) return next();
      const text = rawText;
      if (state.step === "await_new_user_telegram") {
        let telegramId = null;
        if (/^\d+$/.test(text)) {
          telegramId = text;
        }
        setUserCreateState(ctx.from.id, {
          step: "await_new_user_name",
          tmpTelegramId: telegramId,
        });
        await ctx.reply(
          "Теперь отправь имя сотрудника (как он будет отображаться в админке) одним сообщением."
        );
        return;
      }
      if (state.step === "await_new_user_name") {
        const fullName = text;
        const telegramId = state.tmpTelegramId || null;
        try {
          let userRow = null;
          if (telegramId) {
            try {
              const insertRes = await pool.query(
                `
                INSERT INTO users (telegram_id, role, full_name)
                VALUES ($1, 'user', $2)
                RETURNING id
                `,
                [telegramId, fullName]
              );
              userRow = insertRes.rows[0];
            } catch (err) {
              if (err.code === "23505") {
                const updRes = await pool.query(
                  `
                  UPDATE users
                  SET full_name = $1
                  WHERE telegram_id = $2
                  RETURNING id
                  `,
                  [fullName, telegramId]
                );
                if (updRes.rows.length) {
                  userRow = updRes.rows[0];
                } else {
                  throw err;
                }
              } else {
                throw err;
              }
            }
          } else {
            const insertRes = await pool.query(
              `
              INSERT INTO users (role, full_name)
              VALUES ('user', $1)
              RETURNING id
              `,
              [fullName]
            );
            userRow = insertRes.rows[0];
          }
          clearUserCreateState(ctx.from.id);
          await ctx.reply(
            `Пользователь создан (id: ${userRow.id}).\nВозвращаю список пользователей...`
          );
          await showAdminUsers(ctx);
        } catch (err) {
          logError("admin_create_user", err);
          clearUserCreateState(ctx.from.id);
          await ctx.reply("Не удалось создать пользователя (ошибка БД).");
        }
        return;
      }
      return next();
    } catch (err) {
      logError("admin_user_text_handler", err);
      return next();
    }
  });
}

module.exports = {
  registerAdminUsersList,
  showAdminUsers,
};
