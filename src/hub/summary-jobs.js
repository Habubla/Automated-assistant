import { createHash } from "node:crypto";

export function summaryChunks(rows, maxChars = 8500) {
  const chunks = [];
  let chunk = [],
    size = 0;
  for (const row of rows) {
    const body = row.body || "Media attached";
    for (let start = 0; start < body.length; start += 3000) {
      const part = {
        ...row,
        subject: row.chat_name || row.subject,
        body: body.slice(start, start + 3000),
      };
      const cost = JSON.stringify({
        sender: part.sender_name || part.sender,
        at: part.received_at,
        subject: part.subject,
        text: part.body,
        attachments: part.attachments,
      }).length;
      if (chunk.length && size + cost > maxChars) {
        chunks.push(chunk);
        chunk = [];
        size = 0;
      }
      chunk.push(part);
      size += cost;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export function initializeSummaries(store) {
  const columns = store.db.prepare("PRAGMA table_info(inbox)").all();
  if (!columns.some((c) => c.name === "june_read_at"))
    store.db.exec("ALTER TABLE inbox ADD COLUMN june_read_at TEXT");
  store.db.exec(`CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, message_ids TEXT NOT NULL, status TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]', total_parts INTEGER NOT NULL, error TEXT, next_attempt INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS inbox_unread ON inbox(source,direction,june_read_at,received_at);
    UPDATE summaries SET status='queued' WHERE status='running';`);
  // Fresh installs begin today in IST. Existing state survives every restart.
  if (!store.get("unreadSince")) {
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    store.set("unreadSince", new Date(today + "T00:00:00+05:30").toISOString());
  }
}

export class SummaryJobs {
  constructor(store, model) {
    this.store = store;
    this.model = model;
    this.running = false;
  }
  rows({ threadId, id, allUnread } = {}) {
    if (id) return [this.store.inboxItem(id)].filter(Boolean);
    if (!allUnread && !/^CHAT-[a-f0-9]{32}$/.test(threadId ?? ""))
      throw Error("INVALID_CHAT");
    const where =
      "source='whatsapp' AND direction='incoming' AND june_read_at IS NULL AND received_at>=?";
    return this.store.db
      .prepare(
        "SELECT id FROM inbox WHERE " +
          where +
          (allUnread ? "" : " AND thread_id=?") +
          " ORDER BY received_at,id",
      )
      .all(this.store.get("unreadSince"), ...(allUnread ? [] : [threadId]))
      .map((r) => this.store.inboxItem(r.id));
  }
  start(selection) {
    const rows = this.rows(selection);
    if (!rows.length) throw Error("NO_UNREAD_MESSAGES");
    const ids = rows.map((r) => r.id),
      scope = selection.id || selection.threadId || "all-unread";
    const id =
      "SUM-" +
      createHash("sha256")
        .update(JSON.stringify([scope, ids]))
        .digest("hex")
        .slice(0, 32);
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO summaries(id,scope,message_ids,status,total_parts,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)",
      )
      .run(
        id,
        scope,
        JSON.stringify(ids),
        summaryChunks(rows).length,
        now,
        now,
      );
    this.store.db
      .prepare(
        "UPDATE summaries SET status='queued',error=NULL,next_attempt=0 WHERE id=? AND status='failed'",
      )
      .run(id);
    return this.get(id);
  }
  get(id) {
    const r = this.store.db
      .prepare("SELECT * FROM summaries WHERE id=?")
      .get(id);
    if (!r) throw Error("SUMMARY_NOT_FOUND");
    const parts = JSON.parse(r.parts),
      ids = JSON.parse(r.message_ids);
    return {
      id: r.id,
      status: r.status,
      messages: ids.length,
      completedParts: parts.length,
      totalParts: r.total_parts,
      summary: parts
        .map((s, i) => (parts.length > 1 ? "Part " + (i + 1) + "\n" + s : s))
        .join("\n\n"),
      error: r.error,
      model: "qwen3.5:4b",
      updatedAt: r.updated_at,
    };
  }
  acknowledge(id) {
    const r = this.store.db
      .prepare("SELECT * FROM summaries WHERE id=? AND status='complete'")
      .get(id);
    if (!r) throw Error("SUMMARY_NOT_COMPLETE");
    const update = this.store.db.prepare(
      "UPDATE inbox SET june_read_at=? WHERE id=? AND source='whatsapp'",
    );
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const messageId of JSON.parse(r.message_ids))
        update.run(new Date().toISOString(), messageId);
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true };
  }
  async tick() {
    if (this.running || this.model.busy) return;
    const row = this.store.db
      .prepare(
        "SELECT * FROM summaries WHERE status='queued' AND next_attempt<=? ORDER BY created_at LIMIT 1",
      )
      .get(Date.now());
    if (!row) return;
    this.running = true;
    try {
      this.store.db
        .prepare("UPDATE summaries SET status='running' WHERE id=?")
        .run(row.id);
      const rows = JSON.parse(row.message_ids).map((id) =>
        this.store.inboxItem(id),
      );
      if (rows.some((r) => !r)) throw Error("SOURCE_MESSAGE_MISSING");
      const chunks = summaryChunks(rows),
        parts = JSON.parse(row.parts);
      const result = await this.model.summarize(chunks[parts.length]);
      parts.push(result.summary);
      this.store.db
        .prepare(
          "UPDATE summaries SET parts=?,status=?,error=NULL,updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify(parts),
          parts.length === chunks.length ? "complete" : "queued",
          new Date().toISOString(),
          row.id,
        );
    } catch (e) {
      this.store.db
        .prepare(
          "UPDATE summaries SET status=?,error=?,next_attempt=?,updated_at=? WHERE id=?",
        )
        .run(
          e.message === "LOCAL_MODEL_BUSY" ? "queued" : "failed",
          /^[A-Z_]+$/.test(e.message) ? e.message : "SUMMARY_FAILED",
          Date.now() + 10000,
          new Date().toISOString(),
          row.id,
        );
    } finally {
      this.running = false;
    }
  }
}
