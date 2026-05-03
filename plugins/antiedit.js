// plugins/antiedit.js — Advanced AntiEdit with dest/scope system
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";

function getBotNum(conn) {
  const raw = conn?.user?.id || "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "") || null;
}

function parseCfg(input) {
  const parts = input.trim().split(/\s+/);
  if (!parts[0]) return null;
  if (parts[0] === "off") return false;

  const dest  = parts[0];
  const scope = parts[1] || "all";
  const validScopes = ["all","pm","gm","no-pm","no-gm"];
  return { dest, scope: validScopes.includes(scope) ? scope : "all" };
}

const STATUS_TEXT = (cfg) => {
  if (!cfg) return "❌ OFF";
  const destLabel  = cfg.dest === "g" ? "Same Chat" : cfg.dest === "p" ? "Your PM/Sudo" : cfg.dest;
  const scopeLabel = { all:"All",pm:"PM Only",gm:"Group Only","no-pm":"Exclude PM","no-gm":"Exclude Groups" }[cfg.scope] || cfg.scope;
  return `✅ ON\n📤 *Destination:* ${destLabel}\n🔍 *Scope:* ${scopeLabel}`;
};

Module({
  command: "antiedit",
  aliases: ["aedit"],
  package: "owner",
  description: "Advanced AntiEdit — reveal original message before edit",
})(async (message, match) => {
  if (!(message.isFromMe || message.isfromMe)) return message.send("_Only bot owner can use this._");
  const botNum = getBotNum(message.conn);
  if (!botNum) return message.send("❌ Bot number not found.");

  const input = (match || "").trim().toLowerCase();

  if (!input) {
    const cfg = db.get(botNum, "antiedit", false);
    return message.send(
      `✏️ *AntiEdit*\n` +
      `> Status: ${STATUS_TEXT(cfg)}\n\n` +
      `*Usage Examples:*\n` +
      `• \`.antiedit g\` — Same chat\n` +
      `• \`.antiedit p\` — Your PM/sudo\n` +
      `• \`.antiedit g pm\` — Same chat, PM only\n` +
      `• \`.antiedit g gm\` — Same chat, groups only\n` +
      `• \`.antiedit p no-gm\` — PM, exclude groups\n` +
      `• \`.antiedit p no-pm\` — PM, exclude personal\n` +
      `• \`.antiedit <jid>\` — Send to specific JID\n` +
      `• \`.antiedit <jid> gm\` — JID, groups only\n` +
      `• \`.antiedit off\` — Disable\n\n` +
      `*Scopes:* pm, gm, no-pm, no-gm`
    );
  }

  await message.react("⏳");
  const cfg = parseCfg(input);

  if (cfg === false) {
    db.setHot(botNum, "antiedit", false);
    await message.react("✅");
    return message.send("✏️ *AntiEdit* disabled.");
  }

  db.setHot(botNum, "antiedit", cfg);
  await message.react("✅");

  const destLabel  = cfg.dest === "g" ? "Same Chat" : cfg.dest === "p" ? "Your PM/Sudo" : cfg.dest;
  const scopeLabel = { all:"All",pm:"PM Only",gm:"Group Only","no-pm":"Exclude PM","no-gm":"Exclude Groups" }[cfg.scope] || cfg.scope;

  return message.send(
    `✏️ *AntiEdit ENABLED*\n` +
    `📤 *Destination:* ${destLabel}\n` +
    `🔍 *Scope:* ${scopeLabel}`
  );
});
