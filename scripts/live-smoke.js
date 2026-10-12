import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { OllamaMemoryProvider } from "../src/provider.js";
import { MemoryPipeline } from "../src/pipeline.js";
import assert from "node:assert/strict";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-live-qwen-"));
try {
  const vault = new Vault(root);
  await vault.initialize();
  const provider = new OllamaMemoryProvider({ timeoutMs: 60000, retries: 0 });
  const timestamp = new Date().toISOString();
  const result = await new MemoryPipeline({
    vault,
    provider,
  }).processConversation({
    sessionId: "synthetic-live-qwen",
    messages: [
      {
        role: "user",
        content:
          "I prefer written plans. I commit to submitting my report by 2026-10-15T17:00:00+05:30.",
        timestamp,
      },
    ],
  });
  assert.ok(
    result.observations.length >= 1,
    "No grounded candidates were extracted",
  );
  assert.equal(result.active.length, 0);
  assert.deepEqual(await vault.searchTrusted("report plans"), []);
  const list = await vault.listRecords("records/observations");
  const o =
    list.find((x) => x.suggestedActive?.type === "preference") ?? list[0];
  await vault.reviewObservation(o.id, { verdict: "confirmed" });
  if (o.suggestedActive?.type === "preference" || !o.suggestedActive)
    await vault.promoteObservation(o.id);
  else await vault.activateObservation(o.id);
  assert.equal((await vault.validate()).ok, true);
  console.log(
    JSON.stringify({
      ok: true,
      model: provider.model,
      candidates: result.observations.length,
      rejected: result.rejectedCandidates.length,
      summary: result.summaryStatus,
      pendingIsolation: true,
      review: true,
      validation: true,
      synthetic: true,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({ ok: false, error: e.code ?? e.name, synthetic: true }),
  );
  process.exitCode = 1;
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
