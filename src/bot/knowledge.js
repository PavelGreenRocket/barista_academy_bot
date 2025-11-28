// src/bot/knowledge.js

const pool = require("../db/pool");
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

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (!normA || !normB) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Ищем самые релевантные фрагменты теории по вопросу.
 * Возвращаем массив [{ id, source, text, score }, ...]
 */
async function getRelevantChunks(question, limit = 5) {
  // эмбеддинг вопроса
  const [qVec] = await embeddingsClient.embedDocuments([question]);

  const res = await pool.query(
    `
      SELECT id, source, chunk_index, text, embedding
      FROM knowledge_chunks
      WHERE embedding IS NOT NULL
    `
  );

  if (!res.rows.length) {
    return [];
  }

  const scored = [];

  for (const row of res.rows) {
    const emb = row.embedding; // jsonb → уже JS-массив
    if (!Array.isArray(emb)) continue;
    const score = cosineSimilarity(qVec, emb);
    if (score <= 0) continue;
    scored.push({
      id: row.id,
      source: row.source,
      text: row.text,
      score,
    });
  }

  // сортируем по убыванию похожести
  scored.sort((a, b) => b.score - a.score);

  // можно отсечь совсем слабые совпадения
  const filtered = scored.filter((x) => x.score > 0.2);

  return (filtered.length ? filtered : scored).slice(0, limit);
}

module.exports = {
  getRelevantChunks,
};
