import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { HubStore } from "../src/hub/store.js";
import { prepareStarterResources } from "../src/hub/resources.js";
import { createBackup, verifyBackup } from "../src/backup.js";
import { Vault } from "../src/vault.js";

test("starter resources label challenges without claiming live opportunities or spending Gemini calls", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-resources-")),
    store = new HubStore(root);
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, text: async () => "<html>Captcha challenge</html>" };
  };
  await prepareStarterResources({ store, researchRoot: root, fetchImpl });
  assert.equal(calls, 4);
  assert.match(store.researches()[0].result, /Live check unavailable/);
  assert.match(
    store.researches()[0].result,
    /no open competition or internship is claimed/,
  );
  await prepareStarterResources({ store, researchRoot: root, fetchImpl });
  assert.equal(calls, 4);
});
test("backup includes consistent hub and n8n snapshots plus private configuration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-backup-hub-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hub = path.join(root, "hub"),
    n8n = path.join(root, "n8n"),
    settings = path.join(root, "settings");
  await fs.mkdir(n8n);
  await fs.mkdir(settings);
  const store = new HubStore(hub);
  store.set("fixture", { retained: true });
  store.close();
  const db = new DatabaseSync(path.join(n8n, "database.sqlite"));
  db.exec("CREATE TABLE fixture(id);INSERT INTO fixture VALUES(1)");
  db.close();
  await fs.writeFile(path.join(settings, "gemini-api-keys.txt"), "");
  const secret = path.join(root, "secrets.json");
  await fs.writeFile(secret, '{"synthetic":true}');
  const vault = new Vault(path.join(root, "vault"));
  await vault.initialize();
  const result = await createBackup({
    vault,
    backupRoot: path.join(root, "backups"),
    hubRoot: hub,
    n8nRoot: n8n,
    settingsRoot: settings,
    serviceSecretsFile: secret,
  });
  assert.equal((await verifyBackup(result.path)).ok, true);
  const manifest = JSON.parse(
    await fs.readFile(path.join(result.path, "manifest.json"), "utf8"),
  );
  for (const file of [
    "june-private/databases/hub.sqlite",
    "june-private/databases/n8n.sqlite",
    "june-private/service-secrets.json",
    "june-private/settings/gemini-api-keys.txt",
  ])
    assert.ok(
      manifest.files.some((entry) => entry.path === file),
      file,
    );
});
test("hub isolates owner actions from worker credentials and rejects foreign origins", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "june-hub-http-"));
  await fs.writeFile(path.join(root, "email-accounts.json"), "[]");
  const port = 33341,
    origin = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["src/hub/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    windowsHide: true,
    env: {
      ...process.env,
      JUNE_HUB_PORT: String(port),
      JUNE_HUB_STATE: root,
      JUNE_SETTINGS_ROOT: root,
      JUNE_WORKER_TOKEN: "synthetic-worker",
      JUNE_REVIEW_TOKEN: "synthetic-review",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ended = once(child, "exit");
  t.after(async () => {
    child.kill();
    await ended;
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("hub startup timeout")), 10000);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
  });
  assert.equal((await fetch(origin + "/api/state")).status, 401);
  assert.equal(
    (
      await fetch(origin + "/api/command", {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-worker",
          "content-type": "application/json",
        },
        body: '{"command":"priority add Test"}',
      })
    ).status,
    403,
  );
  const { token } = JSON.parse(
    await fs.readFile(path.join(root, "access.json"), "utf8"),
  );
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const headers = {
    "content-type": "application/json",
    cookie: "june_session=" + token,
    "x-june-action": "1",
    origin,
  };
  assert.equal(
    (
      await fetch(origin + "/api/command", {
        method: "POST",
        headers: { ...headers, origin: "https://untrusted.example" },
        body: '{"command":"priority add Test"}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(origin + "/api/command", {
        method: "POST",
        headers,
        body: '{"command":"priority add Test"}',
      })
    ).status,
    200,
  );
  for (const route of [
    "/api/inbox/chats",
    "/api/inbox/mail",
    "/api/inbox/status",
    "/api/tasks",
    "/api/opportunities",
  ]) {
    assert.equal((await fetch(origin + route)).status, 401);
    assert.equal(
      (
        await fetch(origin + route, {
          headers: { authorization: "Bearer synthetic-worker" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + route, {
          headers: { cookie: "june_session=" + token },
        })
      ).status,
      200,
    );
  }
  assert.equal(
    await fs.readFile(path.join(root, "whatsapp-priority.txt"), "utf8"),
    "Test\n",
  );
});
