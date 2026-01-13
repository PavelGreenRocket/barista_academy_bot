// src/bot/attest.js
// Академия: настройка групп и элементов аттестации (админ)
// ВАЖНО: здесь только настройка (создание/редактирование/тип/пример/перемещение/порядок)

const pool = require("../db/pool");
const { Markup } = require("telegraf");

// ----- state -----
const stateByTg = new Map();
// { step, groupId?, itemId?, tempTitle?, tempReward?, tempType? , returnTo? }

function setState(tgId, s) { stateByTg.set(tgId, s); }
function getState(tgId) { return stateByTg.get(tgId); }
function clearState(tgId) { stateByTg.delete(tgId); }

function isAdminRole(role) {
  return role === "admin" || role === "super_admin";
}

async function ensureDefaultGroupAndItems() {
  // ensure at least one group exists
  const g = await pool.query(
    `SELECT id FROM attestation_groups ORDER BY order_index, id LIMIT 1`
  );
  let groupId = g.rows[0]?.id;
  if (!groupId) {
    const ins = await pool.query(
      `INSERT INTO attestation_groups(title, reward_text, order_index, is_active)
       VALUES ('группа 1', NULL, 0, TRUE)
       RETURNING id`
    );
    groupId = ins.rows[0].id;
  }

  // add columns might not exist before migration; ignore errors gracefully
  // ensure default items exist
  const defaults = [
    { title: "📖 техкарта", key: "techcard" },
    { title: "📘 теория база", key: "theory_basic" },
    { title: "📕 теория продвинутый", key: "theory_adv" },
    { title: "🗣️ Коммуникация с клиентами", key: "communication" },
    { title: "🌱 курс стажировки", key: "internship_course" },
  ];

  for (let i = 0; i < defaults.length; i++) {
    const d = defaults[i];
    const exists = await pool.query(
      `SELECT id FROM attestation_items WHERE title=$1 LIMIT 1`,
      [d.title]
    );
    if (!exists.rows[0]) {
      // try insert with new columns if present
      try {
        await pool.query(
          `INSERT INTO attestation_items(title, description, order_index, is_active, is_default, item_type, group_id)
           VALUES ($1, NULL, $2, TRUE, TRUE, 'normal', $3)`,
          [d.title, i, groupId]
        );
      } catch (e) {
        // fallback old schema
        await pool.query(
          `INSERT INTO attestation_items(title, description, order_index, is_active)
           VALUES ($1, NULL, $2, TRUE)`,
          [d.title, i]
        );
      }
    }
  }

  // attach existing items without group to groupId
  try {
    await pool.query(
      `UPDATE attestation_items SET group_id=$1 WHERE group_id IS NULL`,
      [groupId]
    );
  } catch (e) {}
}

async function fetchGroups() {
  const r = await pool.query(
    `SELECT id, title, reward_text, order_index, COALESCE(is_active, true) AS is_active
     FROM attestation_groups
     ORDER BY order_index, id`
  );
  return r.rows;
}

async function fetchGroup(groupId) {
  const r = await pool.query(
    `SELECT id, title, reward_text, order_index, COALESCE(is_active, true) AS is_active
     FROM attestation_groups WHERE id=$1`,
    [groupId]
  );
  return r.rows[0] || null;
}

async function fetchItemsByGroup(groupId) {
  // show active+inactive in admin
  let q = `
    SELECT id, title, description, order_index, is_active,
           COALESCE(is_default,false) AS is_default,
           COALESCE(item_type,'normal') AS item_type,
           example_file_id, example_file_type,
           group_id
    FROM attestation_items
    WHERE group_id=$1
    ORDER BY order_index, id`;
  const r = await pool.query(q, [groupId]);
  return r.rows;
}

async function fetchItem(itemId) {
  const r = await pool.query(
    `SELECT id, title, description, order_index, is_active,
            COALESCE(is_default,false) AS is_default,
            COALESCE(item_type,'normal') AS item_type,
            example_file_id, example_file_type,
            group_id
     FROM attestation_items WHERE id=$1`,
    [itemId]
  );
  return r.rows[0] || null;
}

function backBtn(cb) {
  return Markup.button.callback("⬅️ Назад", cb);
}

