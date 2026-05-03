import { Module } from "../lib/plugins.js";

/**
 * Try to obtain group metadata from common properties/methods.
 * Returns null if not available.
 */
async function getGroupMetadata(message, targetJid) {
  // If message already has metadata and no custom JID, use it
  if (message.groupMetadata && !targetJid) return message.groupMetadata;

  // Try connection-level API: conn.groupMetadata(jid)
  try {
    if (typeof message.conn?.groupMetadata === "function") {
      const md = await message.conn.groupMetadata(targetJid);
      if (md) return md;
    }
  } catch (e) {}

  // Try connection-level alternate API: conn.groupFetchAll()
  try {
    if (typeof message.conn?.groupFetchAll === "function") {
      const all = await message.conn.groupFetchAll();
      if (all) {
        // some libs return an object keyed by jid
        const found = Object.values(all).find(
          (g) => g?.id === targetJid || g?.jid === targetJid
        );
        if (found) return found;
      }
    }
  } catch (e) {}

  // As a last resort, if message.loadGroupInfo exists, call it and re-check
  try {
    if (typeof message.loadGroupInfo === "function") {
      await message.loadGroupInfo();
      if (message.groupMetadata) return message.groupMetadata;
    }
  } catch (e) {}

  return null;
}

/** Normalize participants to objects: { id, admin } */
function normalizeParticipants(md) {
  const raw = md?.participants || md?.participantsMap || [];
  // raw may be array or object; convert to array of entries
  const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
  return arr
    .map((p) => {
      if (!p) return null;
      const id =
        p?.id ??
        p?.jid ??
        p?.participant ??
        (typeof p === "string" ? p : undefined);
      const admin =
        !!p?.admin || // boolean/admin flag
        !!p?.isAdmin ||
        p?.role === "admin" ||
        p?.admin === "superadmin";
      return id ? { id, admin } : null;
    })
    .filter(Boolean);
}

/** Helper to call the group's participants update API */
async function removeParticipants(message, targetJid, jidList) {
  // preferred: message.conn.groupParticipantsUpdate
  if (typeof message.conn?.groupParticipantsUpdate === "function") {
    return message.conn.groupParticipantsUpdate(targetJid, jidList, "remove");
  }
  // fallback: message.client.groupParticipantsUpdate
  if (typeof message.client?.groupParticipantsUpdate === "function") {
    return message.client.groupParticipantsUpdate(targetJid, jidList, "remove");
  }
  // No supported API found
  throw new Error("No groupParticipantsUpdate method found on conn/client");
}

Module({
  command: "kickall",
  package: "group",
  description: "Kick all non-admin users at once. Usage: .kickall OR .kickall <group_jid>",
})(async (message, match) => {
  // ensure we have group info in message object if possible
  try {
    if (typeof message.loadGroupInfo === "function")
      await message.loadGroupInfo();
  } catch (e) {
    // ignore
  }

  // Determine target JID — match দিলে সেটা, না দিলে current group
  const matchJid = match?.trim();
  const targetJid = matchJid?.endsWith("@g.us") ? matchJid : message.from;

  if (!targetJid?.endsWith("@g.us")) return message.send("❌ Group only");
  if (!message.isAdmin && !message.isfromMe)
    return message.send("❌ Admin only");
  if (!message.isBotAdmin) return message.send("❌ Bot must be admin");

  const md = await getGroupMetadata(message, targetJid);
  if (!md) return message.send("❌ No participants found");

  const participants = normalizeParticipants(md);
  if (!participants.length) return message.send("❌ No participants found");

  // Try to detect the bot JID from connection info to avoid removing self
  const possibleBotIds = new Set(
    [
      message.conn?.user?.id,
      message.conn?.user?.jid,
      message.conn?.user?.lid, // keep original field if present
      message.client?.user?.id,
      message.client?.user?.jid,
    ].filter(Boolean)
  );

  // Build targets: non-admins, excluding bot JIDs
  const targets = participants
    .filter((p) => !p.admin)
    .map((p) => p.id)
    .filter((jid) => jid && !possibleBotIds.has(jid));

  if (!targets.length) return message.send("✅ No non-admin users");

  try {
    await removeParticipants(message, targetJid, targets);
    // We don't cache here (cache removed) — just report result
    await message.send(`✅ Kicked ${targets.length} users in ONE action`);
  } catch (err) {
    console.error("[kickall] Error while kicking participants:", err);
    return message.send(
      "❌ Failed to remove users. Bot API may not support bulk remove."
    );
  }
});
