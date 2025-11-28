// src/index.js

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const pool = require("./db/pool");

const registerAdminCommands = require("./bot/admin");
const registerAdminCardCommands = require("./bot/adminCards");
const registerTheory = require("./bot/theory");
const registerTrain = require("./bot/train");
const registerAttest = require("./bot/attest");
const registerAdminUsers = require("./bot/adminUsers");
const registerInstructions = require("./bot/instructions");
const {
  registerNotifications,
  hasUnreadNotification,
} = require("./bot/notifications");
const { registerAssistant } = require("./bot/assistant");

const { deliver } = require("./utils/renderHelpers");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не найден в .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ----- Вспомогательные вещи -----

function logError(context, error) {
  console.error(`❌ Ошибка в ${context}:`, error);
}

// регистрируем/обновляем пользователя в БД
async function ensureUser(ctx) {
  try {
    const tgId = ctx.from.id;

    const res = await pool.query(
      `INSERT INTO users (telegram_id, role)
       VALUES ($1, 'user')
       ON CONFLICT (telegram_id) DO UPDATE
       SET telegram_id = EXCLUDED.telegram_id
       RETURNING id, role`,
      [tgId]
    );

    return res.rows[0];
  } catch (err) {
    logError("ensureUser", err);
    return null;
  }
}

// показ главного меню
// показ главного меню
async function showMainMenu(ctx) {
  const user = await ensureUser(ctx);
  const isAdmin = user?.role === "admin";

  const text = "Привет! Я бот для обучения бариста. ☕\n\nВыбери раздел:";

  const keyboard = [];

  // уведомление, если есть непрочитанное
  const hasNotif = await hasUnreadNotification(user.id);
  if (hasNotif) {
    keyboard.push([
      Markup.button.callback(
        "🔔 Уведомление (НАЖМИ)!!!",
        "user_notification_open"
      ),
    ]);
  }

  keyboard.push([Markup.button.callback("📚 Теория", "user_theory")]);
  keyboard.push([Markup.button.callback("🎯 Тренировки", "user_train")]);

  // ❓ новая кнопка — вопрос к ассистенту
  keyboard.push([
    Markup.button.callback("❓ Вопрос по обучению", "user_ask_question"),
  ]);

  keyboard.push([Markup.button.callback("✅ Аттестация", "user_attest")]);

  if (isAdmin) {
    keyboard.push([Markup.button.callback("🛠 Админ-панель", "admin_menu")]);
  }

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(keyboard) },
    { edit: true }
  );
}

// ----- Подключаем модули -----
registerAdminCommands(bot, ensureUser, logError);
registerAdminCardCommands(bot, ensureUser, logError);
registerTheory(bot, ensureUser, logError);
registerTrain(bot, ensureUser, logError);
registerAttest(bot, ensureUser, logError);
registerAdminUsers(bot, ensureUser, logError);
registerInstructions(bot, ensureUser, logError);
registerNotifications(bot, ensureUser, logError);
registerAssistant(bot, ensureUser, logError);

// ----- Команды и кнопки для всех пользователей -----

bot.start(async (ctx) => {
  try {
    await showMainMenu(ctx);
  } catch (err) {
    logError("/start", err);
    await ctx.reply("Произошла ошибка при старте. Попробуй позже.");
  }
});

// Назад в главное меню
bot.action("back_main", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await showMainMenu(ctx);
  } catch (err) {
    logError("back_main", err);
    await ctx.reply("Не удалось вернуться в главное меню.");
  }
});

// ----- Глобальный обработчик ошибок -----

bot.catch((err, ctx) => {
  logError("bot.catch", err);
  if (ctx && ctx.reply) {
    ctx.reply("Произошла непредвиденная ошибка. Попробуй снова.");
  }
});

// ----- Запуск бота -----

bot
  .launch()
  .then(() => {
    console.log("✅ Bot started: barista_academy_bot");
  })
  .catch((err) => {
    logError("bot.launch", err);
    process.exit(1);
  });

process.once("SIGINT", () => {
  console.log("👋 SIGINT получен, останавливаем бота...");
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  console.log("👋 SIGTERM получен, останавливаем бота...");
  bot.stop("SIGTERM");
});
