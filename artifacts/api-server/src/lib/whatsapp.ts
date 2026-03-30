import qrcode from "qrcode";
import { rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { logger } from "./logger";

const require = createRequire(import.meta.url);
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require("@whiskeysockets/baileys");

export type WhatsappState =
  | "initializing"
  | "qr_ready"
  | "pairing"
  | "authenticated"
  | "ready"
  | "disconnected";

interface BotState {
  state: WhatsappState;
  qrCode: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  name: string | null;
  groupCount: number | null;
}

export interface GroupInfo {
  id: string;
  name: string;
  participantCount: number;
}

let sock: any = null;
let botState: BotState = {
  state: "initializing",
  qrCode: null,
  pairingCode: null,
  phoneNumber: null,
  name: null,
  groupCount: null,
};
// In-memory group cache — populated once per connection, never re-fetched by status polls
let cachedGroups: GroupInfo[] = [];
// Tracks when the socket entered qr_ready so we can enforce a stabilization delay
let qrReadyAt: number | null = null;

// Use a path outside /tmp so credentials survive server restarts and redeployments.
// In Replit VM deployments the /home/runner directory persists across redeploys.
// Override with BAILEYS_AUTH_PATH env var when running on your own VPS
const AUTH_PATH = process.env.BAILEYS_AUTH_PATH ?? "/home/runner/.baileys-auth";

export function getBotState(): BotState {
  return { ...botState };
}

async function ensureAuthDir() {
  if (!existsSync(AUTH_PATH)) {
    await mkdir(AUTH_PATH, { recursive: true });
  }
}

async function clearAuthState() {
  try {
    await rm(AUTH_PATH, { recursive: true, force: true });
    await mkdir(AUTH_PATH, { recursive: true });
  } catch (_) {}
}

// Minimal pino-compatible logger shim for Baileys (suppresses verbose internal logs)
const silentLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (msg: any) => logger.warn(msg, "baileys"),
  error: (msg: any) => logger.error(msg, "baileys"),
  fatal: (msg: any) => logger.error(msg, "baileys fatal"),
  child: () => silentLogger,
};

