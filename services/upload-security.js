const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ARTWORK_LIMIT = 25 * 1024 * 1024;
const PRODUCT_IMAGE_LIMIT = 8 * 1024 * 1024;
const PRODUCT_IMAGE_AGGREGATE_LIMIT = 32 * 1024 * 1024;
const PRODUCT_IMAGE_COUNT_LIMIT = 10;
const ARTWORK_EXTENSIONS = new Set([".pdf", ".png", ".ai", ".psd"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const GENERATED_FILE = /^[0-9]+-(?:[a-f0-9]{16}|[a-f0-9]{32})\.(?:pdf|png|ai|psd|jpe?g|webp)$/i;
const pngCrcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function fail(message) {
  throw Object.assign(new Error(message), { code: "UPLOAD_INVALID" });
}
function tooLarge(message) {
  throw Object.assign(new Error(message), { code: "UPLOAD_TOO_LARGE" });
}

function safeOriginalFilename(value) {
  const input = String(value || "").normalize("NFC");
  if (!input || input.length > 240 || /[\\/\u0000-\u001f\u007f]/.test(input) || input === "." || input === "..") fail("Choose a valid file name.");
  if (input.split(".").some(part => part === "..")) fail("Path-like file names are not allowed.");
  const safe = input.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ").trim();
  if (!safe || safe.length > 180 || safe.startsWith(".")) fail("Choose a valid file name.");
  return safe;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(data) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 45 || !data.subarray(0, 8).equals(signature)) return false;
  let offset = 8, sawHeader = false, sawData = false, sawEnd = false;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const compressed = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) return false;
    const type = data.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    const expectedCrc = data.readUInt32BE(offset + 8 + length);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      width = data.readUInt32BE(offset + 8); height = data.readUInt32BE(offset + 12);
      if (!width || !height || width > 100000 || height > 100000) return false;
      bitDepth = data[offset + 16]; colorType = data[offset + 17]; interlace = data[offset + 20];
      const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowedDepths[colorType]?.includes(bitDepth) || data[offset + 18] !== 0 || data[offset + 19] !== 0 || interlace > 1) return false;
      sawHeader = true;
    } else if (type === "IHDR") return false;
    if (type === "IDAT") { sawData = true; compressed.push(data.subarray(offset + 8, offset + 8 + length)); }
    if (type === "IEND") {
      if (length !== 0 || !sawData || end !== data.length) return false;
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd) return false;
  try {
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
    const expected = interlace === 0 ? Math.ceil(width * channels * bitDepth / 8 + 1) * height : undefined;
    if (expected > 64 * 1024 * 1024) return false;
    const decoded = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: 64 * 1024 * 1024 });
    return decoded.length > 0 && (expected === undefined || decoded.length === expected);
  } catch { return false; }
}

function validateJpeg(data) {
  if (data.length < 16 || data[0] !== 0xff || data[1] !== 0xd8) return false;
  let offset = 2, sawFrame = false, sawScan = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) return false;
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset++];
    if (marker === 0xd9) return sawFrame && sawScan && offset === data.length;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > data.length) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || !data.readUInt16BE(offset + 3) || !data.readUInt16BE(offset + 5)) return false;
      sawFrame = true;
    }
    offset += length;
    if (marker === 0xda) {
      sawScan = true;
      while (offset < data.length) {
        if (data[offset++] !== 0xff) continue;
        while (data[offset] === 0xff) offset += 1;
        const scanMarker = data[offset++];
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) continue;
        if (scanMarker === 0xd9) return sawFrame && offset === data.length;
        offset -= 2;
        break;
      }
      if (offset >= data.length) return false;
    }
  }
  return false;
}

function validateWebp(data) {
  if (data.length < 20 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP" || data.readUInt32LE(4) + 8 !== data.length) return false;
  let offset = 12, imageChunk = false;
  while (offset + 8 <= data.length) {
    const name = data.toString("ascii", offset, offset + 4), size = data.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size & 1);
    if (end > data.length) return false;
    const body = offset + 8;
    if (name === "VP8 " && size >= 10 && data[body + 3] === 0x9d && data[body + 4] === 0x01 && data[body + 5] === 0x2a) imageChunk = true;
    if (name === "VP8L" && size >= 5 && data[body] === 0x2f) imageChunk = true;
    if (name === "VP8X" && size >= 10 && data[body + 1] === 0 && data[body + 2] === 0 && data[body + 3] === 0) imageChunk = true;
    offset = end;
  }
  return offset === data.length && imageChunk;
}

function validatePdf(data) {
  if (data.length < 16 || !/^%PDF-(?:1\.[0-7]|2\.0)/.test(data.toString("latin1", 0, Math.min(16, data.length))) || !/%%EOF\s*$/.test(data.toString("latin1", Math.max(0, data.length - 2048)))) return false;
  const text = data.toString("latin1");
  return /(?:\b\d+\s+\d+\s+obj\b|\/Type\s*\/XRef\b)/.test(text) && !/(?:\/JavaScript\b|\/JS\b|\/Launch\b|\/EmbeddedFiles\b|\/OpenAction\b)/i.test(text);
}

function validatePsd(data) {
  if (data.length < 40 || data.toString("ascii", 0, 4) !== "8BPS" || data.readUInt16BE(4) !== 1 || !data.subarray(6, 12).equals(Buffer.alloc(6))) return false;
  const channels = data.readUInt16BE(12), height = data.readUInt32BE(14), width = data.readUInt32BE(18), depth = data.readUInt16BE(22), mode = data.readUInt16BE(24);
  if (!channels || channels > 56 || !height || !width || height > 300000 || width > 300000 || ![1, 8, 16, 32].includes(depth) || ![0, 1, 2, 3, 4, 7, 8, 9].includes(mode)) return false;
  let offset = 26;
  for (let section = 0; section < 3; section += 1) {
    if (offset + 4 > data.length) return false;
    const length = data.readUInt32BE(offset);
    offset += 4 + length;
    if (offset > data.length) return false;
  }
  return offset + 2 <= data.length && data.readUInt16BE(offset) <= 3;
}

