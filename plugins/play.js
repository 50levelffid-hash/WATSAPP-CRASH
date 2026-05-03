import axios from "axios";
import yts from "yt-search";
import { Module } from "../lib/plugins.js";

Module({
  command: "play",
  package: "youtube",
  description: "Play song from YouTube (API based)",
})(async (message, match) => {
  try {
    // ❌ No query
    if (!match) {
      return message.send("❌ Eɴᴛᴇʀ Sᴏɴɢ Nᴀᴍᴇ\n\n.ᴘʟᴀʏ Tᴜᴍ ʜɪ ʜᴏ");
    }

    await message.react("🔍");

    // 🔎 1. Search YouTube
    const res = await yts(match);
    if (!res.videos || res.videos.length === 0) {
      return message.send("❌ Song not found");
    }

    const video = res.videos[0];

    // 📝 2. Caption
    const caption = `
🎵 *Now Playing*

*Pᴏᴡᴇʀᴇᴅ Bʏ Rᴀʙʙɪᴛ - xᴍᴅ*

📌 *Tɪᴛʟᴇ:* ${video.title}
👤 *Cʜᴀɴɴᴇʟ:* ${video.author.name}
⏱️ *Dᴜʀᴇᴛɪᴏɴ:* ${video.timestamp}

⬇️ *Dᴏᴡɴʟᴏᴀᴅɪɴɢ Aᴜᴅɪᴏ...*
`.trim();

    // 🖼️ 3. Send thumbnail + info
    await message.send({
      image: { url: video.thumbnail },
      caption: caption,
      mimetype: "image/jpeg",
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: "120363418088880523@newsletter",
          newsletterName: " 𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸",
          serverMessageId: 6,
        },
      },
    });

    // 🌐 4. API Call
    const apiUrl =
      "https://newapi-536w.onrender.com/api/song?url=" +
      encodeURIComponent(video.url);

    const { data } = await axios.get(apiUrl, { timeout: 30000 });

    // ❌ Check API response
    if (!data || !data.status || !data.result?.audio) {
      return message.send("❌ Audio download failed");
    }

    // 🎧 5. Send Audio
    await message.send({
      audio: { url: data.result.audio },
      mimetype: "audio/mpeg",
      fileName: `${video.title}.mp3`,
      contextInfo: {
        externalAdReply: {
          title: video.title,
          body: "Powered By 𓆩⃟𝐑𝛂͎᪱ʙʙᷱ᪳ɪ͓ʈ 𝐗ᴹᴅ˺⤹六⤸",
          mediaType: 2,
          sourceUrl: video.url,
          thumbnailUrl: video.thumbnail,
        },
      },
    });

    await message.react("🎧");

  } catch (err) {
    console.error("[PLAY ERROR]", err);

    // ⚠️ Better error message
    if (err.code === "ECONNABORTED") {
      await message.send("⏳ Server timeout, try again");
    } else {
      await message.send("⚠️ Play failed");
    }
  }
});