async function createConnection(): Promise<void> {
  try {
    await ensureAuthDir();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    logger.info({ version: version.join(".") }, "Baileys: using WA version");

    const newSock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      printQRInTerminal: false,
      logger: silentLogger,
      // macOS/Safari is less likely to trigger WhatsApp bot-detection than ubuntu/Chrome
      browser: Browsers.macOS("Safari"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      // Skip all protocol init queries (privacy, contacts, etc.) after handshake
      fireInitQueries: false,
      // Never retransmit — prevents decrypt-error cascades
      getMessage: async () => undefined,
      retryRequestDelayMs: 250_000,
      maxMsgRetryCount: 0,
      // 5 min window so the pairing code stays valid while the user navigates to WA
      qrTimeout: 300_000,
      // Ignore all incoming JIDs at the application layer — send-only bot
      shouldIgnoreJid: () => true,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
    });

    sock = newSock;

    sock.ev.on("creds.update", saveCreds);

    // ── Drop every incoming Baileys event — we are send-only ─────────────────
    sock.ev.on("messaging-history.set", () => {});
    sock.ev.on("chats.upsert", () => {});
    sock.ev.on("chats.update", () => {});
    sock.ev.on("chats.delete", () => {});
    sock.ev.on("contacts.upsert", () => {});
    sock.ev.on("contacts.update", () => {});
    sock.ev.on("messages.upsert", () => {});
    sock.ev.on("messages.update", () => {});
    sock.ev.on("messages.delete", () => {});
    sock.ev.on("messages.reaction", () => {});
    sock.ev.on("message-receipt.update", () => {});
    sock.ev.on("groups.upsert", () => {});
    sock.ev.on("groups.update", () => {});
    sock.ev.on("group-participants.update", () => {});
    sock.ev.on("blocklist.set", () => {});
    sock.ev.on("blocklist.update", () => {});
    sock.ev.on("call", () => {});
    sock.ev.on("labels.edit", () => {});
    sock.ev.on("labels.association", () => {});

    // ── Block ALL receipt/ack nodes from reaching WhatsApp ────────────────────
    // On first connect WA dumps the full group backlog → Baileys sends a burst
    // of ACKs → 420 rate-limit → device_removed (401).  Drop every receipt
    // and message-delivery ACK; outgoing <message> nodes are unaffected.
    const _origSendNode = (sock as any).sendNode?.bind(sock);
    if (_origSendNode) {
      (sock as any).sendNode = async (frame: any) => {
        if (frame?.tag === "receipt") return;
        if (frame?.tag === "ack" && frame?.attrs?.class === "receipt") return;
        return _origSendNode(frame);
      };
      logger.info("Message ACK suppression active");
    }

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      if (qr) {
        if (botState.state === "pairing") {
          logger.info("QR refresh ignored (in pairing state)");
          return;
        }
        try {
          const qrDataUrl = await qrcode.toDataURL(qr);
          botState = { ...botState, state: "qr_ready", qrCode: qrDataUrl };
          qrReadyAt = Date.now();
          logger.info("QR code ready");
        } catch (err) {
          logger.error({ err }, "Failed to convert QR to image");
        }
      }

      if (connection === "open") {
        const user = sock.user;
        const rawId: string = user?.id ?? "";
        const phone = rawId.split("@")[0]?.split(":")[0] ?? null;
        cachedGroups = [];
        botState = {
          state: "ready",
          qrCode: null,
          pairingCode: null,
          phoneNumber: phone,
          name: user?.name ?? null,
          groupCount: null,
        };
        logger.info({ phoneNumber: botState.phoneNumber, name: botState.name }, "WhatsApp connected");
        // Groups are NOT fetched automatically — user must trigger /groups/refresh.
        // Auto-fetching 500+ groups on connect takes 40-50s and triggers WA bot detection.
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.info({ statusCode }, "Connection closed");
        sock = null;

        // Check for specific conflict reasons (device_removed, etc.)
        const conflictType = (lastDisconnect?.error as any)?.output?.payload?.errorNode?.content?.find?.(
          (n: any) => n?.tag === "conflict"
        )?.attrs?.type;
        if (conflictType) logger.warn({ conflictType }, "Disconnect conflict");

        cachedGroups = [];
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          const reason = conflictType === "device_removed"
            ? "device_removed"
            : "logged_out";
          logger.warn({ reason }, "Logged out — clearing auth state");
          await clearAuthState();
          botState = { state: "disconnected", qrCode: null, pairingCode: null, phoneNumber: null, name: null, groupCount: null };
        } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          logger.info("Restart required, reconnecting in 1s...");
          botState = { state: "initializing", qrCode: null, pairingCode: null, phoneNumber: null, name: null, groupCount: null };
          setTimeout(createConnection, 1000);
        } else if (statusCode === DisconnectReason.connectionClosed || statusCode === 428) {
          // 428 fires when WhatsApp closes the socket after the pairing code is entered.
          // We MUST wait long enough for Baileys to finish flushing the new credentials to
          // disk before we reload them in the next createConnection() call. 1s was too short
          // — the reconnect started with stale/empty credentials → immediate 401.
          const wasInPairing = botState.state === "pairing";
          const delay = wasInPairing ? 5000 : 1500;
          logger.info({ wasInPairing, delay }, "Connection closed by server, reconnecting...");
          botState = { state: "initializing", qrCode: null, pairingCode: null, phoneNumber: null, name: null, groupCount: null };
          setTimeout(createConnection, delay);
        } else if (statusCode === DisconnectReason.connectionReplaced) {
          // Another instance (e.g. a new deployment) took over. Retry after a delay —
          // by then the other process will have won and ours will reconnect cleanly.
          logger.warn("Connection replaced — retrying in 8s...");
          botState = { state: "initializing", qrCode: null, pairingCode: null, phoneNumber: null, name: null, groupCount: null };
          setTimeout(createConnection, 8000);
        } else {
          logger.info({ statusCode }, "Unexpected close, reconnecting in 5s...");
          botState = { state: "initializing", qrCode: null, pairingCode: null, phoneNumber: null, name: null, groupCount: null };
          setTimeout(createConnection, 5000);
        }
      }
    });
  } catch (err) {
    logger.error({ err }, "Failed to create Baileys connection");
    botState = { state: "disconnected", qrCode: null, pairingCode: null, phoneNumber: null, name: null, groupCount: null };
    sock = null;
  }
}

export async function initializeClient(): Promise<void> {
  if (sock) return;
  logger.info("Initializing WhatsApp client (Baileys — no browser)");
  botState = { state: "initializing", qrCode: null, pairingCode: null, phoneNumber: null, name: null };
  await createConnection();
}

