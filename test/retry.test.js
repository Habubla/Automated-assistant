import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { MemoryPipeline } from "../src/pipeline.js";
test("concurrent duplicate pipeline jobs extract once and preserve the same receipt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-retry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new Vault(root);
  await vault.initialize();
  let calls = 0;
  const provider = {
    extract: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return '{"candidates":[]}';
    },
  };
  const p = new MemoryPipeline({ vault, provider }),
    input = {
      sessionId: "same",
      messages: [
        { role: "user", content: "Hello.", timestamp: "2026-10-12T09:00:00Z" },
      ],
    };
  const results = await Promise.all([
    p.processConversation(input),
    p.processConversation(input),
  ]);
  assert.equal(calls, 1);
  assert.ok(results.some((r) => r.replayed));
});
test("recurring item completion and next occurrence are separate, idempotent records", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-recurrence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new Vault(root);
  await vault.initialize();
  const timestamp = "2026-10-12T09:00:00Z";
  await vault.archiveConversation({
    sessionId: "repeat",
    messages: [
      { role: "user", content: "Review my plan every day.", timestamp },
    ],
  });
  const evidence = [
    {
      sourceId: "repeat",
      sourceType: "conversation",
      quote: "Review my plan every day.",
      capturedAt: timestamp,
    },
  ];
  await vault.storeActiveMemory({
    id: "repeat-task",
    type: "recurring_task",
    claim: "Review my plan.",
    dueAt: timestamp,
    recurrence: 1,
    evidence,
  });
  await vault.updateActiveMemory("repeat-task", {
    status: "completed",
    expectedRevision: 1,
  });
  const next = await vault.nextOccurrence("repeat-task", {
      expectedRevision: 2,
    }),
    again = await vault.nextOccurrence("repeat-task", { expectedRevision: 2 });
  assert.equal(next.record.id, again.record.id);
  assert.equal(next.record.dueAt, "2026-10-13T09:00:00.000Z");
  assert.equal((await vault.getActive("repeat-task")).status, "completed");
});
