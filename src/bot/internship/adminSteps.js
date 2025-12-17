
const { pool, Markup, deliver, configStates, isAdmin, isTelegraphUrl } = require("./common");

async function showSectionStepsList(ctx, sectionId, partId) {
  const secRes = await pool.query(
    `SELECT id, title FROM internship_sections WHERE id=$1 AND part_id=$2`,
    [sectionId, partId]
  );
  if (!secRes.rows.length) {
    await ctx.reply("Раздел не найден.");
    return;
  }
  const section = secRes.rows[0];

  const stepsRes = await pool.query(
    `SELECT id, title, order_index, planned_duration_min
     FROM internship_steps
     WHERE section_id=$1
     ORDER BY order_index ASC, id ASC`,
    [sectionId]
  );
  const steps = stepsRes.rows;

  let text = `📋 Этапы раздела: ${section.title}\n`;
  if (!steps.length) text += `\n(пока нет этапов)\n`;

  const rows = [];
  for (const st of steps) {
    const dur = st.planned_duration_min ? ` (${st.planned_duration_min} мин.)` : "";
    rows.push([Markup.button.callback(`🎯 ${st.title}${dur}`, `admin_internship_step_edit_${st.id}_${sectionId}_${partId}`)]);
  }

  rows.push([Markup.button.callback("➕ Добавить этап", `admin_internship_step_new_${sectionId}_${partId}`)]);
  rows.push([Markup.button.callback("🔁 Изменить последовательность", `admin_internship_steps_reorder_${sectionId}_${partId}`)]);
  rows.push([Markup.button.callback("🔙 К разделу", `admin_internship_section_edit_${sectionId}_${partId}`)]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(rows) }, { edit: true });
}

async function showStepsReorder(ctx, sectionId, partId) {
  const secRes = await pool.query(
    `SELECT id, title FROM internship_sections WHERE id=$1 AND part_id=$2`,
    [sectionId, partId]
  );
  if (!secRes.rows.length) {
    await ctx.reply("Раздел не найден.");
    return;
  }
  const section = secRes.rows[0];

  const stepsRes = await pool.query(
    `SELECT id, title, order_index FROM internship_steps WHERE section_id=$1 ORDER BY order_index ASC, id ASC`,
    [sectionId]
  );
  const steps = stepsRes.rows;

  const text =
    `🎯 Этапы (режим изменения порядка):\n\n` +
    `Раздел: ${section.title}\n` +
    `Нажимай ⬆️ / ⬇️ рядом с этапами.\n`;

  const rows = [];
  for (const st of steps) {
    rows.push([
      Markup.button.callback(st.title.length > 24 ? st.title.slice(0, 24) + "…" : st.title, `admin_internship_step_edit_${st.id}_${sectionId}_${partId}`),
      Markup.button.callback("⬆️", `admin_internship_steps_reorder_up_${sectionId}_${partId}_${st.id}`),
      Markup.button.callback("⬇️", `admin_internship_steps_reorder_down_${sectionId}_${partId}_${st.id}`),
    ]);
  }

  rows.push([Markup.button.callback("✅ Закончить изменение порядка", `admin_internship_steps_reorder_done_${sectionId}_${partId}`)]);
  rows.push([Markup.button.callback("🔙 К этапам", `admin_internship_section_steps_${sectionId}_${partId}`)]);

  await deliver(ctx, { text, extra: Markup.inlineKeyboard(rows) }, { edit: true });
}

