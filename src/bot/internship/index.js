
const { configStates, pool, isTelegraphUrl } = require("./common");
const { registerAdminParts, showInternshipPart } = require("./adminParts");
const { registerAdminSections, showInternshipSection } = require("./adminSections");
const { registerAdminSteps, showSectionStepsList, showStepSettings } = require("./adminSteps");

/**
 * Entry point: register handlers for the NEW admin editor flow:
 * - reorder sections in part
 * - section settings -> "Этапы раздела"
 * - steps list + reorder + step settings
 *
 * Подключение:
 *   const { registerInternshipAdminEditor } = require("./internship");
 *   registerInternshipAdminEditor(bot, { ensureUser, logError });
 */
function registerInternshipAdminEditor(bot, { ensureUser, logError }) {
  registerAdminParts(bot, { ensureUser, logError });
  registerAdminSections(bot, { ensureUser, logError });
  registerAdminSteps(bot, { ensureUser, logError });

  // Text handler for admin states (rename/duration/telegraph/new step)
  bot.on("text", async (ctx, next) => {
    const state = configStates.get(ctx.from.id);
    if (!state) return next();

    const text = String(ctx.message.text || "").trim();

    try {
      // --- Section rename ---
      if (state.mode === "rename_section") {
        if (!text) return;
        await pool.query(`UPDATE internship_sections SET title=$1 WHERE id=$2`, [text, state.sectionId]);
        configStates.delete(ctx.from.id);
        await ctx.reply("✅ Раздел переименован.");
        return showInternshipSection(ctx, state.sectionId, state.partId);
      }

      // --- Section duration days ---
      if (state.mode === "section_duration") {
        let value = null;
        if (text !== "-") {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n <= 0) {
            await ctx.reply("Введите целое число > 0, либо '-' чтобы очистить.");
            return;
          }
          value = n;
        }
        await pool.query(`UPDATE internship_sections SET duration_days=$1 WHERE id=$2`, [value, state.sectionId]);
        configStates.delete(ctx.from.id);
        await ctx.reply("✅ Срок сохранён.");
        return showInternshipSection(ctx, state.sectionId, state.partId);
      }

      // --- Section telegraph ---
      if (state.mode === "section_telegraph") {
        let value = null;
        if (text !== "-") {
          if (!isTelegraphUrl(text)) {
            await ctx.reply("Похоже, это не ссылка Telegraph. Пришлите корректную ссылку или '-' чтобы очистить.");
            return;
          }
          value = text;
        }
        await pool.query(`UPDATE internship_sections SET telegraph_url=$1 WHERE id=$2`, [value, state.sectionId]);
        configStates.delete(ctx.from.id);
        await ctx.reply("✅ Ссылка сохранена.");
        return showInternshipSection(ctx, state.sectionId, state.partId);
      }

      // --- New step: title -> duration -> create ---
      if (state.mode === "new_step_title") {
        if (!text) return;
        configStates.set(ctx.from.id, {
          mode: "new_step_duration",
          sectionId: state.sectionId,
          partId: state.partId,
          title: text,
        });
        await ctx.reply("⏱ Введите срок этапа в минутах (целое число). Можно '-' чтобы не указывать.");
        return;
      }

      if (state.mode === "new_step_duration") {
        let durationMin = null;
        if (text !== "-") {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n <= 0) {
            await ctx.reply("Введите целое число > 0, либо '-' чтобы не указывать срок.");
            return;
          }
          durationMin = n;
        }

        // order_index = max+1
        const mx = await pool.query(
          `SELECT COALESCE(MAX(order_index), 0) AS mx FROM internship_steps WHERE section_id=$1`,
          [state.sectionId]
        );
        const nextIdx = (mx.rows[0]?.mx || 0) + 1;

        const ins = await pool.query(
          `INSERT INTO internship_steps (section_id, title, order_index, planned_duration_min)
           VALUES ($1,$2,$3,$4)
           RETURNING id`,
          [state.sectionId, state.title, nextIdx, durationMin]
        );

        configStates.delete(ctx.from.id);
        await ctx.reply("✅ Этап добавлен.");
        return showSectionStepsList(ctx, state.sectionId, state.partId);
      }

      // --- Step rename ---
      if (state.mode === "rename_step") {
        if (!text) return;
        await pool.query(`UPDATE internship_steps SET title=$1 WHERE id=$2`, [text, state.stepId]);
        configStates.delete(ctx.from.id);
        await ctx.reply("✅ Этап переименован.");
        return showStepSettings(ctx, state.stepId, state.sectionId, state.partId);
      }

      // --- Step duration ---
      if (state.mode === "step_duration") {
        let value = null;
        if (text !== "-") {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n <= 0) {
            await ctx.reply("Введите целое число > 0, либо '-' чтобы очистить.");
            return;
          }
          value = n;
        }
        await pool.query(`UPDATE internship_steps SET planned_duration_min=$1 WHERE id=$2`, [value, state.stepId]);
        configStates.delete(ctx.from.id);
        await ctx.reply("✅ Срок сохранён.");
        return showStepSettings(ctx, state.stepId, state.sectionId, state.partId);
      }

      // --- Step telegraph (optional column) ---
      if (state.mode === "step_telegraph") {
        let value = null;
        if (text !== "-") {
          if (!isTelegraphUrl(text)) {
            await ctx.reply("Похоже, это не ссылка Telegraph. Пришлите корректную ссылку или '-' чтобы очистить.");
            return;
          }
          value = text;
        }
        try {
          await pool.query(`UPDATE internship_steps SET telegraph_url=$1 WHERE id=$2`, [value, state.stepId]);
          await ctx.reply("✅ Ссылка сохранена.");
        } catch (e) {
          await ctx.reply("⚠️ В БД нет колонки telegraph_url у internship_steps. Если нужно — добавь её, и функция заработает.");
        }
        configStates.delete(ctx.from.id);
        return showStepSettings(ctx, state.stepId, state.sectionId, state.partId);
      }

      // unknown mode -> pass through
      return next();
    } catch (err) {
      configStates.delete(ctx.from.id);
      logError("internship_admin_text_handler", err);
      await ctx.reply("❌ Ошибка при сохранении. Проверь лог.");
      return;
    }
  });
}

module.exports = {
  registerInternshipAdminEditor,
};
