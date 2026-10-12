import { createHash } from "node:crypto";
import { redactSensitiveText } from "../util.js";
const clean = (value, max = 500) =>
  redactSensitiveText(
    String(value ?? "")
      .replace(/\0/g, "")
      .trim(),
  ).slice(0, max);
export const threadId = (source, account, chat) =>
  "CHAT-" +
  createHash("sha256")
    .update(JSON.stringify([source, account, chat]))
    .digest("hex")
    .slice(0, 32);
export const attachments = (value) =>
  (Array.isArray(value) ? value : []).slice(0, 30).map((a) => ({
    kind: ["image", "video", "audio", "document", "sticker", "file"].includes(
      a?.kind,
    )
      ? a.kind
      : "file",
    name: clean(a?.name, 250),
    mime: clean(a?.mime, 100),
    size: Number.isSafeInteger(a?.size) && a.size >= 0 ? a.size : null,
  }));
export function initializeViewer(store) {
  const cols = new Set(
    store.db
      .prepare("PRAGMA table_info(inbox)")
      .all()
      .map((c) => c.name),
  );
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, definition] of Object.entries({
      attachments_json: "TEXT NOT NULL DEFAULT '[]'",
      direction: "TEXT NOT NULL DEFAULT 'incoming'",
      thread_id: "TEXT NOT NULL DEFAULT ''",
      metadata_version: "INTEGER NOT NULL DEFAULT 0",
      ai_note: "TEXT",
      ai_classified_at: "TEXT",
    }))
      if (!cols.has(name))
        store.db.exec(
          "ALTER TABLE inbox ADD COLUMN " + name + " " + definition,
        );
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY,name TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS inbox_threads ON inbox(source,thread_id,received_at,id);",
    );
    const update = store.db.prepare("UPDATE inbox SET thread_id=? WHERE id=?");
    for (const row of store.db
      .prepare(
        "SELECT id,source,account,chat_id,sender FROM inbox WHERE thread_id=''",
      )
      .all())
      update.run(
        threadId(row.source, row.account, row.chat_id || row.sender),
        row.id,
      );
    store.db.exec(
      "INSERT OR IGNORE INTO contacts(id,name,updated_at) SELECT chat_id,coalesce(nullif(chat_name,''),sender_name),received_at FROM inbox WHERE source='whatsapp' AND direction='incoming' AND chat_id<>'' AND chat_id NOT LIKE '%@g.us' AND sender_name<>'' ORDER BY received_at DESC",
    );
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
const publicRow = (row) => {
  if (!row) return null;
  const { result_json, attachments_json, ...rest } = row;
  return {
    ...rest,
    attachments: attachments(JSON.parse(attachments_json || "[]")),
  };
};
const pageSize = (value) =>
  Math.max(1, Math.min(100, Math.trunc(Number(value) || 50)));
const like = (value) =>
  "%" + clean(value, 300).replace(/[\\%_]/g, "\\$&") + "%";
