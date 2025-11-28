// src/tools/import_docx.js

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const mammoth = require("mammoth");
const { Agent } = require("node:https");
const { GigaChatEmbeddings } = require("langchain-gigachat");
const pool = require("../db/pool");

const httpsAgent = new Agent({
  rejectUnauthorized: false,
});

const embeddingsClient = new GigaChatEmbeddings({
  credentials: process.env.GIGACHAT_CREDENTIALS,
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  httpsAgent,
});

// простая косая проверка
async function main() {
  const [, , filePath, sourceNameArg, modeArg] = process.argv;

  if (!filePath) {
    console.error(
      "Использование: node src/tools/import_docx.js path/to/file.docx [sourceName] [--replace]"
    );
    process.exit(1);
  }

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error("Файл не найден:", absPath);
    process.exit(1);
  }

  const sourceName =
    sourceNameArg || path.basename(filePath, path.extname(filePath)); // имя файла без .docx
  const replace = modeArg === "--replace";

  console.log(`Источник: "${sourceName}"`);
  console.log(`Файл: ${absPath}`);
  if (replace) {
    console.log(
      "Режим: ЗАМЕНА (старые фрагменты этого источника будут удалены)"
    );
  }

  // читаем docx → в текст
  const { value: fullText } = await mammoth.extractRawText({ path: absPath });

  let chunks = fullText
    .split(/\n{2,}/) // делим по пустым строкам
    .map((t) => t.trim())
    .filter((t) => t.length > 40); // отбрасываем слишком короткое

  if (!chunks.length) {
    console.error("Не удалось выделить фрагменты текста из файла.");
    process.exit(1);
  }

  console.log(`Найдено фрагментов: ${chunks.length}`);

  // при replace сначала чистим старые записи для этого source
  if (replace) {
    await pool.query("DELETE FROM knowledge_chunks WHERE source = $1", [
      sourceName,
    ]);
    console.log("Старые фрагменты для этого источника удалены.");
  }

  // генерируем эмбеддинги батчами
  const batchSize = 16;
  let globalIndex = 0;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    console.log(
      `Обрабатываем фрагменты ${i + 1}–${i + batch.length} из ${chunks.length}`
    );

    const vectors = await embeddingsClient.embedDocuments(batch);
    // vectors: массив массивов чисел

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
    `Готово! Импортировано ${globalIndex} фрагментов для источника "${sourceName}".`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Ошибка импорта:", err);
  process.exit(1);
});
