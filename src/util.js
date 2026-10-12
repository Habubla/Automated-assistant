import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ConflictError,
  CorruptRecordError,
  ValidationError,
} from "./errors.js";

export function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}
export function requirePlainObject(v, label) {
  if (!isPlainObject(v))
    throw new ValidationError(`${label} must be an object.`);
  return v;
}
export function requireString(v, label, { min = 1, max = 20_000 } = {}) {
  if (typeof v !== "string" || v.trim().length < min || v.length > max)
    throw new ValidationError(`${label} must be a bounded string.`);
  return v.trim();
}
export function exactKeys(v, keys, label) {
  requirePlainObject(v, label);
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new ValidationError(`${label} has unexpected fields.`);
}
export function requireOneOf(v, label, values) {
  if (!values.includes(v))
    throw new ValidationError(`${label} has an invalid value.`);
  return v;
}
export function integer(v, label, min = 1, max = 1_000_000) {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new ValidationError(`${label} is out of range.`);
  return v;
}
export function timestamp(v, label = "timestamp") {
  requireString(v, label, { max: 40 });
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      v,
    ) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new ValidationError(
      `${label} must include a valid time and timezone.`,
    );
  const [y, m, d] = v.slice(0, 10).split("-").map(Number);
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > new Date(Date.UTC(y, m, 0)).getUTCDate() ||
    Number(v.slice(11, 13)) > 23 ||
    Number(v.slice(14, 16)) > 59 ||
    Number(v.slice(17, 19)) > 59
  )
    throw new ValidationError(`${label} is invalid.`);
  return v;
}
const SECRET_PATTERNS = [
  /\bAQ\.[A-Za-z0-9_-]{20,256}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /["']?\b(?:token|api[_ -]?key|password|secret|authorization)["']?\s*[:=]\s*["']?[^\s,;"'}]{4,}["']?/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
  /https?:\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi,
];
export function redactSensitiveText(v) {
  return SECRET_PATTERNS.reduce(
    (s, p) => s.replace(p, "[REDACTED_SECRET]"),
    String(v),
  );
}
export function assertNoSecret(v, label = "value") {
  if (redactSensitiveText(v) !== String(v))
    throw new ValidationError(`${label} appears to contain a secret.`);
}
export function cleanText(v, label, options) {
  const s = requireString(v, label, options);
  assertNoSecret(s, label);
  return s;
}
export function safeId(v, label = "id") {
  const s = requireString(v, label, { max: 128 });
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) ||
    s.endsWith(".") ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)
  )
    throw new ValidationError(`${label} is not a safe identifier.`);
  return s;
}
export const isoNow = (clock = () => new Date()) => clock().toISOString();
export const recordId = (prefix, clock = () => new Date()) =>
  `${prefix}-${isoNow(clock).slice(0, 10).replaceAll("-", "")}-${randomUUID()}`;
export const checksum = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const sha256 = (v) => createHash("sha256").update(v).digest("hex");
export async function assertNoLinks(target) {
  let cur = path.resolve(target);
  for (;;) {
    const st = await fs
      .lstat(cur)
      .catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (st?.isSymbolicLink())
      throw new ValidationError(
        "Symbolic links and junctions are not allowed in managed storage.",
      );
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}
export function inside(root, relative) {
  const result = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), result);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new ValidationError("Path escapes the vault.");
  return result;
}
export async function readJson(file) {
  await assertNoLinks(file);
  let text;
  try {
    if ((await fs.stat(file)).size > 8_000_000)
      throw new CorruptRecordError(file, "file too large");
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CorruptRecordError(file, "invalid JSON");
  }
}
export async function writeJsonAtomic(
  file,
  value,
  { overwrite = true, io = fs } = {},
) {
  await assertNoLinks(file);
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await io.open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (overwrite) await io.rename(temp, file);
    else {
      try {
        await io.link(temp, file);
      } catch (e) {
        if (e.code === "EEXIST")
          throw new ConflictError("Record already exists.");
        throw e;
      }
    }
  } finally {
    await handle?.close().catch(() => {});
    await io.unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
export async function listJsonFiles(dir) {
  await assertNoLinks(dir);
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch((e) => (e.code === "ENOENT" ? [] : Promise.reject(e)));
  const out = [];
  for (const e of entries) {
    if (e.isSymbolicLink())
      throw new ValidationError("Managed storage contains a link.");
    if (e.isDirectory())
      out.push(...(await listJsonFiles(path.join(dir, e.name))));
    else if (e.isFile() && e.name.endsWith(".json"))
      out.push(path.join(dir, e.name));
  }
  return out.sort();
}
// SQLite only coordinates writers. Process exit releases its OS lock, including after a crash.
export async function withVaultLock(
  root,
  operation,
  { attempts = 100, retryMs = 20 } = {},
) {
  await assertNoLinks(root);
  await fs.mkdir(root, { recursive: true });
  if (
    await fs
      .stat(path.join(root, ".june-memory.lock"))
      .catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)))
  )
    throw new ConflictError(
      "Legacy directory lock requires owner verification before removal.",
    );
  const lock = path.join(root, ".june-memory-lock.sqlite");
  await assertNoLinks(lock);
  const db = new DatabaseSync(lock);
  let locked = false;
  try {
    for (let i = 0; i < attempts; i++) {
      try {
        db.exec("BEGIN IMMEDIATE");
        locked = true;
        break;
      } catch (e) {
        if (!/locked|busy/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    if (!locked) throw new ConflictError("Vault is busy; retry the operation.");
    return await operation();
  } finally {
    if (locked) db.exec("ROLLBACK");
    db.close();
  }
}
export function tokenize(v) {
  return [
    ...new Set(
      String(v)
        .toLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
    ),
  ];
}
export function localUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new ValidationError(
      "Only loopback HTTP service origins are allowed.",
    );
  return url.origin;
}
