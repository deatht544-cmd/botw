const chalk = require("chalk");
const { loadSettings, updateSetting } = require("./lib/settings");
const { isOwner, getMessageText, getMessageType, getQuotedMessage, formatNumber } = require("./lib/utils");
const fs = require("fs");
const path = require("path");

// Load all plugins dynamically
const plugins = {};
const pluginsDir = path.join(__dirname, "plugins");

function loadPlugins() {
  if (!fs.existsSync(pluginsDir)) return;
  const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith(".js"));
  for (const file of files) {
    try {
      const plugin = require(`./plugins/${file}`);
      const name = file.replace(".js", "");
      plugins[name] = plugin;
      console.log(chalk.green(`✅ Plugin loaded: ${name}`));
    } catch (e) {
      console.log(chalk.red(`❌ Plugin error [${file}]: ${e.message}`));
    }
  }
}

loadPlugins();

// Status viewed senders (anti-view-once memory)
const statusViewedJids = new Set();

async function handleMessage(sock, msg, store) {
  const settings = loadSettings();
  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith("@g.us");
  const sender = isGroup ? msg.key.participant : jid;
  const fromMe = msg.key.fromMe;
  const msgType = getMessageType(msg);
  const body = getMessageText(msg);
  const prefix = settings.prefix;
  const isCmd = body.startsWith(prefix);
  const cmd = isCmd ? body.slice(prefix.length).trim().split(" ")[0].toLowerCase() : "";
  const args = isCmd ? body.slice(prefix.length).trim().split(" ").slice(1) : [];
  const text = args.join(" ");
  const isOwnerSender = isOwner(sender);

  // ─── Status Updates ───────────────────────────────
  if (jid === "status@broadcast") {
    // Auto Seen
    if (settings.autoStatusSeen) {
      await sock.readMessages([msg.key]).catch(() => {});
    }

    // Auto React
    if (settings.autoStatusReact) {
      await sock.sendMessage(jid, {
        react: { text: settings.statusReactEmoji, key: msg.key },
      }).catch(() => {});
    }

    // Auto Save Status
    if (settings.autoStatusSave && msgType) {
      await saveStatus(sock, msg, sender, msgType);
    }
    return;
  }

  // ─── Anti Call ─────────────────────────────────────
  if (msgType === "call") {
    if (settings.antiCall) {
      const callKey = msg.message?.call;
      if (callKey) {
        await sock.rejectCall(callKey.id, callKey.from).catch(() => {});
        await sock.sendMessage(jid, {
          text: `❌ *NEXUS-XD | Anti-Call*\n\n📵 Calls are disabled!\nContact owner: wa.me/${settings.ownerNumber}`,
        }).catch(() => {});
      }
    }
    return;
  }

  // ─── Anti Delete ───────────────────────────────────
  if (msgType === "protocolMessage" && settings.antiDelete) {
    const proto = msg.message?.protocolMessage;
    if (proto?.type === 0) {
      const deletedKey = proto.key;
      const deletedMsg = store?.loadMessage?.(deletedKey.remoteJid, deletedKey.id);
      if (deletedMsg) {
        const deletedText = getMessageText(deletedMsg);
        if (deletedText) {
          await sock.sendMessage(jid, {
            text: `🗑️ *NEXUS-XD | Anti-Delete*\n\n👤 *From:* @${formatNumber(sender)}\n💬 *Deleted Message:* ${deletedText}`,
            mentions: [sender],
          }).catch(() => {});
        }
      }
    }
    return;
  }

  // ─── Anti View Once ─────────────────────────────────
  if (settings.antiViewOnce && msgType === "viewOnceMessage") {
    const vMsg = msg.message?.viewOnceMessage?.message;
    if (vMsg) {
      try {
        await sock.sendMessage(jid, {
          forward: { key: msg.key, message: { ...msg.message, viewOnceMessage: undefined, ...vMsg } },
        }).catch(() => {});
      } catch {}
    }
    return;
  }

  // ─── Auto Save Contact ─────────────────────────────
  if (settings.autoSaveContact && msgType === "contactMessage") {
    const contact = msg.message?.contactMessage;
    if (contact) {
      await sock.sendMessage(jid, {
        text: `✅ *NEXUS-XD | Contact Saved*\n👤 ${contact.displayName}\n📞 Saved automatically!`,
      }).catch(() => {});
    }
  }

  // ─── Always Online/Offline ─────────────────────────
  if (settings.alwaysOnline) {
    await sock.sendPresenceUpdate("available", jid).catch(() => {});
  }

  // ─── Commands ──────────────────────────────────────
  if (!isCmd) return;

  // Check bot mode
  if (settings.botMode === "private" && !isOwnerSender) return;

  console.log(chalk.cyan(`📨 CMD: .${cmd} | FROM: ${formatNumber(sender)} | GROUP: ${isGroup}`));

  // Route to plugin handlers
  const ctx = { sock, msg, jid, sender, isGroup, isOwnerSender, args, text, settings, body, cmd, prefix, store };

  // ─── Built-in Menu ─────────────────────────────────
  if (cmd === "menu" || cmd === "help" || cmd === "start") {
    return await sendMenu(sock, jid, settings, isGroup);
  }

  // ─── Settings Commands ──────────────────────────────
  if (cmd === "settings") {
    return await sendSettingsMenu(sock, jid, settings);
  }

  // Route through plugins
  for (const [name, plugin] of Object.entries(plugins)) {
    if (typeof plugin.commands === "object" && plugin.commands[cmd]) {
      try {
        await plugin.commands[cmd](ctx);
        return;
      } catch (e) {
        console.log(chalk.red(`Plugin [${name}] error: ${e.message}`));
        await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` }).catch(() => {});
        return;
      }
    }
  }

  // Unknown command
  await sock.sendMessage(jid, {
    text: `❓ Unknown command: *${prefix}${cmd}*\nType *${prefix}menu* to see all commands.`,
  }).catch(() => {});
}

// ─── Save Status ──────────────────────────────────────
async function saveStatus(sock, msg, sender, msgType) {
  try {
    const statusDir = "./downloads/status";
    if (!fs.existsSync(statusDir)) fs.mkdirSync(statusDir, { recursive: true });

    const { downloadMediaMessage } = require("@whiskeysockets/baileys");
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const ext = msgType.includes("image") ? "jpg" : msgType.includes("video") ? "mp4" : "bin";
    const filename = `${Date.now()}_${formatNumber(sender)}.${ext}`;
    fs.writeFileSync(path.join(statusDir, filename), buffer);
  } catch {}
}

// ─── Main Menu ────────────────────────────────────────
async function sendMenu(sock, jid, settings, isGroup) {
  const s = settings;
  const e = s.menuEmoji;

  const menu = `
╔════════════════════════╗
║  ${e}  *NEXUS-XD BOT*  ${e}  ║
╚════════════════════════╝

👑 *Owner:* ${s.ownerName}
📞 *Contact:* wa.me/${s.ownerNumber}
🤖 *Mode:* ${s.botMode.toUpperCase()}
🔤 *Prefix:* ${s.prefix}

━━━━━━━━━━━━━━━━━━━━━━
🛡️ *PROTECTION*
━━━━━━━━━━━━━━━━━━━━━━
• \`${s.prefix}antidelete\` - Anti Delete ${s.antiDelete ? "✅" : "❌"}
• \`${s.prefix}anticall\` - Anti Call ${s.antiCall ? "✅" : "❌"}
• \`${s.prefix}antiviewonce\` - Anti View Once ${s.antiViewOnce ? "✅" : "❌"}

━━━━━━━━━━━━━━━━━━━━━━
📊 *STATUS*
━━━━━━━━━━━━━━━━━━━━━━
• \`${s.prefix}statusauto\` - Auto Status Seen/React/Save
• \`${s.prefix}statussave\` - Status Auto Save ${s.autoStatusSave ? "✅" : "❌"}
• \`${s.prefix}statusseen\` - Status Auto Seen ${s.autoStatusSeen ? "✅" : "❌"}
• \`${s.prefix}statusreact\` - Status Auto React ${s.autoStatusReact ? "✅" : "❌"}

━━━━━━━━━━━━━━━━━━━━━━
👥 *GROUP*
━━━━━━━━━━━━━━━━━━━━━━
• \`${s.prefix}groupinfo\` - Group Information
• \`${s.prefix}kick @user\` - Kick Member
• \`${s.prefix}add number\` - Add Member

━━━━━━━━━━━━━━━━━━━━━━
🔧 *TOOLS*
━━━━━━━━━━━━━━━━━━━━━━
• \`${s.prefix}getdp @user\` - Get Profile Picture
• \`${s.prefix}savecontact\` - Auto Save ${s.autoSaveContact ? "✅" : "❌"}
• \`${s.prefix}sticker\` - Make Sticker

━━━━━━━━━━━━━━━━━━━━━━
⚙️ *SETTINGS*
━━━━━━━━━━━━━━━━━━━━━━
• \`${s.prefix}settings\` - Settings Menu
• \`${s.prefix}online\` - Always Online
• \`${s.prefix}offline\` - Always Offline
• \`${s.prefix}setemoji 🔥\` - Set Status Emoji
• \`${s.prefix}setprefix .\` - Change Prefix
• \`${s.prefix}mode public/private\` - Bot Mode

━━━━━━━━━━━━━━━━━━━━━━
© 2024 NEXUS-XD | vishath kawshika
`.trim();

  await sock.sendMessage(jid, { text: menu });
}

// ─── Settings Menu ────────────────────────────────────
async function sendSettingsMenu(sock, jid, settings) {
  const s = settings;
  const on = "✅ ON";
  const off = "❌ OFF";

  const menu = `
╔════════════════════════╗
║  ⚙️  *NEXUS-XD SETTINGS*  ║
╚════════════════════════╝

🛡️ *PROTECTION SETTINGS*
├ Anti Delete: ${s.antiDelete ? on : off}
├ Anti Call: ${s.antiCall ? on : off}
└ Anti View Once: ${s.antiViewOnce ? on : off}

📊 *STATUS SETTINGS*
├ Auto Status Save: ${s.autoStatusSave ? on : off}
├ Auto Status Seen: ${s.autoStatusSeen ? on : off}
└ Auto Status React: ${s.autoStatusReact ? on : off}

🌐 *PRESENCE SETTINGS*
├ Always Online: ${s.alwaysOnline ? on : off}
└ Always Offline: ${s.alwaysOffline ? on : off}

🤖 *BOT SETTINGS*
├ Mode: ${s.botMode.toUpperCase()}
├ Prefix: ${s.prefix}
├ Status React Emoji: ${s.statusReactEmoji}
└ Menu Emoji: ${s.menuEmoji}

📞 *AUTO SAVE*
└ Auto Save Contact: ${s.autoSaveContact ? on : off}

━━━━━━━━━━━━━━━━━━━━━━
*TOGGLE COMMANDS:*
• \`.antidelete\` - Toggle Anti Delete
• \`.anticall\` - Toggle Anti Call
• \`.antiviewonce\` - Toggle Anti View Once
• \`.statussave\` - Toggle Status Save
• \`.statusseen\` - Toggle Status Seen
• \`.statusreact\` - Toggle Status React
• \`.online\` - Set Always Online
• \`.offline\` - Set Always Offline
• \`.normalmode\` - Remove Presence
• \`.savecontact\` - Toggle Auto Save
• \`.setemoji [emoji]\` - Change React Emoji
• \`.setprefix [p]\` - Change Prefix
• \`.mode public/private\` - Change Mode
`.trim();

  await sock.sendMessage(jid, { text: menu });
}

module.exports = { handleMessage };
