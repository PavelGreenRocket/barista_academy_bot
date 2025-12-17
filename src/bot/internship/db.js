// src/internship/db.js
"use strict";

const pool = require("../../db/pool");

/**
 * DB helpers для стажировки.
 * Вынесены из internship.js без изменения поведения.
 */

// активная сессия стажировки по тренеру (для кнопки в главном меню)
async function hasActiveInternshipSessionForTrainer(trainerUserId) {
  const res = await pool.query(
    `
    SELECT 1
    FROM internship_sessions
    WHERE started_by = $1
      AND finished_at IS NULL
      AND is_canceled = FALSE
    LIMIT 1
  `,
    [trainerUserId]
  );
  return res.rows.length > 0;
}

// активная сессия по пользователю
async function getActiveSessionForUser(userId) {
  const res = await pool.query(
    `
    SELECT *
    FROM internship_sessions
    WHERE user_id = $1
      AND finished_at IS NULL
      AND is_canceled = FALSE
    ORDER BY started_at DESC
    LIMIT 1
  `,
    [userId]
  );
  return res.rows[0] || null;
}

// части + разделы + этапы (этапы строго внутри разделов)
async function getPartsWithSteps() {
  const res = await pool.query(
    `
    SELECT
      p.id AS part_id,
      p.title AS part_title,
      p.order_index AS part_order,
      p.doc_file_id,

      sec.id AS section_id,
      sec.title AS section_title,
      sec.order_index AS section_order,
      sec.telegraph_url AS section_telegraph_url,
      sec.duration_days AS section_duration_days,

      st.id AS step_id,
      st.title AS step_title,
      st.step_type,
      st.order_index AS step_order,
      st.planned_duration_min
    FROM internship_parts p
    LEFT JOIN internship_sections sec
      ON sec.part_id = p.id
    LEFT JOIN internship_steps st
      ON st.section_id = sec.id
    ORDER BY
      p.order_index, p.id,
      sec.order_index, sec.id,
      st.order_index, st.id
  `
  );

  const partsMap = new Map();

  for (const row of res.rows) {
    let part = partsMap.get(row.part_id);
    if (!part) {
      part = {
        id: row.part_id,
        title: row.part_title,
        order_index: row.part_order,
        doc_file_id: row.doc_file_id,
        // новый источник истины
        sections: [],
        // для обратной совместимости по коду ниже: плоский список этапов части
        steps: [],
      };
      partsMap.set(row.part_id, part);
    }

    // section
    if (row.section_id) {
      let sec = part.sections.find((s) => s.id === row.section_id);
      if (!sec) {
        sec = {
          id: row.section_id,
          title: row.section_title,
          order_index: row.section_order,
          telegraph_url: row.section_telegraph_url,
          duration_days: row.section_duration_days,
          steps: [],
        };
        part.sections.push(sec);
      }

      // step
      if (row.step_id) {
        const stepObj = {
          id: row.step_id,
          title: row.step_title,
          type: row.step_type,
          step_type: row.step_type,
          order_index: row.step_order,
          planned_duration_min: row.planned_duration_min,
          section_id: row.section_id,
        };
        sec.steps.push(stepObj);
        part.steps.push(stepObj);
      }
    }
  }

  // сортировка на случай NULL order_index
  for (const part of partsMap.values()) {
    part.sections.sort(
      (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id
    );
    for (const sec of part.sections) {
      sec.steps.sort(
        (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id
      );
    }
    part.steps.sort(
      (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id
    );
  }

  return [...partsMap.values()];
}

// мапа step_id → состояние по сессии
async function getSessionStepMap(sessionId) {
  const res = await pool.query(
    `
    SELECT
      r.step_id,
      r.is_passed,
      r.checked_at,
      u.full_name AS checked_by_name
    FROM internship_step_results r
    LEFT JOIN users u ON u.id = r.checked_by
    WHERE r.session_id = $1
  `,
    [sessionId]
  );

  const map = new Map();
  for (const row of res.rows) {
    map.set(row.step_id, {
      is_passed: row.is_passed,
      checked_at: row.checked_at,
      checked_by_name: row.checked_by_name,
    });
  }
  return map;
}

// мапа step_id → самое "свежее" состояние по ВСЕМ неотменённым сессиям пользователя
async function getUserOverallStepMap(userId) {
  const res = await pool.query(
    `
    SELECT DISTINCT ON (r.step_id)
      r.step_id,
      r.is_passed,
      r.checked_at,
      r.session_id,
      u.full_name AS checked_by_name
    FROM internship_step_results r
    JOIN internship_sessions s ON s.id = r.session_id
    LEFT JOIN users u ON u.id = r.checked_by
    WHERE s.user_id = $1
      AND (s.is_canceled IS NULL OR s.is_canceled = FALSE)
    ORDER BY r.step_id, r.is_passed DESC, r.checked_at DESC
  `,
    [userId]
  );

  const map = new Map();
  for (const row of res.rows) {
    map.set(row.step_id, {
      is_passed: row.is_passed,
      checked_at: row.checked_at,
      checked_by_name: row.checked_by_name,
      session_id: row.session_id,
    });
  }
  return map;
}

// прогресс по этапам стажировки по всем неотменённым дням пользователя
async function getUserStepProgressAcrossSessions(userId) {
  // Берём только неотменённые дни
  const sessRes = await pool.query(
    `
    SELECT id
    FROM internship_sessions
    WHERE user_id = $1 AND (is_canceled IS NULL OR is_canceled = FALSE)
  `,
    [userId]
  );
  const sessionIds = sessRes.rows.map((r) => r.id);

  const map = new Map();
  if (!sessionIds.length) return map;

  const res = await pool.query(
    `
    SELECT step_id, bool_or(is_passed) AS is_passed
    FROM internship_step_results
    WHERE session_id = ANY($1::int[])
    GROUP BY step_id
  `,
    [sessionIds]
  );

  for (const row of res.rows) {
    map.set(row.step_id, row.is_passed);
  }

  return map;
}

function formatDurationMs(ms) {
  if (!ms || ms <= 0) return "-";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (!hours && !minutes) return "< 1 мин";
  if (!hours) return `${minutes} мин`;
  return `${hours} ч ${minutes} мин`;
}

// ---------- helpers для админских reorder-режимов ----------

const __colExistsCache = new Map(); // key: "table.column" -> boolean
async function columnExists(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (__colExistsCache.has(key)) return __colExistsCache.get(key);

  const res = await pool.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );

  const ok = res.rows.length > 0;
  __colExistsCache.set(key, ok);
  return ok;
}

/**
 * swap order_index между текущим и соседом (надежнее, чем +/- 1)
 * dir: "up" => ищем соседа с меньшим order_index
 * dir: "down" => с большим
 */
async function swapOrderIndex({ table, id, scopeWhereSql, scopeParams, dir }) {
  const curRes = await pool.query(
    `SELECT id, order_index FROM ${table} WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!curRes.rows.length) return false;

  const cur = curRes.rows[0];
  const curIdx = Number(cur.order_index ?? 0);

  const op = dir === "up" ? "<" : ">";
  const order = dir === "up" ? "DESC" : "ASC";

  const neighborRes = await pool.query(
    `
      SELECT id, order_index
      FROM ${table}
      WHERE ${scopeWhereSql}
        AND order_index ${op} $${scopeParams.length + 1}
      ORDER BY order_index ${order}, id ${order}
      LIMIT 1
    `,
    [...scopeParams, curIdx]
  );

  if (!neighborRes.rows.length) return false;

  const nb = neighborRes.rows[0];

  // swap
  await pool.query(`UPDATE ${table} SET order_index = $1 WHERE id = $2`, [
    nb.order_index,
    cur.id,
  ]);
  await pool.query(`UPDATE ${table} SET order_index = $1 WHERE id = $2`, [
    cur.order_index,
    nb.id,
  ]);

  return true;
}

// next order_index для нового раздела внутри части
async function getNextSectionOrderIndex(partId) {
  const maxRes = await pool.query(
    `SELECT COALESCE(MAX(order_index), 0) AS max
     FROM internship_sections
     WHERE part_id = $1`,
    [partId]
  );
  return Number(maxRes.rows[0]?.max || 0) + 1;
}

// next order_index для нового этапа внутри раздела
async function getNextStepOrderIndex(sectionId) {
  const maxRes = await pool.query(
    `SELECT COALESCE(MAX(order_index), 0) AS max
     FROM internship_steps
     WHERE section_id = $1`,
    [sectionId]
  );
  return Number(maxRes.rows[0]?.max || 0) + 1;
}

module.exports = {
  // shared pool (иногда удобно, но можно не использовать напрямую)
  pool,

  // sessions
  hasActiveInternshipSessionForTrainer,
  getActiveSessionForUser,

  // structure
  getPartsWithSteps,

  // step maps / progress
  getSessionStepMap,
  getUserOverallStepMap,
  getUserStepProgressAcrossSessions,

  // utils
  formatDurationMs,

  // schema + ordering helpers
  columnExists,
  swapOrderIndex,
  getNextSectionOrderIndex,
  getNextStepOrderIndex,
};
