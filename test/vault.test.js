import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConflictError,
  ProviderUnavailableError,
  ValidationError,
} from "../src/errors.js";
import { MemoryPipeline } from "../src/pipeline.js";
import { OllamaMemoryProvider } from "../src/provider.js";
import { validateActiveMemory } from "../src/schema.js";
import { Vault } from "../src/vault.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = new Vault(root, {
    clock: () => new Date("2026-10-02T10:00:00.000Z"),
  });
  await vault.initialize();
  await vault.archiveConversation({
    sessionId: "session-1",
    messages: [
      {
        role: "user",
        content: "I prefer written plans.",
        timestamp: "2026-10-02T09:00:00.000Z",
      },
    ],
  });
  return { root, vault };
}

const evidence = [
  {
    sourceId: "session-1",
    sourceType: "conversation",
    quote: "I prefer written plans.",
    capturedAt: "2026-10-02T09:00:00.000Z",
  },
];

test("pending observations cannot be retrieved or promoted", async (t) => {
  const { vault } = await fixture(t);
  const created = await vault.createObservation({
    id: "OBS-1",
    claim: "User tends to prefer written plans.",
    confidence: "medium",
    evidence,
  });
  assert.equal(created.record.status, "pending");
  assert.deepEqual(await vault.searchTrusted("written plans"), []);
  await assert.rejects(() => vault.promoteObservation("OBS-1"), ConflictError);

  await vault.reviewObservation("OBS-1", {
    verdict: "confirmed",
    note: "Yes.",
  });
  assert.equal((await vault.searchTrusted("written plans")).length, 1);
  const biography = await vault.promoteObservation("OBS-1", {
    autobiographyId: "BIO-1",
  });
  assert.deepEqual(biography.supportingObservationIds, ["OBS-1"]);
});

test("review enforces terminal state and preserves correction history", async (t) => {
  const { vault } = await fixture(t);
  await vault.createObservation({
    id: "OBS-2",
    claim: "User avoids meetings.",
    confidence: "low",
    evidence,
  });
  const corrected = await vault.reviewObservation("OBS-2", {
    verdict: "corrected",
    correctedClaim: "User prefers short meetings.",
    note: "Clarified by the user.",
  });
  assert.equal(corrected.status, "corrected");
  assert.equal(corrected.claim, "User avoids meetings.");
  assert.equal(corrected.correction, "User prefers short meetings.");
  assert.equal(
    corrected.reviewHistory[0].originalClaim,
    "User avoids meetings.",
  );
  assert.equal(corrected.reviewHistory.length, 1);
  await assert.rejects(
    () => vault.reviewObservation("OBS-2", { verdict: "confirmed" }),
    ConflictError,
  );
});

test("active memory requires a direct user-stated assertion and deduplicates", async (t) => {
  const { vault } = await fixture(t);
  assert.throws(
    () =>
      validateActiveMemory({
        kind: "active_memory",
        schemaVersion: 1,
        id: "ACT-1",
        type: "preference",
        claim: "x",
        status: "active",
        priority: "low",
        dueAt: null,
        assertionOrigin: "model_inferred",
        evidence,
        createdAt: "x",
        updatedAt: "x",
      }),
    ValidationError,
  );
  const first = await vault.storeActiveMemory({
    id: "ACT-1",
    type: "preference",
    claim: "Prefers written plans.",
    evidence,
  });
  const second = await vault.storeActiveMemory({
    id: "ACT-2",
    type: "preference",
    claim: "Prefers written plans.",
    evidence,
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.record.id, "ACT-1");
});

test("archives are immutable and idempotent", async (t) => {
  const { vault, root } = await fixture(t);
  const messages = [
    {
      role: "user",
      content: "Keep the original transcript.",
      timestamp: "2026-10-02T09:00:00.000Z",
    },
  ];
  assert.equal(
    (
      await vault.archiveConversation({
        sessionId: "session-archive",
        messages,
        summary: "Transcript preservation request.",
      })
    ).created,
    true,
  );
  assert.equal(
    (
      await vault.archiveConversation({
        sessionId: "session-archive",
        messages,
        summary: "Ignored on idempotent call.",
      })
    ).created,
    false,
  );
  const raw = JSON.parse(
    await fs.readFile(
      path.join(root, "archives/raw/session-archive.json"),
      "utf8",
    ),
  );
  assert.equal(raw.messages[0].content, "Keep the original transcript.");
  await assert.rejects(
    () =>
      vault.archiveConversation({
        sessionId: "session-archive",
        messages: [{ ...messages[0], content: "Different transcript." }],
      }),
    ConflictError,
  );
});

test("validation reports corrupt records without silently accepting them", async (t) => {
  const { vault, root } = await fixture(t);
  await fs.writeFile(
    path.join(root, "records/active/broken.json"),
    "{not json",
    "utf8",
  );
  const result = await vault.validate();
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "CORRUPT_RECORD");
});

