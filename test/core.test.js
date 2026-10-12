import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Vault } from "../src/vault.js";
import { MemoryPipeline } from "../src/pipeline.js";
import { OllamaMemoryProvider } from "../src/provider.js";
import {
  validateCompaction,
  validateMessages,
  parseExtractionOutput,
} from "../src/schema.js";
import {
  writeJsonAtomic,
  readJson,
  safeId,
  timestamp,
  withVaultLock,
  checksum,
} from "../src/util.js";

const stamp = "2026-10-12T09:00:00.000Z";
const messages = [
  {
    role: "user",
    content:
      "I prefer written plans. Submit the report on 2026-10-15T10:00:00+05:30.",
    timestamp: stamp,
  },
];
const evidence = [
  {
    sourceId: "s1",
    sourceType: "conversation",
    quote: "I prefer written plans.",
    capturedAt: stamp,
  },
];
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-core-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new Vault(root, { clock: () => new Date(stamp), ...options });
  await vault.initialize();
  await vault.archiveConversation({ sessionId: "s1", messages });
  return { root, vault };
}
async function observation(vault, extras = {}) {
  return (
    await vault.createObservation({
      id: "OBS-one",
      claim: "Prefers written plans.",
      confidence: "high",
      evidence,
      ...extras,
    })
  ).record;
}
test("every model category stays pending and review is required for activation", async (t) => {
  const { vault } = await fixture(t);
  const candidate = {
    kind: "deadline",
    claim: "Submit report.",
    confidence: "high",
    dueAt: "2026-10-15T10:00:00+05:30",
    evidence,
  };
  const pipeline = new MemoryPipeline({
    vault,
    provider: {
      extract: async () => JSON.stringify({ candidates: [candidate] }),
    },
  });
  const result = await pipeline.processConversation({
    sessionId: "s1",
    messages,
  });
  assert.equal(result.active.length, 0);
  assert.equal(result.observations.length, 1);
  assert.deepEqual(await vault.searchTrusted("report"), []);
  const id = result.observations[0].id;
  await assert.rejects(() => vault.activateObservation(id), {
    code: "CONFLICT",
  });
  await vault.reviewObservation(id, {
    verdict: "confirmed",
    note: "User approved",
    expectedRevision: 1,
  });
  const act = await vault.activateObservation(id);
  assert.equal(act.record.dueAt, candidate.dueAt);
  const hits = await vault.searchTrusted("report");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].provenance[0].archiveRef, "archives/raw/s1.json");
  await vault.updateActiveMemory(act.record.id, {
    status: "completed",
    expectedRevision: 1,
  });
  assert.deepEqual(await vault.searchTrusted("report"), []);
  const replay = await pipeline.processConversation({
    sessionId: "s1",
    messages,
  });
  assert.equal(replay.replayed, true);
  assert.equal((await vault.listRecords("records/active")).length, 1);
});
test("candidate isolation rejects secrets and fabricated dates without leaking them", async (t) => {
  const { vault } = await fixture(t),
    valid = {
      kind: "observation",
      claim: "Likes written plans.",
      confidence: "high",
      evidence,
    };
  const secret = "password=veryprivatevalue";
  const p = new MemoryPipeline({
    vault,
    provider: {
      extract: async () =>
        JSON.stringify({
          candidates: [
            valid,
            { ...valid, claim: secret },
            {
              ...valid,
              evidence: [
                { ...evidence[0], capturedAt: "2026-10-13T09:00:00Z" },
              ],
            },
          ],
        }),
    },
  });
  const r = await p.processConversation({ sessionId: "s1", messages });
  assert.equal(r.observations.length, 1);
  assert.equal(r.rejectedCandidates.length, 2);
  assert.ok(!JSON.stringify(r).includes(secret));
});
test("timestamps, null model output, extra fields and path traversal are rejected", () => {
  for (const x of ["2026-02-30T10:00:00Z", "today", "2026-10-12T25:00:00Z"])
    assert.throws(() => timestamp(x));
  for (const x of ["../a", "a/b", "CON", "nul.json", "abc."])
    assert.throws(() => safeId(x));
  assert.throws(() => parseExtractionOutput('{"candidates":null}'));
  assert.throws(() => validateMessages([{ ...messages[0], token: "secret" }]));
  assert.throws(() =>
    validateCompaction({
      kind: "conversation_compaction",
      schemaVersion: 1,
      sessionId: "s",
      archiveRef: "../a",
      summary: "x",
      createdAt: stamp,
    }),
  );
});
test("forged review history and arbitrary profile replacement cannot become truth", async (t) => {
  const { vault, root } = await fixture(t);
  await observation(vault);
  await vault.reviewObservation("OBS-one", { verdict: "confirmed" });
  await assert.rejects(() =>
    vault.promoteObservation("OBS-one", { claim: "Invented fact" }),
  );
  const p = vault.file("records/observations", "OBS-one"),
    r = await readJson(p);
  r.reviewHistory = [];
  await fs.writeFile(p, JSON.stringify(r));
  assert.equal((await vault.validate()).ok, false);
  await assert.rejects(() => vault.searchTrusted("written"));
});
test("contradiction suppresses observation, active memory and derived biography", async (t) => {
  const { vault } = await fixture(t);
  await observation(vault);
  await vault.reviewObservation("OBS-one", { verdict: "confirmed" });
  await vault.promoteObservation("OBS-one");
  await vault.activateObservation("OBS-one", { type: "preference" });
  assert.ok((await vault.searchTrusted("plans")).length);
  await vault.addContradiction("OBS-one", {
    evidence,
    note: "User says this needs review",
    expectedRevision: 2,
  });
  assert.deepEqual(await vault.searchTrusted("plans"), []);
});
test("confirmed replacement suppresses old biography without erasing audit", async (t) => {
  const { vault, root } = await fixture(t);
  await observation(vault);
  await vault.reviewObservation("OBS-one", { verdict: "confirmed" });
  await vault.promoteObservation("OBS-one");
  await observation(vault, {
    id: "OBS-two",
    claim: "Plans depend on the situation.",
  });
  await vault.reviewObservation("OBS-two", { verdict: "confirmed" });
  await vault.supersedeObservation("OBS-one", {
    replacementId: "OBS-two",
    expectedRevision: 2,
  });
  assert.deepEqual(await vault.searchTrusted("written"), []);
  const audit = await fs.readdir(path.join(root, "audit"));
  assert.ok(audit.length >= 6);
  assert.equal((await vault.validate()).ok, true);
});
test("compaction validation checks checksum and malformed JSON", async (t) => {
  const { vault, root } = await fixture(t);
  await vault.storeCompaction("s1", "A short source-linked summary.");
  await fs.writeFile(vault.file("archives/compactions", "s1"), "{broken");
  assert.equal((await vault.validate()).ok, false);
  const raw = await readJson(vault.file("archives/raw", "s1"));
  raw.messages[0].content = "changed";
  await fs.writeFile(vault.file("archives/raw", "s1"), JSON.stringify(raw));
  assert.equal((await vault.validate()).errors.length, 2);
});
test("invalid summary does not partially archive and replay can fill absent summary", async (t) => {
  const { vault } = await fixture(t);
  await assert.rejects(() =>
    vault.archiveConversation({
      sessionId: "new",
      messages,
      summary: "password=abcdefghijk",
    }),
  );
  assert.equal(await readJson(vault.file("archives/raw", "new")), undefined);
  await vault.storeCompaction("s1", "Summary.");
  assert.equal((await vault.validate()).ok, true);
});
test("parallel duplicates create only one record and revision conflict has one winner", async (t) => {
  const { vault } = await fixture(t);
  const created = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      observation(vault, { id: "OBS-" + i }),
    ),
  );
  assert.equal(new Set(created.map((r) => r.id)).size, 1);
  const id = created[0].id;
  const results = await Promise.allSettled([
    vault.reviewObservation(id, { verdict: "confirmed", expectedRevision: 1 }),
    vault.reviewObservation(id, { verdict: "rejected", expectedRevision: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await vault.validate()).ok, true);
});
test("failed rename preserves original, removes temporary files, and leaves an inert audit intent", async (t) => {
  const { vault, root } = await fixture(t);
  await observation(vault);
  const before = await fs.readFile(
    vault.file("records/observations", "OBS-one"),
    "utf8",
  );
  const fail = new Vault(root, {
    clock: () => new Date(stamp),
    writer: (file, v, o) =>
      writeJsonAtomic(file, v, {
        ...o,
        io: {
          ...fs,
          rename: async (a, b) => {
            if (b.includes(path.join("records", "observations")))
              throw Object.assign(new Error("disk failure"), { code: "EIO" });
            return fs.rename(a, b);
          },
        },
      }),
  });
  await assert.rejects(() =>
    fail.reviewObservation("OBS-one", { verdict: "confirmed" }),
  );
  assert.equal(
    await fs.readFile(vault.file("records/observations", "OBS-one"), "utf8"),
    before,
  );
  assert.ok(
    !(await fs.readdir(path.join(root, "records/observations"))).some((n) =>
      n.endsWith(".tmp"),
    ),
  );
  assert.deepEqual(await vault.searchTrusted("plans"), []);
  await vault.reviewObservation("OBS-one", { verdict: "confirmed" });
  assert.equal((await vault.validate()).ok, true);
});
test("atomic exclusive creation has one winner", async (t) => {
  const { root } = await fixture(t),
    file = path.join(root, "race.json");
  const r = await Promise.allSettled([
    writeJsonAtomic(file, { a: 1 }, { overwrite: false }),
    writeJsonAtomic(file, { a: 2 }, { overwrite: false }),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.ok([1, 2].includes((await readJson(file)).a));
});
test("lock is not stolen from a slow live holder", async (t) => {
  const { root } = await fixture(t);
  let release;
  const gate = new Promise((r) => (release = r));
  let ready;
  const started = new Promise((r) => (ready = r));
  const held = withVaultLock(root, async () => {
    ready();
    await gate;
  });
  await started;
  await assert.rejects(
    () => withVaultLock(root, async () => {}, { attempts: 2, retryMs: 5 }),
    { code: "CONFLICT" },
  );
  release();
  await held;
});
test("process crash releases lock and history survives a new Vault", async (t) => {
  const { root, vault } = await fixture(t);
  await observation(vault);
  const util = new URL("../src/util.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {withVaultLock} from ${JSON.stringify(util)};await withVaultLock(${JSON.stringify(root)},async()=>{console.log('LOCKED');await new Promise(()=>{});});`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (b) => {
      if (b.toString().includes("LOCKED")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (c) => reject(new Error("child exited " + c)));
  });
  const done = once(child, "exit");
  child.kill();
  await done;
  await withVaultLock(root, async () => {});
  assert.equal(
    (await new Vault(root).getObservation("OBS-one")).claim,
    "Prefers written plans.",
  );
});
test("expiry is hidden while overdue deadlines remain explicitly labeled", async (t) => {
  const { vault } = await fixture(t);
  await vault.storeActiveMemory({
    id: "expired",
    type: "preference",
    claim: "Old preference",
    expiresAt: "2026-10-11T00:00:00Z",
    evidence,
  });
  await vault.storeActiveMemory({
    id: "overdue",
    type: "deadline",
    claim: "Report deadline",
    dueAt: "2026-10-11T00:00:00Z",
    evidence,
  });
  assert.deepEqual(await vault.searchTrusted("preference"), []);
  assert.equal((await vault.searchTrusted("report"))[0].overdue, true);
  const paused = await vault.updateActiveMemory("overdue", {
    status: "paused",
    expectedRevision: 1,
  });
  assert.deepEqual(await vault.searchTrusted("report"), []);
  await vault.updateActiveMemory("overdue", {
    status: "active",
    expectedRevision: paused.revision,
  });
});
test("junctions cannot redirect managed storage", async (t) => {
  const { vault, root } = await fixture(t),
    other = await fs.mkdtemp(path.join(os.tmpdir(), "june-other-"));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.rmdir(path.join(root, "records/observations"));
  await fs.symlink(other, path.join(root, "records/observations"), "junction");
  await assert.rejects(() => observation(vault), { code: "VALIDATION_ERROR" });
});
test("provider retries transient outage but never retries malformed output", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw Error("unavailable");
    return new Response(
      JSON.stringify({ message: { content: '{"candidates":[]}' }, done: true }),
    );
  };
  const provider = new OllamaMemoryProvider({ fetchImpl });
  assert.equal(
    await provider.extract({ sessionId: "s1", messages }),
    '{"candidates":[]}',
  );
  assert.equal(calls, 2);
  const bad = new OllamaMemoryProvider({
    fetchImpl: async () => new Response("bad"),
  });
  await assert.rejects(() => bad.extract({ sessionId: "s1", messages }), {
    code: "VALIDATION_ERROR",
  });
});
test("provider timeout, unavailable model and excessive response are bounded", async () => {
  const timed = new OllamaMemoryProvider({
    timeoutMs: 10,
    retries: 0,
    fetchImpl: async (_u, o) =>
      new Promise((_, reject) =>
        o.signal.addEventListener("abort", () => reject(Error("timeout"))),
      ),
  });
  // Keep this injected fake alive until AbortSignal.timeout fires (native fetch already owns a handle).
  const keep = setInterval(() => {}, 100);
  try {
    await assert.rejects(() => timed.extract({ sessionId: "s1", messages }), {
      code: "PROVIDER_UNAVAILABLE",
    });
  } finally {
    clearInterval(keep);
  }
  let count = 0;
  const missing = new OllamaMemoryProvider({
    fetchImpl: async () => {
      count++;
      return new Response("{}", { status: 404 });
    },
  });
  await assert.rejects(() => missing.extract({ sessionId: "s1", messages }));
  assert.equal(count, 1);
  const huge = new OllamaMemoryProvider({
    fetchImpl: async () => new Response("x".repeat(130000)),
  });
  await assert.rejects(() => huge.extract({ sessionId: "s1", messages }), {
    code: "VALIDATION_ERROR",
  });
});
