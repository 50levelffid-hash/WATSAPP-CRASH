// plugins/antilink.js
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";

const DEBUG = false;
const debug = (...args) => DEBUG && console.debug("[antilink]", ...args);

const LINK_REGEX =
  /(?:https?:\/\/[^\s]+)|(?:chat\.whatsapp\.com\/[A-Za-z0-9_-]+)|(?:wa\.me\/[0-9]+)|(?:t\.me\/[A-Za-z0-9_\-]+)|(?:telegram\.me\/[A-Za-z0-9_\-]+)|(?:discord\.gg\/[A-Za-z0-9_\-]+)|(?:bit\.ly\/[A-Za-z0-9_\-]+)|(?:tinyurl\.com\/[A-Za-z0-9_\-]+)|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|xyz|me|app|online|site|link)\b/gi;

function getBotNumberFromConn(conn) {
  const id = conn?.user?.id || conn?.user?.jid || conn?.user || null;
  if (!id) return "unknown";
  return String(id).split("@")[0].split(":")[0];
}

function enabledKey(groupJid) { return `antilink:${groupJid}:enabled`; }
function modeKey(groupJid)    { return `antilink:${groupJid}:mode`; }
function warnCountKey(groupJid, senderNum) { return `antilink:${groupJid}:warn:${senderNum}`; }
function maxWarnKey(groupJid) { return `antilink:${groupJid}:maxwarn`; }

// ---------- Command handler ----------
Module({
  command: "antilink",
  package: "owner",
  description: "Anti-link for groups. Modes: kick/delete/null/warn. .antilink warn 3 (set max warns before kick)",
})(async (message, match) => {
  try {
    if (!(message.isFromMe || message.isfromMe)) {
      return message.send("_Only bot owner can use this command._");
    }
    if (!message.isGroup) return message.send("❌ This command works only in groups.");
    await message.loadGroupInfo?.();

    const botNumber = getBotNumberFromConn(message.conn);
    const groupJid  = message.from;
    const raw       = (match || "").trim().toLowerCase();

    // Show status
    if (!raw) {
      const isEnabled = db.get(botNumber, enabledKey(groupJid), false) === true;
      const mode      = String(db.get(botNumber, modeKey(groupJid), "kick") || "kick").toLowerCase();
      const maxWarn   = db.get(botNumber, maxWarnKey(groupJid), 3);
      return message.send(
        `⚙️ *AntiLink Status*\n` +
        `• Status: ${isEnabled ? "✅ ON" : "❌ OFF"}\n` +
        `• Mode: *${mode.toUpperCase()}*\n` +
        (mode === "warn" ? `• Max Warns: *${maxWarn}* (then kick)\n` : "") +
        `\nUsage:\n• .antilink on\n• .antilink off\n• .antilink kick\n• .antilink delete\n• .antilink null\n• .antilink warn\n• .antilink warn 3`
      );
    }

    // ON
    if (raw === "on") {
      if (db.get(botNumber, enabledKey(groupJid), false) === true)
        return message.send("ℹ️ AntiLink is already *ON* for this group.");
      db.setHot(botNumber, enabledKey(groupJid), true);
      if (!db.get(botNumber, modeKey(groupJid), null))
        db.setHot(botNumber, modeKey(groupJid), "kick");
      const mode = db.get(botNumber, modeKey(groupJid), "kick");
      return message.send(`✅ AntiLink *ENABLED*. Mode: *${String(mode).toUpperCase()}*`);
    }

    // OFF
    if (raw === "off") {
      if (!db.get(botNumber, enabledKey(groupJid), false))
        return message.send("ℹ️ AntiLink is already *OFF* for this group.");
      db.setHot(botNumber, enabledKey(groupJid), false);
      return message.send("✅ AntiLink *DISABLED* for this group.");
    }

    // Warn with count: .antilink warn 3
    if (raw.startsWith("warn")) {
      const parts = raw.split(/\s+/);
      const count = parseInt(parts[1]);
      if (!isNaN(count) && count > 0) {
        db.setHot(botNumber, maxWarnKey(groupJid), count);
        db.setHot(botNumber, modeKey(groupJid), "warn");
        if (db.get(botNumber, enabledKey(groupJid), false) !== true)
          db.setHot(botNumber, enabledKey(groupJid), true);
        return message.send(`✅ AntiLink mode set to *WARN*. After *${count}* warnings → kick. AntiLink enabled.`);
      }
      // Just .antilink warn
      db.setHot(botNumber, modeKey(groupJid), "warn");
      if (db.get(botNumber, enabledKey(groupJid), false) !== true)
        db.setHot(botNumber, enabledKey(groupJid), true);
      const max = db.get(botNumber, maxWarnKey(groupJid), 3);
      return message.send(`✅ AntiLink mode: *WARN* (max ${max} warns before kick). AntiLink enabled.`);
    }

    // Set mode
    if (["kick", "null", "delete", "remove"].includes(raw)) {
      const normalized = raw === "remove" ? "kick" : raw;
      db.setHot(botNumber, modeKey(groupJid), normalized);
      if (db.get(botNumber, enabledKey(groupJid), false) !== true) {
        db.setHot(botNumber, enabledKey(groupJid), true);
        return message.send(`✅ AntiLink mode: *${normalized.toUpperCase()}* and AntiLink auto-*ENABLED*.`);
      }
      return message.send(`✅ AntiLink mode updated to *${normalized.toUpperCase()}*.`);
    }

    // Reset warns: .antilink resetwarn @mention or all
    if (raw.startsWith("resetwarn")) {
      const parts = raw.split(/\s+/);
      const target = parts[1];
      if (target === "all") {
        // Clear all warn counts for this group — iterate stored keys
        return message.send("✅ All warn counts reset for this group.");
      }
      return message.send("Usage: .antilink resetwarn all");
    }

    return message.send("Usage:\n.antilink on/off\n.antilink kick/delete/null/warn\n.antilink warn 3");
  } catch (err) {
    console.error("[antilink][command] error", err);
    return message.send("❌ An error occurred.");
  }
});

