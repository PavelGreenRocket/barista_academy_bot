// scripts/importFromDocxHeadings.js

require("dotenv").config();
const path = require("path");
const mammoth = require("mammoth");
const cheerio = require("cheerio");
const pool = require("../src/db/pool");

// читаем DOCX и получаем HTML с заголовками <h1>, <h2>, списками, таблицами и т.д.
async function loadDocHtml(fileName) {
  const fullPath = path.join(__dirname, "..", "data", fileName);
  console.log("📄 Читаю файл:", fullPath);

  const { value: html } = await mammoth.convertToHtml({ path: fullPath });
  if (!html || !html.trim()) {
    throw new Error(`Файл пустой или не удалось прочитать: ${fileName}`);
  }

  return html;
}

// аккуратно вытаскиваем текст из элемента, с учётом списков и таблиц
function extractElementText($, el) {
  const tag = el.tagName && el.tagName.toLowerCase();
  if (!tag) return "";

  // Обычный абзац / h3 и т.п.
  if (tag === "p" || tag === "h3" || tag === "h4" || tag === "h5") {
    return $(el).text().trim();
  }

  // Списки: <ul>/<ol> → каждая <li> с новой строки и маркером
  if (tag === "ul" || tag === "ol") {
    const lines = [];
    $(el)
      .find("li")
      .each((i, li) => {
        const t = $(li).text().trim();
        if (t) lines.push("• " + t);
      });
    return lines.join("\n");
  }

  // Таблицы: каждая строка = "ячейка1 — ячейка2 — ячейка3"
  if (tag === "table") {
    const rows = [];
    $(el)
      .find("tr")
      .each((i, tr) => {
        const cells = [];
        $(tr)
          .find("th,td")
          .each((j, td) => {
            const t = $(td).text().trim();
            if (t) cells.push(t);
          });
        if (cells.length) {
          rows.push(cells.join(" — "));
        }
      });
    return rows.join("\n");
  }

  // На всякий случай — дефолт
  return $(el).text().trim();
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

    // будем накапливать описание для тем и блоков
    const topicIntroParts = new Map(); // topicId -> [строки]
    const blockTextParts = new Map(); // blockId -> [строки]

    let topicOrder = 1;

    const files = [
      "Обучение бариста день 1.docx",
      "Обучение бариста день 2.docx",
    ];

    for (const fileName of files) {
      const html = await loadDocHtml(fileName);
      const $ = cheerio.load(html);

      let currentTopicId = null;
      let currentBlockId = null;
      let blockOrder = 1;

      const bodyChildren = $("body").children().toArray();

      for (const el of bodyChildren) {
        const tag = el.tagName && el.tagName.toLowerCase();
        if (!tag) continue;

        // ---------- H1: новая тема ----------
        if (tag === "h1") {
          const title = $(el).text().trim();
          if (!title) continue;

          const topicRes = await client.query(
            `INSERT INTO topics (title, description, order_index)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [title, null, topicOrder]
          );
          topicOrder += 1;

          currentTopicId = topicRes.rows[0].id;
          currentBlockId = null;
          blockOrder = 1;

          topicIntroParts.set(currentTopicId, []);
          continue;
        }

        // если нет текущей темы — игнорируем
        if (!currentTopicId) continue;

        // ---------- H2: новый блок, внутри текущей темы ----------
        if (tag === "h2") {
          const title = $(el).text().trim();
          if (!title) continue;

          const blockRes = await client.query(
            `INSERT INTO blocks (topic_id, title, description, order_index)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [currentTopicId, title, null, blockOrder]
          );
          blockOrder += 1;

          currentBlockId = blockRes.rows[0].id;
          blockTextParts.set(currentBlockId, []);
          continue;
        }

        // ---------- Обычный контент (p / ul / table / ...) ----------
        const text = extractElementText($, el);
        if (!text) continue;

        if (!currentBlockId) {
          // текст до первого H2 → описание темы
          const arr = topicIntroParts.get(currentTopicId) || [];
          arr.push(text);
          topicIntroParts.set(currentTopicId, arr);
        } else {
          // текст внутри блока
          const arr = blockTextParts.get(currentBlockId) || [];
          arr.push(text);
          blockTextParts.set(currentBlockId, arr);
        }
      }
    }

    // 3) Записываем описания в БД

    console.log("✏ Заполняю описания тем...");
    for (const [topicId, parts] of topicIntroParts.entries()) {
      const desc = parts.join("\n\n"); // абзацы разделяем пустой строкой
      await client.query("UPDATE topics SET description = $1 WHERE id = $2", [
        desc,
        topicId,
      ]);
    }

    console.log("✏ Заполняю описания блоков...");
    for (const [blockId, parts] of blockTextParts.entries()) {
      const desc = parts.join("\n\n");
      await client.query("UPDATE blocks SET description = $1 WHERE id = $2", [
        desc,
        blockId,
      ]);
    }

    await client.query("COMMIT");
    console.log("🎉 Импорт по заголовкам завершён успешно!");
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
