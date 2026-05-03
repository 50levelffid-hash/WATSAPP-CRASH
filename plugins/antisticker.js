// plugins/antisticker.js — AntiSticker group protection (same pattern as antilink)
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";

function getBotNum(conn) {
  const id = conn?.user?.id || conn?.user?.jid || "";
  return String(id).split("@")[0].split(":")[0];
}

function enabledKey(groupJid) { return `antisticker:${groupJid}:enabled`; }
function modeKey(groupJid)    { return `antisticker:${groupJid}:mode`; }
function warnKey(groupJid, num) { return `antisticker:${groupJid}:warn:${num}`; }
function maxWarnKey(groupJid) { return `antisticker:${groupJid}:maxwarn`; }

// ---------- Command ----------
Module({
  command: "antisticker",
  aliases: ["asticker"],
  package: "owner",
  description: "Prevent stickers in group. Modes: kick/delete/warn. .antisticker warn 3",
})(async (message, match) => {
  try {
    if (!(message.isFromMe || message.isfromMe)) return message.send("_Only bot owner can use this._");
    if (!message.isGroup) return message.send("❌ Groups only.");
    await message.loadGroupInfo?.();

    const botNum  = getBotNum(message.conn);
    const grpJid  = message.from;
    const raw     = (match || "").trim().toLowerCase();

    if (!raw) {
      const on   = db.get(botNum, enabledKey(grpJid), false) === true;
      const mode = db.get(botNum, modeKey(grpJid), "delete") || "delete";
      const max  = db.get(botNum, maxWarnKey(grpJid), 3);
      return message.send(
        `🎭 *AntiSticker*\n` +
        `• Status: ${on ? "✅ ON" : "❌ OFF"}\n` +
        `• Mode: *${String(mode).toUpperCase()}*\n` +
        (mode === "warn" ? `• Max Warns: *${max}*\n` : "") +
        `\nUsage:\n• .antisticker on/off\n• .antisticker kick\n• .antisticker delete\n• .antisticker warn\n• .antisticker warn 3`
      );
    }

    if (raw === "on") {
      db.setHot(botNum, enabledKey(grpJid), true);
      if (!db.get(botNum, modeKey(grpJid))) db.setHot(botNum, modeKey(grpJid), "delete");
      return message.send(`✅ AntiSticker *ENABLED*. Mode: *${String(db.get(botNum, modeKey(grpJid), "delete")).toUpperCase()}*`);
    }
    if (raw === "off") {
      db.setHot(botNum, enabledKey(grpJid), false);
      return message.send("✅ AntiSticker *DISABLED*.");
    }

    if (raw.startsWith("warn")) {
      const n = parseInt(raw.split(/\s+/)[1]);
      if (!isNaN(n) && n > 0) db.setHot(botNum, maxWarnKey(grpJid), n);
      db.setHot(botNum, modeKey(grpJid), "warn");
      db.setHot(botNum, enabledKey(grpJid), true);
      const max = db.get(botNum, maxWarnKey(grpJid), 3);
      return message.send(`✅ AntiSticker mode: *WARN* (max ${max} → kick). Enabled.`);
    }

    if (["kick","delete","null"].includes(raw)) {
      db.setHot(botNum, modeKey(grpJid), raw);
      db.setHot(botNum, enabledKey(grpJid), true);
      return message.send(`✅ AntiSticker mode: *${raw.toUpperCase()}*. Enabled.`);
    }

    return message.send("Usage: .antisticker on/off/kick/delete/warn/warn 3");
  } catch (e) {
    console.error("[antisticker][cmd]", e);
  }
});

// ---------- Enforcement ----------
Module({
  on: "text",
  package: "group",
  description: "AntiSticker enforcement",
})(async (message) => {
  try {
    if (!message?.isGroup) return;
    // Only trigger for sticker messages
    const isSticker = !!(
      message.msg?.stickerMessage ||
      message.message?.stickerMessage ||
      message.type === "stickerMessage"
    );
    if (!isSticker) return;

    const botNum = getBotNum(message.conn);
    const grpJid = message.from;

    if (db.get(botNum, enabledKey(grpJid), false) !== true) return;

    try { await message.loadGroupInfo?.(); } catch {}

    if (!message.isBotAdmin) return;
    if (message.isAdmin || message.isFromMe || message.isfromMe) return;

    const mode = String(db.get(botNum, modeKey(grpJid), "delete") || "delete").toLowerCase();

    // Delete sticker
    try { await message.conn.sendMessage(message.from, { delete: message.key }).catch(() => {}); } catch {}

    const senderJid = message.sender || message.key?.participant || null;
    const senderNum = senderJid ? String(senderJid).split("@")[0] : "unknown";

    if (mode === "delete" || mode === "null") {
      await message.send?.(`🎭 Sticker removed from @${senderNum}`, { mentions: senderJid ? [senderJid] : [] }).catch(() => {});
      return;
    }

    if (mode === "warn") {
      const max = db.get(botNum, maxWarnKey(grpJid), 3);
      const wk  = warnKey(grpJid, senderNum);
      const cur = (db.get(botNum, wk, 0) || 0) + 1;
      db.setHot(botNum, wk, cur);

      if (cur >= max) {
        db.setHot(botNum, wk, 0);
        await message.send?.(`🚫 @${senderNum} reached *${max}/${max}* sticker warnings. Removing.`, { mentions: senderJid ? [senderJid] : [] });
        await new Promise(r => setTimeout(r, 500));
        try {
          if (typeof message.removeParticipant === "function") await message.removeParticipant([senderJid]);
          else await message.conn.groupParticipantsUpdate(message.from, [senderJid], "remove");
        } catch {}
        return;
      }

      await message.send?.(
        `⚠️ @${senderNum}, stickers are not allowed!\n📊 *Warning ${cur}/${max}*`,
        { mentions: senderJid ? [senderJid] : [] }
      ).catch(() => {});
      return;
    }

    if (mode === "kick") {
      await message.send?.(`🚫 @${senderNum} sent a sticker and will be removed.`, { mentions: senderJid ? [senderJid] : [] });
      await new Promise(r => setTimeout(r, 500));
      try {
        if (typeof message.removeParticipant === "function") await message.removeParticipant([senderJid]);
        else await message.conn.groupParticipantsUpdate(message.from, [senderJid], "remove");
      } catch {}
    }
  } catch (e) {
    console.error("[antisticker][enforce]", e);
  }
});
