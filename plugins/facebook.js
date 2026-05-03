// fb-plugin.js
import axios from "axios";
import { Module } from "../lib/plugins.js";

/* ⚡ Keep-Alive Agents (faster networking) */
import http from "http";
import https from "https";

const axiosInstance = axios.create({
  timeout: 12000,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/* ⚡ Get video (parallel APIs for ultra speed) */
async function getVideo(url) {
  try {
    const [res1, res2] = await Promise.allSettled([
      axiosInstance.get(
        `https://www.apiskeith.top/download/fbdown?url=${encodeURIComponent(url)}`
      ),
      axiosInstance.get(
        `https://www.apiskeith.top/download/fbdl?url=${encodeURIComponent(url)}`
      ),
    ]);

    // 🔥 Priority: HD
    if (res1.status === "fulfilled") {
      const media = res1.value.data?.result?.media;
      if (media?.hd) return { url: media.hd, quality: "HD" };
      if (media?.sd) return { url: media.sd, quality: "SD" };
    }

    // 🔥 Fallback
    if (res2.status === "fulfilled") {
      const video = res2.value.data?.result;
      if (video) return { url: video, quality: "SD" };
    }
  } catch {}

  return null;
}

Module({
  command: "fb",
  package: "downloader",
  description: "Facebook Ultra Fast Downloader ⚡",
})(async (message, match) => {
  if (!match) return message.send("_Please provide a Facebook URL_");

  const url = match.trim();

  // ✅ Validate Facebook link
  if (!/facebook\.com|fb\.watch/.test(url)) {
    return message.send("_Please provide a valid Facebook link_");
  }

  try {
    message.react?.("⚡"); // fast reaction (no await)

    /* ⚡ Fetch video */
    const video = await getVideo(url);

    if (!video?.url) {
      return message.send("_❌ Video not found_");
    }

    /* ⚡ Direct send (zero storage) */
    await message.send({
      video: { url: video.url },
      mimetype: "video/mp4",
      caption: `🎬 Facebook Video\n⚡ Quality: ${video.quality}\n\nGᴇɴᴇʀᴀᴛᴇᴅ ʙʏ 〆͎ＭＲ－Ｒａｂｂｉｔ`,
    });

    message.react?.("✅");
  } catch (err) {
    console.error("[FB ERROR]:", err?.message || err);
    message.send("_⚠️ Failed to download video_");
  }
});
