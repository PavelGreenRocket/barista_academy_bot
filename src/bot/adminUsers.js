// src/bot/adminUsers.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

const SUPER_ADMIN_TELEGRAM_ID = "925270231"; // твой tg id
const ADMIN_THEORY_PASS_PERCENT = 90; // порог зачёта по теме для теории (в %)

function isAdmin(user) {
  return user && user.role === "admin";
}

// состояния для создания пользователя админом
// key: telegram_id админа, value: { step, tmpTelegramId? }
const userCreateStates = new Map();

// состояния для изменения имени пользователя
// key: telegram_id админа, value: { userId }
const userRenameStates = new Map();

// состояния админских тестов по "теории база" / "полной теории"
// key: telegram_id админа, value: { userId, itemId, type, topicId, topicTitle, sessionId, cards, index, showAnswer, correctCount }
const adminTheorySessions = new Map();

// ---------- state helpers ----------

function setUserCreateState(adminId, state) {
  userCreateStates.set(adminId, state);
}
function clearUserCreateState(adminId) {
  userCreateStates.delete(adminId);
}

function setUserRenameState(adminId, state) {
  userRenameStates.set(adminId, state);
}
function clearUserRenameState(adminId) {
  userRenameStates.delete(adminId);
}

function setAdminTheorySession(adminId, state) {
  adminTheorySessions.set(adminId, state);
}
function getAdminTheorySession(adminId) {
  return adminTheorySessions.get(adminId);
}
function clearAdminTheorySession(adminId) {
  adminTheorySessions.delete(adminId);
}

// -----------------------------------------------------------------------------
// СПИСОК ПОЛЬЗОВАТЕЛЕЙ
// -----------------------------------------------------------------------------

