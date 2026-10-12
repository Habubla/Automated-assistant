import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { Vault } from "./vault.js";
import { MemoryPipeline } from "./pipeline.js";
import { OllamaMemoryProvider } from "./provider.js";
import { Jobs } from "./jobs.js";
import { createBackup } from "./backup.js";
import { ValidationError } from "./errors.js";
import { exactKeys, integer, requireString, safeId } from "./util.js";

function same(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new ValidationError("Use application/json.");
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 128000) throw new ValidationError("Request too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Invalid JSON.");
  }
}
function send(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
export function createServer({
  vault,
  pipeline,
  jobs,
  workerToken,
  reviewToken,
  readerToken = workerToken,
}) {
  for (const token of [workerToken, reviewToken, readerToken])
    requireString(token, "service credential", { min: 32, max: 256 });
  if (same(workerToken, reviewToken) || same(readerToken, reviewToken))
    throw new ValidationError("Review and worker credentials must differ.");
  let busy = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin)
        return send(res, 403, { ok: false, error: "BROWSER_ORIGIN_DENIED" });
      const u = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/healthz")
        return send(res, 200, {
          ok: true,
          service: "june-memory",
          version: "0.2.0",
        });
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const reviewer = same(token, reviewToken),
        worker = same(token, workerToken),
        reader = same(token, readerToken) || worker || reviewer;
      if (!reader) return send(res, 401, { ok: false, error: "UNAUTHORIZED" });
      if (req.method === "GET" && u.pathname === "/v1/search")
        return send(res, 200, {
          ok: true,
          results: await vault.searchTrusted(u.searchParams.get("q") ?? "", {
            limit: Number(u.searchParams.get("limit") ?? 10),
          }),
        });
      if (req.method === "GET" && u.pathname === "/v1/active")
        return send(res, 200, {
          ok: true,
          records: (await vault.trustedRecords())
            .filter((r) => r.kind === "active_memory")
            .slice(0, 200),
        });
      if (req.method === "GET" && u.pathname === "/v1/status")
        return send(res, 200, { ok: true, validation: await vault.validate() });
      if (req.method === "GET" && u.pathname === "/v1/review-queue") {
        if (!reviewer)
          return send(res, 403, {
            ok: false,
            error: "REVIEW_AUTHORITY_REQUIRED",
          });
        return send(res, 200, {
          ok: true,
          records: (await vault.listRecords("records/observations"))
            .filter((r) => r.status === "pending")
            .slice(0, 100),
        });
      }
      if (req.method !== "POST")
        return send(res, 404, { ok: false, error: "NOT_FOUND" });
      const b = await body(req);
      if (u.pathname === "/v1/process") {
        if (!worker && !reviewer)
          return send(res, 403, {
            ok: false,
            error: "WORKER_AUTHORITY_REQUIRED",
          });
        exactKeys(b, ["sessionId", "messages"], "conversation");
        if (busy >= 2) return send(res, 429, { ok: false, error: "BUSY" });
        busy++;
        try {
          return send(res, 200, {
            ok: true,
            ...(await pipeline.processConversation(b)),
          });
        } finally {
          busy--;
        }
      }
      if (u.pathname.startsWith("/v1/jobs/")) {
        if (!worker && !reviewer)
          return send(res, 403, {
            ok: false,
            error: "WORKER_AUTHORITY_REQUIRED",
          });
        const name = u.pathname.slice("/v1/jobs/".length);
        const allowed = {
          consolidate: ["date", "dryRun"],
          reminders: ["leadHours", "dryRun"],
          health: [],
          backup: [],
        };
        if (!allowed[name])
          return send(res, 404, { ok: false, error: "NOT_FOUND" });
        exactKeys(b, allowed[name], "job");
        if (busy >= 2) return send(res, 429, { ok: false, error: "BUSY" });
        busy++;
        try {
          const result = await (name === "consolidate"
            ? jobs.consolidate(b)
            : name === "reminders"
              ? jobs.reminders(b)
              : name === "health"
                ? jobs.health()
                : jobs.backupVerification());
          return send(res, 200, result);
        } finally {
          busy--;
        }
      }
      if (!reviewer)
        return send(res, 403, {
          ok: false,
          error: "REVIEW_AUTHORITY_REQUIRED",
        });
      const match = u.pathname.match(
        /^\/v1\/(observations|active)\/([A-Za-z0-9._-]+)\/(review|activate|promote|contradict|supersede|transition|recur)$/,
      );
      if (!match) return send(res, 404, { ok: false, error: "NOT_FOUND" });
      const [, kind, id, action] = match;
      safeId(id);
      let result;
      if (kind === "active" && action === "transition") {
        exactKeys(
          b,
          ["status", "note", "expectedRevision", "supersededBy", "dueAt"],
          "transition",
        );
        integer(b.expectedRevision, "expectedRevision");
        result = await vault.updateActiveMemory(id, {
          ...b,
          actor: "human-reviewer",
        });
      } else if (kind === "active" && action === "recur") {
        exactKeys(b, ["expectedRevision"], "recurrence");
        result = await vault.nextOccurrence(id, b);
      } else if (kind === "observations") {
        const keys = {
          review: ["verdict", "note", "correctedClaim", "expectedRevision"],
          activate: ["type", "dueAt", "expiresAt", "recurrence", "priority"],
          promote: [],
          contradict: ["evidence", "note", "expectedRevision"],
          supersede: ["replacementId", "expectedRevision"],
        }[action];
        if (!keys) return send(res, 404, { ok: false, error: "NOT_FOUND" });
        exactKeys(b, keys, "review operation");
        if (["review", "contradict", "supersede"].includes(action))
          integer(b.expectedRevision, "expectedRevision");
        if (action === "review")
          result = await vault.reviewObservation(id, {
            ...b,
            actor: "human-reviewer",
          });
        if (action === "activate")
          result = await vault.activateObservation(id, b);
        if (action === "promote") result = await vault.promoteObservation(id);
        if (action === "contradict")
          result = await vault.addContradiction(id, b);
        if (action === "supersede")
          result = await vault.supersedeObservation(id, {
            ...b,
            actor: "human-reviewer",
          });
      } else return send(res, 404, { ok: false, error: "NOT_FOUND" });
      return send(res, 200, { ok: true, result });
    } catch (e) {
      const status =
        {
          VALIDATION_ERROR: 400,
          CONFLICT: 409,
          CORRUPT_RECORD: 503,
          PROVIDER_UNAVAILABLE: 503,
        }[e.code] ?? 500;
      send(res, status, { ok: false, error: e.code ?? "INTERNAL_ERROR" });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  return server;
}
export async function startFromEnvironment(env = process.env) {
  const vault = new Vault(env.JUNE_MEMORY_VAULT ?? "D:/June/MemoryVault/june");
  await vault.initialize();
  const provider = new OllamaMemoryProvider({
    baseUrl: env.JUNE_OLLAMA_URL ?? "http://127.0.0.1:11434",
  });
  const pipeline = new MemoryPipeline({ vault, provider });
  const engineRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const backup = env.JUNE_BACKUP_ROOT
    ? () =>
        createBackup({
          vault,
          backupRoot: env.JUNE_BACKUP_ROOT,
          openclawRoot: env.JUNE_OPENCLAW_ROOT ?? null,
          engineRoot,
          settingsRoot: env.JUNE_SETTINGS_ROOT ?? null,
          hubRoot: env.JUNE_SETTINGS_ROOT
            ? path.join(engineRoot, ".local/hub")
            : null,
          n8nRoot: env.JUNE_SETTINGS_ROOT
            ? path.join(engineRoot, "automation/n8n/runtime/user/.n8n")
            : null,
          serviceSecretsFile: env.JUNE_SETTINGS_ROOT
            ? path.join(engineRoot, ".local/service-secrets.json")
            : null,
          researchRoot: env.JUNE_SETTINGS_ROOT ? "D:/June/Research" : null,
        })
    : null;
  const jobs = new Jobs({ vault, pipeline, backup });
  const server = createServer({
    vault,
    pipeline,
    jobs,
    workerToken: env.JUNE_WORKER_TOKEN,
    reviewToken: env.JUNE_REVIEW_TOKEN,
    readerToken: env.JUNE_READER_TOKEN ?? env.JUNE_WORKER_TOKEN,
  });
  const port = integer(
    Number(env.JUNE_MEMORY_PORT ?? 3210),
    "port",
    1024,
    65535,
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(
    JSON.stringify({
      ok: true,
      service: "june-memory",
      address: "127.0.0.1",
      port,
    }),
  );
  return server;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startFromEnvironment().catch((e) => {
    console.error(
      JSON.stringify({ ok: false, error: e.code ?? "START_FAILED" }),
    );
    process.exitCode = 1;
  });
