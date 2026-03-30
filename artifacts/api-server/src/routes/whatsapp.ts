import { Router, type IRouter } from "express";
import {
  GetWhatsappStatusResponse,
  GetWhatsappGroupsResponse,
  BroadcastMessageBody,
  BroadcastMessageResponse,
  DisconnectWhatsappResponse,
} from "@workspace/api-zod";
import {
  getBotState,
  getGroups,
  fetchAndCacheGroups,
  fetchGroupLinks,
  broadcastMessage,
  disconnectClient,
  initializeClient,
  resetAndReinitialize,
  requestPairingCodeDirect,
} from "../lib/whatsapp";

const router: IRouter = Router();

router.get("/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  try {
    const state = getBotState();
    const data = GetWhatsappStatusResponse.parse({
      state: state.state,
      qrCode: state.qrCode,
      pairingCode: state.pairingCode,
      phoneNumber: state.phoneNumber,
      name: state.name,
      // groupCount comes from the in-memory cache — no live WA query here
      groupCount: state.groupCount ?? null,
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to get WhatsApp status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/groups", (req, res) => {
  try {
    // Returns cached groups — no live WhatsApp query, safe to call frequently
    const groups = getGroups();
    const data = GetWhatsappGroupsResponse.parse({ groups });
    res.json(data);
  } catch (err: any) {
    req.log.error({ err }, "Failed to get groups");
    res.status(400).json({ error: err.message ?? "Failed to get groups" });
  }
});

// User-triggered group fetch — the only place groupFetchAllParticipating is called.
// Never call this automatically; doing so for 500+ groups triggers WA bot detection.
router.post("/groups/refresh", async (req, res) => {
  try {
    const groups = await fetchAndCacheGroups();
    const data = GetWhatsappGroupsResponse.parse({ groups });
    res.json(data);
  } catch (err: any) {
    req.log.error({ err }, "Failed to refresh groups");
    res.status(400).json({ error: err.message ?? "Failed to refresh groups" });
  }
});

// Fetches WhatsApp invite links for all cached groups — user-triggered only.
// Takes ~200ms per group so can be slow for large group lists.
router.post("/groups/links", async (req, res) => {
  try {
    const links = await fetchGroupLinks();
    res.json({ links });
  } catch (err: any) {
    req.log.error({ err }, "Failed to fetch group links");
    res.status(400).json({ error: err.message ?? "Failed to fetch group links" });
  }
});

router.post("/broadcast", async (req, res) => {
  try {
    const body = BroadcastMessageBody.parse(req.body);
    const result = await broadcastMessage(body.message, body.groupIds);
    const data = BroadcastMessageResponse.parse(result);
    res.json(data);
  } catch (err: any) {
    req.log.error({ err }, "Failed to broadcast message");
    res.status(400).json({ error: err.message ?? "Failed to broadcast" });
  }
});

router.post("/disconnect", async (req, res) => {
  try {
    await disconnectClient();
    const data = DisconnectWhatsappResponse.parse({
      success: true,
      message: "Disconnected successfully",
    });
    res.json(data);
  } catch (err: any) {
    req.log.error({ err }, "Failed to disconnect");
    res.status(500).json({ error: err.message ?? "Failed to disconnect" });
  }
});

router.post("/pair-phone", async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ error: "phoneNumber is required" });
    }
    // Run in background — code arrives via status polling
    requestPairingCodeDirect(String(phoneNumber)).catch((err) => {
      req.log.error({ err }, "Failed to get pairing code");
    });
    res.json({ started: true });
  } catch (err: any) {
    req.log.error({ err }, "Failed to start phone pairing");
    res.status(500).json({ error: err.message ?? "Failed to start phone pairing" });
  }
});

router.post("/reconnect", async (req, res) => {
  try {
    res.json({ success: true, message: "Reconnecting..." });
    // Run in background so response is returned immediately
    resetAndReinitialize().catch((err) => {
      req.log.error({ err }, "Background reconnect failed");
    });
  } catch (err: any) {
    req.log.error({ err }, "Failed to trigger reconnect");
    res.status(500).json({ error: err.message ?? "Failed to reconnect" });
  }
});

export default router;

export { initializeClient };
