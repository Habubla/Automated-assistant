import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { redactSensitiveText } from "../util.js";
import { initializeSummaries } from "./summary-jobs.js";
import {
  initializeViewer,
  attachments,
  threadId,
  viewerMethods,
} from "./viewer-store.js";
export const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
export const text = (value, max = 16000) =>
  redactSensitiveText(
    String(value ?? "")
      .replace(/\0/g, "")
      .trim(),
  ).slice(0, max);
export class HubStore {
  constructor(root) {
    fs.mkdirSync(root, { recursive: true });
    this.root = root;
    this.db = new DatabaseSync(path.join(root, "hub.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,source TEXT NOT NULL,account TEXT NOT NULL,external_id TEXT NOT NULL,received_at TEXT NOT NULL,sender TEXT NOT NULL,sender_name TEXT NOT NULL,chat_id TEXT NOT NULL,chat_name TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,url TEXT NOT NULL,category TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,result_json TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research(id TEXT PRIMARY KEY,title TEXT NOT NULL,brief TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_queue ON inbox(status,next_attempt);
    `);
    initializeViewer(this);
    initializeSummaries(this);
    this.db.exec(
      "UPDATE inbox SET status='retry' WHERE status='running'; UPDATE research SET status='needs-review',error='Interrupted research; review before retry' WHERE status='running'",
    );
  }
  get(key, fallback = null) {
    const r = this.db.prepare("SELECT value FROM state WHERE key=?").get(key);
    return r ? JSON.parse(r.value) : fallback;
  }
  set(key, value) {
    this.db
      .prepare(
        "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  ingest(input, rules = { priority: [], ignore: [] }) {
    if (
      !input ||
      !["email", "whatsapp", "conversation", "manual"].includes(input.source)
    )
      throw Error("Invalid source");
    if (
      !input.externalId ||
      !input.account ||
      !Number.isFinite(Date.parse(input.receivedAt))
    )
      throw Error("Source identity and timestamp required");
    const fields = {
      sender: text(input.sender, 300),
      senderName: text(input.senderName, 300),
      chatId: text(input.chatId, 300),
      chatName: text(input.chatName, 300),
    };
    const values = Object.values(fields).map((v) => v.toLocaleLowerCase());
    const matches = (entries) =>
      entries.some((x) =>
        values.some((v) => v && v.includes(x.toLocaleLowerCase())),
      );
    if (input.source === "whatsapp" && matches(rules.ignore ?? []))
      return { ignored: true };
    const media = attachments(input.attachments);
    const body = text(input.text) || (media.length ? "Media attached" : "");
    if (!body) return { skipped: "empty" };
    const subject = text(input.subject, 500);
    const category =
      input.source === "email" && input.promotional
        ? "promotional"
        : /deadline|due date|submit by|last date|assignment/i.test(
              subject + " " + body,
            )
          ? "deadline"
          : /internship|competition|scholarship|hackathon|opportunit|free course|research assistant/i.test(
                subject + " " + body,
              )
            ? "opportunity"
            : "message";
    const id =
      "IN-" +
      digest([input.source, input.account, input.externalId].join("\n")).slice(
        0,
        40,
      );
    const old = this.db.prepare("SELECT id FROM inbox WHERE id=?").get(id);
    if (old) {
      if (input.metadataComplete)
        this.db
          .prepare(
            "UPDATE inbox SET attachments_json=?,metadata_version=1 WHERE id=? AND metadata_version=0",
          )
          .run(JSON.stringify(media), id);
      return { id, replayed: true };
    }
    if (
      input.source === "whatsapp" &&
      fields.chatId &&
      !fields.chatId.endsWith("@g.us") &&
      input.direction !== "outgoing" &&
      fields.senderName
    )
      this.db
        .prepare(
          "INSERT INTO contacts VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(
          fields.chatId,
          fields.chatName || fields.senderName,
          new Date().toISOString(),
        );
    const priority = matches(rules.priority ?? []) ? 1 : 0;
    let url = "";
    try {
      const u = new URL(input.url);
      if (u.protocol === "https:" && !u.username && !u.password) url = u.href;
    } catch {}
    this.db
      .prepare(
        "INSERT INTO inbox(id,source,account,external_id,received_at,sender,sender_name,chat_id,chat_name,subject,body,url,category,priority,status,created_at,attachments_json,direction,thread_id,metadata_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.source,
        text(input.account, 300),
        text(input.externalId, 500),
        new Date(input.receivedAt).toISOString(),
        fields.sender,
        fields.senderName,
        fields.chatId,
        fields.chatName,
        subject,
        body,
        url,
        category,
        priority,
        input.direction === "outgoing"
          ? "display-only"
          : category === "promotional"
            ? "filtered"
            : "queued",
        new Date().toISOString(),
        JSON.stringify(media),
        input.direction === "outgoing" ? "outgoing" : "incoming",
        threadId(input.source, input.account, fields.chatId || fields.sender),
        input.metadataComplete ? 1 : 0,
      );
    return {
      id,
      category,
      queued: category !== "promotional" && input.direction !== "outgoing",
    };
  }
  list(limit = 100) {
    return this.db
      .prepare(
        "SELECT * FROM inbox ORDER BY priority DESC,received_at DESC LIMIT ?",
      )
      .all(Math.min(200, limit));
  }
  next() {
    return this.db
      .prepare(
        "SELECT * FROM inbox WHERE status IN ('queued','retry') AND next_attempt<=? ORDER BY priority DESC,received_at LIMIT 1",
      )
      .get(Date.now());
  }
  markRunning(id) {
    return (
      this.db
        .prepare(
          "UPDATE inbox SET status='running',attempts=attempts+1 WHERE id=? AND status IN ('queued','retry')",
        )
        .run(id).changes === 1
    );
  }
  finish(id, result) {
    this.db
      .prepare(
        "UPDATE inbox SET status='processed',result_json=?,error=NULL WHERE id=?",
      )
      .run(JSON.stringify(result), id);
  }
  fail(id, code) {
    const r = this.db.prepare("SELECT attempts FROM inbox WHERE id=?").get(id);
    this.db
      .prepare("UPDATE inbox SET status=?,error=?,next_attempt=? WHERE id=?")
      .run(
        r.attempts >= 5 ? "needs-attention" : "retry",
        text(code, 150),
        Date.now() + Math.min(3600000, 60000 * 2 ** r.attempts),
        id,
      );
  }
  research(title, brief, id = null) {
    id ??= "R-" + digest(title + "\n" + brief).slice(0, 30);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO research(id,title,brief,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        text(title, 500),
        text(brief, 6000),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    return id;
  }
  researches() {
    return this.db
      .prepare("SELECT * FROM research ORDER BY created_at DESC LIMIT 50")
      .all();
  }
  close() {
    this.db.close();
  }
}

Object.assign(HubStore.prototype, viewerMethods);
