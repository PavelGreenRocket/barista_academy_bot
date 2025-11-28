// src/bot/instructions.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");
const mammoth = require("mammoth");
const { Agent } = require("node:https");
const { GigaChatEmbeddings } = require("langchain-gigachat");

const httpsAgent = new Agent({
  rejectUnauthorized: false,
});

const embeddingsClient = new GigaChatEmbeddings({
  credentials: process.env.GIGACHAT_CREDENTIALS,
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  httpsAgent,
});

function isAdmin(user) {
  return user && user.role === "admin";
}

// состояние для замены инструкций
// key: telegram_id админа,
// value: { type: 'barista' | 'admin' | 'ai', step: 'await_file' }
const instructionEditStates = new Map();

async function getInstructionFileId(type) {
  const res = await pool.query(
    "SELECT file_id FROM bot_instructions WHERE type = $1",
    [type]
  );
  return res.rows.length ? res.rows[0].file_id : null;
}

async function setInstructionFileId(type, fileId) {
  await pool.query(
    `
    INSERT INTO bot_instructions (type, file_id)
    VALUES ($1, $2)
    ON CONFLICT (type) DO UPDATE
    SET file_id = EXCLUDED.file_id
    `,
    [type, fileId]
  );
}

async function showInstructionMenu(ctx, user, options = {}) {
  const edit = options.edit || false;
  const admin = isAdmin(user);

  const buttons = [];

  buttons.push([
    Markup.button.callback("📘 Инструкция для бариста", "instr_barista_show"),
  ]);

  if (admin) {
    buttons.push([
      Markup.button.callback("🛠 Инструкция для админа", "instr_admin_show"),
    ]);
    buttons.push([
      Markup.button.callback("🤖 Инструкция для ИИ", "instr_ai_show"),
    ]);
    buttons.push([
      Markup.button.callback("✏️ Изменить инструкции", "instr_edit_menu"),
    ]);
  }

  const text = "📄 Инструкции.\n\n" + "Выбери нужную инструкцию:";

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    edit ? { edit: true } : {}
  );
}

// Импортирует Word-документ (инструкция для ИИ) в таблицу knowledge_chunks
// sourceName сейчас фиксированный: "ai_instruction"
async function importAiDocFromTelegram(ctx, doc) {
  const fileId = doc.file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);

  // Node 18+ имеет глобальный fetch
  const response = await fetch(fileLink.href);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { value: fullText } = await mammoth.extractRawText({ buffer });

  let chunks = fullText
    .split(/\n{2,}/) // делим по пустым строкам
    .map((t) => t.trim())
    .filter((t) => t.length > 40); // отбрасываем совсем короткое

  if (!chunks.length) {
    throw new Error("Не удалось выделить фрагменты текста из документа.");
  }

  const sourceName = "ai_instruction";

  // удаляем старые фрагменты для этого источника
  await pool.query("DELETE FROM knowledge_chunks WHERE source = $1", [
    sourceName,
  ]);

  const batchSize = 16;
  let globalIndex = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vectors = await embeddingsClient.embedDocuments(batch); // массив векторов

    for (let j = 0; j < batch.length; j++) {
      const text = batch[j];
      const embedding = vectors[j];

      await pool.query(
        `
          INSERT INTO knowledge_chunks (source, chunk_index, text, embedding)
          VALUES ($1, $2, $3, $4)
        `,
        [sourceName, globalIndex, text, JSON.stringify(embedding)]
      );

      globalIndex++;
    }
  }

  console.log(
    `Импорт инструкции для ИИ завершён. Всего фрагментов: ${globalIndex}`
  );
}

