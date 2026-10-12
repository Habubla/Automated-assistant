import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { Vault } from "../src/vault.js";
import { MemoryPipeline } from "../src/pipeline.js";
import { createServer } from "../src/server.js";
import { Jobs } from "../src/jobs.js";
import { createBackup, verifyBackup, restoreVault } from "../src/backup.js";
const worker = "synthetic-worker-".repeat(3),
  reviewer = "synthetic-review-".repeat(3),
  stamp = "2026-10-12T09:00:00Z";
const messages = [
  { role: "user", content: "Submit the report tomorrow.", timestamp: stamp },
];
async function setup(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "june-service-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const vault = new Vault(path.join(base, "vault"), {
    clock: () => new Date(stamp),
  });
  await vault.initialize();
  let calls = 0;
  const provider = {
    extract: async ({ sessionId, messages }) => {
      calls++;
      return JSON.stringify({
        candidates: [
          {
            kind: "commitment",
            claim: "Submit report.",
            confidence: "high",
            dueAt: "2026-10-13T09:00:00Z",
            evidence: [
              {
                sourceId: sessionId,
                sourceType: "conversation",
                quote: messages[0].content.slice(0, 4000),
                capturedAt: messages[0].timestamp,
              },
            ],
          },
        ],
      });
    },
  };
  const pipeline = new MemoryPipeline({ vault, provider }),
    jobs = new Jobs({
      vault,
      pipeline,
      fetchImpl: async () => {
        throw Error("offline");
      },
    });
  const server = createServer({
    vault,
    pipeline,
    jobs,
    workerToken: worker,
    reviewToken: reviewer,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = "http://127.0.0.1:" + server.address().port;
  async function request(
    route,
    { token = worker, body, method = body ? "POST" : "GET" } = {},
  ) {
    const r = await fetch(url + route, {
      method,
      headers: {
        authorization: "Bearer " + token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, value: await r.json() };
  }
  return { base, vault, pipeline, jobs, request, url, getCalls: () => calls };
}
test("authenticated intake cannot grant itself review authority", async (t) => {
  const { request, vault } = await setup(t);
  assert.equal((await request("/v1/status", { token: "wrong" })).status, 401);
  assert.equal(
    (await request("/v1/process", { body: { sessionId: "s", messages } }))
      .status,
    200,
  );
  const o = (await vault.listRecords("records/observations"))[0];
  assert.equal(
    (
      await request("/v1/observations/" + o.id + "/review", {
        body: { verdict: "confirmed", expectedRevision: 1 },
      })
    ).status,
    403,
  );
  assert.equal((await request("/v1/review-queue")).status, 403);
  assert.equal(
    (
      await request("/v1/observations/" + o.id + "/review", {
        token: reviewer,
        body: { verdict: "confirmed", expectedRevision: 1 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/v1/observations/" + o.id + "/activate", {
        token: reviewer,
        body: {},
      })
    ).status,
    200,
  );
  const hits = (await request("/v1/search?q=report")).value.results;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provenance[0].sourceId, "s");
  assert.equal(
    (
      await request("/v1/active/" + hits[0].id + "/transition", {
        token: reviewer,
        body: { status: "completed", expectedRevision: 1 },
      })
    ).status,
    200,
  );
  assert.deepEqual((await request("/v1/search?q=report")).value.results, []);
});
test("service rejects malformed, oversized, browser and unexpected-field inputs", async (t) => {
  const { request, url } = await setup(t);
  assert.equal(
    (
      await request("/v1/process", {
        body: { sessionId: "s", messages, status: "confirmed" },
      })
    ).status,
    400,
  );
  const bad = await fetch(url + "/v1/process", {
    method: "POST",
    headers: {
      authorization: "Bearer " + worker,
      "content-type": "application/json",
    },
    body: "{bad",
  });
  assert.equal(bad.status, 400);
  const big = await fetch(url + "/v1/process", {
    method: "POST",
    headers: {
      authorization: "Bearer " + worker,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "s",
      messages: [{ ...messages[0], content: "x".repeat(130000) }],
    }),
  });
  assert.equal(big.status, 400);
  const browser = await fetch(url + "/v1/status", {
    headers: {
      authorization: "Bearer " + worker,
      origin: "https://untrusted.invalid",
    },
  });
  assert.equal(browser.status, 403);
  assert.equal((await request("/v1/search?q=report&limit=-1")).status, 400);
});
test("pipeline replay and malformed conflicting archive are idempotent over HTTP", async (t) => {
  const { request, getCalls } = await setup(t);
  await request("/v1/process", { body: { sessionId: "s", messages } });
  assert.equal(
    (await request("/v1/process", { body: { sessionId: "s", messages } })).value
      .replayed,
    true,
  );
  assert.equal(getCalls(), 1);
  assert.equal(
    (
      await request("/v1/process", {
        body: {
          sessionId: "s",
          messages: [{ ...messages[0], content: "Different." }],
        },
      })
    ).status,
    409,
  );
});
test("daily consolidation previews source and only creates review candidates", async (t) => {
  const { vault, jobs } = await setup(t);
  const file = path.join(vault.root, "daily/2026/10/2026-10-11.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "# Daily\nSubmit a draft report tomorrow.\n");
  const original = await fs.readFile(file, "utf8");
  const preview = await jobs.consolidate({ date: "2026-10-11" });
  assert.equal(preview.status, "eligible");
  assert.equal((await vault.listRecords("records/observations")).length, 0);
  const done = await jobs.consolidate({ date: "2026-10-11", dryRun: false });
  assert.equal(done.status, "candidates-for-review");
  assert.equal(
    (await vault.listRecords("records/observations"))[0].status,
    "pending",
  );
  assert.equal(await fs.readFile(file, "utf8"), original);
  const replay = await jobs.consolidate({ date: "2026-10-11", dryRun: false });
  assert.equal(replay.result.replayed, true);
  await assert.rejects(() => jobs.consolidate({ date: "../../elsewhere" }));
});
test("blank daily template is skipped", async (t) => {
  const { vault, jobs } = await setup(t);
  const file = path.join(vault.root, "daily/2026/10/2026-10-11.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "# Daily\n## Commitments\n-\n");
  assert.equal(
    (await jobs.consolidate({ dryRun: false })).status,
    "empty-scaffold",
  );
});
test("reminder dry run does not consume delivery and local delivery deduplicates", async (t) => {
  const { vault, jobs, request } = await setup(t);
  await request("/v1/process", { body: { sessionId: "s", messages } });
  const o = (await vault.listRecords("records/observations"))[0];
  await vault.reviewObservation(o.id, { verdict: "confirmed" });
  await vault.activateObservation(o.id);
  assert.equal((await jobs.reminders()).notifications.length, 1);
  assert.equal((await jobs.reminders()).notifications.length, 1);
  const actual = await jobs.reminders({ dryRun: false });
  assert.equal(actual.externalDelivery, false);
  assert.equal(actual.notifications[0].status, "delivered-local");
  assert.equal(
    (await jobs.reminders({ dryRun: false })).notifications.length,
    0,
  );
});
test("health distinguishes absent services and records only changed state", async (t) => {
  const { jobs, vault } = await setup(t);
  const first = await jobs.health(),
    second = await jobs.health();
  assert.equal(first.ok, false);
  assert.equal(first.checks.filter((c) => !c.ok).length, 3);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(
    (await vault.state("state/reports", "health")).signature,
    first.signature,
  );
});
test("backup verifies and restores history into a new directory", async (t) => {
  const { vault, base, request } = await setup(t);
  await request("/v1/process", { body: { sessionId: "s", messages } });
  const before = await fs.readFile(vault.file("archives/raw", "s"), "utf8");
  const snap = await createBackup({
    vault,
    backupRoot: path.join(base, "backups"),
  });
  assert.equal((await verifyBackup(snap.path)).ok, true);
  const dest = path.join(base, "restored");
  assert.equal(
    (await restoreVault({ backupPath: snap.path, target: dest })).ok,
    true,
  );
  assert.equal(
    await fs.readFile(path.join(dest, "archives/raw/s.json"), "utf8"),
    before,
  );
  await assert.rejects(() =>
    restoreVault({ backupPath: snap.path, target: vault.root }),
  );
  await assert.rejects(() =>
    createBackup({ vault, backupRoot: path.join(vault.root, "bad-backup") }),
  );
  await fs.appendFile(path.join(snap.path, "vault/archives/raw/s.json"), "x");
  await assert.rejects(() => verifyBackup(snap.path));
});