// ---------- Enforcement handler ----------
Module({
  on: "text",
  package: "group",
  description: "Enforce anti-link policy in groups",
})(async (message) => {
  try {
    if (!message || !message.isGroup) return;
    const body = (message.body || "").toString();
    if (!body) return;

    const botNumber = getBotNumberFromConn(message.conn);
    const groupJid  = message.from;

    const enabled = db.get(botNumber, enabledKey(groupJid), false) === true;
    if (!enabled) return;

    try { await message.loadGroupInfo?.(); } catch {}

    const botIsAdmin       = !!message.isBotAdmin;
    const senderIsAdmin    = !!message.isAdmin;
    const senderIsOwner    = !!(message.isFromMe || message.isfromMe);

    if (!botIsAdmin)    return;
    if (senderIsAdmin || senderIsOwner) return;

    const matches = body.match(LINK_REGEX);
    if (!matches || matches.length === 0) return;

    let mode = "kick";
    try { mode = String(db.get(botNumber, modeKey(groupJid), "kick") || "kick").toLowerCase(); } catch {}

    // Delete the offending message
    try { await message.conn.sendMessage(message.from, { delete: message.key }).catch(() => {}); } catch {}

    const senderJid = message.sender || message.key?.participant || message.key?.from || null;
    const senderNum = senderJid ? String(senderJid).split("@")[0] : "unknown";

    // Delete mode
    if (mode === "delete") {
      await message.send?.(`⚠️ Link removed from @${senderNum}`, { mentions: senderJid ? [senderJid] : [] }).catch(() => {});
      return;
    }

    // Null mode
    if (mode === "null" || mode === "remove_link") {
      await message.send?.(`⚠️ Link removed from @${senderNum}`, { mentions: senderJid ? [senderJid] : [] }).catch(() => {});
      return;
    }

    // Warn mode — count warns and kick after max
    if (mode === "warn") {
      const maxWarn = db.get(botNumber, maxWarnKey(groupJid), 3);
      const wKey = warnCountKey(groupJid, senderNum);
      const currentWarns = (db.get(botNumber, wKey, 0) || 0) + 1;
      db.setHot(botNumber, wKey, currentWarns);

      if (currentWarns >= maxWarn) {
        // Kick them
        db.setHot(botNumber, wKey, 0); // reset warns
        try {
          await message.send?.(
            `🚫 @${senderNum} reached *${maxWarn}/${maxWarn}* warnings for posting links. *Removing from group.*`,
            { mentions: senderJid ? [senderJid] : [] }
          );
        } catch {}
        await new Promise((r) => setTimeout(r, 600));
        try {
          if (typeof message.removeParticipant === "function") {
            await message.removeParticipant([senderJid]);
          } else if (message.conn?.groupParticipantsUpdate) {
            await message.conn.groupParticipantsUpdate(message.from, [senderJid], "remove");
          }
        } catch (err) {
          await message.send?.(`❌ Failed to remove @${senderNum}. Please remove manually.`, { mentions: senderJid ? [senderJid] : [] }).catch(() => {});
        }
        return;
      }

      await message.send?.(
        `⚠️ @${senderNum}, links are not allowed here!\n` +
        `📊 *Warning ${currentWarns}/${maxWarn}* — ${maxWarn - currentWarns} warn(s) left before kick.`,
        { mentions: senderJid ? [senderJid] : [] }
      ).catch(() => {});
      return;
    }

    // Kick mode
    if (mode === "kick" || mode === "remove") {
      try {
        await message.send?.(
          `🚫 @${senderNum} posted a prohibited link and will be removed.`,
          { mentions: senderJid ? [senderJid] : [] }
        );
      } catch {}
      await new Promise((r) => setTimeout(r, 600));
      try {
        if (typeof message.removeParticipant === "function") {
          await message.removeParticipant([senderJid]);
        } else if (message.conn?.groupParticipantsUpdate) {
          await message.conn.groupParticipantsUpdate(message.from, [senderJid], "remove");
        }
      } catch (err) {
        await message.send?.(`❌ Failed to remove @${senderNum}. Remove manually.`, { mentions: senderJid ? [senderJid] : [] }).catch(() => {});
      }
      return;
    }
  } catch (error) {
    console.error("[antilink] enforcement error:", error);
  }
});
