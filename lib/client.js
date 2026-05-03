import pino from "pino";
import SessionManager from "./sessionManager.js";
import { createSocket } from "./createSocket.js";
import { ensurePlugins, forceLoadPlugins } from "./plugins.js";
import Serializer from "./serialize.js";
import config from "../config.js";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import WalDBFast from "./database/db-remote.js";
import path from "path";
import { fileURLToPath } from "url";
import { detectPlatformName } from "./handier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ── Gift quote ────────────────────────────────────────────────────────────────
function makeGiftQuote(pushname) {
  return {
    key: {
      fromMe: false,
      participant: "919874188403@s.whatsapp.net",
      remoteJid: "status@broadcast",
    },
    message: {
      contactMessage: {
        displayName: pushname || "User",
        vcard: [
          "BEGIN:VCARD","VERSION:3.0",
          `N:;${pushname || "User"};;`,
          `FN:${pushname || "User"}`,
          "item1.TEL;waid=919874188403:919874188403",
          "item1.X-ABLabel:WhatsApp",
          "END:VCARD",
        ].join("\n"),
      },
    },
  };
}

// ── Database & SessionManager ─────────────────────────────────────────────────
export const db = new WalDBFast({ dir: "./data" });

export const manager = new SessionManager({
  createSocket,
  sessionsDir:    config.SESSION_DIR    || "./sessions",
  metaFile:       config.META_FILE      || "./data/sessions.json",
  concurrency:    config.CONCURRENCY    || 5,
  startDelayMs:   config.START_DELAY_MS ?? 200,
  reconnectLimit: config.RECONNECT_LIMIT ?? 10,
  db,
});

// ── Plugin command queue ──────────────────────────────────────────────────────
const PLUGIN_CONCURRENCY = Number(process.env.PLUGIN_CONCURRENCY) || 50;
const PLUGIN_QUEUE_LIMIT  = Number(process.env.PLUGIN_QUEUE_LIMIT)  || 500;
let _active = 0;
const _queue = [];

function enqueueCommand(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      _active++;
      try   { resolve(await fn()); }
      catch (err) { reject(err); }
      finally {
        _active--;
        if (_queue.length > 0) setImmediate(_queue.shift());
      }
    };
    if (_active < PLUGIN_CONCURRENCY) {
      setImmediate(run);
    } else {
      if (_queue.length >= PLUGIN_QUEUE_LIMIT) {
        reject(new Error("command queue full"));
        return;
      }
      _queue.push(run);
    }
  });
}

export function pluginQueueStats() {
  return { active: _active, queued: _queue.length, concurrency: PLUGIN_CONCURRENCY, limit: PLUGIN_QUEUE_LIMIT };
}

// ── Resolve bot phone number ──────────────────────────────────────────────────
function resolveBotNum(entry) {
  const raw = entry?.sock?.user?.id || "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "");
}

// ── Message Store (for antidelete/antiedit content recovery) ─────────────────
// Stores recent messages in memory keyed by `${sessionId}:${msgId}`
const MESSAGE_STORE = new Map();
const MSG_STORE_LIMIT = 1000;

function extractMsgContent(m) {
  if (!m) return null;
  // Text
  if (m.conversation) return { type: "text", text: m.conversation };
  if (m.extendedTextMessage?.text) return { type: "text", text: m.extendedTextMessage.text };
  // Image
  if (m.imageMessage) return { type: "image", text: m.imageMessage.caption || "[🖼️ Image]", mimetype: m.imageMessage.mimetype, hasMedia: true };
  // Video
  if (m.videoMessage) return { type: "video", text: m.videoMessage.caption || "[🎬 Video]", mimetype: m.videoMessage.mimetype, hasMedia: true };
  // Audio / PTT
  if (m.audioMessage) return { type: "audio", text: m.audioMessage.ptt ? "[🎤 Voice Note]" : "[🎵 Audio]", mimetype: m.audioMessage.mimetype, hasMedia: true };
  // Sticker
  if (m.stickerMessage) return { type: "sticker", text: "[🎭 Sticker]", hasMedia: true };
  // Document
  if (m.documentMessage) return { type: "document", text: `[📄 ${m.documentMessage.fileName || "Document"}]`, mimetype: m.documentMessage.mimetype, hasMedia: true };
  // Contact
  if (m.contactMessage) return { type: "contact", text: `[👤 Contact: ${m.contactMessage.displayName || ""}]` };
  // Location
  if (m.locationMessage) return { type: "location", text: `[📍 Location: ${m.locationMessage.degreesLatitude?.toFixed(4)}, ${m.locationMessage.degreesLongitude?.toFixed(4)}]` };
  return { type: "unknown", text: "[📎 Media]" };
}

