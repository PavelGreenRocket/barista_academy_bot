// src/bot/notifications.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// состояние "ждём текст рассылки" по telegram_id
const broadcastState = new Set();

/**
 * Проверка: есть ли у пользователя хоть одно непрочитанное уведомление
 */
async function hasUnreadNotification(userId) {
  const res = await pool.query(
    `
      SELECT 1
      FROM user_notifications un
      WHERE un.user_id = $1 AND un.is_read = FALSE
      LIMIT 1
    `,
    [userId]
  );
  return res.rows.length > 0;
}

/**
 * Получить последнее непрочитанное уведомление пользователя
 */
async function getLastUnreadNotification(userId) {
  const res = await pool.query(
    `
      SELECT n.id, n.text, n.created_at
      FROM notifications n
      JOIN user_notifications un
        ON un.notification_id = n.id
      WHERE un.user_id = $1 AND un.is_read = FALSE
      ORDER BY n.created_at DESC
      LIMIT 1
    `,
    [userId]
  );
  return res.rows[0] || null;
}

/**
 * Показать пользователю текст уведомления
 */
async function showUserNotification(ctx, ensureUser, logError) {
  try {
    const user = await ensureUser(ctx);
    const row = await getLastUnreadNotification(user.id);

    if (!row) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 В меню", "back_main")],
      ]);

      await deliver(
        ctx,
        {
          text: "Сейчас нет новых уведомлений.",
          extra: keyboard,
        },
        { edit: true }
      );
      return;
    }

    const date = row.created_at.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const text = `🔔 Уведомление от ${date}:\n\n` + row.text;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "✅ ПРОЧИТАЛ",
          `user_notification_read_${row.id}`
        ),
      ],
    ]);

    await deliver(ctx, { text, extra: keyboard }, { edit: true });
  } catch (err) {
    logError("showUserNotification", err);
    await ctx.reply("Не удалось показать уведомление.");
  }
}

/**
 * Регистрация всех хендлеров уведомлений
 */
function registerNotifications(bot, ensureUser, logError) {
  // --- ADMIN: меню рассылки ---

  bot.action("admin_broadcast_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("✉️ Новое уведомление", "admin_broadcast_new")],
        [
          Markup.button.callback(
            "📊 Статус последнего",
            "admin_broadcast_status"
          ),
        ],
        [Markup.button.callback("🔙 В админ-панель", "admin_menu")],
      ]);

      await deliver(
        ctx,
        {
          text: "Раздел «Рассылка».\n\nВыбери действие:",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_broadcast_menu", err);
    }
  });

  // Админ нажал "Новое уведомление"
  bot.action("admin_broadcast_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      broadcastState.add(ctx.from.id);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Назад", "admin_broadcast_menu")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "Отправь текст уведомления одним сообщением.\n\n" +
            "Чтобы отменить, нажми «Назад».",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_broadcast_new", err);
    }
  });

  // Админ смотрит статус последнего уведомления
  // Админ смотрит статус последнего уведомления
  bot.action("admin_broadcast_status", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return;

      const lastRes = await pool.query(
        `
          SELECT id, text, created_at
          FROM notifications
          ORDER BY created_at DESC
          LIMIT 1
        `
      );

      if (!lastRes.rows.length) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Назад", "admin_broadcast_menu")],
        ]);

        await deliver(
          ctx,
          { text: "Уведомлений ещё не было.", extra: keyboard },
          { edit: true }
        );
        return;
      }

      const notif = lastRes.rows[0];

      const statsRes = await pool.query(
        `
          SELECT 
            COUNT(*) FILTER (WHERE un.is_read = FALSE) AS unread_count,
            COUNT(*) FILTER (WHERE un.is_read = TRUE) AS read_count
          FROM user_notifications un
          WHERE un.notification_id = $1
        `,
        [notif.id]
      );

      const listRes = await pool.query(
        `
          SELECT u.full_name
          FROM user_notifications un
          JOIN users u ON u.id = un.user_id
          WHERE un.notification_id = $1 AND un.is_read = FALSE
          ORDER BY u.full_name
        `,
        [notif.id]
      );

      const stats = statsRes.rows[0];
      const date = notif.created_at.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      let text =
        `Последнее уведомление от ${date}:\n\n` +
        `${notif.text}\n\n` +
        `📊 Статус:\n` +
        `• Прочитали: ${stats.read_count}\n` +
        `• НЕ прочитали: ${stats.unread_count}\n`;

      if (listRes.rows.length) {
        text += `\nПользователи без отметки:\n`;
        for (const row of listRes.rows) {
          text += `• ${row.full_name || "Без имени"}\n`;
        }
      }

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Назад", "admin_broadcast_menu")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_broadcast_status", err);
      await ctx.reply("Не удалось получить статус рассылки.");
    }
  });

  // --- ADMIN: перехват текста рассылки ---

  bot.on("text", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!user || user.role !== "admin") return next();
      if (!broadcastState.has(ctx.from.id)) return next();

      broadcastState.delete(ctx.from.id);
      const text = ctx.message.text.trim();
      if (!text) {
        await ctx.reply("Текст уведомления пустой. Попробуй ещё раз.");
        return;
      }

      // 1) создаём уведомление
      const notifRes = await pool.query(
        `
          INSERT INTO notifications (text, created_by)
          VALUES ($1, $2)
          RETURNING id
        `,
        [text, user.id]
      );
      const notifId = notifRes.rows[0].id;

      // 2) создаём отметки для всех пользователей
      await pool.query(
        `
          INSERT INTO user_notifications (notification_id, user_id)
          SELECT $1, u.id
          FROM users u
          WHERE u.telegram_id IS NOT NULL
        `,
        [notifId]
      );

      // 3) шлём пуш всем пользователям
      const usersRes = await pool.query(
        `
          SELECT telegram_id
          FROM users
          WHERE telegram_id IS NOT NULL
        `
      );

      let sendCount = 0;

      for (const row of usersRes.rows) {
        try {
          await ctx.telegram.sendMessage(
            row.telegram_id,
            "📣 НОВОЕ УВЕДОМЛЕНИЕ! Нажмите /start"
          );
          sendCount++;
        } catch (e) {
          // игнорируем ошибки конкретного юзера
        }
      }

      await ctx.reply(
        `Готово! Уведомление отправлено ${sendCount} пользователям.`
      );
      return;
    } catch (err) {
      logError("admin_broadcast_text", err);
      await ctx.reply("Не удалось отправить рассылку.");
    }

    return next();
  });

  // --- USER: открыть уведомление ---

  bot.action("user_notification_open", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await showUserNotification(ctx, ensureUser, logError);
  });

  // --- USER: отметить прочитанным ---

  bot.action(/^user_notification_read_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      const notifId = Number(ctx.match[1]);

      await pool.query(
        `
          UPDATE user_notifications
          SET is_read = TRUE, read_at = NOW()
          WHERE user_id = $1 AND notification_id = $2
        `,
        [user.id, notifId]
      );

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 В меню", "back_main")],
      ]);

      await deliver(
        ctx,
        {
          text: "Спасибо! Уведомление отмечено как прочитанное.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("user_notification_read", err);
      await ctx.reply("Не удалось отметить уведомление.");
    }
  });
}

module.exports = {
  registerNotifications,
  hasUnreadNotification,
};
