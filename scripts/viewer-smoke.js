import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { HubStore } from "../src/hub/store.js";
import { TaskBoard } from "../src/hub/tasks.js";
const project = path.resolve(import.meta.dirname, ".."),
  root = await fs.mkdtemp(path.join(os.tmpdir(), "june-viewer-ui-"));
let child, browser;
try {
  const store = new HubStore(root);
  store.set("unreadSince", "2026-10-12T00:00:00+05:30");
  await fs.writeFile(
    path.join(root, "email-accounts.json"),
    JSON.stringify([
      {
        id: "fixture",
        email: "student@example.test",
        enabled: true,
        appPassword: "synthetic",
      },
    ]),
  );
  store.set("mailStatus", [{ account: "fixture", status: "connected" }]);
  const add = (x) =>
    store.ingest({
      source: "whatsapp",
      account: "fixture",
      sender: "111@s.whatsapp.net",
      senderName: "Ananya Rao",
      chatId: "111@s.whatsapp.net",
      receivedAt: "2026-10-12T10:20:00+05:30",
      metadataComplete: true,
      ...x,
    });
  add({
    externalId: "a1",
    text: "The circuit measurements are ready. Can you check the voltage readings before tomorrow's lab?",
  });
  add({
    externalId: "a2",
    text: "",
    attachments: [
      {
        kind: "image",
        name: "oscilloscope.jpg",
        mime: "image/jpeg",
        size: 145000,
      },
    ],
    receivedAt: "2026-10-12T10:21:00+05:30",
  });
  add({
    externalId: "a3",
    text: "I will compare them with the simulation.",
    direction: "outgoing",
    sender: "self",
    senderName: "You",
    receivedAt: "2026-10-12T10:22:00+05:30",
  });
  add({
    externalId: "lab1",
    sender: "teacher@s.whatsapp.net",
    senderName: "Professor Mehta",
    chatId: "lab@g.us",
    chatName: "EEE Lab · Section A",
    text: "Submit the RC filter report by 14 October, 5 pm.",
    receivedAt: "2026-10-12T09:50:00+05:30",
  });
  add({
    externalId: "team1",
    sender: "dev@s.whatsapp.net",
    senderName: "Dev",
    chatId: "project@g.us",
    chatName: "Project Team",
    text: "I have pushed the sensor logger code. The first graphs look good.",
    receivedAt: "2026-10-12T09:40:00+05:30",
  });
  add({
    source: "email",
    account: "student@example.test",
    externalId: "email1",
    chatId: "",
    sender: "lab@example.test",
    senderName: "Electronics Lab",
    subject: "Lab report deadline · RC filters",
    text: "Hello,\n\nPlease include the circuit diagram, simulated response, and measured cutoff frequency in your report. Submit it by 14 October at 5 pm.\n\nThe experiment notes are attached.\n\nElectronics Lab",
    attachments: [
      {
        kind: "document",
        name: "RC-filter-notes.pdf",
        mime: "application/pdf",
        size: 204800,
      },
    ],
    receivedAt: "2026-10-12T10:00:00+05:30",
  });
  add({
    source: "email",
    account: "student@example.test",
    externalId: "email2",
    chatId: "",
    sender: "opportunities@example.test",
    senderName: "Student Opportunities",
    subject: "Remote research internship — beginner project track",
    text: "Review the eligibility criteria and project details before applying.",
    receivedAt: "2026-10-12T09:30:00+05:30",
  });
  add({
    source: "email",
    account: "student@example.test",
    externalId: "email3",
    chatId: "",
    sender: "offers@example.test",
    senderName: "Campus Offers",
    subject: "Weekend sale",
    text: "Promotional fixture",
    promotional: true,
    receivedAt: "2026-10-12T09:00:00+05:30",
  });
  const taskBoard = new TaskBoard(store);
  taskBoard.scan();
  store.close();
  const port = 33342,
    origin = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, ["src/hub/server.js"], {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      JUNE_HUB_PORT: String(port),
      JUNE_HUB_STATE: root,
      JUNE_SETTINGS_ROOT: root,
      JUNE_WORKER_TOKEN: "synthetic-worker",
      JUNE_REVIEW_TOKEN: "synthetic-review",
      JUNE_BACKGROUND_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("fixture hub startup timeout")),
      15000,
    );
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
  });
  const { token } = JSON.parse(
    await fs.readFile(path.join(root, "access.json"), "utf8"),
  );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/messages#token=" + token);
  await page.locator(".entry").first().waitFor();
  assert.equal(await page.locator(".entry").count(), 3);
  await page.getByRole("button", { name: /Ananya Rao/ }).click();
  await page
    .locator(".attachment")
    .filter({ hasText: "oscilloscope.jpg" })
    .waitFor();
  assert.equal(await page.locator(".bubble").count(), 3);
  assert.match(await page.locator("#messages").innerText(), /Photo attached/);
  await page.getByRole("button", { name: /EEE Lab/ }).click();
  await page
    .locator("#messages")
    .getByText("Submit the RC filter report by 14 October, 5 pm.", {
      exact: true,
    })
    .waitFor();
  await page.locator("#search").fill("Ananya");
  await page.waitForFunction(
    () => document.querySelectorAll(".entry").length === 1,
  );
  await page.getByRole("button", { name: /Ananya/ }).click();
  await page
    .locator(".attachment")
    .filter({ hasText: "oscilloscope.jpg" })
    .waitFor();
  await page.locator("#search").fill("");
  await page.waitForFunction(
    () => document.querySelectorAll(".entry").length === 3,
  );
  await page.route("**/api/inbox/summarize", (route) =>
    route.fulfill({
      json: {
        ok: true,
        summary:
          "Ananya shared circuit measurements and a photo. You offered to compare the simulation.",
        model: "fixture-local",
        messages: 3,
      },
    }),
  );
  await page
    .getByRole("button", { name: "Summarize unread", exact: true })
    .click();
  await page.locator("#local-summary:not([hidden])").waitFor();
  const output = path.join(project, ".local");
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "viewer-messages.png"),
    fullPage: true,
  });
  await page.unroute("**/api/inbox/summarize");
  const queued = await context.request.post(origin + "/api/inbox/summarize", {
    headers: { "x-june-action": "1" },
    data: { allUnread: true },
  });
  assert.equal(queued.status(), 202);
  const queuedJob = await queued.json();
  assert.equal(queuedJob.messages, 4);
  const jobState = await context.request.get(
    origin + "/api/inbox/summary?id=" + queuedJob.id,
  );
  assert.equal((await jobState.json()).status, "queued");
  const mailPage = await context.newPage();
  mailPage.on("pageerror", (e) => errors.push(e.message));
  await mailPage.goto(origin + "/mail");
  await mailPage.locator(".entry").first().waitFor();
  assert.equal(await mailPage.locator(".entry").count(), 2);
  await mailPage
    .locator(".attachment")
    .filter({ hasText: "RC-filter-notes.pdf" })
    .waitFor();
  await mailPage
    .getByRole("button", { name: "Promotions", exact: true })
    .click();
  await mailPage.waitForFunction(
    () => document.querySelectorAll(".entry").length === 1,
  );
  assert.match(await mailPage.locator("#list").innerText(), /Campus Offers/);
  await mailPage.getByRole("button", { name: "All", exact: true }).click();
  await mailPage.waitForFunction(
    () => document.querySelectorAll(".entry").length === 3,
  );
  await mailPage.getByRole("button", { name: "Focused", exact: true }).click();
  await mailPage.waitForFunction(
    () => document.querySelectorAll(".entry").length === 2,
  );
  await mailPage
    .locator(".attachment")
    .filter({ hasText: "RC-filter-notes.pdf" })
    .waitFor();
  await mailPage.screenshot({
    path: path.join(output, "viewer-mail.png"),
    fullPage: true,
  });
  await mailPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await mailPage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  const taskPage = await context.newPage();
  taskPage.on("pageerror", (e) => errors.push(e.message));
  await taskPage.goto(origin + "/tasks");
  await taskPage.locator(".task").first().waitFor();
  await taskPage.locator(".task").first().click();
  await taskPage.getByRole("heading", { name: "Prepared brief" }).waitFor();
  assert.match(
    await taskPage.locator("#detail").innerText(),
    /report|measurements/,
  );
  await taskPage
    .getByRole("button", { name: "+ Add reminder", exact: true })
    .click();
  await taskPage.locator("#new-title").fill("Synthetic oscilloscope revision");
  await taskPage.locator("#new-due").fill("2026-10-22T17:00");
  await taskPage
    .locator("#new-notes")
    .fill("Review the RC cutoff formula and plot Bode response.");
  await taskPage
    .getByRole("button", { name: "Save task & reminders", exact: true })
    .click();
  await taskPage
    .locator("#detail h2")
    .filter({ hasText: "Synthetic oscilloscope revision" })
    .waitFor();
  await taskPage
    .getByRole("button", { name: "Snooze 1 hour", exact: true })
    .click();
  await taskPage.screenshot({
    path: path.join(output, "tasks-synthetic.png"),
    fullPage: true,
  });
  await taskPage.getByRole("button", { name: "Complete", exact: true }).click();
  await taskPage.waitForFunction(
    () =>
      !document
        .querySelector("#task-list")
        .textContent.includes("Synthetic oscilloscope revision"),
  );
  await taskPage
    .getByRole("button", { name: "Opportunities", exact: true })
    .click();
  await taskPage.waitForFunction(() =>
    document
      .querySelector("#connection")
      .textContent.includes("cannot read your feed"),
  );
  await taskPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await taskPage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      synthetic: true,
      conversationSelection: true,
      mediaLabels: true,
      search: true,
      separateMailWindow: true,
      filters: true,
      summaryButton: true,
      taskBrief: true,
      manualReminder: true,
      snooze: true,
      taskCompletion: true,
      opportunityStatus: true,
      mobileOverflow: false,
      browserErrors: errors.length,
    }),
  );
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  await fs.rm(root, { recursive: true, force: true });
}
