
const { pool, Markup, deliver, isAdmin } = require("./common");

/**
 * Экран: Настройка части — список разделов + управление.
 * Требование: вместо "Часть вверх/вниз" -> "Изменить последовательность" (разделов внутри части).
 */
async function showInternshipPart(ctx, partId) {
  const pRes = await pool.query(
    "SELECT id, title, order_index FROM internship_parts WHERE id = $1",
    [partId]
  );
  if (!pRes.rows.length) {
    await ctx.reply("Часть стажировки не найдена.");
    return;
  }
  const part = pRes.rows[0];

  const secRes = await pool.query(
    `
    SELECT id, title, order_index, telegraph_url, duration_days
    FROM internship_sections
    WHERE part_id = $1
    ORDER BY order_index ASC, id ASC
    `,
    [partId]
  );
  const sections = secRes.rows;

  let text =
    `Часть стажировки:\n` +
    `Название: ${part.title}\n` +
    `Порядок: ${part.order_index}\n\n` +
    `Разделы (нажмите, чтобы редактировать):\n`;

  if (!sections.length) {
    text += "(пока нет разделов)\n";
  } else {
    for (const sec of sections) {
      const tg = sec.telegraph_url ? "✅" : "❌";
      const dur = sec.duration_days != null ? `, срок: ${sec.duration_days} дн.` : "";
      text += `• [${sec.order_index}] ${sec.title} ${tg}${dur}\n`;
    }
  }

  const buttons = [];
  for (const sec of sections) {
    buttons.push([
      Markup.button.callback(
        `📚 ${sec.title}`,
        `admin_internship_section_edit_${sec.id}_${part.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback("➕ Добавить раздел", `admin_internship_section_new_${part.id}`),
  ]);

  // ✅ Новый режим изменения порядка разделов
  buttons.push([
    Markup.button.callback("🔁 Изменить последовательность", `admin_internship_sections_reorder_${part.id}`),
  ]);

  buttons.push([
    Markup.button.callback("🗑 Удалить часть", `admin_internship_part_del_${part.id}`),
  ]);

  buttons.push([Markup.button.callback("🔙 К частям", "admin_internship_menu")]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(buttons) }, { edit: true });
}

async function showSectionsReorder(ctx, partId) {
  const partRes = await pool.query(
    "SELECT id, title FROM internship_parts WHERE id=$1",
    [partId]
  );
  if (!partRes.rows.length) {
    await ctx.reply("Часть не найдена.");
    return;
  }

  const secRes = await pool.query(
    `SELECT id, title, order_index FROM internship_sections WHERE part_id=$1 ORDER BY order_index ASC, id ASC`,
    [partId]
  );
  const sections = secRes.rows;

  let text =
    `📚 Разделы (режим изменения порядка):\n\n` +
    `Нажимай стрелки ⬆️ / ⬇️ рядом с разделами,\n` +
    `а затем вернись к обычному списку.\n`;

  const rows = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const up = Markup.button.callback("⬆️", `admin_internship_sections_reorder_up_${partId}_${sec.id}`);
    const down = Markup.button.callback("⬇️", `admin_internship_sections_reorder_down_${partId}_${sec.id}`);

    // как в "Темы": три колонки (название, up, down)
    rows.push([
      Markup.button.callback(
        sec.title.length > 24 ? sec.title.slice(0, 24) + "…" : sec.title,
        `admin_internship_section_edit_${sec.id}_${partId}`
      ),
      up,
      down,
    ]);
  }

  rows.push([Markup.button.callback("✅ Закончить изменение порядка", `admin_internship_sections_reorder_done_${partId}`)]);
  rows.push([Markup.button.callback("🔙 К части", `admin_internship_part_${partId}`)]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(rows) }, { edit: true });
}

// swap соседних элементов по order_index, чтобы не зависеть от "дыр" в индексах
async function swapSections(partId, sectionId, direction /* 'up'|'down' */) {
  const curRes = await pool.query(
    `SELECT id, order_index FROM internship_sections WHERE id=$1 AND part_id=$2`,
    [sectionId, partId]
  );
  if (!curRes.rows.length) return;

  const cur = curRes.rows[0];

  const neighborRes = await pool.query(
    direction === "up"
      ? `SELECT id, order_index FROM internship_sections WHERE part_id=$1 AND order_index < $2 ORDER BY order_index DESC, id DESC LIMIT 1`
      : `SELECT id, order_index FROM internship_sections WHERE part_id=$1 AND order_index > $2 ORDER BY order_index ASC, id ASC LIMIT 1`,
    [partId, cur.order_index]
  );
  if (!neighborRes.rows.length) return;

  const nb = neighborRes.rows[0];

  await pool.query("BEGIN");
  try {
    await pool.query(
      `UPDATE internship_sections SET order_index=$1 WHERE id=$2`,
      [nb.order_index, cur.id]
    );
    await pool.query(
      `UPDATE internship_sections SET order_index=$1 WHERE id=$2`,
      [cur.order_index, nb.id]
    );
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}

function registerAdminParts(bot, { ensureUser, logError }) {
  bot.action(/^admin_internship_part_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const partId = parseInt(ctx.match[1], 10);
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_part_x", err);
    }
  });

  bot.action(/^admin_internship_sections_reorder_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      const partId = parseInt(ctx.match[1], 10);
      await showSectionsReorder(ctx, partId);
    } catch (err) {
      logError("admin_internship_sections_reorder_x", err);
    }
  });

  bot.action(/^admin_internship_sections_reorder_up_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);

      await swapSections(partId, sectionId, "up");
      await showSectionsReorder(ctx, partId);
    } catch (err) {
      logError("admin_internship_sections_reorder_up_x", err);
    }
  });

  bot.action(/^admin_internship_sections_reorder_down_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);

      await swapSections(partId, sectionId, "down");
      await showSectionsReorder(ctx, partId);
    } catch (err) {
      logError("admin_internship_sections_reorder_down_x", err);
    }
  });

  bot.action(/^admin_internship_sections_reorder_done_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Готово").catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const partId = parseInt(ctx.match[1], 10);
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_sections_reorder_done_x", err);
    }
  });
}

module.exports = {
  registerAdminParts,
  showInternshipPart,
};
