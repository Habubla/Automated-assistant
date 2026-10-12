import fs from "node:fs/promises";
import path from "node:path";
import { ConflictError, ValidationError } from "./errors.js";
import {
  ACTIVE_TYPES,
  validateAnyRecord,
  validateObservation,
  validateActiveMemory,
  validateAutobiography,
  validateEvidenceList,
  validateArchive,
  validateCompaction,
  validateMessages,
} from "./schema.js";
import {
  checksum,
  isoNow,
  listJsonFiles,
  readJson,
  recordId,
  requireOneOf,
  cleanText,
  safeId,
  tokenize,
  withVaultLock,
  writeJsonAtomic,
  inside,
  assertNoLinks,
  integer,
  exactKeys,
} from "./util.js";

export const SECTIONS = [
  "records/active",
  "records/observations",
  "records/autobiography",
  "archives/raw",
  "archives/compactions",
];
export const STATE_SECTIONS = [
  "state/jobs",
  "state/reports",
  "state/notifications",
];
const keyOf = (r) =>
  checksum({
    type: r.type ?? r.suggestedActive?.type ?? "observation",
    claim: r.claim.toLowerCase(),
    due: r.dueAt ?? r.suggestedActive?.dueAt ?? null,
    evidence: r.evidence,
  });
const usable = (o) =>
  o.status === "confirmed" && !o.supersededBy && !o.contradictions.length;
