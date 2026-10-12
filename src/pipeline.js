import path from "node:path";
import { ValidationError } from "./errors.js";
import {
  extractionEnvelope,
  validateCandidate,
  validateMessages,
} from "./schema.js";
import { safeId, checksum, withVaultLock } from "./util.js";

export class MemoryPipeline {
  constructor({ vault, provider }) {
    this.vault = vault;
    this.provider = provider;
  }
  async processConversation(input) {
    const id = safeId(input.sessionId);
    return withVaultLock(
      path.join(this.vault.root, "state/processing", id),
      () => this.processLocked(input),
    );
  }
  async processLocked({ sessionId, messages, summary = null }) {
    const id = safeId(sessionId),
      transcript = validateMessages(messages, { redact: true });
    await this.vault.archiveConversation({
      sessionId: id,
      messages: transcript,
      summary,
    });
    const receipt = await this.vault.state("state/jobs", id);
    if (receipt) return { ...receipt, replayed: true };
    const output = await this.provider.extract({
      sessionId: id,
      messages: transcript,
    });
    const candidates = extractionEnvelope(output);
    const result = {
      sessionId: id,
      active: [],
      observations: [],
      rejectedCandidates: [],
      summaryStatus: "not-requested",
    };
    for (let i = 0; i < candidates.length; i++) {
      let candidate;
      try {
        candidate = validateCandidate(candidates[i]);
        if (
          !candidate.evidence.every(
            (e) =>
              e.sourceType === "conversation" &&
              e.sourceId === id &&
              transcript.some(
                (m) =>
                  m.role === "user" &&
                  m.timestamp === e.capturedAt &&
                  m.content.includes(e.quote),
              ),
          )
        )
          throw new ValidationError("ungrounded evidence");
        const suggestedActive =
          candidate.kind === "observation"
            ? null
            : {
                type: candidate.kind,
                dueAt: candidate.dueAt,
                expiresAt: candidate.expiresAt,
                recurrence: candidate.recurrence,
              };
        const created = await this.vault.createObservation({
          id: "OBS-" + checksum({ id, candidate }).slice(0, 40),
          claim: candidate.claim,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
          suggestedActive,
        });
        result.observations.push({
          id: created.record.id,
          created: created.created,
          status: created.record.status,
        });
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e; // I/O and conflicts require retry, never a false success receipt.
        result.rejectedCandidates.push({
          index: i,
          reason:
            e.message === "ungrounded evidence"
              ? "ungrounded evidence"
              : "invalid candidate",
        });
      }
    }
    if (typeof this.provider.summarize === "function") {
      try {
        await this.vault.storeCompaction(
          id,
          await this.provider.summarize({
            sessionId: id,
            messages: transcript,
          }),
        );
        result.summaryStatus = "stored-untrusted";
      } catch (e) {
        if (!["PROVIDER_UNAVAILABLE", "VALIDATION_ERROR"].includes(e.code))
          throw e;
        result.summaryStatus =
          e.code === "PROVIDER_UNAVAILABLE"
            ? "provider-unavailable"
            : "invalid-summary";
      }
    }
    // Receipt contains IDs and counts only, never conversation text or rejected secret-bearing claims.
    await this.vault.writeState("state/jobs", id, result);
    return result;
  }
}
