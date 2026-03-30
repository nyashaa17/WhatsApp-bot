import app from "./app";
import { logger } from "./lib/logger";
import { initializeClient } from "./routes/whatsapp";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Prevent Baileys' internal noise-handler crypto errors from crashing the process.
// "Unsupported state or unable to authenticate data" is thrown during pairing
// handshake failures — catching it here keeps the server alive so the connection
// close event fires normally and our reconnect logic can take over.
process.on("uncaughtException", (err: Error) => {
  logger.error({ err: { message: err.message, stack: err.stack } }, "Uncaught exception (suppressed)");
});
process.on("unhandledRejection", (reason: unknown) => {
  logger.error({ reason }, "Unhandled promise rejection (suppressed)");
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  initializeClient().catch((err) => {
    logger.error({ err }, "Failed to initialize WhatsApp client");
  });
});
