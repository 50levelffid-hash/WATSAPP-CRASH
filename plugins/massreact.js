// plugins/massreact.js — Mass react to a channel post using all active sessions
import { Module } from "../lib/plugins.js";
import { manager } from "../lib/client.js";

// Parse channel invite link or newsletter JID
async function resolveChannelJid(input, conn) {
  input = input.trim();
  if (input.includes("@newsletter")) return input;
  try {
    const url = new URL(input);
    if (url.pathname.startsWith("/channel/")) {
      const code = url.pathname.split("/channel/")[1];
      const res = await conn.newsletterMetadata("invite", code, "GUEST");
      return res.id;
    }
  } catch (_) {}
  return null;
}

// Extract message ID from a post link
// whatsapp.com/channel/xxx/yyy  => yyy is message ID
// Or user can pass raw numeric/string msgId directly
function extractMsgId(postLink) {
  try {
    const url = new URL(postLink);
    const parts = url.pathname.split("/").filter(Boolean);
    // /channel/<code>/<msgId>
    if (parts.length >= 3 && parts[0] === "channel") return parts[2];
    // /channel/<code>  => no specific msgId
    return null;
  } catch {
    // Not a URL — treat as raw msg ID
    return /^\d+$/.test(postLink) ? postLink : null;
  }
}

Module({
  command: "massreact",
  package: "owner",
  description: "Mass react to a channel post using all active sessions",
  usage: ".massreact <post_link_or_jid> , <emoji1,emoji2,...> , <quantity>",
})(async (message, match) => {
  if (!(message.isFromMe || message.isfromMe)) return message.send("_Only bot owner can use this._");

  if (!match) {
    return message.send(
      "Mass React — react to a channel post with all active sessions\n\n" +
      "Usage:\n" +
      ".massreact https://whatsapp.com/channel/xxx/msgId , emoji , quantity\n\n" +
      "Examples:\n" +
      ".massreact https://whatsapp.com/channel/abc123/456 , emoji , 100\n" +
      ".massreact 120363418088880523@newsletter , emoji , 50\n\n" +
      "Multiple emojis (rotated):\n" +
      ".massreact <link> , emoji , 100"
    );
  }

  // Parse args: link , emoji(s) , quantity
  const parts = match.split(",").map(s => s.trim());
  if (parts.length < 3) {
    return message.send(
      "Format: .massreact <channel_link_or_jid> , <emoji> , <quantity>\n" +
      "Example: .massreact https://whatsapp.com/channel/xxx/456 , emoji , 100"
    );
  }

  const linkOrJid = parts[0].trim();
  const emojiPart = parts[1].trim();
  const quantity  = Math.min(Math.max(parseInt(parts[2]) || 10, 1), 500);

  // Emojis: support comma-separated in the emoji field — but they're already split above
  // So emojiPart is single or a few chars
  const emojis = emojiPart ? [...new Intl.Segmenter().segment(emojiPart)].map(s => s.segment).filter(Boolean) : ["emoji"];
  if (!emojis.length) return message.send("Please provide at least one emoji.");

  await message.react("⏳");

  // Resolve channel JID
  const channelJid = await resolveChannelJid(linkOrJid, message.conn).catch(() => null)
    || (linkOrJid.includes("@newsletter") ? linkOrJid : null);

  if (!channelJid) return message.send("Could not resolve channel JID. Provide a valid channel link or JID.");

  // Extract message ID from link
  let msgId = extractMsgId(linkOrJid);

  // Get all active sessions
  const activeSessions = [...manager.sessions.entries()]
    .filter(([, entry]) => entry?.sock?.user?.id)
    .map(([sid, entry]) => ({ sid, sock: entry.sock }));

  if (!activeSessions.length) return message.send("No active sessions found.");

  await message.send(
    `Mass React started\n` +
    `Channel: ${channelJid}\n` +
    `MsgId: ${msgId || "latest"}\n` +
    `Sessions: ${activeSessions.length}\n` +
    `Emojis: ${emojis.join(" ")}\n` +
    `Quantity: ${quantity}`
  );

  let sent = 0;
  let failed = 0;
  let idx = 0;

  for (let i = 0; i < quantity; i++) {
    const { sid, sock } = activeSessions[idx % activeSessions.length];
    idx++;

    const emoji = emojis[i % emojis.length];

    try {
      if (msgId) {
        await sock.newsletterReactMessage(channelJid, msgId, emoji);
      } else {
        // Try IDs 1-50 for latest
        let done = false;
        for (let j = 1; j <= 50; j++) {
          try {
            await sock.newsletterReactMessage(channelJid, String(j), emoji);
            msgId = String(j); // cache found msgId
            done = true;
            break;
          } catch {}
        }
        if (!done) throw new Error("msgId not found");
      }
      sent++;
    } catch {
      failed++;
    }

    // Small delay to avoid rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  await message.react("✅");
  return message.send(
    `Mass React Complete\n` +
    `Sent: ${sent}/${quantity}\n` +
    `Failed: ${failed}\n` +
    `Sessions used: ${activeSessions.length}`
  );
});
