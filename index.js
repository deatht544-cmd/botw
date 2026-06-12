const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidDecode,
  proto,
  getContentType,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const readline = require("readline");
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");
const { Boom } = require("@hapi/boom");

const { loadSettings, saveSettings } = require("./lib/settings");
const { handleMessage } = require("./main");

const store = makeInMemoryStore({
  logger: pino().child({ level: "silent", stream: "store" }),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const SESSION_DIR = "./session";

function printBanner() {
  console.clear();
  console.log(chalk.cyan(`
╔══════════════════════════════════════════╗
║                                          ║
║    ███╗   ██╗███████╗██╗  ██╗██╗   ██╗  ║
║    ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║  ║
║    ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║  ║
║    ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║  ║
║    ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝  ║
║    ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝   ║
║                                          ║
║         ✦  NEXUS-XD BOT  ✦              ║
║      Owner: Vishath Kawshika             ║
║      Number: +94725613084                ║
║      Version: 2.0.0                      ║
╚══════════════════════════════════════════╝
`));
}

async function connectToWhatsApp() {
  printBanner();

  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["NEXUS-XD", "Chrome", "1.0.0"],
    getMessage: async (key) => {
      if (store) {
        const msg = await store.loadMessage(key.remoteJid, key.id);
        return msg?.message || undefined;
      }
      return proto.Message.fromObject({});
    },
  });

  store?.bind(sock.ev);

  // Pairing Code Login
  if (!sock.authState.creds.registered) {
    console.log(chalk.yellow("\n📱 Pairing Code Login"));
    console.log(chalk.gray("─────────────────────────────────"));
    let phoneNumber = await question(chalk.green("➤ Enter your WhatsApp number (with country code, e.g. 94725613084): "));
    phoneNumber = phoneNumber.replace(/[^0-9]/g, "");
    
    await new Promise(r => setTimeout(r, 2000));
    
    const code = await sock.requestPairingCode(phoneNumber);
    const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
    
    console.log(chalk.cyan("\n╔══════════════════════════════╗"));
    console.log(chalk.cyan("║   🔑 YOUR PAIRING CODE:       ║"));
    console.log(chalk.white(`║   👉  ${chalk.yellow.bold(formattedCode)}           ║`));
    console.log(chalk.cyan("╚══════════════════════════════╝"));
    console.log(chalk.gray("\n📲 Go to WhatsApp > Linked Devices > Link with phone number"));
    console.log(chalk.gray("   Enter the code above to connect.\n"));
  }

  sock.ev.process(async (events) => {
    // Connection update
    if (events["connection.update"]) {
      const { connection, lastDisconnect } = events["connection.update"];
      
      if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const reasons = {
          [DisconnectReason.badSession]: ["Bad Session - Delete session folder", false],
          [DisconnectReason.connectionClosed]: ["Connection closed", true],
          [DisconnectReason.connectionLost]: ["Connection lost", true],
          [DisconnectReason.connectionReplaced]: ["Connection replaced - Another session opened", false],
          [DisconnectReason.loggedOut]: ["Logged out - Delete session folder", false],
          [DisconnectReason.restartRequired]: ["Restart required", true],
          [DisconnectReason.timedOut]: ["Timed out", true],
        };
        
        const [msg, reconnect] = reasons[reason] || ["Unknown disconnect", true];
        console.log(chalk.red(`\n⚠️  Disconnected: ${msg}`));
        
        if (reconnect) {
          console.log(chalk.yellow("🔄 Reconnecting..."));
          connectToWhatsApp();
        } else {
          console.log(chalk.red("❌ Please restart bot manually."));
          process.exit(1);
        }
      }
      
      if (connection === "open") {
        const settings = loadSettings();
        console.log(chalk.green("\n✅ NEXUS-XD Connected Successfully!"));
        console.log(chalk.cyan(`👤 Bot: ${sock.user?.name}`));
        console.log(chalk.cyan(`📞 Number: ${sock.user?.id?.split(":")[0]}`));
        console.log(chalk.gray("─────────────────────────────────\n"));
        
        // Apply presence on start
        applyPresence(sock, settings);
      }
    }

    // Save credentials
    if (events["creds.update"]) await saveCreds();

    // Messages
    if (events["messages.upsert"]) {
      const upsert = events["messages.upsert"];
      if (upsert.type !== "notify") return;
      
      for (const msg of upsert.messages) {
        if (!msg.message) continue;
        try {
          await handleMessage(sock, msg, store);
        } catch (e) {
          console.log(chalk.red("Message handler error:"), e);
        }
      }
    }
  });

  return sock;
}

async function applyPresence(sock, settings) {
  if (settings.alwaysOnline) {
    await sock.sendPresenceUpdate("available");
    console.log(chalk.green("🟢 Status: Always Online"));
  } else if (settings.alwaysOffline) {
    await sock.sendPresenceUpdate("unavailable");
    console.log(chalk.gray("⚫ Status: Always Offline"));
  }
}

connectToWhatsApp().catch(console.error);

module.exports = { connectToWhatsApp };