// ----- UI -----
async function showGroups(ctx, { edit=true } = {}) {
  const groups = await fetchGroups();
  let text = `🔧 Группы аттестации\n\nВыберите группу для настройки:`;

  const rows = [];
  for (const g of groups) {
    const activeMark = g.is_active ? "" : "🚫 ";
    rows.push([Markup.button.callback(`${activeMark}${g.title}`, `admin_attest_group_${g.id}`)]);
  }
  rows.push([
    Markup.button.callback("🔁 Изменить последовательность", "admin_attest_groups_reorder"),
  ]);
  rows.push([Markup.button.callback("➕ Добавить группу", "admin_attest_group_add")]);
  rows.push([Markup.button.callback("⬅️ В настройки", "admin_settings")]);

  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) return ctx.editMessageText(text, { parse_mode: "HTML", ...keyboard });
  return ctx.reply(text, { parse_mode: "HTML", ...keyboard });
}

async function showGroupSettings(ctx, groupId, { edit=true } = {}) {
  const g = await fetchGroup(groupId);
  if (!g) return;

  const reward = (g.reward_text && String(g.reward_text).trim()) ? g.reward_text : "не указано";
  const activeLine = g.is_active ? "Активна ✅" : "Скрыта 🚫";

  const text =
    `🔧 Группа аттестации\n\n` +
    `Название: <b>${g.title}</b>\n` +
    `Статус: ${activeLine}\n` +
    `💰 Вознаграждение: ${reward}\n\n` +
    `Здесь можно настроить элементы внутри группы, переименовать группу, изменить вознаграждение и порядок.`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("📋 Элементы аттестации группы", `admin_attest_group_items_${groupId}`)],
    [Markup.button.callback("✏️ Изменить имя группы", `admin_attest_group_rename_${groupId}`)],
    [Markup.button.callback("💰 Изменить вознаграждение", `admin_attest_group_reward_${groupId}`)],
    [Markup.button.callback(g.is_active ? "🚫 Скрыть группу" : "✅ Показать группу", `admin_attest_group_toggle_${groupId}`)],
    [Markup.button.callback("🗑️ Удалить группу", `admin_attest_group_delete_${groupId}`)],
    [backBtn("admin_attest_menu")],
  ]);

  if (edit) return ctx.editMessageText(text, { parse_mode: "HTML", ...kb });
  return ctx.reply(text, { parse_mode: "HTML", ...kb });
}

async function showGroupItems(ctx, groupId, { edit=true } = {}) {
  await ensureDefaultGroupAndItems();
  const g = await fetchGroup(groupId);
  const items = await fetchItemsByGroup(groupId);
  if (!g) return;

  const text = `✅ Элементы аттестации группы\n\n<b>${g.title}</b>\n\nВыберите элемент:`;

  const rows = [];
  for (const it of items) {
    const icon = it.is_active ? "✅" : "🚫";
    rows.push([Markup.button.callback(`${icon} ${it.title}`, `admin_attest_item_${it.id}`)]);
  }
  rows.push([Markup.button.callback("➕ Новый элемент", `admin_attest_item_add_${groupId}`)]);
  rows.push([backBtn(`admin_attest_group_${groupId}`)]);
  const kb = Markup.inlineKeyboard(rows);
  if (edit) return ctx.editMessageText(text, { parse_mode: "HTML", ...kb });
  return ctx.reply(text, { parse_mode: "HTML", ...kb });
}