async function showAdminUsers(ctx, options = {}) {
  const PAGE_SIZE = 10;

  let page = Number(options.page) || 1;
  if (page < 1) page = 1;

  let filterItemId = Number(options.filterItemId) || 0; // 0 = без фильтра
  const showFilters = !!options.showFilters; // показывать ли панель фильтров

  // --- элементы аттестации для фильтра ---
  const filtersRes = await pool.query(
    `SELECT id, title
     FROM attestation_items
     WHERE is_active = TRUE
     ORDER BY order_index, id`
  );
  const filterItems = filtersRes.rows;

  let activeFilter = null;
  if (filterItemId) {
    const fRes = await pool.query(
      "SELECT id, title FROM attestation_items WHERE id = $1",
      [filterItemId]
    );
    if (fRes.rows.length) {
      activeFilter = fRes.rows[0];
    } else {
      filterItemId = 0; // элемент удалён — фильтр сбрасываем
    }
  }

  // --- считаем пользователей ---
  let totalUsers = 0;
  let usersRes;
  const offset = (page - 1) * PAGE_SIZE;

  if (!filterItemId) {
    // без фильтра
    const countRes = await pool.query("SELECT COUNT(*) FROM users");
    totalUsers = Number(countRes.rows[0].count) || 0;

    usersRes = await pool.query(
      `SELECT id, telegram_id, role, full_name
       FROM users
       ORDER BY id ASC
       LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset]
    );
  } else {
    // фильтр по элементу аттестации: показываем тех, у кого он НЕ passed
    const countRes = await pool.query(
      `
      SELECT COUNT(*)
      FROM users u
      LEFT JOIN user_attestation_status uas
        ON uas.user_id = u.id AND uas.item_id = $1
      WHERE COALESCE(uas.status, 'not_passed') <> 'passed'
      `,
      [filterItemId]
    );
    totalUsers = Number(countRes.rows[0].count) || 0;

    usersRes = await pool.query(
      `
      SELECT u.id, u.telegram_id, u.role, u.full_name
      FROM users u
      LEFT JOIN user_attestation_status uas
        ON uas.user_id = u.id AND uas.item_id = $1
      WHERE COALESCE(uas.status, 'not_passed') <> 'passed'
      ORDER BY u.id ASC
      LIMIT $2 OFFSET $3
      `,
      [filterItemId, PAGE_SIZE, offset]
    );
  }

  const users = usersRes.rows;
  const totalPages = totalUsers > 0 ? Math.ceil(totalUsers / PAGE_SIZE) : 1;
  if (page > totalPages) page = totalPages;

  let text = "👥 Пользователи";

  if (activeFilter) {
    text += ` (фильтр: ❌ ${activeFilter.title} — не сдали)`;
  }

  if (!totalUsers) {
    if (activeFilter) {
      text += `\n\nПо выбранному фильтру пока нет пользователей.`;
    } else {
      text += `\n\nПока нет ни одного пользователя.`;
    }
  } else {
    text += `\n\nВсего: ${totalUsers}`;
    if (totalPages > 1) {
      text += `\nСтраница ${page} из ${totalPages}`;
    }
  }

  const buttons = [];

  // сами пользователи
  for (const row of users) {
    const name = row.full_name || "Без имени";
    const label = name;
    buttons.push([Markup.button.callback(label, `admin_user_${row.id}`)]);
  }

  // добавить пользователя
  buttons.push([
    Markup.button.callback("➕ Добавить пользователя", "admin_add_user"),
  ]);

  // пагинация
  if (totalPages > 1) {
    const navRow = [];
    const panelFlag = showFilters ? 1 : 0;
    const filt = filterItemId || 0;

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

  // панель фильтров
  if (filterItems.length) {
    const panelFlagNext = showFilters ? 0 : 1;
    const filt = filterItemId || 0;

    buttons.push([
      Markup.button.callback(
        "🔼 Фильтр",
        `admin_users_list_${page}_${filt}_${panelFlagNext}`
      ),
    ]);

    if (showFilters) {
      for (const item of filterItems) {
        const icon = "❌";
        buttons.push([
          Markup.button.callback(
            `${icon} ${item.title}`,
            `admin_users_list_1_${item.id}_1`
          ),
        ]);
      }

      buttons.push([
        Markup.button.callback("Показать всех", "admin_users_list_1_0_1"),
      ]);
    }
  }

  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// -----------------------------------------------------------------------------
// ПРОГРЕСС ПО ТЕОРИИ (БЛОКИ) – пока только для внутреннего использования
// -----------------------------------------------------------------------------

async function getTopicsProgressForUser(userId) {
  const res = await pool.query(
    `
    SELECT
      t.id,
      t.title,
      t.order_index,
      COUNT(b.id) AS total_blocks,
      COALESCE(
        SUM(
          CASE WHEN ubs.status = 'passed' THEN 1 ELSE 0 END
        ),
        0
      ) AS passed_blocks
    FROM topics t
    LEFT JOIN blocks b
      ON b.topic_id = t.id
    LEFT JOIN user_block_status ubs
      ON ubs.block_id = b.id AND ubs.user_id = $1
    GROUP BY t.id, t.title, t.order_index
    ORDER BY t.order_index, t.id
  `,
    [userId]
  );

  return res.rows.map((row) => {
    const total = Number(row.total_blocks) || 0;
    const passed = Number(row.passed_blocks) || 0;
    const percent = total > 0 ? Math.round((passed * 100) / total) : 0;
    const isDone = total > 0 && passed === total;
    return {
      id: row.id,
      title: row.title,
      totalBlocks: total,
      passedBlocks: passed,
      percent,
      isDone,
    };
  });
}

async function getTopicBlocksProgressForUser(userId, topicId) {
  const res = await pool.query(
    `
    SELECT
      b.id,
      b.title,
      COALESCE(ubs.status, 'not_passed') AS status
    FROM blocks b
    LEFT JOIN user_block_status ubs
      ON ubs.block_id = b.id AND ubs.user_id = $1
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

async function toggleUserBlockStatus(userId, blockId) {
  const statusRes = await pool.query(
    `SELECT status
     FROM user_block_status
     WHERE user_id = $1 AND block_id = $2`,
    [userId, blockId]
  );

  let newStatus;
  if (!statusRes.rows.length || statusRes.rows[0].status !== "passed") {
    newStatus = "passed";
  } else {
    newStatus = "not_passed";
  }

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
    await deliver(
      ctx,
      {
        text: `Для ${userName} пока нет ни одной темы теории.`,
        extra: Markup.inlineKeyboard([
          [Markup.button.callback("🔙 К пользователям", "admin_users")],
          [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
        ]),
      },
      { edit: true }
    );
    return;
  }

  let text =
    `👤 ${userName}\n\n` +
    "📚 Темы теории.\n" +
    "Нажимай на тему, чтобы посмотреть статусы блоков.";

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
    const text =
      `👤 ${userName}\n` +
      `Тема: ${topicTitle}\n\n` +
      "В этой теме пока нет блоков.";

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🔙 Ко всем темам",
          `admin_user_topics_${userId}`
        ),
      ],
      [Markup.button.callback("🔙 К пользователям", "admin_users")],
    ]);

    await deliver(ctx, { text, extra: keyboard }, { edit: true });
    return;
  }

  const text =
    `👤 ${userName}\n` +
    `Тема: ${topicTitle}\n\n` +
    "Выбери блок, чтобы поставить / снять галочку.";

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