function registerInstructions(bot, ensureUser, logError) {
  // команда /instruction
  bot.command("instruction", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      await showInstructionMenu(ctx, user, { edit: false });
    } catch (err) {
      logError("/instruction", err);
      await ctx.reply("Не удалось открыть меню инструкций.");
    }
  });

  // показать инструкцию для бариста
  bot.action("instr_barista_show", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx); // просто чтобы создать запись, если надо

      const fileId = await getInstructionFileId("barista");
      if (!fileId) {
        await ctx.reply("Инструкция для бариста пока не загружена.");
        return;
      }

      await ctx.replyWithDocument(fileId);
    } catch (err) {
      logError("instr_barista_show_x", err);
      await ctx.reply("Не удалось отправить инструкцию для бариста.");
    }
  });

  // показать инструкцию для админа (только админам)
  bot.action("instr_admin_show", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const fileId = await getInstructionFileId("admin");
      if (!fileId) {
        await ctx.reply("Инструкция для админа пока не загружена.");
        return;
      }

      await ctx.replyWithDocument(fileId);
    } catch (err) {
      logError("instr_admin_show_x", err);
      await ctx.reply("Не удалось отправить инструкцию для админа.");
    }
  });

  // показать инструкцию для ИИ (только админам) + меню действий
  bot.action("instr_ai_show", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const fileId = await getInstructionFileId("ai");
      if (fileId) {
        // сначала отправляем текущий файл, если он есть
        await ctx.replyWithDocument(fileId);
      } else {
        await ctx.reply(
          "Инструкция для ИИ пока не загружена. Ты можешь добавить её, отправив Word-файл."
        );
      }

      const buttons = [
        [
          Markup.button.callback("➕ Добавить", "instr_ai_add"),
          Markup.button.callback("♻ Заменить", "instr_ai_replace"),
        ],
        [Markup.button.callback("🔙 Назад", "instr_back_to_menu")],
      ];

      await ctx.reply(
        "🤖 Инструкция для ИИ.\n\nВыбери действие:",
        Markup.inlineKeyboard(buttons)
      );
    } catch (err) {
      logError("instr_ai_show_x", err);
    }
  });

  // показать инструкцию для админа (только админам)
  bot.action("instr_admin_show", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const fileId = await getInstructionFileId("admin");
      if (!fileId) {
        await ctx.reply("Инструкция для админа пока не загружена.");
        return;
      }

      await ctx.replyWithDocument(fileId);
    } catch (err) {
      logError("instr_admin_show_x", err);
      await ctx.reply("Не удалось отправить инструкцию для админа.");
    }
  });

  // меню редактирования инструкций
  bot.action("instr_edit_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const buttons = [
        [
          Markup.button.callback(
            "✏️ Изменить инструкцию для бариста",
            "instr_edit_barista"
          ),
        ],
        [
          Markup.button.callback(
            "✏️ Изменить инструкцию для админа",
            "instr_edit_admin"
          ),
        ],
        [Markup.button.callback("🔙 Назад", "instr_back_to_menu")],
      ];

      const text =
        "✏️ Редактирование инструкций.\n\n" +
        "Выбери, какую инструкцию хочешь заменить:";

      await deliver(
        ctx,
        { text, extra: Markup.inlineKeyboard(buttons) },
        { edit: true }
      );
    } catch (err) {
      logError("instr_edit_menu_x", err);
    }
  });

  // назад в меню инструкций
  bot.action("instr_back_to_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      await showInstructionMenu(ctx, user, { edit: true });
    } catch (err) {
      logError("instr_back_to_menu_x", err);
    }
  });

  // выбор, какую инструкцию обновлять
  bot.action("instr_edit_barista", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      instructionEditStates.set(ctx.from.id, {
        type: "barista",
        step: "await_file",
      });

      await ctx.reply(
        "Отправь новый Word-файл (*.doc или *.docx) с инструкцией для бариста одним сообщением.\n" +
          "Он заменит текущую версию."
      );
    } catch (err) {
      logError("instr_edit_barista_x", err);
    }
  });

  // добавить инструкцию для ИИ
  bot.action("instr_ai_add", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      instructionEditStates.set(ctx.from.id, {
        type: "ai",
        step: "await_file",
      });

      await ctx.reply(
        "Отправь Word-файл (*.doc или *.docx) с инструкцией/теорией для ИИ одним сообщением.\n" +
          "Если такой инструкции ещё нет, она будет добавлена. Если уже есть — будет обновлена."
      );
    } catch (err) {
      logError("instr_ai_add_x", err);
    }
  });

  // заменить инструкцию для ИИ
  bot.action("instr_ai_replace", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      instructionEditStates.set(ctx.from.id, {
        type: "ai",
        step: "await_file",
      });

      await ctx.reply(
        "Отправь Word-файл (*.doc или *.docx) с обновлённой инструкцией для ИИ одним сообщением.\n" +
          "Старая версия будет заменена."
      );
    } catch (err) {
      logError("instr_ai_replace_x", err);
    }
  });

  bot.action("instr_edit_admin", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      instructionEditStates.set(ctx.from.id, {
        type: "admin",
        step: "await_file",
      });

      await ctx.reply(
        "Отправь новый Word-файл (*.doc или *.docx) с инструкцией для админа одним сообщением.\n" +
          "Он заменит текущую версию."
      );
    } catch (err) {
      logError("instr_edit_admin_x", err);
    }
  });

  // обработка загруженных документов
  bot.on("document", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const state = instructionEditStates.get(ctx.from.id);
      if (!state || state.step !== "await_file") return next();

      const doc = ctx.message.document;
      if (!doc) return next();

      const fileName = doc.file_name || "";
      const lower = fileName.toLowerCase();

      if (!lower.endsWith(".doc") && !lower.endsWith(".docx")) {
        await ctx.reply("Пожалуйста, отправь файл в формате .doc или .docx.");
        return;
      }

      const fileId = doc.file_id;

      // сохраняем файл в таблицу инструкций (чтобы потом можно было его получить)
      await setInstructionFileId(state.type, fileId);

      // если обновляем инструкцию для ИИ — импортируем её в базу знаний
      if (state.type === "ai") {
        await ctx.reply(
          "Получил файл. Обновляю теоретическую базу для ИИ, подожди пару секунд…"
        );

        try {
          await importAiDocFromTelegram(ctx, doc);
          await ctx.reply(
            "Готово! Инструкция для ИИ сохранена, а база знаний обновлена. " +
              "Теперь ответы ассистента опираются на эту версию документа."
          );
        } catch (e) {
          console.error("Ошибка импорта инструкции для ИИ:", e);
          await ctx.reply(
            "Файл сохранён как инструкция для ИИ, но не удалось обновить базу знаний. " +
              "Проверь логи сервера."
          );
        }
      } else {
        let who = "";
        if (state.type === "barista") who = "для бариста";
        else if (state.type === "admin") who = "для админа";

        await ctx.reply(`Инструкция ${who ? who + " " : ""}обновлена.`);
      }

      instructionEditStates.delete(ctx.from.id);
    } catch (err) {
      logError("instr_document_handler_x", err);
      return next();
    }
  });
}

module.exports = registerInstructions;
