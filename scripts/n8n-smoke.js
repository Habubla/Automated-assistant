import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Vault } from "../src/vault.js";
import { MemoryPipeline } from "../src/pipeline.js";
import { createServer } from "../src/server.js";
import { Jobs } from "../src/jobs.js";
import { createBackup } from "../src/backup.js";
import { buildWorkflows } from "../automation/n8n/generate.js";
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const root = path.join(project, ".local", "n8n-verification-" + Date.now());
await fs.mkdir(root, { recursive: true });
const cli = path.join(
  project,
  "automation/n8n/runtime/node_modules/n8n/bin/n8n",
);
const worker = randomBytes(32).toString("hex"),
  review = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  N8N_USER_FOLDER: root,
  N8N_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  N8N_DIAGNOSTICS_ENABLED: "false",
  N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
  N8N_TEMPLATES_ENABLED: "false",
  N8N_PERSONALIZATION_ENABLED: "false",
  N8N_LISTEN_ADDRESS: "127.0.0.1",
  N8N_HOST: "127.0.0.1",
  N8N_RUNNERS_BROKER_LISTEN_ADDRESS: "127.0.0.1",
  N8N_LOG_LEVEL: "info",
  GENERIC_TIMEZONE: "Asia/Calcutta",
  N8N_BLOCK_ENV_ACCESS_IN_NODE: "true",
};
async function command(args, label) {
  const child = spawn(process.execPath, [cli, ...args], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const timer = setTimeout(() => child.kill(), 300000);
  const capture = (b) => {
    output += b;
    fs.appendFile(path.join(root, label + ".progress.log"), b).catch(() => {});
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  await fs.writeFile(path.join(root, label + ".log"), output);
  if (code !== 0)
    throw new Error(label + " failed (see private diagnostic log)");
  return output;
}
const vault = new Vault(path.join(root, "vault"));
await vault.initialize();
const provider = {
  extract: async ({ sessionId, messages }) =>
    JSON.stringify({
      candidates: [
        {
          kind: "preference",
          claim: "Prefers written plans.",
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
const pipeline = new MemoryPipeline({ vault, provider });
const jobs = new Jobs({
  vault,
  pipeline,
  fetchImpl: async () => {
    throw Error("synthetic unavailable");
  },
  backup: () => createBackup({ vault, backupRoot: path.join(root, "backups") }),
});
const server = createServer({
  vault,
  pipeline,
  jobs,
  workerToken: worker,
  reviewToken: review,
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
try {
  const credentials = [
    {
      id: "june-memory-worker",
      name: "June Memory worker (local)",
      type: "httpHeaderAuth",
      data: { name: "Authorization", value: "Bearer " + worker },
    },
    {
      id: "june-webhook-header",
      name: "June inbound webhook",
      type: "httpHeaderAuth",
      data: {
        name: "X-June-Webhook-Key",
        value: randomBytes(32).toString("hex"),
      },
    },
  ];
  const credentialsFile = path.join(root, "credentials.json");
  await fs.writeFile(credentialsFile, JSON.stringify(credentials), {
    mode: 0o600,
  });
  await command(
    ["import:credentials", "--input", credentialsFile],
    "credentials-import",
  );
  const workflows = buildWorkflows();
  for (const w of workflows) {
    w.nodes.find((n) => n.name === "Memory engine").parameters.url = w.nodes
      .find((n) => n.name === "Memory engine")
      .parameters.url.replace(":3210", ":" + port);
  }
  const input = path.join(root, "workflows.json");
  await fs.writeFile(input, JSON.stringify(workflows));
  await command(["import:workflow", "--input", input], "workflow-import");
  const results = [];
  for (const w of workflows) {
    const output = await command(
      ["execute", "--id", w.id, "--rawOutput"],
      "execute-" + w.id,
    );
    // Parse the emitted execution envelope; progress messages may precede it.
    let parsed;
    for (let i = output.indexOf("{"); i >= 0; i = output.indexOf("{", i + 1)) {
      try {
        parsed = JSON.parse(output.slice(i));
        break;
      } catch {}
    }
    if (!parsed) throw new Error("No execution JSON for " + w.id);
    const runData =
      parsed.data?.resultData?.runData ??
      parsed.resultData?.runData ??
      parsed.data?.runData;
    const result =
      runData?.["Sanitized result"]?.at(-1)?.data?.main?.[0]?.[0]?.json;
    assert.ok(result, "Missing final sanitized result for " + w.id);
    if (w.id !== "june-health") assert.equal(result.ok, true, w.id);
    else
      assert.equal(result.ok, false, "health must report offline dependencies");
    results.push({ workflow: w.id, executed: true, result });
    console.log(JSON.stringify(results.at(-1)));
  }
  assert.equal((await vault.listRecords("records/observations")).length, 1);
  assert.deepEqual(await vault.searchTrusted("written plans"), []);
  await fs.writeFile(
    path.join(project, "docs/N8N_VERIFICATION.json"),
    JSON.stringify(
      {
        version: "2.42.6",
        createdAt: new Date().toISOString(),
        scope:
          "real n8n CLI imports and executions against synthetic local engine; live webhook tested separately",
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      imported: 5,
      executed: 5,
      privateDiagnostics: root,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({ ok: false, error: e.message, privateDiagnostics: root }),
  );
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