export class Vault {
  constructor(
    root,
    { clock = () => new Date(), writer = writeJsonAtomic } = {},
  ) {
    this.root = path.resolve(root);
    this.clock = clock;
    this.writer = writer;
  }
  file(section, id) {
    if (![...SECTIONS, ...STATE_SECTIONS, "audit"].includes(section))
      throw new ValidationError("Unknown storage section.");
    return inside(this.root, path.join(section, `${safeId(id)}.json`));
  }
  async initialize() {
    return withVaultLock(this.root, async () => {
      for (const d of [...SECTIONS, ...STATE_SECTIONS, "audit", "templates"]) {
        const dest = inside(this.root, d);
        await assertNoLinks(dest);
        await fs.mkdir(dest, { recursive: true });
      }
      const manifest = inside(this.root, "june-memory.manifest.json");
      if (!(await readJson(manifest)))
        await this.writer(
          manifest,
          {
            schemaVersion: 1,
            createdAt: isoNow(this.clock),
            purpose: "June validated persistent-memory vault",
          },
          { overwrite: false },
        );
    });
  }
  async listRecords(section) {
    if (!SECTIONS.includes(section))
      throw new ValidationError("Unknown record section.");
    const files = await listJsonFiles(inside(this.root, section));
    const out = [];
    for (const file of files) {
      const r = validateAnyRecord(await readJson(file));
      const expected = this.file(section, r.id ?? r.sessionId);
      if (expected !== file)
        throw new ValidationError("Record identity and filename disagree.");
      out.push(r);
    }
    return out;
  }
  async getObservation(id) {
    const r = await readJson(this.file("records/observations", id));
    if (!r) throw new ValidationError("Unknown observation.");
    return validateObservation(r);
  }
  async getActive(id) {
    const r = await readJson(this.file("records/active", id));
    if (!r) throw new ValidationError("Unknown active record.");
    return validateActiveMemory(r);
  }
  async assertEvidence(evidence) {
    for (const e of validateEvidenceList(evidence)) {
      if (e.sourceType !== "conversation")
        throw new ValidationError(
          "Evidence must reference an immutable conversation archive.",
        );
      const raw = await readJson(this.file("archives/raw", e.sourceId));
      if (!raw) throw new ValidationError("Evidence source is missing.");
      const archive = validateArchive(raw);
      if (
        !archive.messages.some(
          (m) =>
            m.role === "user" &&
            m.timestamp === e.capturedAt &&
            m.content.includes(e.quote),
        )
      )
        throw new ValidationError(
          "Evidence quote/date does not match a user source.",
        );
    }
  }
  async persist(section, value, { create = false } = {}) {
    const r = validateAnyRecord(value);
    const file = this.file(section, r.id ?? r.sessionId);
    if (create && (await readJson(file)))
      throw new ConflictError("Record ID is already used.");
    // Immutable revision intent is written first. The current record is the commit point.
    // An interrupted intent never becomes current truth; its hash can be compared during recovery.
    const auditId = `${r.id ?? r.sessionId}-${r.revision ?? 1}-${checksum(r).slice(0, 24)}`;
    const audit = this.file("audit", auditId);
    if (!(await readJson(audit)))
      await this.writer(
        audit,
        { schemaVersion: 1, section, record: r, checksum: checksum(r) },
        { overwrite: false },
      );
    await this.writer(file, r, { overwrite: !create });
    return r;
  }
  async createObservation({
    id = recordId("OBS", this.clock),
    claim,
    confidence,
    evidence,
    suggestedActive = null,
  }) {
    const now = isoNow(this.clock);
    const record = validateObservation({
      kind: "observation",
      schemaVersion: 1,
      id,
      claim,
      confidence,
      status: "pending",
      evidence,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      reviewHistory: [],
      correction: null,
      suggestedActive,
      contradictions: [],
      supersededBy: null,
    });
    return withVaultLock(this.root, async () => {
      await this.assertEvidence(record.evidence);
      const existing = await this.listRecords("records/observations");
      const dup = existing.find((x) => keyOf(x) === keyOf(record));
      if (dup) return { created: false, record: dup };
      await this.persist("records/observations", record, { create: true });
      return { created: true, record };
    });
  }
  async reviewObservation(
    id,
    {
      verdict,
      note = "",
      correctedClaim = null,
      expectedRevision,
      actor = "local-user",
    },
  ) {
    requireOneOf(verdict, "verdict", ["confirmed", "corrected", "rejected"]);
    if (note !== "") cleanText(note, "review note");
    cleanText(actor, "actor", { max: 100 });
    if (verdict === "corrected" && !correctedClaim)
      throw new ValidationError("Correction text is required.");
    if (verdict !== "corrected" && correctedClaim !== null)
      throw new ValidationError(
        "Correction is only valid with corrected verdict.",
      );
    return withVaultLock(this.root, async () => {
      const current = await this.getObservation(id);
      if (
        current.status === verdict &&
        current.reviewHistory[0]?.note === note &&
        current.correction === correctedClaim
      )
        return current;
      if (
        expectedRevision !== undefined &&
        current.revision !== expectedRevision
      )
        throw new ConflictError("Observation revision changed.");
      if (current.status !== "pending")
        throw new ConflictError("Only pending observations may be reviewed.");
      await this.assertEvidence(current.evidence);
      const now = isoNow(this.clock);
      return this.persist("records/observations", {
        ...current,
        status: verdict,
        correction: correctedClaim,
        revision: current.revision + 1,
        updatedAt: now,
        reviewHistory: [
          {
            verdict,
            note,
            reviewedAt: now,
            actor,
            originalClaim: current.claim,
          },
        ],
      });
    });
  }
  async addContradiction(id, { evidence, note, expectedRevision }) {
    return withVaultLock(this.root, async () => {
      const current = await this.getObservation(id);
      if (current.revision !== integer(expectedRevision, "expectedRevision"))
        throw new ConflictError("Observation revision changed.");
      await this.assertEvidence(evidence);
      const item = {
        evidence: validateEvidenceList(evidence),
        note: cleanText(note, "contradiction"),
        createdAt: isoNow(this.clock),
      };
      return this.persist("records/observations", {
        ...current,
        contradictions: [...current.contradictions, item],
        revision: current.revision + 1,
        updatedAt: isoNow(this.clock),
      });
    });
  }
  async supersedeObservation(
    id,
    { replacementId, expectedRevision, actor = "local-user" },
  ) {
    return withVaultLock(this.root, async () => {
      const current = await this.getObservation(id),
        replacement = await this.getObservation(replacementId);
      if (id === replacementId || !usable(replacement))
        throw new ValidationError(
          "Replacement must be a separate supported confirmed observation.",
        );
      if (
        current.revision !== expectedRevision ||
        current.status !== "confirmed" ||
        current.supersededBy
      )
        throw new ConflictError("Observation changed or cannot be superseded.");
      return this.persist("records/observations", {
        ...current,
        supersededBy: replacementId,
        revision: current.revision + 1,
        updatedAt: isoNow(this.clock),
        reviewHistory: [
          ...current.reviewHistory,
          {
            verdict: "superseded",
            note: "Replaced by " + replacementId,
            reviewedAt: isoNow(this.clock),
            actor,
          },
        ],
      });
    });
  }
  async promoteObservation(id, { autobiographyId, claim } = {}) {
    return withVaultLock(this.root, async () => {
      const o = await this.getObservation(id);
      if (!usable(o))
        throw new ConflictError(
          "Only supported confirmed observations may enter the profile.",
        );
      if (
        o.suggestedActive &&
        (o.suggestedActive.type !== "preference" ||
          o.suggestedActive.dueAt ||
          o.suggestedActive.expiresAt)
      )
        throw new ValidationError(
          "Time-bound candidates belong in active memory, not the stable profile.",
        );
      if (claim && claim !== o.claim)
        throw new ValidationError(
          "Promotion cannot substitute an unreviewed claim.",
        );
      const existing = (await this.listRecords("records/autobiography")).find(
        (b) => b.supportingObservationIds.includes(id),
      );
      if (existing) return existing;
      const now = isoNow(this.clock);
      return this.persist(
        "records/autobiography",
        validateAutobiography({
          kind: "autobiography",
          schemaVersion: 1,
          id: autobiographyId ?? "BIO-" + checksum(id).slice(0, 32),
          claim: o.claim,
          supportingObservationIds: [id],
          status: "confirmed",
          createdAt: now,
          updatedAt: now,
          revision: 1,
        }),
        { create: true },
      );
    });
  }
  async storeActiveMemory({
    id = recordId("ACT", this.clock),
    type,
    claim,
    priority = "medium",
    dueAt = null,
    expiresAt = null,
    recurrence = null,
    evidence,
    sourceObservationId = null,
  }) {
    const now = isoNow(this.clock);
    const r = validateActiveMemory({
      kind: "active_memory",
      schemaVersion: 1,
      id,
      type,
      claim,
      status: "active",
      priority,
      dueAt,
      expiresAt,
      recurrence,
      completedAt: null,
      assertionOrigin: sourceObservationId ? "user_confirmed" : "user_stated",
      evidence,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      statusHistory: [],
      sourceObservationId,
      supersededBy: null,
    });
    return withVaultLock(this.root, async () => {
      await this.assertEvidence(r.evidence);
      if (sourceObservationId) {
        const o = await this.getObservation(sourceObservationId);
        if (
          !usable(o) ||
          o.claim !== claim ||
          checksum(o.evidence) !== checksum(r.evidence)
        )
          throw new ConflictError(
            "Activation requires the exact supported reviewed claim and evidence.",
          );
      }
      const existing = await this.listRecords("records/active"),
        dup = existing.find((x) => keyOf(x) === keyOf(r));
      if (dup) return { created: false, record: dup };
      await this.persist("records/active", r, { create: true });
      return { created: true, record: r };
    });
  }
  async activateObservation(id, options = {}) {
    const o = await this.getObservation(id);
    if (!usable(o))
      throw new ConflictError("Candidate must be confirmed first.");
    exactKeys(
      options,
      ["type", "dueAt", "expiresAt", "recurrence", "priority"],
      "activation options",
    );
    const suggested = o.suggestedActive ?? {};
    return this.storeActiveMemory({
      ...suggested,
      ...options,
      id: "ACT-" + checksum(id).slice(0, 32),
      claim: o.claim,
      evidence: o.evidence,
      sourceObservationId: id,
    });
  }
  async updateActiveMemory(
    id,
    {
      status,
      note = "",
      expectedRevision,
      actor = "local-user",
      supersededBy = null,
      dueAt,
    },
  ) {
    requireOneOf(status, "status", [
      "active",
      "completed",
      "cancelled",
      "paused",
      "superseded",
      "expired",
    ]);
    return withVaultLock(this.root, async () => {
      const current = await this.getActive(id);
      if (current.revision !== integer(expectedRevision, "expectedRevision"))
        throw new ConflictError("Active memory revision changed.");
      const allowed = {
        active: ["completed", "cancelled", "paused", "superseded", "expired"],
        paused: ["active", "cancelled", "superseded", "expired"],
      };
      if (!allowed[current.status]?.includes(status))
        throw new ConflictError("Invalid active-memory transition.");
      if (status === "superseded") {
        if (!supersededBy || supersededBy === id)
          throw new ValidationError("Replacement required.");
        const target = await this.getActive(supersededBy);
        if (target.status !== "active")
          throw new ValidationError("Replacement must be active.");
      }
      const now = isoNow(this.clock);
      const r = {
        ...current,
        status,
        completedAt: status === "completed" ? now : null,
        supersededBy: status === "superseded" ? supersededBy : null,
        updatedAt: now,
        revision: current.revision + 1,
        statusHistory: [
          ...current.statusHistory,
          {
            fromStatus: current.status,
            toStatus: status,
            note,
            changedAt: now,
            actor,
          },
        ],
      };
      if (dueAt !== undefined) r.dueAt = dueAt;
      return this.persist("records/active", r);
    });
  }
  async nextOccurrence(id, { expectedRevision }) {
    const current = await this.getActive(id);
    if (current.revision !== integer(expectedRevision, "expectedRevision"))
      throw new ConflictError("Active memory revision changed.");
    if (current.status !== "completed" || !current.recurrence || !current.dueAt)
      throw new ConflictError(
        "Only a completed recurring item can create its next occurrence.",
      );
    const dueAt = new Date(
      Date.parse(current.dueAt) + current.recurrence * 86400000,
    ).toISOString();
    return this.storeActiveMemory({
      id: "ACT-" + checksum({ id, dueAt }).slice(0, 32),
      type: current.type,
      claim: current.claim,
      priority: current.priority,
      dueAt,
      expiresAt: current.expiresAt,
      recurrence: current.recurrence,
      evidence: current.evidence,
      sourceObservationId: current.sourceObservationId,
    });
  }
  async archiveConversation({ sessionId, messages, summary = null }) {
    const id = safeId(sessionId),
      now = isoNow(this.clock),
      sanitized = validateMessages(messages, { redact: true });
    const archive = validateArchive({
      kind: "conversation_archive",
      schemaVersion: 1,
      sessionId: id,
      createdAt: now,
      messages: sanitized,
      checksum: checksum(sanitized),
    });
    const compact =
      summary === null
        ? null
        : validateCompaction({
            kind: "conversation_compaction",
            schemaVersion: 1,
            sessionId: id,
            archiveRef: `archives/raw/${id}.json`,
            summary,
            createdAt: now,
          });
    return withVaultLock(this.root, async () => {
      const existing = await readJson(this.file("archives/raw", id));
      if (existing) {
        validateArchive(existing);
        if (existing.checksum !== archive.checksum)
          throw new ConflictError("Archive ID has different content.");
        return { created: false, archive: existing };
      }
      await this.persist("archives/raw", archive, { create: true });
      if (compact)
        await this.persist("archives/compactions", compact, { create: true });
      return { created: true, archive };
    });
  }
  async storeCompaction(sessionId, summary) {
    return withVaultLock(this.root, async () => {
      const raw = await readJson(this.file("archives/raw", sessionId));
      if (!raw) throw new ValidationError("Summary source is absent.");
      validateArchive(raw);
      const prior = await readJson(
        this.file("archives/compactions", sessionId),
      );
      if (prior) return validateCompaction(prior);
      return this.persist(
        "archives/compactions",
        {
          kind: "conversation_compaction",
          schemaVersion: 1,
          sessionId,
          archiveRef: `archives/raw/${sessionId}.json`,
          summary,
          createdAt: isoNow(this.clock),
        },
        { create: true },
      );
    });
  }
  async trustedRecords() {
    const [active, obs, bio] = await Promise.all(
      ["records/active", "records/observations", "records/autobiography"].map(
        (s) => this.listRecords(s),
      ),
    );
    const supported = new Map(obs.filter(usable).map((o) => [o.id, o]));
    const now = this.clock().getTime();
    const goodActive = active.filter(
      (r) =>
        r.status === "active" &&
        (!r.expiresAt || Date.parse(r.expiresAt) > now) &&
        (!r.sourceObservationId || supported.has(r.sourceObservationId)),
    );
    const goodBio = bio.filter(
      (r) =>
        r.supportingObservationIds.every((id) => supported.has(id)) &&
        r.supportingObservationIds.some(
          (id) => supported.get(id).claim === r.claim,
        ),
    );
    // An activated deadline's observation must not resurrect it after completion or expiration.
    const activated = new Set(
      active.map((r) => r.sourceObservationId).filter(Boolean),
    );
    return [
      ...goodActive,
      ...obs.filter(
        (o) => usable(o) && !activated.has(o.id) && !o.suggestedActive,
      ),
      ...goodBio,
    ];
  }
  async searchTrusted(query, { limit = 10, type } = {}) {
    const terms = tokenize(cleanText(query, "query", { max: 2000 }));
    integer(limit, "limit", 1, 50);
    if (type) requireOneOf(type, "type", ACTIVE_TYPES);
    if (!terms.length) return [];
    const out = [];
    for (const r of await this.trustedRecords()) {
      if (type && r.type !== type) continue;
      const score =
        terms.filter((t) => r.claim.toLowerCase().includes(t)).length /
        terms.length;
      if (!score) continue;
      const provenance = await this.provenance(r);
      out.push({
        id: r.id,
        kind: r.kind,
        type: r.type,
        claim: r.claim,
        status: r.status,
        dueAt: r.dueAt ?? null,
        overdue: Boolean(
          r.dueAt && Date.parse(r.dueAt) < this.clock().getTime(),
        ),
        score,
        provenance,
      });
    }
    return out
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
  async provenance(record) {
    let evidence = record.evidence;
    if (!evidence) {
      evidence = [];
      for (const id of record.supportingObservationIds)
        evidence.push(...(await this.getObservation(id)).evidence);
    }
    await this.assertEvidence(evidence);
    return evidence.map((e) => ({
      ...e,
      archiveRef: `archives/raw/${e.sourceId}.json`,
    }));
  }
  async state(section, id) {
    if (!STATE_SECTIONS.includes(section))
      throw new ValidationError("Invalid state section.");
    return readJson(this.file(section, id));
  }
  async writeState(section, id, value, { overwrite = true } = {}) {
    if (!STATE_SECTIONS.includes(section))
      throw new ValidationError("Invalid state section.");
    return withVaultLock(this.root, () =>
      this.writer(this.file(section, id), value, { overwrite }),
    );
  }
  async validate() {
    const errors = [];
    try {
      const manifest = await readJson(
        inside(this.root, "june-memory.manifest.json"),
      );
      if (manifest?.schemaVersion !== 1)
        throw new ValidationError("Missing or invalid vault manifest.");
    } catch (e) {
      errors.push({
        file: "june-memory.manifest.json",
        code: e.code ?? "IO_ERROR",
      });
    }
    let count = 0;
    for (const section of SECTIONS)
      for (const file of await listJsonFiles(inside(this.root, section))) {
        try {
          const r = validateAnyRecord(await readJson(file));
          if (file !== this.file(section, r.id ?? r.sessionId))
            throw new ValidationError("Record filename mismatch.");
          if (r.evidence) await this.assertEvidence(r.evidence);
          if (r.kind === "conversation_compaction") {
            const raw = await readJson(this.file("archives/raw", r.sessionId));
            if (!raw) throw new ValidationError("Missing summary source.");
            validateArchive(raw);
          }
          if (r.kind === "autobiography")
            for (const id of r.supportingObservationIds)
              await this.getObservation(id);
          count++;
        } catch (e) {
          errors.push({
            file: path.relative(this.root, file),
            code: e.code ?? "IO_ERROR",
          });
        }
      }
    for (const file of await listJsonFiles(inside(this.root, "audit")))
      try {
        const a = await readJson(file);
        if (!SECTIONS.includes(a.section) || checksum(a.record) !== a.checksum)
          throw new ValidationError("Invalid audit revision.");
        validateAnyRecord(a.record);
      } catch (e) {
        errors.push({
          file: path.relative(this.root, file),
          code: e.code ?? "IO_ERROR",
        });
      }
    return { ok: !errors.length, records: count, errors };
  }
}
