import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { Vault } from "../src/vault.js";
import { MemoryPipeline } from "../src/pipeline.js";
import { createServer } from "../src/server.js";
import { Jobs, localDate } from "../src/jobs.js";
import { readJson } from "../src/util.js";
import { buildWorkflows } from "../automation/n8n/generate.js";
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const dirs = (await fs.readdir(path.join(project, ".local")))
  .filter((x) => x.startsWith("n8n-verification-"))
  .sort();
const root = path.join(project, ".local", dirs.at(-1));
const creds = await readJson(path.join(root, "credentials.json"));
const worker = creds
    .find((c) => c.id === "june-memory-worker")
    .data.value.slice(7),
  webhook = creds.find((c) => c.id === "june-webhook-header").data.value;
const key = (await readJson(path.join(root, ".n8n/config"))).encryptionKey;
const cli = path.join(
  project,
  "automation/n8n/runtime/node_modules/n8n/bin/n8n",
);
const env = {
  ...process.env,
  N8N_USER_FOLDER: root,
  N8N_ENCRYPTION_KEY: key,
  N8N_DIAGNOSTICS_ENABLED: "false",
  N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
  N8N_TEMPLATES_ENABLED: "false",
  N8N_PERSONALIZATION_ENABLED: "false",
  N8N_LISTEN_ADDRESS: "127.0.0.1",
  N8N_HOST: "127.0.0.1",
  N8N_RUNNERS_BROKER_LISTEN_ADDRESS: "127.0.0.1",
  N8N_LOG_LEVEL: "info",
  GENERIC_TIMEZONE: "Asia/Calcutta",
  N8N_SECURE_COOKIE: "false",
};
async function command(args, label) {
  const child = spawn(process.execPath, [cli, ...args], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const timer = setTimeout(() => child.kill(), 120000);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  await fs.writeFile(path.join(root, label + ".log"), output);
  assert.equal(code, 0, label);
  return output;
}
function parseExecution(output) {
  for (let i = output.indexOf("{"); i >= 0; i = output.indexOf("{", i + 1)) {
    try {
      const p = JSON.parse(output.slice(i));
      return p.data?.resultData?.runData?.["Sanitized result"]?.at(-1)?.data
        ?.main?.[0]?.[0]?.json;
    } catch {}
  }
  throw Error("No execution result");
}
const vault = new Vault(path.join(root, "vault"));
await vault.initialize();
const provider = {
  extract: async ({ sessionId, messages }) =>
    JSON.stringify({
      candidates: [
        {
          kind: "commitment",
          claim: "Submit synthetic report.",
          confidence: "high",
          dueAt: null,
          evidence: [
            {
              sourceId: sessionId,
              sourceType: "conversation",
              quote: messages[0].content,
              capturedAt: messages[0].timestamp,
            },
          ],
        },
      ],
    }),
};
const pipeline = new MemoryPipeline({ vault, provider }),
  jobs = new Jobs({ vault, pipeline });
const server = createServer({
  vault,
  pipeline,
  jobs,
  workerToken: worker,
  reviewToken: randomBytes(32).toString("hex"),
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const enginePort = server.address().port;
let child;
const summary = { n8n: "2.42.6", synthetic: true };
try {
  const workflows = buildWorkflows();
  for (const w of workflows)
    w.nodes.find((n) => n.name === "Memory engine").parameters.url = w.nodes
      .find((n) => n.name === "Memory engine")
      .parameters.url.replace(":3210", ":" + enginePort);
  const date = localDate(new Date(), -1),
    daily = path.join(
      vault.root,
      "daily",
      date.slice(0, 4),
      date.slice(5, 7),
      date + ".md",
    );
  await fs.mkdir(path.dirname(daily), { recursive: true });
  await fs.writeFile(daily, "I commit to sending the synthetic report.\n");
  const messages = (await readJson(vault.file("archives/raw", "reminder-seed")))
    ?.messages ?? [
    {
      role: "user",
      content: "I commit to sending the synthetic report.",
      timestamp: new Date().toISOString(),
    },
  ];
  await vault.archiveConversation({ sessionId: "reminder-seed", messages });
  const due =
    (await readJson(vault.file("records/active", "ACT-synthetic-reminder")))
      ?.dueAt ?? new Date(Date.now() - 3600000).toISOString();
  await vault.storeActiveMemory({
    id: "ACT-synthetic-reminder",
    type: "commitment",
    claim: "Send synthetic report.",
    dueAt: due,
    evidence: [
      {
        sourceId: "reminder-seed",
        sourceType: "conversation",
        quote: messages[0].content,
        capturedAt: messages[0].timestamp,
      },
    ],
  });
  const file = path.join(root, "webhook-workflows.json");
  await fs.writeFile(file, JSON.stringify(workflows));
  await command(["import:workflow", "--input", file], "webhook-import");
  summary.consolidationDryRun = parseExecution(
    await command(
      ["execute", "--id", "june-consolidation", "--rawOutput"],
      "daily-preview",
    ),
  );
  assert.equal(summary.consolidationDryRun.sourceStatus, "eligible");
  summary.reminderDryRun = parseExecution(
    await command(
      ["execute", "--id", "june-reminders", "--rawOutput"],
      "reminder-preview",
    ),
  );
  assert.ok(summary.reminderDryRun.notifications >= 1);
  for (const w of workflows.filter((x) =>
    ["june-consolidation", "june-reminders"].includes(x.id),
  ))
    w.nodes.find((n) => n.name === "Job configuration").parameters.jsCode =
      w.nodes
        .find((n) => n.name === "Job configuration")
        .parameters.jsCode.replace('"dryRun":true', '"dryRun":false');
  await fs.writeFile(file, JSON.stringify(workflows));
  await command(["import:workflow", "--input", file], "configured-jobs-import");
  summary.consolidationApply = parseExecution(
    await command(
      ["execute", "--id", "june-consolidation", "--rawOutput"],
      "daily-apply",
    ),
  );
  assert.equal(
    summary.consolidationApply.sourceStatus,
    "candidates-for-review",
  );
  summary.reminderDelivery = parseExecution(
    await command(
      ["execute", "--id", "june-reminders", "--rawOutput"],
      "reminder-local",
    ),
  );
  assert.ok(summary.reminderDelivery.notifications >= 1);
  summary.reminderReplay = parseExecution(
    await command(
      ["execute", "--id", "june-reminders", "--rawOutput"],
      "reminder-repeat",
    ),
  );
  assert.equal(summary.reminderReplay.notifications, 0);
  await command(
    ["publish:workflow", "--id", "june-candidates"],
    "publish-test-webhook",
  );
  const reserve = http.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  env.N8N_PORT = String(port);
  env.WEBHOOK_URL = "http://127.0.0.1:" + port + "/";
  child = spawn(process.execPath, [cli, "start"], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) =>
    fs.appendFile(path.join(root, "webhook-server.log"), b).catch(() => {}),
  );
  child.stderr.on("data", (b) =>
    fs.appendFile(path.join(root, "webhook-server.log"), b).catch(() => {}),
  );
  const url = "http://127.0.0.1:" + port + "/webhook/june-memory-candidates";
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw Error("n8n test server exited");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(1000),
      });
      if (r.status === 401 || r.status === 403) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(ready, "Webhook was not ready");
  summary.unauthorizedRejected = true;
  const request = (body) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-June-Webhook-Key": webhook,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  const invalid = await request({ bad: true });
  assert.equal(invalid.status, 400);
  summary.malformedRejected = true;
  const payload = { sessionId: "webhook-synthetic-once", messages };
  const valid = await request(payload);
  assert.equal(valid.status, 200);
  const result = await valid.json();
  assert.equal(result.ok, true);
  assert.equal(result.candidates, 1);
  summary.webhookSuccess = true;
  const count = (await vault.listRecords("records/observations")).length;
  const repeat = await request(payload);
  assert.equal(repeat.status, 200);
  assert.equal((await vault.listRecords("records/observations")).length, count);
  summary.webhookIdempotent = true;
  // Transport failure must reach the sanitized error response, without request/error details.
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const unavailable = await request({ sessionId: "engine-offline", messages });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).ok, false);
  summary.engineOfflineFailurePath = true;
  await fs.writeFile(
    path.join(project, "docs/N8N_WEBHOOK_VERIFICATION.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify({ ok: true, ...summary }));
} catch (e) {
  console.error(
    JSON.stringify({ ok: false, error: e.message, privateDiagnostics: root }),
  );
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    const kill = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    await once(kill, "exit");
  }
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