function detectFile(data, extension) {
  if (extension === ".png" && validatePng(data)) return { mime: "image/png", kind: "image" };
  if ((extension === ".jpg" || extension === ".jpeg") && validateJpeg(data)) return { mime: "image/jpeg", kind: "image" };
  if (extension === ".webp" && validateWebp(data)) return { mime: "image/webp", kind: "image" };
  if (extension === ".pdf" && validatePdf(data)) return { mime: "application/pdf", kind: "document" };
  if (extension === ".ai") {
    if (validatePdf(data)) return { mime: "application/pdf", kind: "document" };
    if (data.subarray(0, 11).toString("ascii").startsWith("%!PS-Adobe") && data.toString("latin1").includes("%%EOF")) return { mime: "application/postscript", kind: "document" };
  }
  if (extension === ".psd" && validatePsd(data)) return { mime: "image/vnd.adobe.photoshop", kind: "document" };
  return null;
}

function validateUpload(file, type, limit) {
  if (!file || !file.filename) return null;
  const original = safeOriginalFilename(file.filename);
  const extension = path.extname(original).toLowerCase();
  const allowed = type === "artwork" ? ARTWORK_EXTENSIONS : IMAGE_EXTENSIONS;
  const bytes = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || "");
  if (!allowed.has(extension)) fail(`Unsupported ${type === "artwork" ? "artwork" : "product image"} file type.`);
  if (!bytes.length) fail("The uploaded file is empty.");
  if (bytes.length > limit) tooLarge("The uploaded file is too large.");
  const detected = detectFile(bytes, extension);
  if (!detected) fail("The file content does not match a valid supported file format.");
  return { original, extension, data: bytes, mime: detected.mime, size: bytes.length };
}

function validateMultipartFiles(files, pathname) {
  const entries = Object.values(files || {}).flatMap(value => Array.isArray(value) ? value : [value]);
  if (!entries.length) return { count: 0, bytes: 0 };
  const productUpload = pathname === "/admin/products/save";
  const limit = productUpload ? PRODUCT_IMAGE_LIMIT : ARTWORK_LIMIT;
  const aggregateLimit = productUpload ? PRODUCT_IMAGE_AGGREGATE_LIMIT : ARTWORK_LIMIT;
  if (entries.length > (productUpload ? PRODUCT_IMAGE_COUNT_LIMIT : 1)) tooLarge("Too many files in this upload.");
  let bytes = 0;
  for (const file of entries) {
    const size = Buffer.isBuffer(file.data) ? file.data.length : Buffer.byteLength(file.data || "");
    if (size > limit) tooLarge("The uploaded file is too large.");
    bytes += size;
  }
  if (bytes > aggregateLimit) tooLarge("The combined upload is too large.");
  return { count: entries.length, bytes };
}

function resolveContained(root, name) {
  const base = path.resolve(root), candidate = path.resolve(base, name);
  if (path.dirname(candidate) !== base) fail("Invalid storage path.");
  return candidate;
}

function assertRequestSize(declaredLength, limit) {
  const declared = Number(declaredLength || 0);
  if (Number.isFinite(declared) && declared > limit) tooLarge("Request too large");
}

function generatedName(extension) {
  return `${Date.now()}-${require("node:crypto").randomBytes(16).toString("hex")}${extension}`;
}

function writeUpload(root, validated) {
  const stored = generatedName(validated.extension);
  const target = resolveContained(root, stored);
  const temporary = resolveContained(root, `${stored}.uploading`);
  try {
    fs.writeFileSync(temporary, validated.data, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { original: validated.original, stored, mime: validated.mime, size: validated.size };
}

function removeUpload(root, name) {
  if (!GENERATED_FILE.test(String(name || ""))) return false;
  const target = resolveContained(root, name);
  try { fs.unlinkSync(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function cleanupOrphanedUploads({ uploadDir, productImageDir, olderThanMs = 24 * 60 * 60 * 1000, now = Date.now() }) {
  // Final files may be legacy order artwork without a historical DB reference; only abandoned staging files are auto-deleted.
  const removed = [];
  for (const root of [uploadDir, productImageDir]) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d+-(?:[a-f0-9]{16}|[a-f0-9]{32})\.(?:pdf|png|ai|psd|jpe?g|webp)\.uploading$/i.test(entry.name)) continue;
      const file = resolveContained(root, entry.name), stat = fs.statSync(file);
      if (now - stat.mtimeMs < olderThanMs) continue;
      fs.unlinkSync(file);
      removed.push(entry.name);
    }
  }
  return removed;
}

module.exports = {
  ARTWORK_LIMIT, PRODUCT_IMAGE_LIMIT, PRODUCT_IMAGE_AGGREGATE_LIMIT, PRODUCT_IMAGE_COUNT_LIMIT,
  ARTWORK_EXTENSIONS, IMAGE_EXTENSIONS, GENERATED_FILE, safeOriginalFilename, validateUpload,
  validateMultipartFiles, resolveContained, assertRequestSize, writeUpload, removeUpload, cleanupOrphanedUploads,
  detectFile, validatePng, validateJpeg, validateWebp, validatePdf, validatePsd
};
