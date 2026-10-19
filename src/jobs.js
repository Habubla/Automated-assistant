import fs from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors.js";
import {
  checksum,
  integer,
  inside,
  assertNoLinks,
  isoNow,
  readJson,
  writeJsonAtomic,
  withVaultLock,
  localUrl,
} from "./util.js";
import { boundedResponse } from "./provider.js";

export function localDate(now = new Date(), offsetDays = 0) {
  const shifted = new Date(now.getTime() + offsetDays * 86400000);
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Calcutta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  return ["year", "month", "day"]
    .map((type) => p.find((x) => x.type === type).value)
    .join("-");
}
export class Jobs {
  constructor({
    vault,
    pipeline,
    fetchImpl = globalThis.fetch,
    backup = null,
    services = {},
  }) {
    this.vault = vault;
    this.pipeline = pipeline;
    this.fetch = fetchImpl;
    this.backup = backup;
    this.services = {
      openclaw: "http://127.0.0.1:18789",
      ollama: "http://127.0.0.1:11434",
      n8n: "http://127.0.0.1:5680",
      ...services,
    };
    for (const v of Object.values(this.services)) localUrl(v);
  }
  async consolidate({
    date = localDate(this.vault.clock(), -1),
    dryRun = true,
  } = {}) {
    if (
      typeof dryRun !== "boolean" ||
      !/^\d{4}-\d\d-\d\d$/.test(date) ||
      !Number.isFinite(Date.parse(date + "T00:00:00Z")) ||
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date
    )
      throw new ValidationError("Invalid consolidation request.");
    const rel = `daily/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`,
      file = inside(this.vault.root, rel);
    await assertNoLinks(file);
    const st = await fs
      .stat(file)
      .catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (!st) return { ok: true, status: "no-note", date, dryRun };
    if (st.size > 32000)
      throw new ValidationError(
        "Daily note exceeds 32 KB; split it before processing.",
      );
    const text = await fs.readFile(file, "utf8");
    const material = text
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^\s*(#|<!--|-->|---|\-\s*$)/.test(l))
      .join("\n")
      .trim();
    const report = {
      ok: true,
      date,
      dryRun,
      source: rel,
      sourceHash: checksum(text),
      status: material ? "eligible" : "empty-scaffold",
    };
    if (material && !dryRun) {
      const id = "daily-" + date + "-" + checksum(text).slice(0, 24);
      report.result = await this.pipeline.processConversation({
        sessionId: id,
        messages: [
          { role: "user", content: text, timestamp: date + "T12:00:00+05:30" },
        ],
      });
      report.status = "candidates-for-review";
    }
    const id = "daily-" + date + "-" + checksum({ text, dryRun }).slice(0, 24);
    await this.vault.writeState("state/reports", id, report);
    return report;
  }
  async reminders({ leadHours = 24, dryRun = true } = {}) {
    integer(leadHours, "leadHours", 1, 720);
    if (typeof dryRun !== "boolean")
      throw new ValidationError("dryRun must be boolean.");
    return withVaultLock(this.vault.root, async () => {
      const now = this.vault.clock().getTime(),
        records = (await this.vault.trustedRecords()).filter(
          (r) =>
            r.kind === "active_memory" &&
            r.dueAt &&
            ["deadline", "commitment", "reminder", "recurring_task"].includes(
              r.type,
            ),
        );
      const notifications = [];
      for (const r of records) {
        const due = Date.parse(r.dueAt);
        if (due > now + leadHours * 3600000) continue;
        const phase = due < now ? "overdue" : "upcoming",
          id =
            "NOTICE-" +
            checksum({ id: r.id, due: r.dueAt, phase }).slice(0, 40);
        const file = this.vault.file("state/notifications", id),
          prior = await readJson(file);
        if (prior?.status === "delivered-local") continue;
        const n = {
          id,
          recordId: r.id,
          dueAt: r.dueAt,
          phase,
          status: dryRun ? "dry-run" : "delivered-local",
          channel: "local-outbox",
          createdAt: isoNow(this.vault.clock),
        };
        if (!dryRun)
          await writeJsonAtomic(
            file,
            {
              ...n,
              claim: r.claim,
              provenance: await this.vault.provenance(r),
            },
            { overwrite: false },
          );
        notifications.push(n);
      }
      return { ok: true, dryRun, notifications, externalDelivery: false };
    });
  }
  async health() {
    const checks = await Promise.all(
      Object.entries(this.services).map(async ([name, origin]) => {
        const endpoint =
          name === "ollama"
            ? "/api/tags"
            : name === "n8n"
              ? "/healthz/readiness"
              : "/healthz";
        try {
          const response = await this.fetch(origin + endpoint, {
            signal: AbortSignal.timeout(2500),
            redirect: "error",
          });
          if (!response.ok) {
            await response.body?.cancel();
            return {
              name,
              ok: false,
              code: "HTTP_" + response.status,
              action:
                "Inspect the local service; no automatic restart performed.",
            };
          }
          if (name === "ollama") {
            const body = JSON.parse(await boundedResponse(response, 64000));
            if (!body.models?.some((m) => m.name === "qwen3.5:4b"))
              return {
                name,
                ok: false,
                code: "MODEL_MISSING",
                action: "Install qwen3.5:4b after checking available storage.",
              };
          } else await response.body?.cancel();
          return { name, ok: true };
        } catch {
          return {
            name,
            ok: false,
            code: "UNAVAILABLE",
            action:
              name === "openclaw"
                ? "Inspect Gateway task, lock owner and logs; preserve sessions before approved recovery."
                : "Start the configured local service manually when needed.",
          };
        }
      }),
    );
    const validation = await this.vault.validate();
    checks.push({
      name: "memory-engine",
      ok: validation.ok,
      invalidRecords: validation.errors.length,
    });
    const signature = checksum(checks),
      prior = await this.vault.state("state/reports", "health");
    const report = {
      ok: checks.every((c) => c.ok),
      checks,
      changed: prior?.signature !== signature,
      signature,
      checkedAt: isoNow(this.vault.clock),
    };
    if (report.changed)
      await this.vault.writeState("state/reports", "health", report);
    return report;
  }
  async backupVerification() {
    if (!this.backup)
      throw new ValidationError("Backup destination is not configured.");
    return this.backup();
  }
}
