const MAX_WEBHOOK_BYTES = 1024 * 1024;
const { errorContext, logger } = require("../services/logger");

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BYTES) tooLarge = true;
    else if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw Object.assign(new Error("Webhook body is too large."), { code: "WEBHOOK_TOO_LARGE" });
  return Buffer.concat(chunks);
}

module.exports = async function webhookRoutes({ req, res, url, app }) {
  if (req.method !== "POST" || url.pathname !== "/webhooks/razorpay") return false;
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    app.sendJson(res, 415, { error: "Webhook content type must be application/json." });
    return true;
  }
  try {
    const rawBody = await readRawBody(req);
    const result = await app.receiveRazorpayWebhook(rawBody, req.headers["x-razorpay-signature"], req.headers["x-razorpay-event-id"]);
    app.sendJson(res, 200, { received: true, duplicate: result.duplicate, status: result.status });
  } catch (error) {
    const status = error.code === "WEBHOOK_INVALID_SIGNATURE" ? 401
      : error.code === "WEBHOOK_TOO_LARGE" ? 413
        : error.code === "WEBHOOK_MALFORMED" ? 400
          : error.code === "WEBHOOK_NOT_CONFIGURED" ? 503 : 503;
    const message = status === 401 ? "Webhook signature is invalid."
      : status === 413 ? "Webhook body is too large."
        : status === 400 ? "Webhook request is malformed."
          : "Webhook processing is temporarily unavailable.";
    const fields = { ...errorContext(error), request_id: req.requestId };
    if (status >= 500) logger.error("payment.webhook_processing_failed", fields);
    else logger.warn("payment.webhook_rejected", fields);
    app.sendJson(res, status, { error: message });
  }
  return true;
};
