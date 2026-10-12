import { ValidationError } from "./errors.js";
import {
  cleanText,
  exactKeys,
  integer,
  requireOneOf,
  safeId,
  timestamp,
  checksum,
  redactSensitiveText,
} from "./util.js";

export const ACTIVE_TYPES = [
  "deadline",
  "commitment",
  "preference",
  "recurring_task",
  "reminder",
  "project",
  "priority",
  "other",
];
export const OBSERVATION_STATUSES = [
  "pending",
  "confirmed",
  "corrected",
  "rejected",
];
export const ACTIVE_STATUSES = [
  "active",
  "completed",
  "cancelled",
  "paused",
  "superseded",
  "expired",
];
function array(v, label, max = 100) {
  if (!Array.isArray(v) || v.length > max)
    throw new ValidationError(`${label} must be a bounded array.`);
  return v;
}
function nullableTime(v, label) {
  return v == null ? null : timestamp(v, label);
}
function base(v, kind, keys) {
  exactKeys(
    v,
    [
      "kind",
      "schemaVersion",
      "id",
      "claim",
      "createdAt",
      "updatedAt",
      "revision",
      ...keys,
    ],
    kind,
  );
  if (v.kind !== kind || v.schemaVersion !== 1)
    throw new ValidationError("Unsupported record schema.");
  const createdAt = timestamp(v.createdAt),
    updatedAt = timestamp(v.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new ValidationError("Update precedes creation.");
  return {
    ...v,
    id: safeId(v.id),
    claim: cleanText(v.claim, "claim"),
    createdAt,
    updatedAt,
    revision: integer(v.revision ?? 1, "revision"),
  };
}
export function validateEvidence(v) {
  exactKeys(v, ["sourceId", "sourceType", "quote", "capturedAt"], "evidence");
  return {
    sourceId: safeId(v.sourceId),
    sourceType: requireOneOf(v.sourceType, "sourceType", [
      "conversation",
      "daily_journal",
      "user_review",
    ]),
    quote: cleanText(v.quote, "evidence.quote", { max: 4000 }),
    capturedAt: timestamp(v.capturedAt),
  };
}
export function validateEvidenceList(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 25)
    throw new ValidationError("Evidence requires 1–25 references.");
  return v.map(validateEvidence);
}
export function validateMessages(messages, { redact = false } = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 100)
    throw new ValidationError("Transcript requires 1–100 messages.");
  let total = 0;
  return messages.map((m) => {
    exactKeys(m, ["role", "content", "timestamp"], "message");
    if (
      typeof m.content !== "string" ||
      !m.content.trim() ||
      m.content.length > 16000 ||
      (total += m.content.length) > 48000
    )
      throw new ValidationError("Transcript exceeds input bounds.");
    return {
      role: requireOneOf(m.role, "role", ["user", "assistant", "system"]),
      content: redact ? redactSensitiveText(m.content) : m.content,
      timestamp: timestamp(m.timestamp),
    };
  });
}
function review(v) {
  exactKeys(
    v,
    ["verdict", "note", "reviewedAt", "actor", "originalClaim"],
    "review",
  );
  return {
    verdict: requireOneOf(v.verdict, "verdict", [
      "confirmed",
      "corrected",
      "rejected",
      "superseded",
    ]),
    note: v.note === "" ? "" : cleanText(v.note, "review note"),
    reviewedAt: timestamp(v.reviewedAt),
    actor: cleanText(v.actor ?? "local-user", "actor", { max: 100 }),
    ...(v.originalClaim
      ? { originalClaim: cleanText(v.originalClaim, "original claim") }
      : {}),
  };
}
function suggestion(v) {
  if (v == null) return null;
  exactKeys(
    v,
    ["type", "dueAt", "expiresAt", "recurrence"],
    "suggested active memory",
  );
  return {
    type: requireOneOf(v.type, "type", ACTIVE_TYPES),
    dueAt: nullableTime(v.dueAt, "dueAt"),
    expiresAt: nullableTime(v.expiresAt, "expiresAt"),
    recurrence:
      v.recurrence == null
        ? null
        : integer(v.recurrence, "recurrence days", 1, 365),
  };
}
export function validateObservation(v) {
  const b = base(v, "observation", [
    "confidence",
    "status",
    "evidence",
    "reviewHistory",
    "correction",
    "suggestedActive",
    "contradictions",
    "supersededBy",
  ]);
  const status = requireOneOf(v.status, "status", OBSERVATION_STATUSES),
    reviews = array(v.reviewHistory, "reviews").map(review);
  if (status === "pending" && reviews.length)
    throw new ValidationError("Pending records cannot have a verdict.");
  if (
    status !== "pending" &&
    (!reviews.length || reviews[0].verdict !== status)
  )
    throw new ValidationError(
      "Reviewed records need matching explicit review history.",
    );
  const correction =
    v.correction == null ? null : cleanText(v.correction, "correction");
  if ((status === "corrected") !== (correction !== null))
    throw new ValidationError("Correction and verdict disagree.");
  return {
    ...b,
    confidence: requireOneOf(v.confidence, "confidence", [
      "low",
      "medium",
      "high",
    ]),
    status,
    evidence: validateEvidenceList(v.evidence),
    reviewHistory: reviews,
    correction,
    suggestedActive: suggestion(v.suggestedActive),
    contradictions: array(v.contradictions ?? [], "contradictions", 25).map(
      (c) => {
        exactKeys(c, ["evidence", "note", "createdAt"], "contradiction");
        return {
          evidence: validateEvidenceList(c.evidence),
          note: cleanText(c.note, "contradiction note"),
          createdAt: timestamp(c.createdAt),
        };
      },
    ),
    supersededBy: v.supersededBy == null ? null : safeId(v.supersededBy),
  };
}
export function validateActiveMemory(v) {
  const b = base(v, "active_memory", [
    "type",
    "status",
    "priority",
    "dueAt",
    "expiresAt",
    "completedAt",
    "assertionOrigin",
    "evidence",
    "statusHistory",
    "recurrence",
    "sourceObservationId",
    "supersededBy",
  ]);
  if (
    v.assertionOrigin !== "user_stated" &&
    v.assertionOrigin !== "user_confirmed"
  )
    throw new ValidationError(
      "Active memory requires explicit user authority.",
    );
  const status = requireOneOf(v.status, "status", ACTIVE_STATUSES),
    completedAt = nullableTime(v.completedAt, "completedAt");
  if ((status === "completed") !== (completedAt !== null))
    throw new ValidationError("Completion time and status disagree.");
  const history = array(v.statusHistory ?? [], "status history").map((h) => {
    exactKeys(
      h,
      ["fromStatus", "toStatus", "note", "changedAt", "actor"],
      "status history",
    );
    return {
      fromStatus: requireOneOf(h.fromStatus, "from", ACTIVE_STATUSES),
      toStatus: requireOneOf(h.toStatus, "to", ACTIVE_STATUSES),
      note: h.note === "" ? "" : cleanText(h.note, "note"),
      changedAt: timestamp(h.changedAt),
      actor: cleanText(h.actor, "actor", { max: 100 }),
    };
  });
  return {
    ...b,
    type: requireOneOf(v.type, "type", ACTIVE_TYPES),
    status,
    priority: requireOneOf(v.priority, "priority", ["low", "medium", "high"]),
    dueAt: nullableTime(v.dueAt, "dueAt"),
    expiresAt: nullableTime(v.expiresAt, "expiresAt"),
    completedAt,
    recurrence:
      v.recurrence == null
        ? null
        : integer(v.recurrence, "recurrence days", 1, 365),
    evidence: validateEvidenceList(v.evidence),
    statusHistory: history,
    sourceObservationId:
      v.sourceObservationId == null ? null : safeId(v.sourceObservationId),
    supersededBy: v.supersededBy == null ? null : safeId(v.supersededBy),
  };
}
export function validateAutobiography(v) {
  const b = base(v, "autobiography", ["supportingObservationIds", "status"]);
  if (
    !Array.isArray(v.supportingObservationIds) ||
    v.supportingObservationIds.length < 1 ||
    v.supportingObservationIds.length > 25
  )
    throw new ValidationError("Profile needs supporting observations.");
  return {
    ...b,
    supportingObservationIds: v.supportingObservationIds.map((x) => safeId(x)),
    status: requireOneOf(v.status, "status", ["confirmed"]),
  };
}
export function validateArchive(v) {
  exactKeys(
    v,
    ["kind", "schemaVersion", "sessionId", "createdAt", "checksum", "messages"],
    "archive",
  );
  if (v.kind !== "conversation_archive" || v.schemaVersion !== 1)
    throw new ValidationError("Unsupported archive.");
  const messages = validateMessages(v.messages);
  if (v.checksum !== checksum(messages))
    throw new ValidationError("Archive checksum mismatch.");
  for (const m of messages)
    if (redactSensitiveText(m.content) !== m.content)
      throw new ValidationError("Archive contains unredacted secrets.");
  return {
    ...v,
    sessionId: safeId(v.sessionId),
    createdAt: timestamp(v.createdAt),
    messages,
  };
}
export function validateCompaction(v) {
  exactKeys(
    v,
    [
      "kind",
      "schemaVersion",
      "sessionId",
      "archiveRef",
      "summary",
      "createdAt",
    ],
    "compaction",
  );
  if (v.kind !== "conversation_compaction" || v.schemaVersion !== 1)
    throw new ValidationError("Unsupported compaction.");
  const id = safeId(v.sessionId);
  if (v.archiveRef !== `archives/raw/${id}.json`)
    throw new ValidationError("Invalid archive reference.");
  return {
    ...v,
    sessionId: id,
    summary: cleanText(v.summary, "summary"),
    createdAt: timestamp(v.createdAt),
  };
}
export function validateAnyRecord(v) {
  const validators = {
    observation: validateObservation,
    active_memory: validateActiveMemory,
    autobiography: validateAutobiography,
    conversation_archive: validateArchive,
    conversation_compaction: validateCompaction,
  };
  if (!Object.hasOwn(validators, v?.kind))
    throw new ValidationError("Unsupported record kind.");
  return validators[v.kind](v);
}
export function validateCandidate(v) {
  exactKeys(
    v,
    [
      "kind",
      "claim",
      "confidence",
      "evidence",
      "dueAt",
      "expiresAt",
      "recurrence",
    ],
    "candidate",
  );
  return {
    kind: requireOneOf(v.kind, "kind", ["observation", ...ACTIVE_TYPES]),
    claim: cleanText(v.claim, "candidate claim"),
    confidence: requireOneOf(v.confidence, "confidence", [
      "low",
      "medium",
      "high",
    ]),
    evidence: validateEvidenceList(v.evidence),
    dueAt: nullableTime(v.dueAt, "dueAt"),
    expiresAt: nullableTime(v.expiresAt, "expiresAt"),
    recurrence:
      v.recurrence == null
        ? null
        : integer(v.recurrence, "recurrence days", 1, 365),
  };
}
export function extractionEnvelope(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 100000)
    throw new ValidationError("Worker output is too large.");
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ValidationError("Memory worker did not return valid JSON.");
  }
  exactKeys(v, ["candidates"], "worker response");
  return array(v.candidates, "candidates", 25);
}
export const parseExtractionOutput = (text) =>
  extractionEnvelope(text).map(validateCandidate);
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "claim", "confidence", "evidence", "dueAt"],
        properties: {
          kind: { type: "string", enum: ["observation", ...ACTIVE_TYPES] },
          claim: { type: "string", maxLength: 4000 },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          dueAt: { type: ["string", "null"] },
          expiresAt: { type: ["string", "null"] },
          recurrence: { type: ["integer", "null"] },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 25,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["sourceId", "sourceType", "quote", "capturedAt"],
              properties: {
                sourceId: { type: "string" },
                sourceType: { type: "string", enum: ["conversation"] },
                quote: { type: "string", maxLength: 4000 },
                capturedAt: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};