async function showItem(ctx, itemId, { edit=true } = {}) {
  const it = await fetchItem(itemId);
  if (!it) return;
  const status = it.is_active ? "Активен ✅" : "Выключен 🚫";
  const type = it.item_type === "photo" ? "Фото" : it.item_type === "video" ? "Видео" : "Обычный";
  const isDefault = it.is_default;

  let text =
    `✅ Элемент аттестации\n\n` +
    `Название: ${it.title}\n` +
    `Статус: ${status}\n` +
    `Тип: ${type}`;

  if (!isDefault && it.description) {
    text += `\n\nОписание:\n${it.description}`;
  }

  const rows = [];
  // default items: only toggle + move group
  if (!isDefault) {
    rows.push([Markup.button.callback("✏️ Название", `admin_attest_item_rename_${itemId}`)]);
    rows.push([Markup.button.callback("📝 Описание", `admin_attest_item_desc_${itemId}`)]);
    rows.push([Markup.button.callback("🔧 Тип", `admin_attest_item_type_${itemId}`)]);
    if (it.item_type === "photo" || it.item_type === "video") {
      rows.push([Markup.button.callback("🧩 Пример", `admin_attest_item_example_${itemId}`)]);
    }
    rows.push([Markup.button.callback("🗑️ Удалить", `admin_attest_item_delete_${itemId}`)]);
  }
  rows.push([Markup.button.callback("📦 Переместить в группу", `admin_attest_item_move_${itemId}`)]);
  rows.push([Markup.button.callback("👁️ Вкл/Выкл", `admin_attest_item_toggle_${itemId}`)]);
  rows.push([backBtn(`admin_attest_group_items_${it.group_id}`)]);

  const kb = Markup.inlineKeyboard(rows);
  if (edit) return ctx.editMessageText(text, { parse_mode: "HTML", ...kb });
  return ctx.reply(text, { parse_mode: "HTML", ...kb });
}

