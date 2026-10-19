import * as chrono from "chrono-node";
import { createHash } from "node:crypto";
import { redactSensitiveText } from "../util.js";

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const clean = (s, max = 12000) =>
  redactSensitiveText(String(s ?? ""))
    .trim()
    .slice(0, max);
const taskWords =
  /\b(deadline|due|submit|submission|last date|assignment|report|register|registration|apply|application|exam|test|quiz|meeting|webinar|interview|presentation|lab|complete|finish)\b/i;
const dateLabel = (iso) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso)) + " IST";
export function detectDeadlines(row) {
  if (row.direction === "outgoing" || row.category === "promotional") return [];
  const body = (row.subject ? row.subject + "\n" : "") + row.body;
  if (!taskWords.test(body)) return [];
  const results = chrono.en.GB.parse(
    body,
    { instant: new Date(row.received_at), timezone: 330 },
    { forwardDate: true, timezones: { IST: 330 } },
  );
  const out = [];
  for (const r of results) {
    const previous = body.lastIndexOf("\n", r.index),
      end = body.indexOf("\n", r.index + r.text.length);
    const line = body.slice(previous + 1, end < 0 ? body.length : end).trim();
    const near = body.slice(
      Math.max(0, r.index - 180),
      Math.min(body.length, r.index + r.text.length + 120),
    );
    if (
      !taskWords.test(near) ||
      (!r.start.isCertain("day") &&
        !r.start.isCertain("weekday") &&
        !/today|tomorrow|tonight/i.test(r.text))
    )
      continue;
    const dateOnly = !r.start.isCertain("hour");
    const c = r.start;
    if (dateOnly) {
      c.assign("hour", 23);
      c.assign("minute", 59);
      c.assign("second", 0);
    }
    const due = c.date();
    if (!Number.isFinite(due.getTime())) continue;
    const title =
      clean(line.replace(/https:\/\/\S+/g, "").replace(/\s+/g, " "), 180) ||
      "Task mentioned in " + (row.chat_name || "message");
    out.push({
      title,
      due_at: due.toISOString(),
      date_quote: r.text,
      evidence: line || near,
      date_precision: dateOnly ? "date" : "time",
      timing_note: dateOnly
        ? "Only a date was stated. Reminders use 11:59 pm IST; edit the time if needed."
        : "Parsed relative to the original message, using IST unless a timezone was stated.",
    });
  }
  // Keep undated requests visible for the user instead of inventing a date.
  if (
    !out.length &&
    /\b(deadline|due|submit|submission|last date|assignment)\b/i.test(body)
  )
    out.push({
      title: clean(
        row.subject || body.split(/\n/).find((s) => taskWords.test(s)) || body,
        180,
      ),
      due_at: null,
      date_quote: "",
      evidence: clean(body, 1500),
      date_precision: "unknown",
      timing_note:
        "No reliable due date found. Set a date to enable reminders.",
    });
  return out;
}