export const viewerMethods = {
  saveContact(id, name) {
    id = clean(id, 300);
    name = clean(name, 300);
    if (!id || !name) return;
    this.db
      .prepare(
        "INSERT INTO contacts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at",
      )
      .run(id, name, new Date().toISOString());
  },
  conversations({ q = "", offset = 0, limit = 60 } = {}) {
    limit = pageSize(limit);
    offset = Math.max(0, Math.trunc(Number(offset) || 0));
    const query = `WITH ranked AS (
   SELECT i.*,coalesce(nullif(c.name,''),nullif(i.chat_name,''),CASE WHEN i.chat_id LIKE '%@g.us' THEN 'WhatsApp group' ELSE coalesce(nullif(i.sender_name,''),i.sender,i.chat_id) END) AS display_name,
   row_number() OVER(PARTITION BY i.thread_id ORDER BY i.received_at DESC,i.id DESC) AS rn,
   count(*) OVER(PARTITION BY i.thread_id) AS message_count,
   max(i.priority) OVER(PARTITION BY i.thread_id) AS thread_priority
   FROM inbox i LEFT JOIN contacts c ON c.id=i.chat_id WHERE i.source='whatsapp')
   SELECT thread_id,chat_id,display_name,message_count,thread_priority,received_at,body AS preview,attachments_json
   FROM ranked WHERE rn=1 AND (display_name LIKE ? ESCAPE '\\' OR chat_id LIKE ? ESCAPE '\\')
   ORDER BY thread_priority DESC,received_at DESC,thread_id LIMIT ? OFFSET ?`;
    const rows = this.db
      .prepare(query)
      .all(like(q), like(q), limit + 1, offset);
    return {
      items: rows.slice(0, limit).map(({ attachments_json, ...r }) => ({
        ...r,
        attachments: attachments(JSON.parse(attachments_json)),
        preview: r.preview.slice(0, 140),
        isGroup: r.chat_id.endsWith("@g.us"),
      })),
      hasMore: rows.length > limit,
    };
  },
  thread(id, { before = "", limit = 50 } = {}) {
    if (!/^CHAT-[a-f0-9]{32}$/.test(id)) throw Error("INVALID_CHAT");
    limit = pageSize(limit);
    const where = ["source='whatsapp'", "thread_id=?"],
      args = [id];
    if (before) {
      const row = this.db
        .prepare("SELECT received_at,id FROM inbox WHERE id=? AND thread_id=?")
        .get(before, id);
      if (!row) throw Error("INVALID_CURSOR");
      where.push("(received_at,id)<(?,?)");
      args.push(row.received_at, row.id);
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM inbox WHERE " +
          where.join(" AND ") +
          " ORDER BY received_at DESC,id DESC LIMIT ?",
      )
      .all(...args, limit + 1);
    return {
      items: rows.slice(0, limit).reverse().map(publicRow),
      hasMore: rows.length > limit,
    };
  },
  emails({
    q = "",
    account = "",
    category = "focused",
    before = "",
    limit = 50,
  } = {}) {
    const where = ["source='email'"],
      args = [];
    if (category === "focused") where.push("category<>'promotional'");
    else if (category === "priority") where.push("priority=1");
    else if (category !== "all") {
      if (
        !["deadline", "opportunity", "promotional", "message"].includes(
          category,
        )
      )
        throw Error("INVALID_FILTER");
      where.push("category=?");
      args.push(category);
    }
    if (account) {
      where.push("account=?");
      args.push(clean(account, 300));
    }
    if (q) {
      where.push(
        "(subject LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')",
      );
      args.push(...Array(4).fill(like(q)));
    }
    if (before) {
      const row = this.db
        .prepare(
          "SELECT id,received_at FROM inbox WHERE id=? AND source='email'",
        )
        .get(before);
      if (!row) throw Error("INVALID_CURSOR");
      where.push("(received_at,id)<(?,?)");
      args.push(row.received_at, row.id);
    }
    limit = pageSize(limit);
    const rows = this.db
      .prepare(
        "SELECT * FROM inbox WHERE " +
          where.join(" AND ") +
          " ORDER BY received_at DESC,id DESC LIMIT ?",
      )
      .all(...args, limit + 1);
    return {
      items: rows.slice(0, limit).map(publicRow),
      hasMore: rows.length > limit,
    };
  },
  inboxItem(id) {
    return publicRow(
      this.db
        .prepare(
          "SELECT * FROM inbox WHERE id=? AND source IN ('email','whatsapp')",
        )
        .get(id),
    );
  },
  classifyItem(id, result) {
    if (
      !["deadline", "opportunity", "promotional", "message"].includes(
        result?.category,
      ) ||
      typeof result?.reason !== "string"
    )
      throw Error("INVALID_CLASSIFICATION");
    const row = this.inboxItem(id);
    if (!row) throw Error("MESSAGE_NOT_FOUND");
    // Explicit deterministic deadline/opportunity matches stay visible.
    const category = ["deadline", "opportunity"].includes(row.category)
      ? row.category
      : result.category;
    this.db
      .prepare(
        "UPDATE inbox SET category=?,ai_note=?,ai_classified_at=? WHERE id=?",
      )
      .run(category, clean(result.reason, 300), new Date().toISOString(), id);
    return category;
  },
};
