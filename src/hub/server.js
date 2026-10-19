import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { HubStore } from "./store.js";
import { loadRules, readAccounts, localCommand } from "./settings.js";
import { HubJobs } from "./jobs.js";
import { LocalInboxModel } from "./local-inbox-model.js";
import { WhatsAppReader } from "./whatsapp.js";
import { SummaryJobs } from "./summary-jobs.js";
import { TaskBoard } from "./tasks.js";
import { GeminiPool } from "./gemini-pool.js";
import { Opportunities } from "./opportunities.js";
import { publicResearch } from "./public-research.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const readBody = async (req) => {
  let data = "";
  for await (const c of req) {
    data += c;
    if (Buffer.byteLength(data) > 128000) throw Error("BODY_TOO_LARGE");
  }
  return JSON.parse(data || "{}");
};
export async function startHub(env = process.env) {
  const settings = env.JUNE_SETTINGS_ROOT ?? "D:/June/Settings",
    state = env.JUNE_HUB_STATE ?? path.join(root, ".local/hub");
  const port = Number(env.JUNE_HUB_PORT ?? 3211),
    origin = "http://127.0.0.1:" + port;
  const store = new HubStore(state),
    secret = randomBytes(32).toString("hex");
  const workerToken = env.JUNE_WORKER_TOKEN,
    reviewToken = env.JUNE_REVIEW_TOKEN;
  if (!workerToken || !reviewToken) throw Error("Service credentials required");
  fs.writeFileSync(
    path.join(state, "access.json"),
    JSON.stringify({ token: secret, pid: process.pid }),
    { mode: 0o600 },
  );
  const inboxModel = new LocalInboxModel();
  const summaries = new SummaryJobs(store, inboxModel);
  const tasks = new TaskBoard(store);
  const pool = new GeminiPool({
    settings,
    pendingRoot: path.join(state, "gemini-requests"),
  });
  const opportunities = new Opportunities(store, pool, {
    research: publicResearch,
  });
  const jobs = new HubJobs({
    inboxModel,
    store,
    settings,
    workerToken,
    openclawEntry: path.join(
      process.env.APPDATA,
      "npm/node_modules/openclaw/dist/index.js",
    ),
    researchRoot: "D:/June/Research",
  });
  const whatsapp = new WhatsAppReader({
    root: path.join(state, "whatsapp"),
    knownContacts: store.db.prepare("SELECT id,name FROM contacts").all(),
    onContact: (id, name) => store.saveContact(id, name),
    onMessage: (message) => {
      try {
        store.ingest(message, loadRules(settings));
      } catch {
        store.set("whatsappError", "MESSAGE_NOT_ACCEPTED");
      }
    },
    onStatus: (s) => store.set("whatsappStatus", { state: s.state }),
  });
  let stopping = false;
  async function memory(
    endpoint,
    { method = "GET", body, review = false } = {},
  ) {
    const r = await fetch("http://127.0.0.1:3210" + endpoint, {
      method,
      headers: {
        authorization: "Bearer " + (review ? reviewToken : workerToken),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error ?? "MEMORY_UNAVAILABLE");
    return data;
  }
  const send = (res, status, data, type = "application/json") => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(type === "application/json" ? JSON.stringify(data) : data);
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (
        !["127.0.0.1:" + port, "localhost:" + port].includes(req.headers.host)
      )
        return send(res, 403, { error: "HOST_DENIED" });
      const u = new URL(req.url, origin);
      if (req.method === "GET" && u.pathname === "/healthz")
        return send(res, 200, { ok: true, service: "june-hub" });
      const staticFiles = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
        "/messages": "viewer.html",
        "/mail": "viewer.html",
        "/viewer.js": "viewer.js",
        "/viewer.css": "viewer.css",
        "/tasks": "tasks.html",
        "/tasks.js": "tasks.js",
        "/tasks.css": "tasks.css",
      };
      if (req.method === "GET" && Object.hasOwn(staticFiles, u.pathname)) {
        const ext = path.extname(staticFiles[u.pathname]);
        return send(
          res,
          200,
          await fsp.readFile(path.join(root, "ui", staticFiles[u.pathname])),
          ext === ".js"
            ? "text/javascript"
            : ext === ".css"
              ? "text/css"
              : "text/html",
        );
      }
      if (req.headers.origin && req.headers.origin !== origin)
        return send(res, 403, { error: "ORIGIN_DENIED" });
      if (
        req.method === "POST" &&
        !req.headers["content-type"]?.startsWith("application/json")
      )
        return send(res, 415, { error: "JSON_REQUIRED" });
      if (req.method === "POST" && u.pathname === "/api/login") {
        const b = await readBody(req);
        if (!equal(b.token, secret))
          return send(res, 401, { error: "OPEN_FROM_START_JUNE" });
        res.setHeader(
          "set-cookie",
          "june_session=" + secret + "; HttpOnly; SameSite=Strict; Path=/",
        );
        return send(res, 200, { ok: true });
      }
      const bearer = req.headers.authorization?.replace(/^Bearer /, ""),
        worker = equal(bearer, workerToken),
        user = equal(
          req.headers.cookie?.match(/(?:^|; )june_session=([^;]+)/)?.[1],
          secret,
        );
      if (!worker && !user)
        return send(res, 401, { error: "OPEN_FROM_START_JUNE" });
      if (
        req.method === "POST" &&
        user &&
        !worker &&
        req.headers["x-june-action"] !== "1"
      )
        return send(res, 403, { error: "ACTION_HEADER_REQUIRED" });
      if (req.method === "POST" && u.pathname === "/v1/intake") {
        const b = await readBody(req);
        return send(res, 200, {
          ok: true,
          ...store.ingest(b, loadRules(settings)),
        });
      }
      if (req.method === "POST" && u.pathname.startsWith("/v1/jobs/")) {
        const job = u.pathname.slice(9);
        if (!["collect", "process", "research"].includes(job))
          return send(res, 404, { error: "NOT_FOUND" });
        await readBody(req);
        return send(res, 200, await jobs[job]());
      }
      if (!user) return send(res, 403, { error: "LOCAL_OWNER_REQUIRED" });
      if (req.method === "GET" && u.pathname === "/api/tasks")
        return send(res, 200, {
          ok: true,
          tasks: tasks.list(Object.fromEntries(u.searchParams)),
          notifications: tasks.notifications(),
        });
      if (req.method === "GET" && u.pathname === "/api/tasks/item")
        return send(res, 200, {
          ok: true,
          task: tasks.get(u.searchParams.get("id")),
        });
      if (req.method === "GET" && u.pathname === "/api/inbox/summary")
        return send(res, 200, {
          ok: true,
          ...summaries.get(u.searchParams.get("id")),
        });
      if (req.method === "GET" && u.pathname === "/api/opportunities")
        return send(res, 200, {
          ok: true,
          items: opportunities.list(),
          connection: opportunities.state(),
          pool: pool.status(),
        });
      if (req.method === "GET" && u.pathname === "/api/inbox/status")
        return send(res, 200, {
          ok: true,
          whatsapp: {
            state: whatsapp.status.state,
            warning: whatsapp.status.warning,
          },
          mail: store.get("mailStatus", []),
          accounts: readAccounts(settings).map((a) => ({
            email: a.email,
            configured: !!(a.appPassword || a.accessToken),
          })),
          counts: store.db
            .prepare(
              "SELECT source,category,count(*) AS count FROM inbox WHERE source IN ('email','whatsapp') GROUP BY source,category",
            )
            .all(),
          model: "qwen3.5:4b",
          unreadSince: store.get("unreadSince"),
          modelBusy: inboxModel.busy,
        });
      if (req.method === "GET" && u.pathname === "/api/inbox/chats")
        return send(res, 200, {
          ok: true,
          ...store.conversations(Object.fromEntries(u.searchParams)),
        });
      if (req.method === "GET" && u.pathname === "/api/inbox/thread")
        return send(res, 200, {
          ok: true,
          ...store.thread(
            u.searchParams.get("id"),
            Object.fromEntries(u.searchParams),
          ),
        });
      if (req.method === "GET" && u.pathname === "/api/inbox/mail")
        return send(res, 200, {
          ok: true,
          ...store.emails(Object.fromEntries(u.searchParams)),
        });
      if (req.method === "GET" && u.pathname === "/api/inbox/item") {
        const item = store.inboxItem(u.searchParams.get("id"));
        return send(res, item ? 200 : 404, { ok: !!item, item });
      }
      if (req.method === "GET" && u.pathname === "/api/talk-url") {
        const config = JSON.parse(
          await fsp.readFile(
            path.join(process.env.USERPROFILE, ".openclaw/openclaw.json"),
            "utf8",
          ),
        );
        const token = config.gateway?.auth?.token;
        return send(res, 200, {
          ok: true,
          url:
            "http://127.0.0.1:18789/" +
            (typeof token === "string"
              ? "#token=" + encodeURIComponent(token)
              : ""),
        });
      }
      if (req.method === "GET" && u.pathname === "/api/state") {
        const services = await Promise.all(
          [
            ["Gateway", "http://127.0.0.1:18789/readyz"],
            ["Local model", "http://127.0.0.1:11434/api/tags"],
            ["Memory", "http://127.0.0.1:3210/healthz"],
            ["Workflows", "http://127.0.0.1:5680/healthz/readiness"],
          ].map(async ([name, url]) => {
            try {
              const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
              const d = await r.json();
              return { name, ok: r.ok && d.ready !== false };
            } catch {
              return { name, ok: false };
            }
          }),
        );
        const review = await memory("/v1/review-queue", { review: true }).catch(
          () => ({ records: [] }),
        );
        return send(res, 200, {
          ok: true,
          services,
          accounts: readAccounts(settings).map((a) => ({
            id: a.id,
            email: a.email,
            enabled: a.enabled,
            configured: !!(a.appPassword || a.accessToken),
          })),
          mail: store.get("mailStatus", []),
          whatsapp: whatsapp.status,
          rules: loadRules(settings),
          inbox: store.list(),
          review: review.records,
          active: (await memory("/v1/active").catch(() => ({ records: [] })))
            .records,
          research: store.researches(),
          running: [...jobs.running],
          pendingRequests: fs.existsSync(
            path.join(root, ".local/gemini-pending"),
          )
            ? fs
                .readdirSync(path.join(root, ".local/gemini-pending"))
                .filter((x) => x.endsWith(".json")).length
            : 0,
        });
      }
      if (req.method !== "POST") return send(res, 404, { error: "NOT_FOUND" });
      const b = await readBody(req);
      if (u.pathname === "/api/inbox/summarize") {
        return send(res, 202, { ok: true, ...summaries.start(b) });
      }
      if (u.pathname === "/api/inbox/summary-read")
        return send(res, 200, summaries.acknowledge(b.id));
      if (u.pathname === "/api/inbox/mark-read") {
        if (
          !/^CHAT-[a-f0-9]{32}$/.test(b.threadId ?? "") ||
          !Array.isArray(b.ids) ||
          b.ids.length > 100
        )
          throw Error("INVALID_READ_SELECTION");
        const update = store.db.prepare(
          "UPDATE inbox SET june_read_at=? WHERE id=? AND thread_id=? AND source='whatsapp'",
        );
        for (const id of b.ids)
          update.run(new Date().toISOString(), id, b.threadId);
        return send(res, 200, { ok: true });
      }
      if (u.pathname === "/api/tasks/add")
        return send(res, 200, { ok: true, task: tasks.add(b) });
      if (u.pathname === "/api/tasks/update")
        return send(res, 200, { ok: true, task: tasks.update(b.id, b) });
      if (u.pathname === "/api/tasks/reminder") {
        tasks.acknowledge(b.id, b.delivered === true);
        return send(res, 200, { ok: true });
      }
      if (u.pathname === "/api/opportunities/scan") {
        void opportunities.scan({ force: true });
        return send(res, 202, { ok: true, status: "queued" });
      }
      if (u.pathname === "/api/inbox/classify") {
        const row = store.inboxItem(b.id);
        if (!row || row.source !== "email") throw Error("MESSAGE_NOT_FOUND");
        const result = await inboxModel.classify(row);
        const category = store.classifyItem(row.id, result);
        return send(res, 200, { ok: true, category, reason: result.reason });
      }
      if (u.pathname === "/api/command")
        return send(res, 200, localCommand(settings, b.command));
      if (u.pathname === "/api/mail") {
        const accounts = readAccounts(settings),
          a = accounts.find((a) => a.id === b.id);
        if (!a) throw Error("ACCOUNT_NOT_FOUND");
        if (
          typeof b.appPassword !== "string" ||
          b.appPassword.replace(/\s/g, "").length !== 16
        )
          throw Error("ENTER_GOOGLE_APP_PASSWORD");
        a.appPassword = b.appPassword.replace(/\s/g, "");
        a.enabled = true;
        const file = path.join(settings, "email-accounts.json"),
          tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2), {
          mode: 0o600,
        });
        fs.renameSync(tmp, file);
        return send(res, 200, { ok: true });
      }
      if (u.pathname === "/api/whatsapp") {
        store.set("whatsappEnabled", true);
        await whatsapp.start();
        return send(res, 200, { ok: true });
      }
      if (u.pathname === "/api/research") {
        if (
          typeof b.title !== "string" ||
          !b.title.trim() ||
          typeof b.brief !== "string" ||
          !b.brief.trim()
        )
          throw Error("TASK_REQUIRED");
        return send(res, 200, {
          ok: true,
          id: store.research(b.title, b.brief),
        });
      }
      if (u.pathname === "/api/review") {
        if (
          !/^OBS-[a-zA-Z0-9._-]+$/.test(b.id) ||
          !["confirmed", "rejected"].includes(b.verdict) ||
          !Number.isInteger(b.revision)
        )
          throw Error("INVALID_REVIEW");
        const result = await memory("/v1/observations/" + b.id + "/review", {
          method: "POST",
          review: true,
          body: {
            verdict: b.verdict,
            expectedRevision: b.revision,
            note: "Explicit confirmation in June control panel",
          },
        });
        if (b.activate && b.verdict === "confirmed")
          await memory("/v1/observations/" + b.id + "/activate", {
            method: "POST",
            review: true,
            body: {},
          });
        return send(res, 200, result);
      }
      if (u.pathname === "/api/active") {
        if (
          !/^ACT-[a-zA-Z0-9._-]+$/.test(b.id) ||
          !["completed", "cancelled"].includes(b.status) ||
          !Number.isInteger(b.revision)
        )
          throw Error("INVALID_TRANSITION");
        return send(
          res,
          200,
          await memory("/v1/active/" + b.id + "/transition", {
            method: "POST",
            review: true,
            body: {
              status: b.status,
              expectedRevision: b.revision,
              note: "Explicit action in June control panel",
            },
          }),
        );
      }
      if (u.pathname === "/api/retry-research") {
        if (typeof b.id !== "string") throw Error("ID_REQUIRED");
        store.db
          .prepare(
            "UPDATE research SET status='queued',attempts=0,next_attempt=0,error=NULL WHERE id=? AND status IN ('needs-attention','needs-review','retry')",
          )
          .run(b.id);
        return send(res, 200, { ok: true });
      }
      if (u.pathname === "/api/retry") {
        if (typeof b.id !== "string") throw Error("ID_REQUIRED");
        store.db
          .prepare(
            "UPDATE inbox SET status='queued',attempts=0,next_attempt=0,error=NULL WHERE id=? AND status='needs-attention'",
          )
          .run(b.id);
        return send(res, 200, { ok: true });
      }
      if (u.pathname === "/api/prepare-stop") {
        jobs.paused = true;
        whatsapp.stop();
        return send(res, 200, { ok: true, running: [...jobs.running] });
      }
      if (u.pathname === "/api/shutdown") {
        send(res, 200, { ok: true });
        setTimeout(() => stop(), 100);
        return;
      }
      send(res, 404, { error: "NOT_FOUND" });
    } catch (e) {
      send(res, 400, {
        ok: false,
        error: /^[A-Z_]+$/.test(e.message) ? e.message : "OPERATION_FAILED",
      });
    }
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    jobs.paused = true;
    clearInterval(backgroundTimer);
    whatsapp.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  // App-owned routines run whenever June is running, including Windows sign-in.
  // Persistent snapshots/checkpoints make interrupted work resumable.
  const backgroundTick = () => {
    if (jobs.paused || env.JUNE_BACKGROUND_DISABLED === "1") return;
    try {
      tasks.scan(500);
      tasks.reminders();
      opportunities.collectAlerts();
    } catch {
      store.set("backgroundError", "TASK_SCAN_FAILED");
    }
    void summaries
      .tick()
      .catch(() => store.set("backgroundError", "SUMMARY_FAILED"));
    void opportunities
      .scan()
      .catch(() => store.set("backgroundError", "OPPORTUNITY_SCAN_FAILED"));
  };
  const backgroundTimer = setInterval(backgroundTick, 10000);
  backgroundTimer.unref();
  if (env.JUNE_BACKGROUND_DISABLED !== "1")
    setTimeout(backgroundTick, 3000).unref();
  if (store.get("whatsappEnabled", false))
    whatsapp
      .start()
      .catch(() => whatsapp.update({ state: "connection-failed" }));
  console.log(JSON.stringify({ ok: true, service: "june-hub", port }));
  return { server, store, jobs, stop };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startHub().catch(() => {
    console.error("June hub could not start; check private configuration.");
    process.exitCode = 1;
  });
