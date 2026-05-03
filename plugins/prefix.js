// plugins/prefix.js — Per-session custom prefix management
import { Module } from "../lib/plugins.js";
import { db, getPrefix } from "../lib/client.js";

function getBotNum(conn) {
  const raw = conn?.user?.id || "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "") || null;
}

Module({
  command: "prefix",
  package: "owner",
  description: "Set custom prefix per session. Use 'null' or 'off' for prefix-less mode.",
  usage: ".prefix . | .prefix ! | .prefix null | .prefix off",
})(async (message, match) => {
  if (!(message.isFromMe || message.isfromMe)) return message.send("_Only bot owner can use this._");
  const botNum = getBotNum(message.conn);
  if (!botNum) return message.send("Bot number not found.");

  const input = (match || "").trim();

  if (!input) {
    const current = getPrefix(botNum);
    return message.send(
      `Prefix Settings\n` +
      `Current: ${current === null ? "None (prefix-less mode)" : current}\n\n` +
      `Usage:\n` +
      `.prefix .   set prefix to dot\n` +
      `.prefix !   set prefix to !\n` +
      `.prefix null   prefix-less mode\n` +
      `.prefix off    same as null\n` +
      `.prefix reset  reset to default`
    );
  }

  if (input === "null" || input === "off" || input === "false") {
    db.setHot(botNum, "prefix", false);
    await message.react("✅");
    return message.send("Prefix-less mode enabled. Commands work without any prefix.");
  }

  if (input === "reset" || input === "default") {
    db.setHot(botNum, "prefix", null);
    await message.react("✅");
    return message.send("Prefix reset to default: " + (process.env.PREFIX || "."));
  }

  if (input.length > 5) return message.send("Prefix too long (max 5 chars).");

  db.setHot(botNum, "prefix", input);
  await message.react("✅");
  return message.send("Prefix set to: " + input);
});
