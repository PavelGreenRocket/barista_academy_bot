// scripts/importDays.js

require("dotenv").config();
const path = require("path");
const mammoth = require("mammoth");
const pool = require("../src/db/pool"); // используем тот же pool, что и бот

async function loadDocText(filePath) {
  const fullPath = path.join(__dirname, "..", "data", filePath);
  console.log("📄 Читаю файл:", fullPath);

  const result = await mammoth.extractRawText({ path: fullPath });
  const text = (result.value || "").trim();

  if (!text) {
    throw new Error(`Файл пустой или не удалось прочитать: ${filePath}`);
  }

  return text;
}

async function main() {
  const client = await pool.connect();

  try {
    console.log("🔌 Подключился к БД");
    await client.query("BEGIN");

    // 1) Чистим учебные таблицы
    console.log(
      "🧹 Очищаю topics / blocks / groups / cards / user_block_status..."
    );
    await client.query(`
      TRUNCATE TABLE cards RESTART IDENTITY CASCADE;
      TRUNCATE TABLE groups RESTART IDENTITY CASCADE;
      TRUNCATE TABLE blocks RESTART IDENTITY CASCADE;
      TRUNCATE TABLE topics RESTART IDENTITY CASCADE;
      TRUNCATE TABLE user_block_status RESTART IDENTITY CASCADE;
    `);

    // 2) Читаем текст из DOCX
    const day1Text = await loadDocText("Обучение бариста день 1.docx");
    const day2Text = await loadDocText("Обучение бариста день 2.docx");

    // 3) Создаём темы
    console.log("🧱 Создаю темы...");

    const topic1Res = await client.query(
      `INSERT INTO topics (title, description, order_index)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Обучение день 1", day1Text, 1]
    );
    const topic1Id = topic1Res.rows[0].id;

    const topic2Res = await client.query(
      `INSERT INTO topics (title, description, order_index)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Обучение день 2", day2Text, 2]
    );
    const topic2Id = topic2Res.rows[0].id;

    console.log("✅ Темы созданы:", topic1Id, topic2Id);

    // 4) Создаём по одному блоку на день
    console.log("📦 Создаю блоки...");

    await client.query(
      `INSERT INTO blocks (topic_id, title, description, order_index)
       VALUES ($1, $2, $3, $4)`,
      [topic1Id, "День 1 — весь материал", null, 1]
    );

    await client.query(
      `INSERT INTO blocks (topic_id, title, description, order_index)
       VALUES ($1, $2, $3, $4)`,
      [topic2Id, "День 2 — весь материал", null, 1]
    );

    console.log("✅ Блоки созданы");

    await client.query("COMMIT");
    console.log("🎉 Импорт завершён успешно!");
  } catch (err) {
    console.error("❌ Ошибка при импорте:", err);
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
    console.log("🔌 Соединение с БД закрыто");
  }
}

main().catch((err) => {
  console.error("Фатальная ошибка:", err);
});
