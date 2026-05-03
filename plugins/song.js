import fs from "fs";
import axios from "axios";
import fetch from "node-fetch";
import os from "os";
import path from "path";
import yts from "yt-search";
import { File } from "megajs";
import { promisify } from "util";
import stream from "stream";
import { fileURLToPath } from "url";
import { Module } from "../lib/plugins.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { Readable, PassThrough } from "stream";
const pipeline = promisify(stream.pipeline);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
ffmpeg.setFfmpegPath(ffmpegPath);

// --- CONFIG ---
const PROXY = process.env.YT_PROXY || "https://app.ytdown.to/proxy.php";

/* -------------------- Helpers -------------------- */
async function downloadToTemp(url, ext = "") {
  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const filename = `file_${Date.now()}${Math.random()
    .toString(36)
    .slice(2, 8)}${ext}`;
  const outPath = path.join(tempDir, filename);
  const res = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 180000,
  });
  await pipeline(res.data, fs.createWriteStream(outPath));
  return outPath;
}
function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {}
}
function makeGiftQuote(pushname, sender) {
  return {
    key: {
      fromMe: false,
      participant: `0@s.whatsapp.net`,
      remoteJid: "status@broadcast",
    },
    message: {
      contactMessage: {
        displayName: pushname || "User",
        vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;${pushname || "User"};;\nFN:${
          pushname || "User"
        }\nitem1.TEL;waid=${(sender || "").split("@")[0]}:${
          (sender || "").split("@")[0]
        }\nitem1.X-ABLabel:WhatsApp\nEND:VCARD`,
      },
    },
  };
}
function ytUrlFromInput(input) {
  const urlRegex = /(?:youtube\.com\/.*v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  if (urlRegex.test(input)) return input;
  return null;
}

/* -------------------- Proxy / Scraper wrappers -------------------- */
import qs from "querystring";
async function postProxy(url, timeout = 20000, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const body = qs.stringify({ url });
      const resp = await axios.post(PROXY, body, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        timeout,
      });
      return resp.data;
    } catch (err) {
      lastErr = err;
      await new Promise((res) =>
        setTimeout(
          res,
          Math.min(200 * Math.pow(2, i), 5000) + Math.floor(Math.random() * 300)
        )
      );
    }
  }
  throw new Error(
    "proxy POST failed: " +
      (lastErr && lastErr.message ? lastErr.message : String(lastErr))
  );
}

async function findMediaItemsForYoutube(youtubeUrl, attempts = 6) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await postProxy(youtubeUrl, 20000, 2).catch((e) => {
      throw e;
    });
    if (
      last &&
      last.api &&
      Array.isArray(last.api.mediaItems) &&
      last.api.mediaItems.length
    )
      return last;
    await new Promise((res) => setTimeout(res, 250 * Math.pow(2, i)));
  }
  return last;
}

async function exchangeForFileUrl(mediaUrl) {
  const resp = await postProxy(mediaUrl, 20000, 3);
  if (!resp || !resp.api || !resp.api.fileUrl)
    throw new Error("No fileUrl in response for mediaUrl");
  return resp.api.fileUrl;
}

function pickAudio(items) {
  if (!Array.isArray(items)) return null;
  const audio = items.filter((i) => i.type && i.type.toLowerCase() === "audio");
  if (!audio.length) return null;
  let best = audio.find(
    (i) =>
      (i.mediaQuality && /128/.test(i.mediaQuality)) ||
      (i.mediaUrl && /\/128k|128k/i.test(i.mediaUrl))
  );
  if (best) return best;
  return audio[0];
}
function pickVideo(items, preferRes) {
  if (!Array.isArray(items)) return null;
  const videos = items.filter(
    (i) => i.type && i.type.toLowerCase() === "video"
  );
  if (!videos.length) return null;
  if (preferRes) {
    const exact = videos.find(
      (v) =>
        (v.mediaRes && v.mediaRes.includes(preferRes)) ||
        (v.mediaUrl && v.mediaUrl.includes(preferRes))
    );
    if (exact) return exact;
  }
  videos.sort((a, b) => {
    const getW = (v) => {
      if (!v) return 0;
      if (v.mediaRes && v.mediaRes.includes("x")) {
        const px = parseInt(v.mediaRes.split("x")[0], 10);
        return isNaN(px) ? 0 : px;
      }
      if (v.mediaQuality) {
        const m = v.mediaQuality.match(/(\d{3,4})/);
        return m ? parseInt(m[1], 10) : 0;
      }
      return 0;
    };
    return getW(b) - getW(a);
  });
  return videos[0];
}

function getMetaFromApiResp(apiResp) {
  if (!apiResp || !apiResp.api) return {};
  const a = apiResp.api;
  return {
    title:
      a.title ||
      a.videoTitle ||
      a.info?.title ||
      (a.mediaItems && a.mediaItems[0] && a.mediaItems[0].title) ||
      null,
    thumbnail:
      a.thumbnail ||
      a.thumb ||
      a.info?.thumbnail ||
      (a.mediaItems && a.mediaItems[0] && a.mediaItems[0].thumbnail) ||
      null,
    timestamp: a.timestamp || a.duration || a.info?.duration || null,
    description: a.description || a.info?.description || null,
  };
}

/* -------------------- Download wrappers that replace old API calls -------------------- */
/**
 * Download MP3 (accepts either a direct YouTube URL, or a search query)
 * Returns an object similar to API `result` (must contain a download link)
 */
export async function downloadYtAudio(input) {
  // determine if input is a URL or search query
  let ytUrl = ytUrlFromInput(input);
  if (!ytUrl) {
    // treat as query
    const search = await yts(input);
    if (!search || !search.videos || !search.videos.length)
      throw new Error("No search results");
    ytUrl = search.videos[0].url;
  }

  const apiResp = await findMediaItemsForYoutube(ytUrl, 6);
  if (!(apiResp && apiResp.api && Array.isArray(apiResp.api.mediaItems))) {
    throw new Error("No mediaItems from proxy for audio");
  }
  const items = apiResp.api.mediaItems;
  const audioItem = pickAudio(items);
  if (!audioItem) throw new Error("No audio item found in mediaItems");
  const fileUrl = await exchangeForFileUrl(audioItem.mediaUrl);
  const meta = getMetaFromApiResp(apiResp);
  const result = {
    title: meta.title || audioItem.title || "audio",
    thumbnail: meta.thumbnail || audioItem.thumbnail || null,
    timestamp: meta.timestamp || audioItem.duration || null,
    download: fileUrl,
    source: ytUrl,
    raw: apiResp,
  };
  return result;
}

/**
 * Download MP4 (accepts either a direct YouTube URL, or a search query)
 * resolution: "720", "480", etc.
 */
export async function downloadYtVideo(input, resolution = "720") {
  let ytUrl = ytUrlFromInput(input);
  if (!ytUrl) {
    const search = await yts(input);
    if (!search || !search.videos || !search.videos.length)
      throw new Error("No search results");
    ytUrl = search.videos[0].url;
  }

  const apiResp = await findMediaItemsForYoutube(ytUrl, 6);
  if (!(apiResp && apiResp.api && Array.isArray(apiResp.api.mediaItems))) {
    throw new Error("No mediaItems from proxy for video");
  }
  const items = apiResp.api.mediaItems;
  const videoItem = pickVideo(items, resolution);
  if (!videoItem) throw new Error("No video item found in mediaItems");
  const fileUrl = await exchangeForFileUrl(videoItem.mediaUrl);
  const meta = getMetaFromApiResp(apiResp);
  const result = {
    title: meta.title || videoItem.title || "video",
    thumbnail: meta.thumbnail || videoItem.thumbnail || null,
    timestamp: meta.timestamp || videoItem.duration || null,
    download: fileUrl,
    format: videoItem.mediaRes || resolution,
    source: ytUrl,
    raw: apiResp,
  };
  return result;
}

/* -------------------- Handlers (mostly unchanged) -------------------- */

export async function handleSongDownload(conn, input, message) {
  try {
    await message.react?.("🔍");

    const r = await downloadYtAudio(input);
    if (!r?.download) throw new Error("Invalid download URL");

    await message.react?.("⬇️");

    // 1️⃣ Fetch m4a as buffer
    const audioRes = await axios.get(r.download, {
      responseType: "arraybuffer",
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const m4aBuffer = Buffer.from(audioRes.data);

    // 2️⃣ Convert m4a → mp3 (stable settings)
    const mp3Buffer = await new Promise((resolve, reject) => {
      const chunks = [];

      const stream = new Readable();
      stream.push(m4aBuffer);
      stream.push(null);

      const passThrough = ffmpeg(stream)
        .audioCodec("libmp3lame")
        .audioBitrate(128)
        .audioChannels(2)
        .audioFrequency(44100)
        .format("mp3")
        .on("error", reject)
        .pipe();
      passThrough.on("data", (chunk) => chunks.push(chunk));
      passThrough.on("end", () => resolve(Buffer.concat(chunks)));
      passThrough.on("error", reject);
    });

    // 3️⃣ Send as normal audio (NOT voice note)
    await conn.sendMessage(
      message.from,
      {
        audio: mp3Buffer,
        mimetype: "audio/mpeg",
        ptt: false,
      },
      {
        quoted: makeGiftQuote("۵♡༏༏ 𝕽ꫝ፝֟፝ʙʙɪ𝖙 ꧕༊", message.bot),
      }
    );

    await message.react?.("✅");
  } catch (err) {
    console.error("[PLUGIN SONG] Error:", err?.message || err);
    await message.send?.("⚠️ Song download failed. Please try again later.");
  }
}

export async function handleVideoDownload(
  conn,
  input,
  message,
  resolution = "720"
) {
  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt === 1) {
        await message.react?.("⬇️");
      }

      const r = await downloadYtVideo(input, resolution);
      const tempPath = await downloadToTemp(r.download, ".mp4");
      const videoBuffer = fs.readFileSync(tempPath);

      let thumbBuf;
      if (r.thumbnail) {
        try {
          const t = await axios.get(r.thumbnail, {
            responseType: "arraybuffer",
          });
          thumbBuf = Buffer.from(t.data);
        } catch {
          thumbBuf = undefined;
        }
      }

      const caption = `*${r.title || "Video"}*\n\n📹 Quality: ${
        r.format || resolution
      }\n⏱️ ${r.timestamp || ""}`;

      await conn.sendMessage(message.from, {
        video: videoBuffer,
        caption,
        jpegThumbnail: thumbBuf,
      });

      await message.react?.("✅");
      safeUnlink(tempPath);

      return;
    } catch (err) {
      lastError = err;
      console.error(
        `[PLUGIN VIDEO] Attempt ${attempt} Error:`,
        err?.message || err
      );

      if (attempt === 1) {
        await delay(3000);
      }
    }
  }

  await message.send?.("⚠️ Video download failed. Please try again later.");
}

/* -------------------- Module registrations -------------------- */
Module({
  command: "yts",
  package: "search",
  description: "Search YouTube videos",
})(async (message, match) => {
  if (!match) return await message.send("Please provide a search query");
  const query = match.trim();
  const results = await (async (q) => {
    // reuse the existing ytSearch using Google API key-less fallback to yts (yt-search)
    try {
      const res = await yts(q, { pages: 1 });
      return res && res.videos
        ? res.videos.map((v) => ({
            id: v.videoId,
            title: v.title,
            url: v.url,
            thumbnail: v.thumbnail,
            channel: v.author && v.author.name,
            publishedAt: v.ago,
          }))
        : [];
    } catch (e) {
      return [];
    }
  })(query);
  if (!results.length) return await message.send("❌ No results found");
  let reply = `*YouTube results for "${query}":*\n\n`;
  results.forEach((v, i) => {
    const date = v.publishedAt || "";
    reply += `⬢ ${i + 1}. ${v.title}\n   Channel: ${
      v.channel || ""
    }\n   Published: ${date}\n   Link: ${v.url}\n\n`;
  });
  await message.send({ image: { url: results[0].thumbnail }, caption: reply });
});

Module({
  command: "song",
  package: "downloader",
  description: "Download audio from YouTube",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or song name_");
  let input = match.trim();
  try {
    await handleSongDownload(message.conn, input, message);
  } catch (err) {
    console.error("[PLUGIN SONG] Error:", err?.message || err);
    await message.send("⚠️ Song download failed. Please try again later.");
  }
});

Module({
  command: "mp4",
  package: "downloader",
  description: "Download YouTube MP4",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or video name_");
  let input = match.trim();
  try {
    await handleVideoDownload(message.conn, input, message, "720");
  } catch (err) {
    console.error("[PLUGIN MP4] Error:", err?.message || err);
    await message.send("⚠️ Video download failed. Please try again later.");
  }
});

Module({
  command: "video",
  package: "downloader",
  description: "Download YouTube Video",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or video name_");
  let input = match.trim();
  try {
    await handleVideoDownload(message.conn, input, message, "720");
  } catch (err) {
    console.error("[PLUGIN VIDEO] Error:", err?.message || err);
    await message.send("⚠️ Video download failed. Please try again later.");
  }
});

Module({
  command: "ytv",
  package: "downloader",
  description: "Download YouTube Video",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or video name_");
  let input = match.trim();
  try {
    await handleVideoDownload(message.conn, input, message, "720");
  } catch (err) {
    console.error("[PLUGIN YTV] Error:", err?.message || err);
    await message.send("⚠️ Video download failed. Please try again later.");
  }
});

Module({
  command: "yta",
  package: "downloader",
  description: "Download YouTube Audio",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or song name_");
  let input = match.trim();
  try {
    await handleSongDownload(message.conn, input, message);
  } catch (err) {
    console.error("[PLUGIN YTA] Error:", err?.message || err);
    await message.send("⚠️ Audio download failed. Please try again later.");
  }
});

Module({
  command: "ytmp3",
  package: "downloader",
  description: "Download YouTube MP3",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or song name_");
  let input = match.trim();
  try {
    await handleSongDownload(message.conn, input, message);
  } catch (err) {
    console.error("[PLUGIN YTMP3] Error:", err?.message || err);
    await message.send("⚠️ MP3 download failed. Please try again later.");
  }
});

/* ----------------- GitClone ----------------- */
Module({
  command: "gitclone",
  package: "downloader",
  description: "Download GitHub repository as zip",
})(async (message, match) => {
  const arg = (match || "").trim();
  if (!arg)
    return message.send(
      "❌ Provide a GitHub link.\n\nExample:\n.gitclone https://github.com/username/repository"
    );
  try {
    const link = arg.split(/\s+/)[0];
    const regex = /github\.com\/([^\/]+)\/([^\/]+)(?:\.git)?/i;
    const m = link.match(regex);
    if (!m) return message.send("⚠️ Invalid GitHub repository format.");
    const [, username, repo] = m;
    const zipUrl = `https://api.github.com/repos/${username}/${repo}/zipball`;
    // Confirm repository exists
    const head = await fetch(zipUrl, { method: "HEAD" });
    if (!head.ok) return message.send("Repository not found or private.");
    const filename = `${repo}.zip`;
    await message.conn.sendMessage(
      message.from,
      {
        document: { url: zipUrl },
        fileName: filename,
        mimetype: "application/zip",
        caption: `GitHub: ${username}/${repo}`,
      },
      { quoted: message.raw }
    );
    await message.react("✅");
  } catch (err) {
    console.error("GitClone Error:", err);
    await message.react("❌");
    return message.send(
      "❌ Failed to download repository. Please try again later."
    );
  }
});
/* ----------------- APK Downloader ----------------- */
Module({
  command: "apk",
  package: "downloader",
  description: "Download APK files using NexOracle API",
})(async (message, match) => {
  const appName = (match || "").trim();
  if (!appName) return message.send("*🏷️ Please provide an app name.*");
  try {
    await message.react("⏳");
    const apiUrl = `https://api.nexoracle.com/downloader/apk`;
    const params = { apikey: "free_key@maher_apis", q: appName };
    const res = await axios.get(apiUrl, { params }).catch(() => null);
    if (!res || !res.data || res.data.status !== 200 || !res.data.result) {
      await message.react("❌");
      return message.send("❌ Unable to find the APK. Please try again later.");
    }
    const { name, lastup, package: pkg, size, icon, dllink } = res.data.result;
    // send metadata first
    await message.conn.sendMessage(
      message.from,
      {
        image: { url: icon },
        caption: `\`「 APK DOWNLOADED 」\`\nName: ${name}\nUpdated: ${lastup}\nPackage: ${pkg}\nSize: ${size}\nSending APK...`,
      },
      { quoted: message.raw }
    );
    const apkRes = await axios
      .get(dllink, { responseType: "arraybuffer" })
      .catch(() => null);
    if (!apkRes || !apkRes.data) {
      await message.react("❌");
      return message.send("❌ Failed to download the APK.");
    }
    await message.conn.sendMessage(
      message.from,
      {
        document: Buffer.from(apkRes.data),
        mimetype: "application/vnd.android.package-archive",
        fileName: `${name}.apk`,
        caption: "APK file",
      },
      { quoted: message.raw }
    );
    await message.react("✅");
  } catch (err) {
    console.error("APK Error:", err);
    await message.react("❌");
    return message.send("❌ Unable to fetch APK details.");
  }
});

/* ----------------- Mega.nz Downloader ----------------- */
Module({
  command: "mega",
  package: "downloader",
  description: "Download files from Mega.nz",
})(async (message, match) => {
  const q = (match || "").trim();
  if (!q) return message.send("❌ Please provide a Mega.nz link!");
  try {
    await message.react("⏳");
    const file = File.fromURL(q);
    const data = await new Promise((resolve, reject) =>
      file.download((err, data) => (err ? reject(err) : resolve(data)))
    );
    const fileName = file.name || `mega_file_${Date.now()}`;
    const savePath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(savePath, data);
    await message.conn.sendMessage(
      message.from,
      {
        document: fs.readFileSync(savePath),
        fileName,
        mimetype: "application/octet-stream",
        caption: `Downloaded from Mega.nz: ${fileName}`,
      },
      { quoted: message.raw }
    );
    fs.unlinkSync(savePath);
    await message.react("✅");
  } catch (err) {
    console.error("MegaDL Error:", err);
    await message.react("❌");
    return message.send("❌ Failed to download from Mega.nz.");
  }
});
