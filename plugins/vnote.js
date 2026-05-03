import { Module } from '../lib/plugins.js';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import os from 'os';

ffmpeg.setFfmpegPath(ffmpegPath);

Module({
  command: "vnote",
  description: "Convert replied audio/video to voice note",
  package: "tools",
})(async (message) => {
  if (!message.quoted) return message.send("❌ Reply to an audio or video");

  const mime = message.quoted?.mimetype || message.quoted?.msg?.mimetype || "";
  if (!/audio|video/.test(mime)) return message.send("❌ Only audio or video supported");

  await message.react("⏳");
  const buffer = await message.quoted.download();

  const inFile = path.join(os.tmpdir(), `vnote_in_${Date.now()}.mp4`);
  const outFile = path.join(os.tmpdir(), `vnote_out_${Date.now()}.ogg`);
  fs.writeFileSync(inFile, buffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inFile)
        .audioCodec("libopus")
        .audioBitrate("48k")
        .noVideo()
        .format("ogg")
        .on("error", reject)
        .on("end", resolve)
        .save(outFile);
    });

    const voice = fs.readFileSync(outFile);
    await message.send({ audio: voice, mimetype: "audio/ogg; codecs=opus", ptt: true });
    await message.react("✅");
  } catch (e) {
    console.error(e);
    message.send("❌ Voice note conversion failed");
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
});