export class TaskBoard {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, source_id TEXT REFERENCES inbox(id), title TEXT NOT NULL, due_at TEXT,
      date_quote TEXT NOT NULL, date_precision TEXT NOT NULL, timing_note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'detected', brief TEXT NOT NULL, evidence TEXT NOT NULL,
      reminder_enabled INTEGER NOT NULL DEFAULT 1, snoozed_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status,due_at);
      CREATE TABLE IF NOT EXISTS task_scanned (source_id TEXT PRIMARY KEY REFERENCES inbox(id));
      CREATE TABLE IF NOT EXISTS task_sources (task_id TEXT REFERENCES tasks(id),source_id TEXT REFERENCES inbox(id),PRIMARY KEY(task_id,source_id));
      CREATE TABLE IF NOT EXISTS task_notifications (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,due_at TEXT NOT NULL,created_at TEXT NOT NULL,delivered_at TEXT,dismissed_at TEXT);`);
  }
  scan(limit = 250) {
    const rows = this.db
      .prepare(
        "SELECT i.* FROM inbox i LEFT JOIN task_scanned s ON s.source_id=i.id WHERE i.source IN ('whatsapp','email') AND s.source_id IS NULL ORDER BY i.received_at DESC LIMIT ?",
      )
      .all(limit);
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        for (const d of detectDeadlines(row)) {
          const id =
            "TASK-" + hash(JSON.stringify([row.thread_id, d.title, d.due_at]));
          const now = new Date().toISOString();
          const attachments = JSON.parse(row.attachments_json || "[]");
          const resources = [
            ...new Set(row.body.match(/https:\/\/[^\s<>"\])}]+/g) ?? []),
          ];
          const brief = [
            "REQUEST\n" + d.title,
            "DEADLINE\n" +
              (d.due_at ? dateLabel(d.due_at) : "Needs a date") +
              "\n" +
              d.timing_note,
            "SOURCE\n" +
              (row.chat_name || row.subject || row.source) +
              " · " +
              (row.sender_name || row.sender) +
              " · " +
              dateLabel(row.received_at),
            "WHAT WAS SHARED\n" + row.body,
            resources.length
              ? "RESOURCES SHARED\n" + resources.join("\n")
              : "RESOURCES\nNo resource links were included in this message.",
            attachments.length
              ? "ATTACHMENTS\n" +
                attachments
                  .map((a) => a.name || a.kind + " attached")
                  .join("\n") +
                "\nAttachment contents have not been read. Open WhatsApp or your mailbox for the files."
              : "",
            "NEXT STEPS\nCheck that this request applies to you. Confirm the deadline, review the source/resources, and mark the task complete when finished. Detected tasks are not confirmed personal commitments.",
          ]
            .filter(Boolean)
            .join("\n\n");
          added += this.db
            .prepare(
              "INSERT OR IGNORE INTO tasks(id,source_id,title,due_at,date_quote,date_precision,timing_note,brief,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              id,
              row.id,
              d.title,
              d.due_at,
              d.date_quote,
              d.date_precision,
              d.timing_note,
              clean(brief, 24000),
              clean(d.evidence, 3000),
              now,
              now,
            ).changes;
          this.db
            .prepare("INSERT OR IGNORE INTO task_sources VALUES(?,?)")
            .run(id, row.id);
        }
        this.db
          .prepare("INSERT OR IGNORE INTO task_scanned VALUES(?)")
          .run(row.id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { scanned: rows.length, added };
  }
  list({ status = "open", q = "" } = {}) {
    const filter =
      status === "all" ? "1=1" : "t.status IN ('detected','confirmed')";
    return this.db
      .prepare(
        `SELECT t.*,i.chat_name,i.sender_name,i.source,i.thread_id FROM tasks t LEFT JOIN inbox i ON i.id=t.source_id WHERE ${filter} AND instr(lower(t.title),lower(?))>0 ORDER BY t.due_at IS NULL,t.due_at,t.created_at DESC`,
      )
      .all(clean(q, 200));
  }
  get(id) {
    const task = this.db
      .prepare(
        "SELECT t.*,i.chat_name,i.sender_name,i.source,i.thread_id FROM tasks t LEFT JOIN inbox i ON i.id=t.source_id WHERE t.id=?",
      )
      .get(id);
    if (!task) throw Error("TASK_NOT_FOUND");
    return task;
  }
  update(id, patch) {
    const t = this.get(id),
      now = new Date().toISOString();
    const status = patch.status ?? t.status;
    if (!["detected", "confirmed", "completed", "dismissed"].includes(status))
      throw Error("INVALID_TASK_STATUS");
    let due = t.due_at;
    if (Object.hasOwn(patch, "dueAt")) {
      if (
        typeof patch.dueAt !== "string" ||
        !Number.isFinite(Date.parse(patch.dueAt)) ||
        !/Z$|[+-]\d\d:\d\d$/.test(patch.dueAt)
      )
        throw Error("INVALID_DUE_DATE");
      due = new Date(patch.dueAt).toISOString();
    }
    let snoozed = t.snoozed_until;
    if (Object.hasOwn(patch, "snoozeMinutes")) {
      if (![0, 15, 60, 1440].includes(patch.snoozeMinutes))
        throw Error("INVALID_SNOOZE");
      snoozed = patch.snoozeMinutes
        ? new Date(Date.now() + patch.snoozeMinutes * 60000).toISOString()
        : null;
    }
    const title = patch.title === undefined ? t.title : clean(patch.title, 180);
    if (!title) throw Error("TITLE_REQUIRED");
    const reminder =
      patch.reminders === undefined
        ? t.reminder_enabled
        : patch.reminders === true
          ? 1
          : patch.reminders === false
            ? 0
            : null;
    if (reminder === null) throw Error("INVALID_REMINDER_SETTING");
    const edited = due !== t.due_at;
    const note = edited
      ? "Due date set by you: " + dateLabel(due)
      : t.timing_note;
    this.db
      .prepare(
        "UPDATE tasks SET title=?,status=?,due_at=?,timing_note=?,date_precision=?,reminder_enabled=?,snoozed_until=?,updated_at=? WHERE id=?",
      )
      .run(
        title,
        status,
        due,
        note,
        edited ? "time" : t.date_precision,
        reminder,
        snoozed,
        now,
        id,
      );
    if (edited)
      this.db
        .prepare("UPDATE tasks SET brief=? WHERE id=?")
        .run(
          "UPDATED DEADLINE\n" + dateLabel(due) + " (set by you)\n\n" + t.brief,
          id,
        );
    if (
      edited ||
      status === "completed" ||
      status === "dismissed" ||
      !reminder ||
      snoozed
    )
      this.db
        .prepare(
          "UPDATE task_notifications SET dismissed_at=? WHERE task_id=? AND dismissed_at IS NULL",
        )
        .run(now, id);
    return this.get(id);
  }
  add({ title, dueAt, notes = "" }) {
    if (
      !clean(title, 180) ||
      !Number.isFinite(Date.parse(dueAt)) ||
      !/Z$|[+-]\d\d:\d\d$/.test(dueAt)
    )
      throw Error("TASK_AND_DATE_REQUIRED");
    const now = new Date().toISOString(),
      id = "TASK-" + hash(now + Math.random() + title),
      due = new Date(dueAt).toISOString();
    this.db
      .prepare(
        "INSERT INTO tasks(id,title,due_at,date_quote,date_precision,timing_note,status,brief,evidence,created_at,updated_at) VALUES(?,?,?,'','time','Date set by you','confirmed',?,'',?,?)",
      )
      .run(
        id,
        clean(title, 180),
        due,
        clean(title, 180) +
          "\n\n" +
          clean(notes) +
          "\n\nDue: " +
          dateLabel(due),
        now,
        now,
      );
    return this.get(id);
  }
  reminders(nowMs = Date.now()) {
    const now = new Date(nowMs).toISOString();
    const tasks = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status IN ('detected','confirmed') AND reminder_enabled=1 AND due_at IS NOT NULL AND (snoozed_until IS NULL OR snoozed_until<=?)",
      )
      .all(now);
    for (const t of tasks) {
      const due = Date.parse(t.due_at),
        remain = due - nowMs;
      // Catch up with only the nearest reminder after sleep, not three stale alerts.
      if (remain > 86400000 || remain < -7 * 86400000) continue;
      const kind = t.snoozed_until
        ? "snooze-" + t.snoozed_until
        : remain <= 0
          ? "due"
          : remain <= 3600000
            ? "1h"
            : "24h";
      const id = "REM-" + hash(t.id + t.due_at + kind);
      const inserted = this.db
        .prepare(
          "INSERT OR IGNORE INTO task_notifications(id,task_id,kind,due_at,created_at) VALUES(?,?,?,?,?)",
        )
        .run(id, t.id, kind, t.due_at, now).changes;
      if (inserted)
        this.db
          .prepare(
            "UPDATE task_notifications SET dismissed_at=? WHERE task_id=? AND id<>? AND dismissed_at IS NULL",
          )
          .run(now, t.id, id);
      if (t.snoozed_until)
        this.db
          .prepare("UPDATE tasks SET snoozed_until=NULL WHERE id=?")
          .run(t.id);
    }
  }
  notifications() {
    return this.db
      .prepare(
        "SELECT n.*,t.title,t.status FROM task_notifications n JOIN tasks t ON t.id=n.task_id WHERE n.dismissed_at IS NULL AND t.status IN ('detected','confirmed') AND t.reminder_enabled=1 AND (t.snoozed_until IS NULL OR t.snoozed_until<=?) ORDER BY n.created_at DESC LIMIT 50",
      )
      .all(new Date().toISOString());
  }
  acknowledge(id, delivered = false) {
    const column = delivered ? "delivered_at" : "dismissed_at";
    this.db
      .prepare(
        "UPDATE task_notifications SET " +
          column +
          "=coalesce(" +
          column +
          ",?) WHERE id=?",
      )
      .run(new Date().toISOString(), id);
  }
}
