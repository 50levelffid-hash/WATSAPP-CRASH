// tiktok-plugin.js
import axios from "axios";
import { Module } from "../lib/plugins.js";

/* ⚡ Keep-Alive (faster requests) */
import http from "http";
import https from "https";

const axiosInstance = axios.create({
  timeout: 12000,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/* ⚡ Fetch TikTok data (shared for video + audio) */
async function fetchTikTok(url) {
  try {
    const [res1, res2] = await Promise.allSettled([
      axiosInstance.get(
        `https://api.vreden.my.id/api/v1/download/tiktok?url=${encodeURIComponent(url)}`
      ),
      axiosInstance.get(
        `https://www.apiskeith.top/download/tiktokdl3?url=${encodeURIComponent(url)}`
      ),
    ]);

    /* 🔥 MAIN API */
    if (res1.status === "fulfilled") {
      const result = res1.value.data?.result;

      if (result) {
        const hd = result.data?.find(d => d.type === "nowatermark_hd");
        const normal = result.data?.find(d => d.type === "nowatermark");

        return {
          video: hd?.url || normal?.url || null,
          audio: result.music_info?.url || null,
          title: result.title || "TikTok Video",
          quality: hd ? "HD" : "SD",
          thumbnail: result.cover || null,
        };
      }
    }

    /* 🔥 BACKUP API */
    if (res2.status === "fulfilled") {
      const video = res2.value.data?.result;
      if (video) {
        return {
          video,
          audio: null,
          title: "TikTok Video",
          quality: "SD",
          thumbnail: null,
        };
      }
    }

  } catch {}

  return null;
}

/* 🎬 VIDEO COMMAND */
Module({
  command: "tiktok",
  package: "downloader",
  description: "TikTok Video Ultra Fast ⚡",
})(async (message, match) => {

  if (!match) return message.send("_Provide TikTok URL_");

  const url = match.trim();

  if (!/tiktok\.com|vt\.tiktok\.com/.test(url)) {
    return message.send("_Invalid TikTok link_");
  }

  try {
    message.react?.("⚡");

    const data = await fetchTikTok(url);

    if (!data?.video) {
      return message.send("_❌ Video not found_");
    }

    await message.send({
      video: { url: data.video },
      mimetype: "video/mp4",
      caption: `🎬 TikTok Video\n⚡ Quality: ${data.quality}\n\nGᴇɴᴇʀᴀᴛᴇᴅ ʙʏ 〆͎ＭＲ－Ｒａｂｂｉｔ`,
    });

    message.react?.("✅");

  } catch (err) {
    console.error("[TT VIDEO ERROR]:", err?.message || err);
    message.send("_⚠️ Failed to download video_");
  }
});

/* 🎵 MP3 COMMAND (Rich Preview Style) */
Module({
  command: "tiktokmp3",
  package: "downloader",
  description: "TikTok Audio Downloader ⚡",
})(async (message, match) => {

  if (!match) return message.send("_Provide TikTok URL_");

  const url = match.trim();

  if (!/tiktok\.com|vt\.tiktok\.com/.test(url)) {
    return message.send("_Invalid TikTok link_");
  }

  try {
    await message.react("🎧");

    const data = await fetchTikTok(url);

    if (!data?.audio) {
      return message.send("_❌ Audio not found_");
    }

    /* ⚡ Fetch audio buffer */
    const audioBuffer = await axios.get(data.audio, {
      responseType: "arraybuffer",
      timeout: 15000,
    });

    /* ⚡ Fetch thumbnail */
    let thumbBuffer = null;
    try {
      if (data.thumbnail) {
        const thumb = await axios.get(data.thumbnail, {
          responseType: "arraybuffer",
          timeout: 10000,
        });
        thumbBuffer = Buffer.from(thumb.data);
      }
    } catch {}

    /* ⚡ Send audio with rich preview */
    await message.conn.sendMessage(message.from, {
      audio: Buffer.from(audioBuffer.data),
      mimetype: "audio/mpeg",
      fileName: `${data.title}.mp3`,
      contextInfo: {
        externalAdReply: {
          title: data.title,
          body: `Gᴇɴᴇʀᴀᴛᴇᴅ ʙʏ 〆͎ＭＲ－Ｒａｂｂｉｔ`,
          thumbnail: thumbBuffer,
          mediaType: 2,
          mediaUrl: url,
          sourceUrl: url,
        },
      },
    });

    await message.react("✅");

  } catch (err) {
    console.error("[TT MP3 ERROR]:", err?.message || err);
    message.send("_⚠️ Failed to fetch audio_");
  }
});
