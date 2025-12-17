
const { pool, Markup, deliver, configStates, isAdmin, isTelegraphUrl } = require("./common");
const { showSectionStepsList } = require("./adminSteps");

async function showInternshipSection(ctx, sectionId, partId) {
  const sRes = await pool.query(
    `SELECT id, title, order_index, telegraph_url, duration_days
     FROM internship_sections WHERE id=$1 AND part_id=$2`,
    [sectionId, partId]
  );
  if (!sRes.rows.length) {
    await ctx.reply("Раздел не найден.");
    return;
  }
  const sec = sRes.rows[0];

  const text =
    `Раздел стажировки:\n` +
    `Название: ${sec.title}\n` +
    `Порядок: ${sec.order_index}\n` +
    `Telegraph: ${sec.telegraph_url ? "✅ прикреплён" : "❌ нет"}\n` +
    `Срок: ${sec.duration_days ? `${sec.duration_days} дн.` : "не указан"}\n`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Переименовать раздел", `admin_internship_section_rename_${sec.id}_${partId}`)],
    [Markup.button.callback("📝 Telegraph (теория)", `admin_internship_section_telegraph_${sec.id}_${partId}`)],
    [Markup.button.callback(
      sec.duration_days
        ? `📅 Изменить срок для раздела (${sec.duration_days} дн.)`
        : "📅 Добавить срок для раздела",
      `admin_internship_section_duration_${sec.id}_${partId}`
    )],

    // ✅ Вместо "+ Добавить этап" -> "Этапы раздела"
    [Markup.button.callback("📋 Этапы раздела", `admin_internship_section_steps_${sec.id}_${partId}`)],

    [Markup.button.callback("🗑 Удалить раздел", `admin_internship_section_del_${sec.id}_${partId}`)],
    [Markup.button.callback("🔙 К части", `admin_internship_part_${partId}`)],
  ]);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

function registerAdminSections(bot, { ensureUser, logError }) {
  bot.action(/^admin_internship_section_edit_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);
      await showInternshipSection(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_section_edit_x", err);
    }
  });

  bot.action(/^admin_internship_section_steps_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);
      await showSectionStepsList(ctx, sectionId, partId);
    } catch (err) {
      logError("admin_internship_section_steps_x", err);
    }
  });

  bot.action(/^admin_internship_section_rename_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      configStates.set(ctx.from.id, { mode: "rename_section", sectionId, partId });
      await deliver(ctx, { text: "✏️ Пришлите новое название раздела одним сообщением." }, { edit: true });
    } catch (err) {
      logError("admin_internship_section_rename_x", err);
    }
  });

  bot.action(/^admin_internship_section_duration_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      configStates.set(ctx.from.id, { mode: "section_duration", sectionId, partId });
      await deliver(ctx, { text: "📅 Введите срок для раздела в днях (целое число). Чтобы очистить — пришлите: -" }, { edit: true });
    } catch (err) {
      logError("admin_internship_section_duration_x", err);
    }
  });

  bot.action(/^admin_internship_section_telegraph_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      configStates.set(ctx.from.id, { mode: "section_telegraph", sectionId, partId });
      await deliver(ctx, { text: "📝 Пришлите ссылку на Telegraph (или '-' чтобы очистить)." }, { edit: true });
    } catch (err) {
      logError("admin_internship_section_telegraph_x", err);
    }
  });

  // delete section (simple confirm-less, to keep snippet short). If you had confirm flow before, keep it.
  bot.action(/^admin_internship_section_del_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const sectionId = parseInt(ctx.match[1], 10);
      const partId = parseInt(ctx.match[2], 10);

      await pool.query("DELETE FROM internship_sections WHERE id=$1", [sectionId]);
      await ctx.reply("✅ Раздел удалён.");
      const { showInternshipPart } = require("./adminParts");
      await showInternshipPart(ctx, partId);
    } catch (err) {
      logError("admin_internship_section_del_x", err);
    }
  });
}

module.exports = {
  registerAdminSections,
  showInternshipSection,
};
