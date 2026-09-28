const crypto = require("node:crypto");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_.-]{1,79}$/;
const SAFE_FIELDS = new Set(["request_id", "method", "status", "duration_ms", "error_code", "error_name", "dependency", "signal", "operation", "port"]);

function requestIdFor(req) {
  const supplied = req?.headers?.["x-request-id"];
  return typeof supplied === "string" && REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
}

function attachRequestId(req, res) {
  const id = requestIdFor(req);
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  return id;
}

function errorContext(error, dependency) {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : undefined;
  const name = typeof error?.name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.name) ? error.name : "Error";
  let kind = dependency;
  if (!kind) {
    if (code === "REDIS_UNAVAILABLE") kind = "redis";
    else if (code === "OBJECT_STORAGE_UNAVAILABLE") kind = "object_storage";
    else if (code === "SMTP_DELIVERY_FAILED") kind = "smtp";
    else if (/^(?:PROVIDER|PAYMENT|REFUND|WEBHOOK)_/.test(code || "")) kind = "payment_provider";
    else if (/^[0-9A-Z]{5}$/.test(code || "") || ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"].includes(code)) kind = "postgresql";
    else kind = "application";
  }
  return { dependency: kind, error_code: code, error_name: name };
}

function createLogger(write = line => process.stdout.write(`${line}\n`)) {
  function emit(severity, event, fields = {}) {
    const record = { timestamp: new Date().toISOString(), severity, event: EVENT_PATTERN.test(event) ? event : "invalid.log_event" };
    for (const [key, value] of Object.entries(fields)) {
      if (!SAFE_FIELDS.has(key) || value === undefined || value === null) continue;
      if (key === "status" || key === "duration_ms" || key === "port") {
        if (Number.isFinite(Number(value))) record[key] = Number(value);
      } else if (typeof value === "string" && value.length <= (key === "request_id" ? 128 : 80) && /^[A-Za-z0-9_.:-]*$/.test(value)) {
        record[key] = value;
      }
    }
    write(JSON.stringify(record));
  }
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields)
  };
}

const logger = createLogger();

module.exports = { REQUEST_ID_PATTERN, attachRequestId, createLogger, errorContext, logger, requestIdFor };
