// src/bot/adminUsers/perf.js

const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");

function registerAdminUsersPerf(bot, ensureUser, logError) {
  bot.action("admin_users_perf_deadline", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return;

      await deliver(
        ctx,
        {
          text: "Экран дедлайнов будет реализован позже.",
          extra: Markup.inlineKeyboard([
            [Markup.button.callback("🔙 К пользователям", "admin_users")],
            [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_users_perf_deadline_x", err);
    }
  });
}

module.exports = {
  registerAdminUsersPerf,
};
