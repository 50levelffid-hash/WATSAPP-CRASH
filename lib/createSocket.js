import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "path";
import fs from "fs/promises";

export async function createSocket(sessionId, opts = {}) {
  const { onQR, phoneNumber } = opts;

  const sessionsDir = path.join(process.cwd(), "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessionPath = path.join(sessionsDir, sessionId);
  await fs.mkdir(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[${sessionId}] Creating socket with Baileys v${version.join(".")}`);

  const silentLogger = pino({ level: "silent" });

  const usePairingCode = !!phoneNumber;

  const sock = makeWASocket({
    version,
    logger: silentLogger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    browser: Browsers.macOS("Safari"),
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    fireInitQueries: true,
    generateHighQualityLinkPreview: false,
  });

  sock.sessionId = sessionId;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
    if (qr && typeof onQR === "function") {
      try { onQR(qr); } catch {}
    }
  });

  // Pairing code generation
  if (usePairingCode && !sock.authState.creds.registered) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const code = await sock.requestPairingCode(phoneNumber);
      console.log(`[${sessionId}] Pairing code: ${code}`);
      if (typeof opts.onPairingCode === "function") {
        opts.onPairingCode(code);
      }
    } catch (e) {
      console.error(`[${sessionId}] Pairing code error:`, e.message);
    }
  }

  return sock;
}