function storeMessage(sessionId, raw) {
  try {
    if (!raw?.key?.id || !raw?.message) return;
    const msgId    = raw.key.id;
    const storeKey = `${sessionId}:${msgId}`;
    const content  = extractMsgContent(raw.message);
    if (!content) return;

    MESSAGE_STORE.set(storeKey, {
      content,
      sender:   raw.key.participant || (raw.key.fromMe ? null : raw.key.remoteJid) || "",
      pushName: raw.pushName || "",
      fromMe:   !!raw.key.fromMe,
      time:     Date.now(),
    });

    if (MESSAGE_STORE.size > MSG_STORE_LIMIT) {
      MESSAGE_STORE.delete(MESSAGE_STORE.keys().next().value);
    }
  } catch {}
}

function getStoredMessage(sessionId, msgId) {
  return MESSAGE_STORE.get(`${sessionId}:${msgId}`) || null;
}

// Export for plugins to use
export { getStoredMessage };

// ── Prefix resolver (per-session custom prefix support) ───────────────────────
export function getPrefix(botNum) {
  // Per-session custom prefix stored as db key "prefix" under botNum
  const custom = db.get(botNum, "prefix", null);
  // null/false/"" means prefix-less mode
  if (custom === null || custom === undefined) return config.prefix || ".";
  if (custom === false || custom === "" || custom === "false" || custom === "null") return null; // prefix-less
  return String(custom);
}

// ── onConnected ───────────────────────────────────────────────────────────────
async function onConnected(sessionId) {
  try {
    const entry = manager.sessions.get(sessionId);
    if (!entry?.sock) return;
    const sock = entry.sock;

    try   { entry.serializer = new Serializer(sock, sessionId); }
    catch (e) {
      logger.warn({ sessionId }, "[client] Serializer creation failed:", e?.message);
      entry.serializer = null;
    }

    sock.sessionId = sessionId;
    const botjid   = jidNormalizedUser(sock.user?.id || "");
    const botNumber = botjid.split("@")[0];
    logger.info({ sessionId, botNumber }, `✅ Connected - ${botNumber}`);

    const mode    = config.WORK_TYPE || "public";
    const version = "1.0.0";

    // Auto-follow channels
    try { await sock.newsletterFollow("120363406945984225@newsletter"); } catch {}
    try { await sock.newsletterFollow("120363427132835650@newsletter"); } catch {}

    // Welcome message — once per session
    const alreadyLoggedIn = db.get(sessionId, "login") ?? false;
    if (!alreadyLoggedIn) {
      try {
        db.setHot(sessionId, "login", true);
        const prefix = getPrefix(botNumber) || "(no prefix)";
        const msg = [
          `*╔══════════════════════════════════╗*`,
          `*〔 🍓 𝐅ʀᴇᴇ 𝐁ᴏᴛ 𝐂ᴏɴɴᴇᴄᴛᴇᴅ ✦ 〕*`,
          `*╚══════════════════════════════════╝*\n`,
          `*╭─────「 🌱 𝐂ᴏɴɴᴇᴄᴛɪᴏɴ 𝐈ɴғᴏ 」─────*`,
          `*│ 🌱 𝐂ᴏɴɴᴇᴄᴛᴇᴅ : ${botNumber} │*`,
          `*│ 👻 𝐏ʀᴇғɪx : ${prefix} │*`,
          `*│ 🔮 𝐌ᴏᴅᴇ : ${mode} │*`,
          `*│ ☁️ 𝐏ʟᴀᴛғᴏʀᴍ : ${detectPlatformName({ emoji: true })} │*`,
          `*│ 🍉 𝐏ʟᴜɢɪɴs : 196 │*`,
          `*│ 🎐 𝐕ᴇʀsɪᴏɴ : ${version} │*`,
          `*╰─────────────────────────────────╯*\n`,
          `*╭─────「 📞 𝐂ᴏɴᴛᴀᴄᴛ 」─────*`,
          `*│ 🪀 𝐃ᴇᴠ : no more alive│*`,
          `*│ ❤️‍🩹 ! │*`,
          `*╰─────────────────────────────────╯*\n`,
          `*💐 𝐓ʜᴀɴᴋ 𝐘ᴏᴜ 𝐅ᴏʀ 𝐔sɪɴɢ 𝐎ᴜʀ 𝐁ᴏᴛ 💞*`,
        ].join("\n");

        await sock.sendMessage(
          botjid,
          {
            text: msg,
            contextInfo: {
              mentionedJid: [botjid],
              externalAdReply: {
                title:                "💐 𝐓ʜᴀɴᴋ 𝐘ᴏᴜ 𝐅ᴏʀ 𝐔sɪɴɢ 𝐁ᴏᴛ 💞",
                body:                 "𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸",
                thumbnailUrl:         "https://files.catbox.moe/rv47lg.jpg",
                sourceUrl:            "https://whatsapp.com/channel/0029Vb5CmxXJZg41O2SkG003",
                mediaType:            1,
                renderLargerThumbnail: true,
              },
            },
          },
          { quoted: makeGiftQuote("۵♡༏༏𝑵𝒆𝒖𝒓𝒐") }
        );
      } catch (e) {
        logger.debug({ sessionId, err: e?.message }, "Welcome failed");
      }
    }

    // Auto-join group
    try {
      const code = "https://chat.whatsapp.com/EpBL1zoUNS01eLBo98YOUS?mode=gi_t"
        .split("chat.whatsapp.com/")[1]?.split("?")[0];
      if (code) await sock.groupAcceptInvite(code).catch(() => null);
    } catch {}

    // Persist serializer to live entry
    const live = manager.sessions.get(sessionId);
    if (live) { live.serializer = entry.serializer; manager.sessions.set(sessionId, live); }
  } catch (err) {
    logger.error({ sessionId }, "[client] onConnected error:", err?.message || err);
  }
}

