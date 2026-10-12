import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubStore } from "../src/hub/store.js";
import { localCommand } from "../src/hub/settings.js";
import { HubJobs } from "../src/hub/jobs.js";
import { collectMail } from "../src/hub/email.js";
import { managedWorkflows } from "../automation/n8n/generate-managed.js";
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "june-hub-"));
  const store = new HubStore(root);
  return {
    root,
    store,
    close() {
      this.store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
};
const input = {
  source: "whatsapp",
  account: "test",
  externalId: "msg-1",
  receivedAt: "2026-10-12T10:00:00+05:30",
  sender: "123",
  senderName: "Professor",
  chatId: "group@g.us",
  chatName: "Circuits",
  text: "Submit the circuit report by 2026-10-20T17:00:00+05:30.",
};
test("ignore filters run before content persistence; priority and idempotency work", () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.store.ingest(
        { ...input, chatName: "Coding Club India" },
        { ignore: ["coding club india"] },
      ),
      { ignored: true },
    );
    assert.equal(f.store.list().length, 0);
    const a = f.store.ingest(input, { priority: ["Professor"] });
    assert.equal(f.store.list()[0].priority, 1);
    assert.equal(f.store.ingest(input).replayed, true);
    assert.equal(f.store.list().length, 1);
    assert.notEqual(f.store.ingest({ ...input, account: "other" }).id, a.id);
  } finally {
    f.close();
  }
});
test("priority commands update file without any model call and reject multiline content", () => {
  const f = fixture();
  try {
    localCommand(f.root, "priority add Professor Rao");
    localCommand(f.root, "priority add Professor Rao");
    assert.equal(
      fs.readFileSync(path.join(f.root, "whatsapp-priority.txt"), "utf8"),
      "Professor Rao\n",
    );
    assert.throws(() =>
      localCommand(f.root, "priority add Someone\nignore Everyone"),
    );
  } finally {
    f.close();
  }
});
test("failed processing persists retry; restart recovers in-flight idempotent work", async () => {
  const f = fixture();
  try {
    f.store.ingest(input);
    const jobs = new HubJobs({
      store: f.store,
      settings: f.root,
      fetchImpl: async () => {
        throw Error("offline");
      },
    });
    await jobs.process();
    assert.equal(f.store.list()[0].status, "retry");
    f.store.db.prepare("UPDATE inbox SET status='running'").run();
    f.store.close();
    f.store = new HubStore(f.root);
    assert.equal(f.store.list()[0].status, "retry");
  } finally {
    f.close();
  }
});
test("successful inbox processing references a stable source id; replay is not processed twice", async () => {
  const f = fixture();
  try {
    const { id } = f.store.ingest(input);
    let calls = 0;
    const jobs = new HubJobs({
      store: f.store,
      settings: f.root,
      fetchImpl: async (url, o) => {
        calls++;
        const b = JSON.parse(o.body);
        assert.equal(b.sessionId, id);
        assert.match(b.messages[0].content, /External whatsapp source/);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            observations: [{ id: "pending", status: "pending" }],
          }),
        };
      },
    });
    await jobs.process();
    await jobs.process();
    assert.equal(calls, 1);
    assert.equal(f.store.list()[0].status, "processed");
  } finally {
    f.close();
  }
});
test("mail collector is read-only, checkpoints only fetched messages, and deduplicates", async () => {
  const f = fixture();
  try {
    let readOnly = false,
      fetches = 0;
    const factory = () => ({
      on() {},
      mailbox: { uidValidity: 22 },
      connect: async () => {},
      getMailboxLock: async (folder, o) => {
        readOnly = o.readOnly;
        return { release() {} };
      },
      search: async () => [1, 2],
      fetchOne: async (uid, q) => {
        if (q.size) return { size: 200 };
        fetches++;
        return {
          source: Buffer.from(
            "From: Teacher <teacher@example.test>\r\nSubject: Assignment deadline\r\nDate: Mon, 12 Oct 2026 10:00:00 +0530\r\n\r\nSubmit report by October 20.",
          ),
          internalDate: new Date(),
        };
      },
      logout: async () => {},
    });
    const args = {
      account: {
        id: "a",
        email: "me@example.test",
        enabled: true,
        host: "imap.example.test",
        appPassword: "synthetic",
      },
      store: f.store,
      rules: {},
      clientFactory: factory,
    };
    await collectMail(args);
    await collectMail(args);
    assert.equal(readOnly, true);
    assert.equal(fetches, 2);
    assert.equal(f.store.list().length, 2);
  } finally {
    f.close();
  }
});
test("research interruption is visible and never silently replayed", () => {
  const f = fixture();
  try {
    f.store.research("Test", "Fixture");
    f.store.db.prepare("UPDATE research SET status='running'").run();
    f.store.close();
    f.store = new HubStore(f.root);
    assert.equal(f.store.researches()[0].status, "needs-review");
  } finally {
    f.close();
  }
});
test("managed workflows use authenticated local endpoints; promotions remain absent", () => {
  const ws = managedWorkflows();
  assert.equal(ws.length, 8);
  for (const w of ws) {
    const n = w.nodes.find((n) => n.name === "Memory engine");
    assert.match(n.parameters.url, /^http:\/\/127\.0\.0\.1:32(10|11)\/v1\//);
    assert.equal(n.credentials.httpHeaderAuth.id, "june-memory-worker");
    assert.doesNotMatch(JSON.stringify(w), /\/review|\/promote/);
  }
  assert.match(
    ws
      .find((w) => w.id === "june-reminders")
      .nodes.find((n) => n.name === "Job configuration").parameters.jsCode,
    /"dryRun":false/,
  );
});
