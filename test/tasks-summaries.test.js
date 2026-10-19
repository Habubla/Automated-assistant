import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubStore } from "../src/hub/store.js";
import { SummaryJobs, summaryChunks } from "../src/hub/summary-jobs.js";
import { TaskBoard, detectDeadlines } from "../src/hub/tasks.js";
import { GeminiPool, refreshGatewayKeys } from "../src/hub/gemini-pool.js";
import { Opportunities, scanSlot } from "../src/hub/opportunities.js";
import { publicResearch, verifyCitations } from "../src/hub/public-research.js";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "june-features-"));
  const store = new HubStore(root);
  store.set("unreadSince", "2026-10-18T00:00:00+05:30");
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, root };
}
const base = {
  source: "whatsapp",
  account: "test",
  chatId: "fixture@g.us",
  chatName: "EEE Lab",
  sender: "teacher@example.test",
  senderName: "Teacher",
  direction: "incoming",
  receivedAt: "2026-10-18T10:00:00+05:30",
  metadataComplete: true,
};
test("all unread messages and long bodies survive chunking, restart and concurrent arrivals", async (t) => {
  const { store } = fixture(t),
    seen = [];
  for (let i = 0; i < 75; i++)
    store.ingest({
      ...base,
      externalId: "msg" + i,
      text: "UNIQUE_" + i + " " + "Detail ".repeat(60),
    });
  store.ingest({
    ...base,
    externalId: "yesterday",
    receivedAt: "2026-10-17T12:00:00+05:30",
    text: "Old read baseline",
  });
  store.ingest({
    ...base,
    externalId: "out",
    direction: "outgoing",
    text: "Our reply",
  });
  const long = "Long content ".repeat(700);
  store.ingest({ ...base, externalId: "long", text: long });
  const model = {
    summarize: async (rows) => {
      seen.push(...rows);
      return { summary: "Detailed batch summary" };
    },
  };
  const jobber = new SummaryJobs(store, model),
    scope = { allUnread: true },
    job = jobber.start(scope);
  assert.equal(job.messages, 76);
  assert.ok(job.totalParts > 3);
  assert.equal(jobber.start(scope).id, job.id);
  await jobber.tick();
  const restarted = new SummaryJobs(store, model);
  store.ingest({
    ...base,
    externalId: "new-during-summary",
    text: "New unread arrival",
  });
  while (restarted.get(job.id).status !== "complete") await restarted.tick();
  assert.equal(new Set(seen.map((r) => r.id)).size, 76);
  assert.equal(
    seen
      .filter((r) => r.body.startsWith("Long") || r.external_id === "long")
      .map((r) => r.body)
      .join(""),
    long.trim(),
  );
  restarted.acknowledge(job.id);
  assert.equal(restarted.rows(scope).length, 1);
  assert.equal(store.conversations().items[0].unread_count, 1);
});
test("failed summary preserves completed parts and resumes without repeating successful batches", async (t) => {
  const { store } = fixture(t);
  for (let i = 0; i < 30; i++)
    store.ingest({
      ...base,
      externalId: String(i),
      text: "message " + i + " " + "content ".repeat(250),
    });
  let calls = 0;
  const model = {
    summarize: async () => {
      if (++calls === 2) throw Error("LOCAL_MODEL_UNAVAILABLE");
      return { summary: "Part " + calls };
    },
  };
  const s = new SummaryJobs(store, model),
    j = s.start({ allUnread: true });
  await s.tick();
  await s.tick();
  assert.equal(s.get(j.id).status, "failed");
  assert.equal(s.get(j.id).completedParts, 1);
  s.start({ allUnread: true });
  await s.tick();
  assert.equal(s.get(j.id).completedParts, 2);
});
test("deadline parser uses message time and IST, labels date-only guesses and ignores outgoing/promotions", () => {
  const parse = (body) =>
    detectDeadlines({ ...base, received_at: base.receivedAt, body });
  assert.equal(
    parse("Submit the report tomorrow at 4 pm.")[0].due_at,
    "2026-10-19T10:30:00.000Z",
  );
  const d = parse("Assignment due 21/10/2026.")[0];
  assert.equal(d.due_at, "2026-10-21T18:29:00.000Z");
  assert.equal(d.date_precision, "date");
  assert.equal(parse("Assignment deadline will be announced")[0].due_at, null);
  assert.equal(
    detectDeadlines({
      ...base,
      received_at: base.receivedAt,
      body: "Submit tomorrow",
      direction: "outgoing",
    }).length,
    0,
  );
  assert.equal(parse("See you next week").length, 0);
});
test("detected tasks keep prepared source briefs, deduplicate forwarding and never become confirmed implicitly", (t) => {
  const { store } = fixture(t),
    board = new TaskBoard(store);
  for (const externalId of ["one", "two"])
    store.ingest({
      ...base,
      externalId,
      text: "Submit circuit report by 20 October, 5 pm. Notes: https://example.test/notes",
      attachments: [{ kind: "document", name: "lab.pdf" }],
    });
  board.scan();
  assert.equal(board.list().length, 1);
  const task = board.list()[0];
  assert.equal(task.status, "detected");
  assert.match(task.brief, /lab.pdf/);
  assert.match(task.brief, /contents have not been read/);
  assert.match(task.brief, /example.test/);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM task_sources").get().n,
    2,
  );
  board.scan();
  assert.equal(board.list().length, 1);
  board.update(task.id, {
    status: "confirmed",
    dueAt: "2026-10-21T16:00:00+05:30",
  });
  assert.match(board.get(task.id).brief, /UPDATED DEADLINE/);
  assert.equal(board.get(task.id).status, "confirmed");
});
test("reminders survive repeated polls, catch up once, snooze and stop for completed tasks", (t) => {
  const { store } = fixture(t),
    board = new TaskBoard(store),
    now = Date.now(),
    due = now + 86400000;
  const task = board.add({
    title: "Synthetic report",
    dueAt: new Date(due).toISOString(),
  });
  board.reminders(now);
  board.reminders(now);
  assert.equal(board.notifications().length, 1);
  assert.equal(board.notifications()[0].kind, "24h");
  board.reminders(due - 3600000);
  assert.equal(board.notifications().length, 1);
  assert.equal(board.notifications()[0].kind, "1h");
  board.reminders(due + 1000);
  assert.equal(board.notifications().length, 1);
  assert.equal(board.notifications()[0].kind, "due");
  board.update(task.id, { snoozeMinutes: 60 });
  assert.equal(board.notifications().length, 0);
  board.update(task.id, { status: "completed" });
  board.reminders(due + 10000);
  assert.equal(board.notifications().length, 0);
  assert.equal(new TaskBoard(store).list().length, 0);
});
test("Gemini rotates on quota, retains exhausted requests, hot reloads keys, and clears the retried snapshot", async (t) => {
  const { root } = fixture(t),
    key1 = "AQ." + "a".repeat(50),
    key2 = "AQ." + "b".repeat(50);
  fs.writeFileSync(path.join(root, "gemini-api-keys.txt"), key1 + "\n" + key2);
  const env = {};
  assert.equal(refreshGatewayKeys(root, env).configured, 2);
  assert.equal(env.GEMINI_API_KEY, key1);
  let quota = true,
    calls = [];
  const pending = path.join(root, "pending");
  const pool = new GeminiPool({
    settings: root,
    pendingRoot: pending,
    sleep: async () => {},
    fetchImpl: async (_, opts) => {
      calls.push(opts.headers["x-goog-api-key"]);
      const status = quota ? 429 : 200;
      return {
        ok: status === 200,
        status,
        headers: new Headers(),
        json: async () =>
          status === 200
            ? { candidates: [{ content: { parts: [{ text: "OK" }] } }] }
            : { error: { details: [{ retryDelay: "1s" }] } },
      };
    },
  });
  await assert.rejects(
    () => pool.generate({ contents: [] }, { requestId: "job" }),
    /QUOTA/,
  );
  assert.deepEqual(calls, [key1, key2]);
  assert.equal(fs.readdirSync(pending).length, 1);
  quota = false;
  pool.cooldowns.clear();
  await pool.generate({ contents: [] }, { requestId: "job" });
  assert.equal(fs.readdirSync(pending).length, 0);
  fs.writeFileSync(path.join(root, "gemini-api-keys.txt"), key2);
  assert.equal(pool.status().configured, 1);
  assert.equal(refreshGatewayKeys(root, env).configured, 1);
  assert.equal(env.GEMINI_API_KEY, key2);
});
test("invalid Gemini requests do not churn through the key pool", async (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(
    path.join(root, "gemini-api-keys.txt"),
    "AQ." + "a".repeat(50) + "\nAQ." + "b".repeat(50),
  );
  let calls = 0;
  const p = new GeminiPool({
    settings: root,
    pendingRoot: path.join(root, "pending"),
    fetchImpl: async () => {
      calls++;
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { status: "INVALID_ARGUMENT" } }),
      };
    },
  });
  await assert.rejects(() => p.generate({}), /REQUEST_REJECTED/);
  assert.equal(calls, 1);
});
test("scheduled public scans catch up in IST, require grounded sources, and import LinkedIn alerts locally", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const pool = {
    generate: async () => {
      calls++;
      return {
        candidates: [
          {
            content: { parts: [{ text: "Verified public lead" }] },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Organizer",
                    uri: "https://example.test/event",
                  },
                },
              ],
            },
          },
        ],
      };
    },
  };
  store.ingest({
    ...base,
    source: "email",
    sender: "jobs-noreply@linkedin.com",
    subject: "Remote internship alert",
    externalId: "linkedin",
    text: "Opportunity https://www.linkedin.com/jobs/view/123",
  });
  const scanner = new Opportunities(store, pool),
    now = Date.parse("2026-10-18T09:01:00+05:30");
  await scanner.scan({ now });
  await scanner.scan({ now });
  assert.equal(calls, 1);
  assert.equal(scanner.list().length, 2);
  assert.equal(scanner.state().accountFeedConnected, false);
  assert.equal(scanSlot(now), "2026-10-18-09");
  assert.equal(
    scanSlot(Date.parse("2026-10-18T06:00:00+05:30")),
    "2026-10-17-18",
  );
});
test("public research rejects invented citations without tool activity and uses successful web checks when grounding is quota-limited", async (t) => {
  const payload = {
    payloads: [{ text: "Public course: https://example.test/course" }],
    meta: {
      toolSummary: {
        calls: 2,
        tools: ["web_search", "web_fetch"],
        failures: 0,
      },
    },
  };
  const result = await publicResearch("Synthetic research", "fixture", {
    run: async () => payload,
  });
  assert.equal(result.sources.length, 1);
  await assert.rejects(
    () =>
      publicResearch("Synthetic", "fixture", {
        run: async () => ({ ...payload, meta: { toolSummary: { calls: 0 } } }),
      }),
    /UNVERIFIED/,
  );
  const { store } = fixture(t);
  let groundingCalls = 0;
  const scanner = new Opportunities(
    store,
    {
      generate: async () => {
        groundingCalls++;
        throw Error("GEMINI_QUOTA_EXHAUSTED");
      },
    },
    { research: async () => result },
  );
  const scan = await scanner.scan({
    now: Date.parse("2026-10-18T18:01:00+05:30"),
  });
  assert.equal(scan.status, "ready");
  assert.equal(groundingCalls, 0);
  assert.equal(scanner.state().route, "June web search");
});
test("citation checks do not mistake a CAPTCHA or old fellowship cohort for a verified current opening", () => {
  const sources = verifyCitations(
    "https://example.test/fellowship https://example.test/challenge",
    [
      {
        url: "https://example.test/fellowship",
        finalUrl: "https://example.test/fellowship/2025",
        status: 200,
        rawLength: 1000,
        blocked: false,
      },
      {
        url: "https://example.test/challenge",
        status: 200,
        rawLength: 1000,
        blocked: true,
      },
    ],
    2026,
  );
  assert.match(sources[0].verification, /older cohort/);
  assert.equal(sources[1].checked, false);
});