// ----- register -----
function registerAttest(bot, ensureUser, logError) {
  // entry from settings menu
  bot.action("admin_attest_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const me = await ensureUser(ctx);
      if (!isAdminRole(me.role)) return;
      await ensureDefaultGroupAndItems();
      await showGroups(ctx);
    } catch (e) {
      logError("admin_attest_menu", e);
    }
  });

  bot.action(/^admin_attest_group_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const me = await ensureUser(ctx);
      if (!isAdminRole(me.role)) return;
      await showGroupSettings(ctx, Number(ctx.match[1]));
    } catch (e) { logError("admin_attest_group_x", e); }
  });

  bot.action(/^admin_attest_group_items_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const me = await ensureUser(ctx);
      if (!isAdminRole(me.role)) return;
      await showGroupItems(ctx, Number(ctx.match[1]));
    } catch (e) { logError("admin_attest_group_items_x", e); }
  });

  // add group flow
  bot.action("admin_attest_group_add", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const me = await ensureUser(ctx);
      if (!isAdminRole(me.role)) return;
      setState(ctx.from.id, { step: "group_name" });
      await ctx.editMessageText(
        "➕ Добавить группу\n\nОтправь название группы одним сообщением.",
        Markup.inlineKeyboard([[backBtn("admin_attest_menu")]])
      );
    } catch (e) { logError("admin_attest_group_add", e); }
  });

  bot.on("text", async (ctx, next) => {
    const st = getState(ctx.from.id);
    if (!st) return next();

    try {
      const me = await ensureUser(ctx);
      if (!isAdminRole(me.role)) { clearState(ctx.from.id); return; }

      const msg = (ctx.message.text || "").trim();

      if (st.step === "group_name") {
        const title = msg.slice(0, 80);
        setState(ctx.from.id, { step: "group_reward", tempTitle: title });
        await ctx.reply(
          "💰 Добавьте вознаграждение за выполнение группы (до 50 символов)\n\nОтправь текст одним сообщением или нажми «указать позже».",
          Markup.inlineKeyboard([
            [Markup.button.callback("⏭️ Указать позже", "admin_attest_group_reward_skip")],
            [Markup.button.callback("⬅️ Назад", "admin_attest_menu")],
          ])
        );
        return;
      }

      if (st.step === "group_reward") {
        const reward = msg.slice(0, 50);
        const title = st.tempTitle || "группа";
        const maxOrdRes = await pool.query(
          `SELECT COALESCE(MAX(order_index),0)::int AS mx FROM attestation_groups`
        );
        const ord = (maxOrdRes.rows[0]?.mx || 0) + 1;
        const ins = await pool.query(
          `INSERT INTO attestation_groups(title, reward_text, order_index, is_active)
           VALUES ($1,$2,$3,TRUE) RETURNING id`,
          [title, reward, ord]
        );
        clearState(ctx.from.id);
        await showGroupSettings(ctx, ins.rows[0].id, { edit:false });
        return;
      }

      if (st.step === "group_rename") {
        const title = msg.slice(0, 80);
        await pool.query(`UPDATE attestation_groups SET title=$2 WHERE id=$1`, [st.groupId, title]);
        clearState(ctx.from.id);
        await showGroupSettings(ctx, st.groupId, { edit:false });
        return;
      }

      if (st.step === "group_reward_edit") {
        const reward = msg === "-" ? null : msg.slice(0, 50);
        await pool.query(`UPDATE attestation_groups SET reward_text=$2 WHERE id=$1`, [st.groupId, reward]);
        clearState(ctx.from.id);
        await showGroupSettings(ctx, st.groupId, { edit:false });
        return;
      }

      if (st.step === "item_rename") {
        await pool.query(`UPDATE attestation_items SET title=$2 WHERE id=$1`, [st.itemId, msg.slice(0,120)]);
        clearState(ctx.from.id);
        await showItem(ctx, st.itemId, { edit:false });
        return;
      }

      if (st.step === "item_desc") {
        await pool.query(`UPDATE attestation_items SET description=$2 WHERE id=$1`, [st.itemId, msg.slice(0,2000)]);
        clearState(ctx.from.id);
        await showItem(ctx, st.itemId, { edit:false });
        return;
      }

      if (st.step === "item_add_title") {
        const title = msg.slice(0,120);
        setState(ctx.from.id, { step: "item_add_type", groupId: st.groupId, tempTitle: title });
        await ctx.reply(
          "Выберите тип элемента:",
          Markup.inlineKeyboard([
            [Markup.button.callback("Обычный", `admin_attest_item_add_type_${st.groupId}_normal`)],
            [Markup.button.callback("Фото", `admin_attest_item_add_type_${st.groupId}_photo`)],
            [Markup.button.callback("Видео", `admin_attest_item_add_type_${st.groupId}_video`)],
            [Markup.button.callback("⬅️ Назад", `admin_attest_group_items_${st.groupId}`)],
          ])
        );
        return;
      }

      if (st.step === "item_example_wait") {
        // expected type stored in st.expected
        if (msg === "-") {
          await pool.query(
            `UPDATE attestation_items SET example_file_id=NULL, example_file_type=NULL WHERE id=$1`,
            [st.itemId]
          );
          clearState(ctx.from.id);
          await showItem(ctx, st.itemId, { edit:false });
          return;
        }
        await ctx.reply("Отправь файл (фото/видео) или '-' чтобы убрать пример.");
        return;
      }
    } catch (e) {
      logError("admin_attest_text_flow", e);
      clearState(ctx.from.id);
    }
  });

  bot.action("admin_attest_group_reward_skip", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const st=getState(ctx.from.id);
      if (!st || st.step!=="group_reward") return;
      const title = st.tempTitle || "группа";
      const maxOrdRes = await pool.query(`SELECT COALESCE(MAX(order_index),0)::int AS mx FROM attestation_groups`);
      const ord = (maxOrdRes.rows[0]?.mx || 0) + 1;
      const ins = await pool.query(
        `INSERT INTO attestation_groups(title, reward_text, order_index, is_active)
         VALUES ($1,NULL,$2,TRUE) RETURNING id`,
        [title, ord]
      );
      clearState(ctx.from.id);
      await showGroupSettings(ctx, ins.rows[0].id);
    } catch(e){ logError("admin_attest_group_reward_skip", e); }
  });

  bot.action(/^admin_attest_group_rename_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const gid=Number(ctx.match[1]);
      setState(ctx.from.id,{step:"group_rename", groupId:gid});
      await ctx.editMessageText(
        "✏️ Изменить имя группы\n\nОтправь новое имя одним сообщением.",
        Markup.inlineKeyboard([[backBtn(`admin_attest_group_${gid}`)]])
      );
    }catch(e){ logError("admin_attest_group_rename_x", e); }
  });

  bot.action(/^admin_attest_group_reward_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const gid=Number(ctx.match[1]);
      setState(ctx.from.id,{step:"group_reward_edit", groupId:gid});
      await ctx.editMessageText(
        "💰 Изменить вознаграждение\n\nОтправь текст (до 50 символов) одним сообщением.\nОтправь '-' чтобы убрать.",
        Markup.inlineKeyboard([[backBtn(`admin_attest_group_${gid}`)]])
      );
    }catch(e){ logError("admin_attest_group_reward_x", e); }
  });

  bot.action(/^admin_attest_group_toggle_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const gid=Number(ctx.match[1]);
      await pool.query(`UPDATE attestation_groups SET is_active = NOT COALESCE(is_active, true) WHERE id=$1`,[gid]);
      await showGroupSettings(ctx, gid);
    }catch(e){ logError("admin_attest_group_toggle_x", e); }
  });

  bot.action(/^admin_attest_group_delete_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const gid=Number(ctx.match[1]);
      const items=await fetchItemsByGroup(gid);
      const defaults = items.filter(x=>x.is_default);
      if (defaults.length){
        const text =
          `Нельзя удалить группу, пока в ней находятся элементы, установленные по умолчанию:\n\n` +
          defaults.map(x=>`• ${x.title}`).join("\n") +
          `\n\nПереместите их в другую группу и попробуйте снова.`;
        return ctx.editMessageText(text, Markup.inlineKeyboard([[backBtn(`admin_attest_group_${gid}`)]]));
      }

      const names = items.map(x=>`• ${x.title}`).join("\n") || "—";
      const text =
        `🗑️ Удалить группу?\n\n` +
        `Будут удалены все элементы внутри группы:\n${names}\n\n` +
        `Подтвердить удаление?`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("✅ Удалить", `admin_attest_group_delete_yes_${gid}`)],
        [backBtn(`admin_attest_group_${gid}`)],
      ]);
      await ctx.editMessageText(text, kb);
    }catch(e){ logError("admin_attest_group_delete_x", e); }
  });

  bot.action(/^admin_attest_group_delete_yes_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const gid=Number(ctx.match[1]);
      await pool.query(`DELETE FROM attestation_items WHERE group_id=$1 AND COALESCE(is_default,false)=false`,[gid]);
      await pool.query(`DELETE FROM attestation_groups WHERE id=$1`,[gid]);
      await showGroups(ctx);
    }catch(e){ logError("admin_attest_group_delete_yes_x", e); }
  });

  // reorder groups
  bot.action("admin_attest_groups_reorder", async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const groups=await fetchGroups();
      const rows=[];
      for (const g of groups){
        rows.push([
          Markup.button.callback(g.title, "noop"),
          Markup.button.callback("⬆️", `admin_attest_group_up_${g.id}`),
          Markup.button.callback("⬇️", `admin_attest_group_down_${g.id}`),
        ]);
      }
      rows.push([Markup.button.callback("✅ Закончить изменение порядка", "admin_attest_menu")]);
      const text =
        "Группы (режим изменения порядка):\n\nНажимай стрелки рядом с группами, затем вернись в обычный список.";
      await ctx.editMessageText(text, Markup.inlineKeyboard(rows));
    }catch(e){ logError("admin_attest_groups_reorder", e); }
  });

  async function swapGroupOrder(idA, idB){
    const a=await fetchGroup(idA); const b=await fetchGroup(idB);
    if(!a||!b) return;
    await pool.query(`UPDATE attestation_groups SET order_index=$2 WHERE id=$1`,[a.id, b.order_index]);
    await pool.query(`UPDATE attestation_groups SET order_index=$2 WHERE id=$1`,[b.id, a.order_index]);
  }

  bot.action(/^admin_attest_group_up_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const gid=Number(ctx.match[1]);
      const groups=await fetchGroups();
      const idx=groups.findIndex(x=>x.id===gid);
      if(idx>0){
        await swapGroupOrder(groups[idx].id, groups[idx-1].id);
      }
      await bot.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.callbackQuery.message.message_id, null, null).catch(()=>{});
      // re-render reorder screen
      await ctx.deleteMessage().catch(()=>{});
      // easiest: call reorder again
      await showGroups(ctx,{edit:false});
      await ctx.reply("Порядок обновлён. Открой «🔁 Изменить последовательность» ещё раз, если нужно продолжить.");
    }catch(e){ logError("admin_attest_group_up_x", e); }
  });

  bot.action(/^admin_attest_group_down_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const gid=Number(ctx.match[1]);
      const groups=await fetchGroups();
      const idx=groups.findIndex(x=>x.id===gid);
      if(idx>=0 && idx<groups.length-1){
        await swapGroupOrder(groups[idx].id, groups[idx+1].id);
      }
      await ctx.deleteMessage().catch(()=>{});
      await showGroups(ctx,{edit:false});
      await ctx.reply("Порядок обновлён. Открой «🔁 Изменить последовательность» ещё раз, если нужно продолжить.");
    }catch(e){ logError("admin_attest_group_down_x", e); }
  });

  // item list -> open item
  bot.action(/^admin_attest_item_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      await showItem(ctx, Number(ctx.match[1]));
    }catch(e){ logError("admin_attest_item_x", e); }
  });

  // add item inside group
  bot.action(/^admin_attest_item_add_(\d+)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const gid=Number(ctx.match[1]);
      setState(ctx.from.id,{step:"item_add_title", groupId:gid});
      await ctx.editMessageText(
        "➕ Новый элемент\n\nОтправь название элемента одним сообщением.",
        Markup.inlineKeyboard([[backBtn(`admin_attest_group_items_${gid}`)]])
      );
    }catch(e){ logError("admin_attest_item_add_x", e); }
  });

  bot.action(/^admin_attest_item_add_type_(\d+)_(normal|photo|video)$/, async (ctx) => {
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const st=getState(ctx.from.id);
      const gid=Number(ctx.match[1]);
      const t=ctx.match[2];
      if(!st || st.step!=="item_add_type" || st.groupId!==gid) return;
      const title=st.tempTitle || "элемент";
      const mx=await pool.query(
        `SELECT COALESCE(MAX(order_index),0)::int AS mx FROM attestation_items WHERE group_id=$1`,
        [gid]
      );
      const ord=(mx.rows[0]?.mx||0)+1;
      const ins=await pool.query(
        `INSERT INTO attestation_items(title, description, order_index, is_active, is_default, item_type, group_id)
         VALUES ($1,NULL,$2,TRUE,FALSE,$3,$4) RETURNING id`,
        [title, ord, t, gid]
      );
      clearState(ctx.from.id);
      await showItem(ctx, ins.rows[0].id);
    }catch(e){ logError("admin_attest_item_add_type_x", e); }
  });

  // item rename/desc/type/toggle/delete
  bot.action(/^admin_attest_item_rename_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const id=Number(ctx.match[1]);
      const it=await fetchItem(id);
      if(!it || it.is_default) return;
      setState(ctx.from.id,{step:"item_rename", itemId:id});
      await ctx.editMessageText(
        "✏️ Новое название (одним сообщением):",
        Markup.inlineKeyboard([[backBtn(`admin_attest_item_${id}`)]])
      );
    }catch(e){ logError("admin_attest_item_rename_x", e); }
  });

  bot.action(/^admin_attest_item_desc_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const id=Number(ctx.match[1]);
      const it=await fetchItem(id);
      if(!it || it.is_default) return;
      setState(ctx.from.id,{step:"item_desc", itemId:id});
      await ctx.editMessageText(
        "📝 Отправь описание одним сообщением:",
        Markup.inlineKeyboard([[backBtn(`admin_attest_item_${id}`)]])
      );
    }catch(e){ logError("admin_attest_item_desc_x", e); }
  });

  bot.action(/^admin_attest_item_type_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const id=Number(ctx.match[1]);
      const it=await fetchItem(id);
      if(!it || it.is_default) return;
      await ctx.editMessageText(
        "🔧 Выберите тип:",
        Markup.inlineKeyboard([
          [Markup.button.callback("Обычный", `admin_attest_item_set_type_${id}_normal`)],
          [Markup.button.callback("Фото", `admin_attest_item_set_type_${id}_photo`)],
          [Markup.button.callback("Видео", `admin_attest_item_set_type_${id}_video`)],
          [backBtn(`admin_attest_item_${id}`)],
        ])
      );
    }catch(e){ logError("admin_attest_item_type_x", e); }
  });

  bot.action(/^admin_attest_item_set_type_(\d+)_(normal|photo|video)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const id=Number(ctx.match[1]);
      const t=ctx.match[2];
      const it=await fetchItem(id);
      if(!it || it.is_default) return;
      await pool.query(`UPDATE attestation_items SET item_type=$2 WHERE id=$1`,[id,t]);
      // if switch to normal, clear example fields
      if (t==="normal"){
        await pool.query(`UPDATE attestation_items SET example_file_id=NULL, example_file_type=NULL WHERE id=$1`,[id]);
      }
      await showItem(ctx,id);
    }catch(e){ logError("admin_attest_item_set_type_x", e); }
  });

  bot.action(/^admin_attest_item_toggle_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const id=Number(ctx.match[1]);
      await pool.query(`UPDATE attestation_items SET is_active = NOT is_active WHERE id=$1`,[id]);
      await showItem(ctx,id);
    }catch(e){ logError("admin_attest_item_toggle_x", e); }
  });

  bot.action(/^admin_attest_item_delete_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const id=Number(ctx.match[1]);
      const it=await fetchItem(id);
      if(!it || it.is_default) return;
      const text = `Удалить элемент «${it.title}»?`;
      await ctx.editMessageText(text, Markup.inlineKeyboard([
        [Markup.button.callback("✅ Удалить", `admin_attest_item_delete_yes_${id}`)],
        [backBtn(`admin_attest_item_${id}`)],
      ]));
    }catch(e){ logError("admin_attest_item_delete_x", e); }
  });

  bot.action(/^admin_attest_item_delete_yes_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const id=Number(ctx.match[1]);
      const it=await fetchItem(id);
      if(!it || it.is_default) return;
      await pool.query(`DELETE FROM attestation_items WHERE id=$1`,[id]);
      await showGroupItems(ctx, it.group_id);
    }catch(e){ logError("admin_attest_item_delete_yes_x", e); }
  });

  // example attach/remove
  bot.action(/^admin_attest_item_example_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const id=Number(ctx.match[1]);
      const it=await fetchItem(id);
      if(!it || it.is_default) return;
      if (!(it.item_type==="photo" || it.item_type==="video")){
        return showItem(ctx,id);
      }
      setState(ctx.from.id,{step:"item_example_wait", itemId:id, expected:it.item_type});
      await ctx.editMessageText(
        `🧩 Пример (${it.item_type==="photo"?"фото":"видео"})\n\nОтправь файл одним сообщением.\nОтправь '-' чтобы убрать пример.`,
        Markup.inlineKeyboard([[backBtn(`admin_attest_item_${id}`)]])
      );
    }catch(e){ logError("admin_attest_item_example_x", e); }
  });

  bot.on(["photo","video"], async (ctx, next)=>{
    const st=getState(ctx.from.id);
    if(!st || st.step!=="item_example_wait") return next();
    try{
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) { clearState(ctx.from.id); return; }
      const it=await fetchItem(st.itemId);
      if(!it) { clearState(ctx.from.id); return; }
      let fileId=null, fileType=null;
      if (ctx.message.photo){
        if (st.expected!=="photo") return ctx.reply("Ожидается видео.");
        fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
        fileType="photo";
      }
      if (ctx.message.video){
        if (st.expected!=="video") return ctx.reply("Ожидается фото.");
        fileId = ctx.message.video.file_id;
        fileType="video";
      }
      await pool.query(
        `UPDATE attestation_items SET example_file_id=$2, example_file_type=$3 WHERE id=$1`,
        [st.itemId, fileId, fileType]
      );
      clearState(ctx.from.id);
      await showItem(ctx, st.itemId, { edit:false });
    }catch(e){ logError("admin_attest_item_example_file", e); clearState(ctx.from.id); }
  });

  // move item to group
  bot.action(/^admin_attest_item_move_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const itemId=Number(ctx.match[1]);
      const groups=await fetchGroups();
      const rows=groups.map(g=>[Markup.button.callback(g.title, `admin_attest_item_move_to_${itemId}_${g.id}`)]);
      rows.push([backBtn(`admin_attest_item_${itemId}`)]);
      await ctx.editMessageText("📦 Выберите группу для перемещения:", Markup.inlineKeyboard(rows));
    }catch(e){ logError("admin_attest_item_move_x", e); }
  });

  bot.action(/^admin_attest_item_move_to_(\d+)_(\d+)$/, async (ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const me=await ensureUser(ctx);
      if(!isAdminRole(me.role)) return;
      const itemId=Number(ctx.match[1]);
      const gid=Number(ctx.match[2]);
      await pool.query(`UPDATE attestation_items SET group_id=$2 WHERE id=$1`,[itemId,gid]);
      await showItem(ctx,itemId);
    }catch(e){ logError("admin_attest_item_move_to_x", e); }
  });

  // noop
  bot.action("noop", async (ctx)=>ctx.answerCbQuery().catch(()=>{}));
}

module.exports = registerAttest;
