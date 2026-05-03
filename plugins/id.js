import { Module } from "../lib/plugins.js";

Module({
  command: "checkid",
  aliases: ["cekid", "getid", "id"],
  description: "Get WhatsApp Group or Channel ID from invite link",
})(async (message, match) => {
  try {
    if (!match) {
      return message.send(
        "❌ Send wp channel/group link 🔗 \n\nExample:\n.checkid https://chat.whatsapp.com/xxxx"
      );
    }

    await message.react("⌛");

    // Extract WhatsApp link
    const linkMatch = match.match(
      /https?:\/\/(chat\.whatsapp\.com|whatsapp\.com\/channel)\/[^\s]+/i
    );

    if (!linkMatch) {
      await message.react("❌");
      return message.send("❌ send WhatsApp group / channel link");
    }

    const link = linkMatch[0];
    const url = new URL(link);

    // ================= GROUP =================
    if (url.hostname === "chat.whatsapp.com") {
      const code = url.pathname.replace("/", "");
      const res = await message.client.groupGetInviteInfo(code);
      const id = res.id;

      await message.react("✅");
      return message.send(`
📊 *Group Link Analysis*

🔗 *Link:* ${link}
🆔 *Group ID:*
\`${id}\`

_Powered By 𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸
`.trim());
    }

    // ================= CHANNEL =================
    if (url.pathname.startsWith("/channel/")) {
      const code = url.pathname.split("/channel/")[1];
      const res = await message.client.newsletterMetadata(
        "invite",
        code,
        "GUEST"
      );
      const id = res.id;

      await message.react("✅");
      return message.send(`
📢 *Channel Link Analysis*

🔗 *Link:* ${link}
🆔 *Channel ID:*
\`${id}\`

_Powered By 𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸_
`.trim());
    }

    await message.react("❌");
    message.send("❌ Unsupported WhatsApp link");

  } catch (err) {
    console.error("[CHECKID ERROR]", err);
    await message.react("❌");
    message.send("⚠️ Link invalid");
  }
});
