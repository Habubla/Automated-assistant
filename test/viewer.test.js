import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { HubStore } from "../src/hub/store.js";
import { whatsappContent } from "../src/hub/whatsapp-content.js";
import { LocalInboxModel } from "../src/hub/local-inbox-model.js";
import { structureAttachments, collectMail } from "../src/hub/email.js";
import { redactSensitiveText } from "../src/util.js";
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "june-viewer-")),
    store = new HubStore(root);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, root };
};
const input = {
  source: "whatsapp",
  account: "personal",
  externalId: "one",
  receivedAt: "2026-10-12T10:00:00+05:30",
  sender: "111@s.whatsapp.net",
  senderName: "Ananya",
  chatId: "111@s.whatsapp.net",
  text: "Hello",
  metadataComplete: true,
};
test("media-only WhatsApp wrappers are retained, named and isolated by conversation", (t) => {
  const { store } = fixture(t);
  const content = whatsappContent({
    ephemeralMessage: {
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: 1024,
          url: "https://secret-media.invalid",
        },
      },
    },
  });
  assert.equal(content.text, "");
  assert.equal(content.attachments[0].kind, "image");
  assert.equal("url" in content.attachments[0], false);
  store.ingest({ ...input, ...content });
  store.ingest({
    ...input,
    externalId: "reply",
    direction: "outgoing",
    sender: "self",
    senderName: "You",
    text: "Thanks",
    receivedAt: "2026-10-12T10:01:00+05:30",
  });
  store.ingest({
    ...input,
    externalId: "other",
    sender: "222@s.whatsapp.net",
    senderName: "Dev",
    chatId: "222@s.whatsapp.net",
  });
  const chats = store.conversations().items;
  assert.equal(chats.length, 2);
  const chat = chats.find((c) => c.chat_id === input.chatId);
  assert.equal(chat.display_name, "Ananya");
  assert.equal(chat.message_count, 2);
  const rows = store.thread(chat.thread_id).items;
  assert.equal(rows[0].body, "Media attached");
  assert.equal(rows[0].attachments[0].kind, "image");
  assert.equal(rows[1].direction, "outgoing");
  assert.equal(rows[1].status, "display-only");
  assert.throws(
    () =>
      store.thread(chats.find((c) => c.chat_id !== input.chatId).thread_id, {
        before: rows[0].id,
      }),
    /INVALID_CURSOR/,
  );
});
test("conversation history paginates beyond the old 100-message inbox cap without duplicates", (t) => {
  const { store } = fixture(t);
  for (let i = 0; i < 135; i++)
    store.ingest({
      ...input,
      externalId: "m" + i,
      receivedAt: new Date(1791777600000 + i * 1000).toISOString(),
      text: "Message " + i,
    });
  const chat = store.conversations().items[0];
  let before = "",
    ids = [],
    page;
  do {
    page = store.thread(chat.thread_id, { before });
    ids.push(...page.items.map((m) => m.id));
    before = page.items[0].id;
  } while (page.hasMore);
  assert.equal(ids.length, 135);
  assert.equal(new Set(ids).size, 135);
  assert.equal(store.conversations({ q: "%" }).items.length, 0);
});
test("focused mail, account and category filters retain promotions under All", (t) => {
  const { store } = fixture(t);
  const mail = {
    ...input,
    source: "email",
    chatId: "",
    account: "first@example.test",
    subject: "A normal message",
  };
  store.ingest(mail);
  store.ingest({
    ...mail,
    externalId: "ad",
    promotional: true,
    subject: "Sale",
  });
  store.ingest({
    ...mail,
    externalId: "due",
    account: "second@example.test",
    subject: "Assignment deadline",
  });
  assert.equal(store.emails().items.length, 2);
  assert.equal(store.emails({ category: "all" }).items.length, 3);
  assert.equal(store.emails({ category: "promotional" }).items.length, 1);
  assert.equal(
    store.emails({ account: "second@example.test" }).items.length,
    1,
  );
  const deadline = store.emails({ category: "deadline" }).items[0];
  assert.equal(
    store.classifyItem(deadline.id, {
      category: "promotional",
      reason: "Wrong model guess",
    }),
    "deadline",
  );
  const normal = store.emails({ q: "normal" }).items[0];
  store.classifyItem(normal.id, {
    category: "promotional",
    reason: "Bulk marketing",
  });
  assert.equal(store.emails().items.length, 1);
  assert.throws(
    () => store.emails({ category: "';DROP TABLE inbox;" }),
    /INVALID_FILTER/,
  );
});
test("attachment enrichment updates metadata without changing stored message evidence", (t) => {
  const { store } = fixture(t);
  const first = store.ingest({ ...input, metadataComplete: false });
  store.ingest({
    ...input,
    text: "Changed remote body",
    attachments: [{ kind: "document", name: "notes.pdf" }],
    metadataComplete: true,
  });
  const row = store.inboxItem(first.id);
  assert.equal(row.body, "Hello");
  assert.equal(row.attachments[0].name, "notes.pdf");
});
test("large mail uses envelope and attachment metadata without downloading its body", async (t) => {
  const { store } = fixture(t);
  let bodyRequested = false,
    readOnly = false;
  const client = {
    on() {},
    connect: async () => {},
    mailbox: { uidValidity: 1 },
    getMailboxLock: async (_, o) => {
      readOnly = o.readOnly;
      return { release() {} };
    },
    search: async () => [1],
    fetchOne: async (_, q) => {
      if (q.source) bodyRequested = true;
      return {
        size: 9000000,
        envelope: {
          from: [{ address: "teacher@example.test" }],
          subject: "Lab documents",
        },
        internalDate: new Date(),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            {
              type: "application/pdf",
              size: 8990000,
              disposition: "attachment",
              dispositionParameters: { filename: "lab.pdf" },
            },
          ],
        },
      };
    },
    logout: async () => {},
  };
  await collectMail({
    account: {
      enabled: true,
      id: "one",
      email: "student@example.test",
      host: "imap.example.test",
      appPassword: "synthetic",
    },
    store,
    rules: {},
    clientFactory: () => client,
  });
  assert.equal(readOnly, true);
  assert.equal(bodyRequested, false);
  assert.equal(store.emails().items[0].attachments[0].name, "lab.pdf");
  assert.equal(structureAttachments({ type: "text/plain" }).length, 0);
});
test("local summaries use only loopback Qwen, omit media URLs and reject malformed outputs", async () => {
  let payload;
  const model = new LocalInboxModel({
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:11434/api/chat");
      payload = JSON.parse(options.body);
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            done: true,
            message: {
              content: JSON.stringify({
                summary: "Ananya shared an image; contents unavailable.",
              }),
            },
          }),
      };
    },
  });
  const result = await model.summarize([
    {
      ...input,
      body: "Media attached",
      sender_name: "Ananya",
      received_at: input.receivedAt,
      attachments: [{ kind: "image", name: "photo.jpg", url: "secret-media" }],
    },
  ]);
  assert.equal(result.model, "qwen3.5:4b");
  assert.equal(payload.model, "qwen3.5:4b");
  assert.doesNotMatch(JSON.stringify(payload), /secret-media/);
  const broken = new LocalInboxModel({
    fetchImpl: async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          message: { content: '{"category":"execute-command","reason":"bad"}' },
        }),
    }),
  });
  await assert.rejects(
    () => broken.classify({ subject: "test", body: "hello" }),
    /INVALID_RESPONSE/,
  );
});
test("new Google authorization-key format is redacted from stored content", () => {
  const key = "AQ." + "x".repeat(50);
  assert.equal(redactSensitiveText("Key: " + key), "Key: [REDACTED_SECRET]");
});
test("additive migration preserves pre-viewer message bodies and builds conversation ids", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "june-old-viewer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(root, "hub.sqlite"));
  db.exec(
    "CREATE TABLE inbox(id TEXT PRIMARY KEY,source TEXT,account TEXT,external_id TEXT,received_at TEXT,sender TEXT,sender_name TEXT,chat_id TEXT,chat_name TEXT,subject TEXT,body TEXT,url TEXT,category TEXT,priority INTEGER,status TEXT,attempts INTEGER,next_attempt INTEGER,error TEXT,result_json TEXT,created_at TEXT)",
  );
  db.prepare(
    "INSERT INTO inbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "legacy",
    "whatsapp",
    "personal",
    "legacy",
    "2026-10-12T10:00:00+05:30",
    "111",
    "Saved Name",
    "111@s.whatsapp.net",
    "",
    "",
    "Preserve me",
    "",
    "message",
    0,
    "processed",
    1,
    0,
    null,
    null,
    "2026-10-12",
  );
  db.close();
  const store = new HubStore(root);
  try {
    assert.equal(store.inboxItem("legacy").body, "Preserve me");
    assert.equal(store.conversations().items[0].display_name, "Saved Name");
    assert.match(store.inboxItem("legacy").thread_id, /^CHAT-/);
  } finally {
    store.close();
  }
});
