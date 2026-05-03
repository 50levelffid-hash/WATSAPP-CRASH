// plugins/antidelete.js — Advanced AntiDelete with dest/scope system
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";

function getBotNum(conn) {
  const raw = conn?.user?.id || "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "") || null;
}

// ── Parser ────────────────────────────────────────────────────────────────────
// .delete g          → dest=g, scope=all
// .delete p          → dest=p, scope=all
// .delete g pm       → dest=g, scope=pm
// .delete g gm       → dest=g, scope=gm
// .delete p no-gm    → dest=p, scope=no-gm
// .delete p no-pm    → dest=p, scope=no-pm
// .delete <jid>      → dest=<jid>, scope=all
// .delete <jid> gm   → dest=<jid>, scope=gm
// .delete off        → disable

function parseCfg(input) {
  const parts = input.trim().split(/\s+/);
  if (!parts[0]) return null;

  if (parts[0] === "off") return false;

  const dest  = parts[0]; // "g", "p", or JID
  const scope = parts[1] || "all"; // "pm","gm","no-pm","no-gm","all"

  const validScopes = ["all","pm","gm","no-pm","no-gm"];
  const resolvedScope = validScopes.includes(scope) ? scope : "all";

  return { dest, scope: resolvedScope };
}

const STATUS_TEXT = (cfg) => {
  if (!cfg) return "❌ OFF";
  const destLabel = cfg.dest === "g" ? "Same Chat" : cfg.dest === "p" ? "Your PM/Sudo" : cfg.dest;
  const scopeLabel = { all: "All Messages", pm: "PM Only", gm: "Group Only", "no-pm": "Exclude PM", "no-gm": "Exclude Groups" }[cfg.scope] || cfg.scope;
  return `✅ ON\n📤 *Destination:* ${destLabel}\n🔍 *Scope:* ${scopeLabel}`;
};

Module({
  command: "delete",
  aliases: ["antidelete", "antidel", "adel"],
  package: "owner",
  description: "Advanced AntiDelete — track & reveal deleted messages",
})(async (message, match) => {
  if (!(message.isFromMe || message.isfromMe)) return message.send("_Only bot owner can use this._");
  const botNum = getBotNum(message.conn);
  if (!botNum) return message.send("❌ Bot number not found.");

  const input = (match || "").trim().toLowerCase();

  if (!input) {
    const cfg = db.get(botNum, "antidelete", false);
    return message.send(
      `🗑️ *AntiDelete*\n` +
      `> Status: ${STATUS_TEXT(cfg)}\n\n` +
      `*Usage Examples:*\n` +
      `• \`.delete g\` — Same chat\n` +
      `• \`.delete p\` — Your PM/sudo\n` +
      `• \`.delete g pm\` — Same chat, PM only\n` +
      `• \`.delete g gm\` — Same chat, groups only\n` +
      `• \`.delete p no-gm\` — PM, exclude groups\n` +
      `• \`.delete p no-pm\` — PM, exclude personal\n` +
      `• \`.delete <jid>\` — Send to specific JID\n` +
      `• \`.delete <jid> gm\` — JID, groups only\n` +
      `• \`.delete off\` — Disable\n\n` +
      `*Scopes:* pm, gm, no-pm, no-gm`
    );
  }

  await message.react("⏳");
  const cfg = parseCfg(input);

  if (cfg === false) {
    db.setHot(botNum, "antidelete", false);
    await message.react("✅");
    return message.send("🗑️ *AntiDelete* disabled.");
  }

  db.setHot(botNum, "antidelete", cfg);
  await message.react("✅");

  const destLabel = cfg.dest === "g" ? "Same Chat" : cfg.dest === "p" ? "Your PM/Sudo" : cfg.dest;
  const scopeLabel = { all: "All Messages", pm: "PM Only", gm: "Group Only", "no-pm": "Exclude PM", "no-gm": "Exclude Groups" }[cfg.scope] || cfg.scope;

  return message.send(
    `🗑️ *AntiDelete ENABLED*\n` +
    `📤 *Destination:* ${destLabel}\n` +
    `🔍 *Scope:* ${scopeLabel}`
  );
});
