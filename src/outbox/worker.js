const pool = require("../db/pool");

async function processOutboxOnce(bot) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(
      `
      SELECT id, event_type, payload
      FROM outbox_events
      WHERE destination = 'academy'
        AND status = 'new'
      ORDER BY id
      LIMIT 10
      FOR UPDATE SKIP LOCKED
      `
    );

    if (!res.rows.length) {
      await client.query("COMMIT");
      return;
    }

    // помечаем processing
    const ids = res.rows.map((r) => r.id);
    await client.query(
      `
      UPDATE outbox_events
      SET status = 'processing'
      WHERE id = ANY($1::bigint[])
      `,
      [ids]
    );

    await client.query("COMMIT");

    // выполняем доставку вне транзакции
    for (const row of res.rows) {
      try {
        if (row.event_type === "internship_started") {
          const p = row.payload || {};
          const mentorTg = Number(p.mentor_telegram_id);
          const internUserId = Number(p.intern_user_id);
          const internName = p.intern_name || "стажёр";

          if (mentorTg && internUserId) {
            const text =
              `🚀 Обучение началось\n\n` +
              `Стажёр: ${internName}\n` +
              `Нажмите кнопку ниже, чтобы открыть курс.`;

            await bot.telegram.sendMessage(mentorTg, text, {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "📖 открыть курс",
                      callback_data: `admin_user_internship_${internUserId}`,
                    },
                  ],
                ],
              },
            });
          }
        }

        await pool.query(
          `
          UPDATE outbox_events
          SET status = 'done',
              processed_at = NOW(),
              error_text = NULL
          WHERE id = $1
          `,
          [row.id]
        );
      } catch (err) {
        await pool.query(
          `
          UPDATE outbox_events
          SET status = 'error',
              processed_at = NOW(),
              error_text = $2
          WHERE id = $1
          `,
          [row.id, String(err?.message || err)]
        );
      }
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

function startOutboxWorker(bot) {
  const intervalMs = Number(process.env.OUTBOX_POLL_MS || 1500);

  // маленький “тик”
  setInterval(() => {
    processOutboxOnce(bot).catch((e) =>
      console.error("[outbox_worker] error:", e)
    );
  }, intervalMs);
}

module.exports = { startOutboxWorker };
