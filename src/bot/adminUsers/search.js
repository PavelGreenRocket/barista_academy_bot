// src/bot/adminUsers/search.js

const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");
const pool = require("../../db/pool");
const {
  setUserSearchState,
  getUserSearchState,
  clearUserSearchState,
} = require("./state");

function registerAdminUsersSearch(bot, ensureUser, logError) {
  // Начало поиска пользователя
  bot.action("admin_users_search_start", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;
      setUserSearchState(ctx.from.id, { step: "await_query" });
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("👥 Список пользователей", "admin_users")],
        [Markup.button.callback("🔙 К фильтрам", "admin_users_list_1_0_1")],
        [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
      ]);
      await deliver(
        ctx,
        {
          text: "🔍 Поиск пользователя\n\nВведи любую часть имени, ID пользователя или перешли его сообщение — я покажу подходящих пользователей.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_users_search_start_x", err);
    }
  });

  // Обработка текстового ввода для поиска
  bot.on("text", async (ctx, next) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin || admin.role !== "admin") return next();
      const rawText = (ctx.message.text || "").trim();
      if (!rawText) return next();
      const searchState = getUserSearchState(ctx.from.id);
      if (!searchState || searchState.step !== "await_query") {
        return next();
      }
      // Есть активный запрос поиска
      const text = rawText;
      clearUserSearchState(ctx.from.id);
      let users = [];
      // Если переслано сообщение пользователя – берём его tgID
      const fwd = ctx.message.forward_from;
      if (fwd && fwd.id) {
        const tgId = fwd.id;
        const res = await pool.query(
          `
          SELECT id, full_name, staff_status
          FROM users
          WHERE telegram_id = $1
          ORDER BY id ASC
          `,
          [tgId]
        );
        users = res.rows;
      } else {
        // Если введены только цифры – пробуем как ID пользователя или Telegram ID
        if (/^\d+$/.test(text)) {
          const num = Number(text);
          const res = await pool.query(
            `
            SELECT id, full_name, staff_status
            FROM users
            WHERE id = $1 OR telegram_id = $1
            ORDER BY id ASC
            `,
            [num]
          );
          users = res.rows;
        }
        // Если по ID не нашли – ищем по имени (частичное совпадение)
        if (!users.length) {
          const pattern = `%${text}%`;
          const res = await pool.query(
            `
            SELECT id, full_name, staff_status
            FROM users
            WHERE full_name ILIKE $1
            ORDER BY full_name ASC
            LIMIT 50
            `,
            [pattern]
          );
          users = res.rows;
        }
      }
      if (!users.length) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("👥 Список пользователей", "admin_users")],
          [
            Markup.button.callback(
              "🔍 Новый поиск",
              "admin_users_search_start"
            ),
          ],
          [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
        ]);
        await deliver(
          ctx,
          {
            text: "Ничего не нашлось.\n\nПопробуй ввести другую часть имени, ID или перешли сообщение пользователя.",
            extra: keyboard,
          },
          { edit: false }
        );
        return;
      }
      let msg =
        "🔍 Результаты поиска пользователей\n\n" +
        `Найдено: ${users.length}\n\n` +
        "Выбери пользователя:";
      const buttons = [];
      for (const u of users) {
        const name = u.full_name || "Без имени";
        const icon = u.staff_status === "intern" ? "🎓" : "🧠";
        buttons.push([
          Markup.button.callback(`${icon} ${name}`, `admin_user_${u.id}`),
        ]);
      }
      buttons.push([
        Markup.button.callback("👥 Список пользователей", "admin_users"),
      ]);
      buttons.push([
        Markup.button.callback("🔍 Новый поиск", "admin_users_search_start"),
      ]);
      buttons.push([Markup.button.callback("🔙 В админ-панель", "admin_menu")]);
      await deliver(
        ctx,
        { text: msg, extra: Markup.inlineKeyboard(buttons) },
        { edit: false }
      );
      return;
    } catch (err) {
      logError("admin_users_search_query_x", err);
      return next();
    }
  });
}

module.exports = {
  registerAdminUsersSearch,
};