async function swapSteps(sectionId, stepId, direction /* up|down */) {
  const curRes = await pool.query(
    `SELECT id, order_index FROM internship_steps WHERE id=$1 AND section_id=$2`,
    [stepId, sectionId]
  );
  if (!curRes.rows.length) return;
  const cur = curRes.rows[0];

  const neighborRes = await pool.query(
    direction === "up"
      ? `SELECT id, order_index FROM internship_steps WHERE section_id=$1 AND order_index < $2 ORDER BY order_index DESC, id DESC LIMIT 1`
      : `SELECT id, order_index FROM internship_steps WHERE section_id=$1 AND order_index > $2 ORDER BY order_index ASC, id ASC LIMIT 1`,
    [sectionId, cur.order_index]
  );
  if (!neighborRes.rows.length) return;
  const nb = neighborRes.rows[0];

  await pool.query("BEGIN");
  try {
    await pool.query(`UPDATE internship_steps SET order_index=$1 WHERE id=$2`, [nb.order_index, cur.id]);
    await pool.query(`UPDATE internship_steps SET order_index=$1 WHERE id=$2`, [cur.order_index, nb.id]);
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}

async function showStepSettings(ctx, stepId, sectionId, partId) {
  const stRes = await pool.query(
    `SELECT id, title, order_index, planned_duration_min
     FROM internship_steps
     WHERE id=$1 AND section_id=$2`,
    [stepId, sectionId]
  );
  if (!stRes.rows.length) {
    await ctx.reply("Этап не найден.");
    return;
  }
  const st = stRes.rows[0];

  // telegraph_url может отсутствовать в таблице — поэтому читаем "мягко"
  let telegraph = null;
  try {
    const tRes = await pool.query(`SELECT telegraph_url FROM internship_steps WHERE id=$1`, [stepId]);
    telegraph = (tRes.rows[0] || {}).telegraph_url || null;
  } catch (_) {
    telegraph = null;
  }

  const text =
    `Этап стажировки:\n` +
    `Название: ${st.title}\n` +
    `Порядок: ${st.order_index}\n` +
    `Telegraph: ${telegraph ? "✅ прикреплён" : "❌ нет"}\n` +
    `Срок: ${st.planned_duration_min ? `${st.planned_duration_min} мин.` : "не указан"}\n`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Переименовать этап", `admin_internship_step_rename_${stepId}_${sectionId}_${partId}`)],
    [Markup.button.callback("📝 Telegraph (опционально)", `admin_internship_step_telegraph_${stepId}_${sectionId}_${partId}`)],
    [Markup.button.callback(
      st.planned_duration_min ? `⏱ Изменить срок этапа (${st.planned_duration_min} мин.)` : "⏱ Добавить срок этапа",
      `admin_internship_step_duration_${stepId}_${sectionId}_${partId}`
    )],
    [Markup.button.callback("🗑 Удалить этап", `admin_internship_step_del_${stepId}_${sectionId}_${partId}`)],
    [Markup.button.callback("🔙 К этапам раздела", `admin_internship_section_steps_${sectionId}_${partId}`)],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

function registerAdminSteps(bot, { ensureUser, logError }) {
  bot.action(/^admin_internship_step_new_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      configStates.set(ctx.from.id, { mode: "new_step_title", sectionId, partId });
      await deliver(ctx, { text: "Отправь название нового этапа одним сообщением." }, { edit: true });
    } catch (err) {
      logError("admin_internship_step_new_x", err);
    }
  });

  bot.action(/^admin_internship_steps_reorder_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);
      await showStepsReorder(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_steps_reorder_x", err);
    }
  });

  bot.action(/^admin_internship_steps_reorder_up_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);
      const stepId = parseInt(ctx.match[3], 10);

      await swapSteps(sectionId, stepId, "up");
      await showStepsReorder(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_steps_reorder_up_x", err);
    }
  });

  bot.action(/^admin_internship_steps_reorder_down_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);
      const stepId = parseInt(ctx.match[3], 10);

      await swapSteps(sectionId, stepId, "down");
      await showStepsReorder(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_steps_reorder_down_x", err);
    }
  });

  bot.action(/^admin_internship_steps_reorder_done_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Готово").catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);
      await showSectionStepsList(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_steps_reorder_done_x", err);
    }
  });

  bot.action(/^admin_internship_step_edit_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const stepId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);
      const partId = parseInt(ctx.match[3], 10);
      await showStepSettings(ctx, stepId, sectionId, partId);
    } catch (err) {
      logError("admin_internship_step_edit_x", err);
    }
  });

  bot.action(/^admin_internship_step_rename_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const stepId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);
      const partId = parseInt(ctx.match[3], 10);

      configStates.set(ctx.from.id, { mode: "rename_step", stepId, sectionId, partId });
      await deliver(ctx, { text: "✏️ Пришлите новое название этапа одним сообщением." }, { edit: true });
    } catch (err) {
      logError("admin_internship_step_rename_x", err);
    }
  });

  bot.action(/^admin_internship_step_duration_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const stepId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);
      const partId = parseInt(ctx.match[3], 10);

      configStates.set(ctx.from.id, { mode: "step_duration", stepId, sectionId, partId });
      await deliver(ctx, { text: "⏱ Введите срок этапа в минутах (целое число). Чтобы очистить — пришлите: -" }, { edit: true });
    } catch (err) {
      logError("admin_internship_step_duration_x", err);
    }
  });

  bot.action(/^admin_internship_step_telegraph_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const stepId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);
      const partId = parseInt(ctx.match[3], 10);

      configStates.set(ctx.from.id, { mode: "step_telegraph", stepId, sectionId, partId });
      await deliver(ctx, { text: "📝 Пришлите ссылку Telegraph для этапа (или '-' чтобы очистить)." }, { edit: true });
    } catch (err) {
      logError("admin_internship_step_telegraph_x", err);
    }
  });

  bot.action(/^admin_internship_step_del_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const stepId = parseInt(ctx.match[1], 10);
      const sectionId = parseInt(ctx.match[2], 10);
      const partId = parseInt(ctx.match[3], 10);

      await pool.query("DELETE FROM internship_steps WHERE id=$1", [stepId]);
      await ctx.reply("✅ Этап удалён.");
      await showSectionStepsList(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_step_del_x", err);
    }
  });
}

module.exports = {
  registerAdminSteps,
  showSectionStepsList,
  showStepSettings,
};