// -----------------------------------------------------------------------------
// ТЕОРИЯ БАЗА / ПОЛНАЯ ТЕОРИЯ – прогресс и админские тесты
// -----------------------------------------------------------------------------

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

// прогресс по элементу "теория база" / "полная теория"
async function getUserTheoryElementProgress(userId, type) {
  const topics = await getTheoryTopics(type);
  const totalTopics = topics.length;
  if (!totalTopics) {
    return { totalTopics: 0, passedTopics: 0, percent: 0 };
  }

  const mode = type === "base" ? "admin_base" : "admin_full";

  const sessionsRes = await pool.query(
    `
    SELECT topic_id, question_count, correct_count, created_at
    FROM test_sessions
    WHERE user_id = $1
      AND mode = $2
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

// синхронизация статуса элемента аттестации по проценту
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

// экран выбора темы для теории база / полной теории
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
    await deliver(
      ctx,
      {
        text:
          `👤 ${userName}\n\n` +
          `${title}.\n\n` +
          "Пока нет ни одной темы с карточками подходящего уровня.",
        extra: Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔙 К аттестации",
              `admin_user_attest_${userId}`
            ),
          ],
          [Markup.button.callback("🔙 К пользователям", "admin_users")],
        ]),
      },
      { edit: true }
    );
    return;
  }

  let text = `👤 ${userName}\n\n` + `${title}.\n\n` + "Выбери тему для теста:";

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

// запуск админского теста по теме для конкретного пользователя
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

  // берём все карточки нужного уровня по этой теме
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

    // следующий вопрос или завершение
    if (index < cards.length - 1) {
      session.index += 1;
      session.showAnswer = false;
      setAdminTheorySession(adminId, session);
      await renderAdminTheoryQuestion(ctx, adminId);
    } else {
      const total = cards.length;
      const correct = session.correctCount;
      const percent = total > 0 ? Math.round((correct * 100) / total) : 0;

      // зачёт / не зачёт по теме
      let statusText;
      if (percent >= ADMIN_THEORY_PASS_PERCENT) {
        statusText = "✅ Тема зачтена по этому виду теории.";

        // для "теория база" помечаем все блоки темы как passed
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

      // обновляем общий прогресс по элементу и статус галочки
      const typeKey = type === "base" ? "base" : "full";
      const progress = await getUserTheoryElementProgress(userId, typeKey);
      await syncUserTheoryItemStatus(userId, itemId, progress.percent);

      const title = type === "base" ? "Теория база" : "Полная теория";

      let text =
        `✅ Тест по теме "${session.topicTitle}" завершён.\n\n` +
        `Результат: ${correct}/${total} (${percent}%).\n` +
        `${statusText}\n\n` +
        `${title}: общий прогресс — ${progress.percent}% ` +
        `(${progress.passedTopics}/${progress.totalTopics} тем).`;

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

// -----------------------------------------------------------------------------
// АТТЕСТАЦИЯ ДЛЯ КОНКРЕТНОГО ПОЛЬЗОВАТЕЛЯ
// -----------------------------------------------------------------------------

async function showUserAttestation(ctx, userId) {
  const userRes = await pool.query(
    "SELECT id, telegram_id, role, full_name FROM users WHERE id = $1",
    [userId]
  );

  if (!userRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }

  const user = userRes.rows[0];

  const res = await pool.query(
    `
    SELECT
      ai.id,
      ai.title,
      uas.status,
      uas.updated_by_admin_id,
      ua.full_name AS updated_by_admin_name
    FROM attestation_items ai
    LEFT JOIN user_attestation_status uas
      ON uas.item_id = ai.id AND uas.user_id = $1
    LEFT JOIN users ua
      ON ua.id = uas.updated_by_admin_id
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

      // спец-элементы: теория база / полная теория
      if (lower === "теория база" || lower === "база теория") {
        const progress = await getUserTheoryElementProgress(userId, "base");
        await syncUserTheoryItemStatus(userId, row.id, progress.percent);

        const passed = progress.totalTopics > 0 && progress.percent >= 100;
        const icon = passed ? "✅" : "⚪";
        const percentLabel =
          progress.totalTopics > 0 ? `${progress.percent}%` : "0%";

        const label = `${icon} Теория база (${percentLabel})`;

        text += `${label}\n`;
        buttons.push([
          Markup.button.callback(
            label,
            `admin_user_theory_base_topics_${userId}_${row.id}`
          ),
        ]);
        continue;
      }

      if (lower === "полная теория" || lower === "теория полная") {
        const progress = await getUserTheoryElementProgress(userId, "full");
        await syncUserTheoryItemStatus(userId, row.id, progress.percent);

        const passed = progress.totalTopics > 0 && progress.percent >= 100;
        const icon = passed ? "✅" : "⚪";
        const percentLabel =
          progress.totalTopics > 0 ? `${progress.percent}%` : "0%";

        const label = `${icon} Полная теория (${percentLabel})`;

        text += `${label}\n`;
        buttons.push([
          Markup.button.callback(
            label,
            `admin_user_theory_full_topics_${userId}_${row.id}`
          ),
        ]);
        continue;
      }

      // обычные элементы аттестации
      const passed = row.status === "passed";
      const icon = passed ? "✅" : "⚪";

      let line = `${icon} ${rawTitle}`;
      // если зачёт и известен админ — показываем в скобках
      if (passed && row.updated_by_admin_name) {
        line += ` (${row.updated_by_admin_name})`;
      }

      text += `${line}\n`;
      buttons.push([
        Markup.button.callback(line, `admin_user_item_${userId}_${row.id}`),
      ]);
    }
  }

  // кнопку «📚 Блоки теории» по твоей просьбе пока не показываем

  buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function toggleUserItemStatus(userId, itemId, adminId) {
  const statusRes = await pool.query(
    `
    SELECT status
    FROM user_attestation_status
    WHERE user_id = $1 AND item_id = $2
    `,
    [userId, itemId]
  );

  let newStatus;
  if (!statusRes.rows.length || statusRes.rows[0].status !== "passed") {
    newStatus = "passed";
  } else {
    newStatus = "not_passed";
  }

  if (newStatus === "passed") {
    // при зачёте сохраняем, КТО поставил галочку
    await pool.query(
      `
      INSERT INTO user_attestation_status (user_id, item_id, status, updated_by_admin_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, item_id) DO UPDATE
      SET status = EXCLUDED.status,
          updated_by_admin_id = EXCLUDED.updated_by_admin_id
      `,
      [userId, itemId, newStatus, adminId]
    );
  } else {
    // при снятии зачёта просто меняем статус, admin_id не трогаем
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

// -----------------------------------------------------------------------------
// КАРТОЧКА ПОЛЬЗОВАТЕЛЯ (c настройками, аттестацией и тестами)
// -----------------------------------------------------------------------------

async function showAdminUserCard(ctx, userId, settingsOpen = false) {
  const userRes = await pool.query(
    "SELECT id, telegram_id, role, full_name FROM users WHERE id = $1",
    [userId]
  );
  if (!userRes.rows.length) {
    await ctx.reply("Пользователь не найден.");
    return;
  }
  const user = userRes.rows[0];
  const name = user.full_name || "Без имени";

  // элементы аттестации (для краткой сводки)
  const attestRes = await pool.query(
    `
    SELECT
      ai.id,
      ai.title,
      uas.status,
      uas.updated_by_admin_id,
      ua.full_name AS updated_by_admin_name
    FROM attestation_items ai
    LEFT JOIN user_attestation_status uas
      ON uas.item_id = ai.id AND uas.user_id = $1
    LEFT JOIN users ua
      ON ua.id = uas.updated_by_admin_id
    WHERE ai.is_active = TRUE
    ORDER BY ai.order_index, ai.id
    `,
    [userId]
  );

  const testsRes = await pool.query(
    `
        SELECT
          ts.created_at,
          ts.mode,
          ts.question_count,
          ts.correct_count,
          t.title AS topic_title,
          ua.full_name AS admin_full_name
        FROM test_sessions ts
        LEFT JOIN topics t ON t.id = ts.topic_id
        LEFT JOIN users ua ON ua.id = COALESCE(ts.conducted_by, ts.admin_id)
        WHERE ts.user_id = $1
        ORDER BY ts.created_at DESC
        LIMIT 5
        `,
    [user.id]
  );

  let testsText = "📊 Последние тесты / тренировки:\n";

  if (!testsRes.rows.length) {
    testsText += "Пока нет ни одного теста.\n";
  } else {
    for (const row of testsRes.rows) {
      const date = new Date(row.created_at.getTime() + 7 * 60 * 60 * 1000);
      const dateStr = date.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      let modeLabel;

      if (row.mode === "topic") {
        modeLabel = `по теме: "${row.topic_title || "Без названия"}"`;
      } else if (row.mode === "admin_base") {
        modeLabel = `админ-тест «Теория база» по теме: "${
          row.topic_title || "Без названия"
        }"`;
      } else if (row.mode === "admin_full") {
        modeLabel = `админ-тест «Полная теория» по теме: "${
          row.topic_title || "Без названия"
        }"`;
      } else {
        modeLabel = "по всем темам";
      }

      const total = row.question_count;
      const correct = row.correct_count;
      const percent = total > 0 ? Math.round((correct / total) * 100) : 0;

      let testerSuffix = "";
      if (row.admin_full_name) {
        testerSuffix = ` (${row.admin_full_name})`;
      }

      testsText +=
        `• ${dateStr} — ${modeLabel}${testerSuffix}\n` +
        `  Результат: ${correct}/${total} (${percent}%)\n`;
    }
  }

  let text = `👤 ${name}\n` + `Роль: ${user.role}\n`;

  if (attestRes.rows.length) {
    text += `\n────────────\n`;
    for (const row of attestRes.rows) {
      const rawTitle = row.title || "";
      const lower = rawTitle.trim().toLowerCase();
      const passed = row.status === "passed";
      const icon = passed ? "✅" : "❌";

      let line = `${icon} ${rawTitle}`;

      // показываем имя админа только для обычных элементов (не теория база/полная)
      if (
        passed &&
        row.updated_by_admin_name &&
        lower !== "теория база" &&
        lower !== "полная теория"
      ) {
        line += ` (${row.updated_by_admin_name})`;
      }

      text += `${line}\n`;
    }
    text += `────────────\n`;
  }

  text += `\n📊 Последние тесты / тренировки:\n`;

  if (!testsRes.rows.length) {
    text += "Пока нет ни одного теста.\n";
  } else {
    for (const row of testsRes.rows) {
      // сдвигаем время назад на 7 часов
      const date = new Date(row.created_at.getTime() + 7 * 60 * 60 * 1000);
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

      let testerSuffix = "";
      if (row.admin_full_name) {
        testerSuffix = ` (${row.admin_full_name})`;
      }

      text +=
        `• ${dateStr} — ${modeLabel}${testerSuffix}\n` +
        `  Результат: ${correct}/${total} (${percent}%)\n`;
    }
  }

  text += `\nВыбери раздел:`;

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

    buttons.push([
      Markup.button.callback(
        "🗑 Удалить пользователя",
        `admin_user_delete_${user.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback("✅ Аттестация", `admin_user_attest_${user.id}`),
  ]);
  buttons.push([Markup.button.callback("🔙 К пользователям", "admin_users")]);
  buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// -----------------------------------------------------------------------------
// РЕГИСТРАЦИЯ ХЕНДЛЕРОВ
// -----------------------------------------------------------------------------

function registerAdminUsers(bot, ensureUser, logError) {
  // список пользователей
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

  // список пользователей: пагинация / фильтр
  bot.action(/^admin_users_list_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const page = parseInt(ctx.match[1], 10) || 1;
      const filterItemId = parseInt(ctx.match[2], 10) || 0;
      const panelFlag = ctx.match[3] === "1";

      await showAdminUsers(ctx, {
        page,
        filterItemId,
        showFilters: panelFlag,
      });
    } catch (err) {
      logError("admin_users_list_x", err);
    }
  });

  // карточка пользователя
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

  // настройки: открыть / закрыть
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

  // начало изменения имени
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

  // переключение роли
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

      // нельзя менять роль главного админа
      if (
        user.telegram_id &&
        String(user.telegram_id) === SUPER_ADMIN_TELEGRAM_ID
      ) {
        await ctx.reply("Нельзя менять роль этого пользователя.");
        return;
      }

      let newRole;
      if (user.role === "admin") {
        // понизить админа может только главный админ
        if (
          !admin.telegram_id ||
          String(admin.telegram_id) !== SUPER_ADMIN_TELEGRAM_ID
        ) {
          await ctx.reply(
            "Понижать администраторов до обычных пользователей может только главный админ."
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

  // создание нового пользователя
  bot.action("admin_add_user", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      setUserCreateState(ctx.from.id, { step: "await_new_user_telegram" });

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 К пользователям", "admin_users")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "✏ Отправь *telegram id* пользователя числом.\n" +
            "Если id пока неизвестен — отправь любой текст, и пользователь будет создан без привязки к Telegram.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_add_user", err);
    }
  });

  // запрос на удаление пользователя
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
        })?\n\n` +
        "Все связанные с ним данные могут быть удалены в соответствии с настройками БД.";
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

  // подтверждение удаления
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
        {
          text: "🗑 Пользователь удалён.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_user_delete_confirm_x", err);
      await ctx.reply("Не удалось удалить пользователя (ошибка БД).");
    }
  });

  // прогресс по темам
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

  // блоки конкретной темы
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

  // переключение статуса блока
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

  // переключение статуса обычного элемента аттестации
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

  // открыть аттестацию пользователя
  bot.action(/^admin_user_attest_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const userId = parseInt(ctx.match[1], 10);

      // 👉 ВОТ ЭТО ДОБАВЛЯЕМ — теперь train.js знает, что это админ-тест
      ctx.session = ctx.session || {};
      ctx.session.adminTestingUser = userId;

      await showUserAttestation(ctx, userId);
    } catch (err) {
      logError("admin_user_attest_x", err);
    }
  });

  // теория база — выбор темы
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

  // полная теория — выбор темы
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

  // старт теста: теория база, конкретная тема
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

  // старт теста: полная теория, конкретная тема
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

  // показать ответ в админ‑тесте
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

  // отметка ответа
  bot.action("admin_theory_mark_correct", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await handleAdminTheoryMark(ctx, true, logError);
  });

  bot.action("admin_theory_mark_wrong", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await handleAdminTheoryMark(ctx, false, logError);
  });

  // текстовые шаги (создание пользователя + изменение имени)
  bot.on("text", async (ctx, next) => {
    try {
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return next();

      const rawText = (ctx.message.text || "").trim();
      if (!rawText) return next();

      // изменение имени
      const renameState = userRenameStates.get(ctx.from.id);
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

      // создание пользователя
      const state = userCreateStates.get(ctx.from.id);
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
            // пробуем вставить; если такой tg-id уже есть — обновляем имя
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
            `Пользователь создан (id: ${userRow.id}).\n` +
              "Возвращаю список пользователей..."
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

// вспомогательная функция: получить topic_id по block_id
async function getBlockTopicId(blockId) {
  const res = await pool.query("SELECT topic_id FROM blocks WHERE id = $1", [
    blockId,
  ]);
  if (!res.rows.length) return null;
  return res.rows[0].topic_id;
}

module.exports = registerAdminUsers;