test("initialization adds canonical storage without overwriting a legacy file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-memory-legacy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "README.md"), "legacy vault", "utf8");
  const vault = new Vault(root);
  await vault.initialize();
  assert.equal(
    await fs.readFile(path.join(root, "README.md"), "utf8"),
    "legacy vault",
  );
  assert.ok(await fs.stat(path.join(root, "records/observations")));
  assert.ok(await fs.stat(path.join(root, "june-memory.manifest.json")));
});

test("malformed model JSON is never written as durable memory", async (t) => {
  const { vault } = await fixture(t);
  const pipeline = new MemoryPipeline({
    vault,
    provider: { extract: async () => "not json" },
  });
  await assert.rejects(
    () =>
      pipeline.processConversation({
        sessionId: "session-bad-json",
        messages: [
          {
            role: "user",
            content: "I prefer lists.",
            timestamp: "2026-10-02T09:00:00.000Z",
          },
        ],
      }),
    ValidationError,
  );
  assert.equal((await vault.listRecords("records/active")).length, 0);
  assert.equal((await vault.listRecords("records/observations")).length, 0);
  assert.ok(
    await fs.stat(path.join(vault.root, "archives/raw/session-bad-json.json")),
  );
});

test("pipeline rejects model claims whose evidence is not in a user message", async (t) => {
  const { vault } = await fixture(t);
  const provider = {
    extract: async () =>
      JSON.stringify({
        candidates: [
          {
            kind: "observation",
            claim: "Unsupported pattern.",
            confidence: "high",
            evidence: [
              {
                sourceId: "session-grounding",
                sourceType: "conversation",
                quote: "invented quote",
                capturedAt: "2026-10-02T09:00:00.000Z",
              },
            ],
          },
        ],
      }),
  };
  const result = await new MemoryPipeline({
    vault,
    provider,
  }).processConversation({
    sessionId: "session-grounding",
    messages: [
      {
        role: "user",
        content: "Actual user statement.",
        timestamp: "2026-10-02T09:00:00.000Z",
      },
    ],
  });
  assert.equal(result.observations.length, 0);
  assert.equal(result.rejectedCandidates[0].reason, "ungrounded evidence");
});

test("Ollama absence fails safely", async () => {
  const provider = new OllamaMemoryProvider({
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
  });
  await assert.rejects(
    () =>
      provider.extract({
        sessionId: "session-ollama",
        messages: [
          {
            role: "user",
            content: "Test.",
            timestamp: "2026-10-02T09:00:00.000Z",
          },
        ],
      }),
    ProviderUnavailableError,
  );
});

test("secrets are redacted from archived transcripts and rejected from durable claims", async (t) => {
  const { vault, root } = await fixture(t);
  await vault.archiveConversation({
    sessionId: "session-secret",
    messages: [
      {
        role: "user",
        content: "My api_key=abcdefghijk is private.",
        timestamp: "2026-10-02T09:00:00.000Z",
      },
    ],
  });
  const raw = JSON.parse(
    await fs.readFile(
      path.join(root, "archives/raw/session-secret.json"),
      "utf8",
    ),
  );
  assert.match(raw.messages[0].content, /REDACTED_SECRET/);
  await assert.rejects(
    () =>
      vault.createObservation({
        id: "OBS-secret",
        claim: "The password=abcdefghijk",
        confidence: "low",
        evidence,
      }),
    ValidationError,
  );
});