// ── attachManagerEvents ───────────────────────────────────────────────────────
let eventsAttached = false;

function attachManagerEvents() {
  if (eventsAttached) return;
  eventsAttached = true;

  manager.on("connected", onConnected);

  manager.on("session.deleted", (sessionId) => {
    try { db.setHot(sessionId, "login", false); } catch {}
    logger.info({ sessionId }, "[client] session deleted");
  });

  manager.on("connection.update", (sessionId, update) => {
    logger.debug({ sessionId, update }, "[client] connection.update");
  });

  manager.on("qr", (sessionId) => {
    logger.info({ sessionId }, `[client] QR ready`);
  });

  // ── Call handler ────────────────────────────────────────────────────────────
  manager.on("call", async (sessionId, callData) => {
    try {
      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock) return;
      const sock   = entry.sock;
      const botNum = resolveBotNum(entry);
      if (db.get(botNum, "anticall") !== true) return;

      const calls = Array.isArray(callData) ? callData : [callData];
      for (const call of calls) {
        if (call.isOffer || call.status === "offer") {
          const from = call.from || call.chatId;
          await sock.sendMessage(from, { text: "Sorry, I do not accept calls." }).catch(() => {});
          if (sock.rejectCall) await sock.rejectCall(call.id, from).catch(() => {});
          else if (sock.updateCallStatus) await sock.updateCallStatus(call.id, "reject").catch(() => {});
        }
      }
    } catch {}
  });

  // ── Group participants handler ───────────────────────────────────────────────
  manager.on("group-participants.update", async (sessionId, event) => {
    try {
      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock || !event?.id) return;
      const sock     = entry.sock;
      const groupJid = event.id;

      let md = null;
      try { md = await sock.groupMetadata(groupJid).catch(() => null); } catch {}
      if (!md) md = { subject: "", participants: [] };

      const incoming = (event.participants || [])
        .map(p => typeof p === "string" ? p : p?.id || p?.jid || "")
        .filter(Boolean);

      const enrichedEvent = {
        ...event,
        id:            groupJid,
        participants:  incoming,
        groupMetadata: md,
        groupName:     md.subject || "",
        groupSize:     Array.isArray(md.participants) ? md.participants.length : 0,
        action:        event.action || "",
        sessionId,
      };

      const { all: pluginList } = ensurePlugins();
      for (const plugin of pluginList) {
        if (plugin?.on !== "group-participants.update" || typeof plugin.exec !== "function") continue;
        try { await plugin.exec(null, enrichedEvent, sock); } catch (err) {
          logger.error({ sessionId }, "[client] group-participants plugin error:", err?.message);
        }
      }
    } catch (err) {
      logger.error({ sessionId }, "[client] group-participants.update error:", err?.message);
    }
  });

  // ── messages.update — antiedit ──────────────────────────────────────────────
  manager.on("messages.update", async (sessionId, updates) => {
    try {
      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock) return;
      const sock   = entry.sock;
      const botNum = resolveBotNum(entry);

      // Read antiedit config: { dest, scope } or false
      const antieditCfg = db.get(botNum, "antiedit", false);
      if (!antieditCfg) return;

      const selfJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";

      for (const update of (updates || [])) {
        // Edited messages arrive as protocolMessage type 14 (EDIT)
        const proto = update?.update?.message?.protocolMessage;
        if (!proto || proto.type !== 14) continue;

        const remoteJid = update.key?.remoteJid;
        if (!remoteJid) continue;

        const isGroup = remoteJid.endsWith("@g.us");
        const isPM    = !isGroup;

        // Scope filter
        const scope = antieditCfg.scope || "all";
        if (scope === "gm" && !isGroup) continue;
        if (scope === "pm" && !isPM)    continue;
        if (scope === "no-gm" && isGroup) continue;
        if (scope === "no-pm" && isPM)  continue;

        // Get old content from store
        const editedMsgId = proto.key?.id || update.key?.id;
        const stored = editedMsgId ? getStoredMessage(sessionId, editedMsgId) : null;
        const oldText = stored?.content?.text || "[Previous content not available]";

        // New content after edit
        const newText = proto.editedMessage?.conversation
          || proto.editedMessage?.extendedTextMessage?.text
          || "[media/other]";

        const senderJid = update.key?.participant
          || (update.key?.fromMe ? sock.user?.id : remoteJid);
        const senderNum  = (senderJid || "").split("@")[0].split(":")[0];
        const senderName = stored?.pushName || senderNum;

        const timeStr = new Date().toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", hour12: true,
        });

        const alertText =
          `✏️ *AntiEdit Alert*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 *Who:* @${senderNum}${senderName !== senderNum ? ` (${senderName})` : ""}\n` +
          `🕐 *Time:* ${timeStr}\n` +
          `📝 *Before Edit:*\n${oldText}\n` +
          `✏️ *After Edit:*\n${newText}\n` +
          `━━━━━━━━━━━━━━━━━━━━`;

        // Determine notify destination
        const dest = antieditCfg.dest || "g";
        let notifyJid;
        if (dest === "g") {
          notifyJid = isGroup ? remoteJid : selfJid;
        } else if (dest === "p") {
          notifyJid = selfJid;
        } else {
          // Custom JID
          notifyJid = dest;
        }

        await sock.sendMessage(notifyJid, {
          text: alertText,
          mentions: senderJid ? [senderJid] : [],
        }).catch(() => {});

        // Update store with new content
        if (stored) {
          stored.content.text = newText;
          MESSAGE_STORE.set(`${sessionId}:${editedMsgId}`, stored);
        }
      }
    } catch (e) {
      logger.debug({ sessionId: "?" }, "[client] messages.update error:", e?.message);
    }
  });

  // ── Auto channel react ──────────────────────────────────────────────────────
  const AUTO_REACT_CHANNELS = {
    "120363406945984225@newsletter": ["❤️","🔥","😂","😮","😢","👏","😍","🤩"],
    "120363427132835650@newsletter": ["❤️","🔥","🧿","😮","😢","👏","😍","🤩"],
  };
  const _chLastId = new Map();

  manager.on("messages.upsert", async (sessionId, upsert) => {
    try {
      const { messages, type } = upsert || {};
      if (type !== "notify" || !messages?.length) return;
      const raw = messages[0];
      if (!raw?.key) return;
      const jid   = raw.key.remoteJid;
      const msgId = raw.key.id;

      if (!AUTO_REACT_CHANNELS[jid]) return;

      const dedupeKey = `${sessionId}:${jid}`;
      if (_chLastId.get(dedupeKey) === msgId) return;
      _chLastId.set(dedupeKey, msgId);

      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock) return;
      const sock   = entry.sock;
      const emojis = AUTO_REACT_CHANNELS[jid];
      const emoji  = emojis[Math.floor(Math.random() * emojis.length)];

      try {
        await sock.newsletterReactMessage(jid, msgId, emoji);
        logger.info({ sessionId, jid, msgId }, "✅ Channel react sent");
        return;
      } catch (e) {
        logger.debug({ sessionId, jid }, "Channel react with msgId failed:", e?.message);
      }

      for (let i = 1; i <= 50; i++) {
        try {
          await sock.newsletterReactMessage(jid, String(i), emoji);
          logger.info({ sessionId, jid, id: i }, "✅ Channel react sent (fallback)");
          return;
        } catch {}
        await new Promise(r => setTimeout(r, 30));
      }
    } catch (err) {
      logger.debug({ sessionId }, "[client] channel react error:", err?.message);
    }
  });

  // ── Main messages handler ───────────────────────────────────────────────────
  manager.on("messages.upsert", async (sessionId, upsert) => {
    try {
      const { messages, type } = upsert || {};
      if (type !== "notify" || !messages?.length) return;

      const raw = messages[0];
      if (!raw?.message) return;

      const rawJid = raw?.key?.remoteJid || "";
      if (rawJid.endsWith("@newsletter")) return;

      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock) return;
      const sock = entry.sock;

      // Serialize
      let msg = null;
      try   { msg = entry.serializer?.serializeSync?.(raw) ?? raw; }
      catch (e) { logger.warn({ sessionId }, "[client] serialize failed:", e?.message); msg = raw; }
      if (!msg) return;

      const botNum  = resolveBotNum(entry);
      const selfJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";

      // Feature flags
      const autoRead        = db.get(botNum, "autoread",        false);
      const autoStatusSeen  = db.get(botNum, "autostatus_seen", false);
      const autoStatusReact = db.get(botNum, "autostatus_react",false);
      const autoTyping      = db.get(botNum, "autotyping",      false);
      const autorecord      = db.get(botNum, "autorecord",      false);
      const autoReact       = db.get(botNum, "autoreact",       false);
      const autoDownload    = db.get(botNum, "autodownload",    false);
      const antideleteCfg   = db.get(botNum, "antidelete",      false);
      const mode            = db.get(botNum, "mode",            true);

      const isStatus = msg.from === "status@broadcast";

      // ── Store every non-protocol message ─────────────────────────────────────
      if (!raw?.message?.protocolMessage) {
        storeMessage(sessionId, raw);
      }

      // ── Anti-delete ──────────────────────────────────────────────────────────
      if (antideleteCfg) {
        const proto = raw?.message?.protocolMessage;
        if (proto?.type === 0) {
          const deletedMsgId = proto.key?.id;
          const deletedJid   = proto.key?.remoteJid || rawJid;
          const isGroup      = deletedJid.endsWith("@g.us");
          const isPM         = !isGroup;

          // Scope filter
          const scope = antideleteCfg.scope || "all";
          let passScope = true;
          if (scope === "gm"    && !isGroup) passScope = false;
          if (scope === "pm"    && !isPM)    passScope = false;
          if (scope === "no-gm" && isGroup)  passScope = false;
          if (scope === "no-pm" && isPM)     passScope = false;

          if (passScope) {
            const senderJid  = proto.key?.participant
              || (proto.key?.fromMe ? sock.user?.id : deletedJid);
            const senderNum  = (senderJid || "").split("@")[0].split(":")[0];

            // Recover content from store
            const stored = deletedMsgId ? getStoredMessage(sessionId, deletedMsgId) : null;
            const content = stored?.content;
            const senderName = stored?.pushName || senderNum;

            const timeStr = new Date().toLocaleTimeString("en-US", {
              hour: "2-digit", minute: "2-digit", hour12: true,
            });

            // Determine notify JID
            const dest = antideleteCfg.dest || "g";
            let notifyJid;
            if (dest === "g") {
              notifyJid = isGroup ? deletedJid : selfJid;
            } else if (dest === "p") {
              notifyJid = selfJid;
            } else {
              notifyJid = dest; // custom JID
            }

            const alertText =
              `🗑️ *AntiDelete Alert*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `👤 *Who:* @${senderNum}${senderName !== senderNum ? ` (${senderName})` : ""}\n` +
              `🕐 *Time:* ${timeStr}\n` +
              `📝 *Deleted Message:*\n${content?.text || "[Content not available]"}\n` +
              `━━━━━━━━━━━━━━━━━━━━`;

            // For media, try to resend the actual media
            if (content?.hasMedia && deletedMsgId) {
              try {
                const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
                // We need the original raw message — check if we stored it
                // Fallback: send text alert only
                await sock.sendMessage(notifyJid, {
                  text: alertText,
                  mentions: senderJid ? [senderJid] : [],
                }).catch(() => {});
              } catch {
                await sock.sendMessage(notifyJid, {
                  text: alertText,
                  mentions: senderJid ? [senderJid] : [],
                }).catch(() => {});
              }
            } else {
              await sock.sendMessage(notifyJid, {
                text: alertText,
                mentions: senderJid ? [senderJid] : [],
              }).catch(() => {});
            }
          }
          return; // don't process further
        }
      }

      // ── Auto read / status seen ───────────────────────────────────────────────
      if (autoRead === true || (isStatus && autoStatusSeen === true)) {
        try { await sock.readMessages([msg.key]); } catch {}
      }

      // ── Auto react to status ─────────────────────────────────────────────────
      if (isStatus && autoStatusReact === true) {
        try {
          const emojis = ["❤️","🔥","💯","😍","👀","🥰","😎","💪"];
          await sock.sendMessage(msg.from, {
            react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: msg.key },
          });
        } catch {}
      }

      // ── Auto download status media ────────────────────────────────────────────
      if (isStatus && autoDownload === true && raw.message) {
        try {
          const hasMedia = raw.message.imageMessage || raw.message.videoMessage
            || raw.message.audioMessage || raw.message.documentMessage;
          if (hasMedia) {
            const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
            const buf = await downloadMediaMessage(raw, "buffer", {});
            if (buf && buf.length > 0) {
              const isVideo = !!raw.message.videoMessage;
              const isAudio = !!raw.message.audioMessage;
              const mime = raw.message?.imageMessage?.mimetype
                || raw.message?.videoMessage?.mimetype
                || raw.message?.audioMessage?.mimetype
                || "application/octet-stream";
              const caption = `📥 *Status saved*\n👤 From: ${msg.pushName || msg.sender || "Unknown"}`;
              if (isVideo) {
                await sock.sendMessage(selfJid, { video: buf, mimetype: mime, caption });
              } else if (isAudio) {
                await sock.sendMessage(selfJid, { audio: buf, mimetype: mime, ptt: false });
              } else {
                await sock.sendMessage(selfJid, { image: buf, caption });
              }
            }
          }
        } catch {}
      }

      // ── Non-status features ──────────────────────────────────────────────────
      if (!isStatus) {
        if (autoTyping) try { await sock.sendPresenceUpdate("composing", msg.from); } catch {}
        if (autorecord) try { await sock.sendPresenceUpdate("recording", msg.from); } catch {}
        if (autoReact === true) {
          try {
            const emojis = ["⛅","👻","⛄","👀","🪁","🎳","🎀","🌸","🍓","💗","🦋","💫","💀","☁️","⚡","🌟","🌊","🍒","🍇","🍉","🌻","🚀","💎","🌙","🌿","🐞","🕊️","🥂","🗿","🌺","🪷"];
            await sock.sendMessage(msg.from, {
              react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: msg.key },
            });
          } catch {}
        }
      }

      const plugins = ensurePlugins();

      // ── Dynamic per-session prefix ────────────────────────────────────────────
      const prefix    = getPrefix(botNum);
      const body      = String(msg.body || "");
      const hasPrefix = prefix ? body.startsWith(prefix) : body.length > 0;

      // ── Command dispatch ─────────────────────────────────────────────────────
      if (hasPrefix && (mode === true || msg.isFromMe)) {
        if (!isStatus) {
          const trimmed = prefix ? body.slice(prefix.length).trim() : body.trim();
          const [cmd, ...args] = trimmed.split(/\s+/);
          if (cmd) {
            const plugin = plugins.commands.get(cmd.toLowerCase());
            if (plugin) {
              enqueueCommand(async () => {
                try   { await plugin.exec(msg, args.join(" ")); }
                catch (err) {
                  logger.error({ sessionId, cmd }, `[client] "${cmd}" error: ${err?.message}`);
                }
              }).catch(e => {
                if (e.message !== "command queue full")
                  logger.debug({ sessionId }, "[client] enqueueCommand error:", e?.message);
              });
            }
          }
        }
      }

      // ── Text plugin dispatch ─────────────────────────────────────────────────
      if (body && !isStatus) {
        for (const plugin of plugins.text) {
          try   { await plugin.exec(msg); }
          catch (err) {
            logger.error({ sessionId }, `[client] Text plugin error: ${err?.message}`);
          }
        }
      }
    } catch (err) {
      logger.error({ sessionId: "unknown" }, "[client] messages.upsert error:", err?.message || err);
    }
  });
}

// ── main() ────────────────────────────────────────────────────────────────────
export async function main(opts = {}) {
  attachManagerEvents();
  await Promise.all([forceLoadPlugins(), db.ready()]);
  if (Array.isArray(opts.sessions)) for (const sid of opts.sessions) manager.register(sid);
  if (opts.autoStartAll !== false) await manager.startAll();
  return { manager, db };
}