export async function requestPairingCodeDirect(rawPhoneNumber: string): Promise<void> {
  if (!sock) throw new Error("WhatsApp not initialized");
  if (botState.state !== "qr_ready") {
    throw new Error(`Cannot request pairing code in state: ${botState.state}. Wait for QR screen.`);
  }

  // Wait at least 4 seconds after the socket became ready before requesting
  // the code — the WebSocket session needs to fully stabilize first.
  const STABILIZE_MS = 4000;
  const elapsed = qrReadyAt ? Date.now() - qrReadyAt : STABILIZE_MS;
  if (elapsed < STABILIZE_MS) {
    const wait = STABILIZE_MS - elapsed;
    logger.info({ waitMs: wait }, "Waiting for socket to stabilize before pairing code request");
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  const phoneNumber = rawPhoneNumber.replace(/\D/g, "");
  logger.info({ phoneNumber }, "Requesting pairing code (Baileys)");

  const code: string = await sock.requestPairingCode(phoneNumber);
  logger.info({ code }, "Pairing code received");
  botState = { ...botState, state: "pairing", pairingCode: code, qrCode: null };
}

/**
 * Returns the in-memory group cache without making any WhatsApp API call.
 * Groups must be loaded first via fetchAndCacheGroups().
 */
export function getGroups(): GroupInfo[] {
  if (botState.state !== "ready") {
    throw new Error("WhatsApp client not ready");
  }
  return cachedGroups;
}

let groupFetchInProgress = false;

/**
 * Fetches all groups from WhatsApp and caches them.
 * Must be called explicitly by the user — never automatically on connect.
 * groupFetchAllParticipating for 500+ groups takes 40-50s and triggers WA bot detection.
 */
export async function fetchAndCacheGroups(): Promise<GroupInfo[]> {
  if (!sock || botState.state !== "ready") {
    throw new Error("WhatsApp client not ready");
  }
  if (groupFetchInProgress) {
    throw new Error("Group fetch already in progress, please wait");
  }
  groupFetchInProgress = true;
  try {
    logger.info("Fetching groups from WhatsApp (user-triggered)");
    const raw = await sock.groupFetchAllParticipating();
    cachedGroups = Object.values(raw as Record<string, any>).map((g: any) => ({
      id: g.id as string,
      name: (g.subject as string) ?? "",
      participantCount: (g.participants?.length as number) ?? 0,
    }));
    botState = { ...botState, groupCount: cachedGroups.length };
    logger.info({ groupCount: cachedGroups.length }, "Groups cached (user-triggered)");
    return cachedGroups;
  } finally {
    groupFetchInProgress = false;
  }
}

export interface GroupLink {
  number: number;
  name: string;
  link: string;
}

let linkFetchInProgress = false;

/**
 * Fetches WhatsApp invite links for all cached groups.
 * Each call uses a small delay to avoid rate-limiting.
 * Groups must be loaded first via fetchAndCacheGroups().
 */
export async function fetchGroupLinks(
  onProgress?: (current: number, total: number) => void
): Promise<GroupLink[]> {
  if (!sock || botState.state !== "ready") {
    throw new Error("WhatsApp client not ready");
  }
  if (cachedGroups.length === 0) {
    throw new Error("No groups loaded — please load groups first");
  }
  if (linkFetchInProgress) {
    throw new Error("Link fetch already in progress, please wait");
  }
  linkFetchInProgress = true;
  const results: GroupLink[] = [];
  try {
    logger.info({ total: cachedGroups.length }, "Fetching group invite links (user-triggered)");
    for (let i = 0; i < cachedGroups.length; i++) {
      const group = cachedGroups[i];
      try {
        const code: string = await sock.groupInviteCode(group.id);
        results.push({
          number: i + 1,
          name: group.name,
          link: `https://chat.whatsapp.com/${code}`,
        });
      } catch (err: any) {
        logger.warn({ groupId: group.id, groupName: group.name, err: err?.message }, "Could not fetch link for group");
        results.push({
          number: i + 1,
          name: group.name,
          link: "(unavailable)",
        });
      }
      if (onProgress) onProgress(i + 1, cachedGroups.length);
      // Small delay between each invite-code request to avoid rate-limiting
      if (i < cachedGroups.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    logger.info({ fetched: results.length }, "Group links fetched");
    return results;
  } finally {
    linkFetchInProgress = false;
  }
}

export async function broadcastMessage(message: string, groupIds?: string[] | null) {
  if (!sock || botState.state !== "ready") {
    throw new Error("WhatsApp client not ready");
  }

  const allGroups = getGroups();
  const targetGroups =
    groupIds && groupIds.length > 0
      ? allGroups.filter((g) => groupIds.includes(g.id))
      : allGroups;

  const results = [];

  for (const group of targetGroups) {
    try {
      const sent = await sock.sendMessage(group.id, { text: message });
      results.push({
        groupId: group.id,
        groupName: group.name,
        success: true,
        messageId: sent?.key?.id ?? null,
        error: null,
        acked: true,
      });
      logger.info({ groupName: group.name }, "Message sent");
      await new Promise((r) => setTimeout(r, 500));
    } catch (err: any) {
      logger.error({ err, groupName: group.name }, "Failed to send message");
      results.push({
        groupId: group.id,
        groupName: group.name,
        success: false,
        messageId: null,
        error: err.message ?? "Unknown error",
        acked: null,
      });
    }
  }

  return {
    total: targetGroups.length,
    sent: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

export async function resetAndReinitialize(): Promise<void> {
  try { sock?.end(undefined); } catch (_) {}
  sock = null;
  botState = { state: "initializing", qrCode: null, pairingCode: null, phoneNumber: null, name: null };
  await createConnection();
}

export async function disconnectClient() {
  try {
    await sock?.logout();
  } catch (err) {
    logger.error({ err }, "Error during logout");
  } finally {
    try { sock?.end(undefined); } catch (_) {}
    sock = null;
    await clearAuthState();
    botState = { state: "disconnected", qrCode: null, pairingCode: null, phoneNumber: null, name: null };
  }
}
