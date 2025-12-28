// src/index.js

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const pool = require("./db/pool");

const registerAdminCommands = require("./bot/admin");
const registerAdminCardCommands = require("./bot/adminCards");
const registerTheory = require("./bot/theory");
const registerTrain = require("./bot/train");
const registerAttest = require("./bot/attest");
const {
  registerInternship,
  hasActiveInternshipSessionForTrainer,
} = require("./bot/internship/index");

const { deliver } = require("./utils/renderHelpers");
const { startOutboxWorker } = require("./outbox/worker");

// -------------------
// Диагностика ENV
// -------------------
const BOT_TOKEN = process.env.BOT_TOKEN;

// безопасный лог токена (не печатаем полностью)
console.log("🔎 ENV BOT_TOKEN exists:", !!process.env.BOT_TOKEN);
console.log(
  "🔎 BOT_TOKEN length:",
  process.env.BOT_TOKEN ? process.env.BOT_TOKEN.length : "null"
);
console.log(
  "🔎 BOT_TOKEN preview:",
  process.env.BOT_TOKEN
    ? `${process.env.BOT_TOKEN.slice(0, 6)}...${process.env.BOT_TOKEN.slice(
        -4
      )}`
    : "null"
);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не найден в .env");
  process.exit(1);
}

console.log("🤖 Creating Telegraf instance...");
const bot = new Telegraf(BOT_TOKEN);
console.log("🤖 Telegraf instance created");

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
async function showMainMenu(ctx) {
  const user = await ensureUser(ctx);
  const isAdmin = user?.role === "admin";

  const text = "Привет! Я бот для обучения бариста. ☕\n\nВыбери раздел:";

  const keyboard = [];

  // основные разделы
  keyboard.push([Markup.button.callback("📚 Теория", "user_theory")]);
  keyboard.push([Markup.button.callback("🎯 Тренировки", "user_train")]);
  keyboard.push([Markup.button.callback("✅ Аттестация", "user_attest")]);

  // 👉 кнопка процесса стажировки, если у админа есть активная сессия
  if (isAdmin) {
    const hasInternship = await hasActiveInternshipSessionForTrainer(user.id);
    if (hasInternship) {
      keyboard.push([
        Markup.button.callback(
          "🧑‍🏫 Процесс стажировки",
          "internship_active_menu"
        ),
      ]);
    }
  }

  // 👉 НОВОЕ: кнопка "Запланировано собеседование", если у админа есть активные кандидаты
  // (оставляю как у тебя — сейчас запрос никуда не выводится, но и не ломает)
  if (isAdmin) {
    await pool.query(
      `
      SELECT 1
      FROM candidates
      WHERE status IN ('invited','interviewed','internship_invited')
        AND admin_id = $1
      LIMIT 1
      `,
      [user.id]
    );
  }

  // переход в админ-панель
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
registerInternship(bot, ensureUser, logError, showMainMenu);

startOutboxWorker(bot);

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

// ----- Запуск бота (с диагностикой) -----

(async () => {
  try {
    console.log("🚀 Preflight: calling getMe() to validate token...");
    const me = await bot.telegram.getMe();
    console.log("✅ getMe OK:", {
      id: me.id,
      username: me.username,
      first_name: me.first_name,
      is_bot: me.is_bot,
    });

    console.log("🚀 Launching bot (polling/getUpdates)...");
    await bot.launch();
    console.log("✅ Bot started: barista_academy_bot");
  } catch (err) {
    console.error("❌ BOT LAUNCH FAILED");
    console.error("Message:", err?.message);
    console.error("Code:", err?.code);
    console.error("Response:", err?.response);
    console.error("On:", err?.on);

    // подсказки по частым кейсам
    const desc = err?.response?.description || "";
    if (err?.response?.error_code === 401 || /Unauthorized/i.test(desc)) {
      console.error(
        "💡 Похоже на неверный BOT_TOKEN. Проверь .env (без пробелов/кавычек/переносов) и что BOT_TOKEN именно тот."
      );
    }
    if (err?.response?.error_code === 409 || /Conflict/i.test(desc)) {
      console.error(
        "💡 409 Conflict: запущен второй инстанс бота с тем же токеном (или активен webhook). Останови второй процесс или сделай deleteWebhook."
      );
    }

    process.exit(1);
  }
})();

process.once("SIGINT", () => {
  console.log("👋 SIGINT получен, останавливаем бота...");
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  console.log("👋 SIGTERM получен, останавливаем бота...");
  bot.stop("SIGTERM");
});
