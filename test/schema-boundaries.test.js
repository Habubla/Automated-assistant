import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateAnyRecord } from "../src/schema.js";
import { Vault } from "../src/vault.js";
test("prototype property names cannot bypass the record-kind validator", () => {
  for (const kind of ["constructor", "toString", "__proto__", "valueOf"])
    assert.throws(() => validateAnyRecord({ kind }), {
      code: "VALIDATION_ERROR",
    });
});
test("missing manifest is unhealthy and validation creates no vault", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "june-manifest-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const target = path.join(base, "missing");
  assert.equal((await new Vault(target).validate()).ok, false);
  await assert.rejects(() => fs.stat(target), { code: "ENOENT" });
});
test("confirmed deadlines cannot be promoted into the stable profile", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const v = new Vault(root);
  await v.initialize();
  const timestamp = "2026-10-12T09:00:00Z";
  await v.archiveConversation({
    sessionId: "s",
    messages: [{ role: "user", content: "Submit tomorrow.", timestamp }],
  });
  await v.createObservation({
    id: "o",
    claim: "Submit tomorrow.",
    confidence: "high",
    evidence: [
      {
        sourceId: "s",
        sourceType: "conversation",
        quote: "Submit tomorrow.",
        capturedAt: timestamp,
      },
    ],
    suggestedActive: { type: "deadline", dueAt: "2026-10-13T09:00:00Z" },
  });
  await v.reviewObservation("o", { verdict: "confirmed" });
  await assert.rejects(() => v.promoteObservation("o"), {
    code: "VALIDATION_ERROR",
  });
});
