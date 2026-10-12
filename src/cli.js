#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Vault, SECTIONS } from "./vault.js";
import { MemoryPipeline } from "./pipeline.js";
import { OllamaMemoryProvider } from "./provider.js";
import { Jobs } from "./jobs.js";
import { createBackup, verifyBackup, restoreVault } from "./backup.js";
import { readJson, inside, assertNoLinks, sha256 } from "./util.js";
const args = process.argv.slice(2),
  command = args[0];
const arg = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const root =
  arg("--vault") ?? process.env.JUNE_MEMORY_VAULT ?? "D:/June/MemoryVault/june";
const vault = new Vault(root);
async function input() {
  const file = arg("--input");
  if (!file) throw Error("Use --input <JSON file>");
  const value = await readJson(path.resolve(file));
  if (!value) throw Error("Input file missing");
  return value;
}
async function main() {
  let result;
  if (command === "init") {
    await vault.initialize();
    result = { ok: true, vault: vault.root, action: "initialized-additively" };
  } else if (command === "validate") {
    result = await vault.validate();
    if (!result.ok) process.exitCode = 1;
  } else if (command === "status") {
    result = {
      vault: vault.root,
      validation: await vault.validate(),
      counts: Object.fromEntries(
        await Promise.all(
          SECTIONS.map(async (s) => [s, (await vault.listRecords(s)).length]),
        ),
      ),
    };
  } else if (command === "search") {
    const sep = args.indexOf("--");
    if (sep < 0) throw Error("Usage: search --vault <path> -- <query>");
    result = await vault.searchTrusted(args.slice(sep + 1).join(" "));
  } else if (command === "pending") {
    result = (await vault.listRecords("records/observations")).filter(
      (r) => r.status === "pending",
    );
  } else if (command === "review") {
    result = await vault.reviewObservation(arg("--id"), await input());
  } else if (command === "activate") {
    result = await vault.activateObservation(
      arg("--id"),
      arg("--input") ? await input() : {},
    );
  } else if (command === "promote") {
    result = await vault.promoteObservation(arg("--id"));
  } else if (command === "transition") {
    result = await vault.updateActiveMemory(arg("--id"), await input());
  } else if (command === "recur") {
    result = await vault.nextOccurrence(arg("--id"), await input());
  } else if (command === "contradict") {
    result = await vault.addContradiction(arg("--id"), await input());
  } else if (command === "supersede") {
    result = await vault.supersedeObservation(arg("--id"), await input());
  } else if (command === "process") {
    result = await new MemoryPipeline({
      vault,
      provider: new OllamaMemoryProvider(),
    }).processConversation(await input());
  } else if (command === "backup") {
    result = await createBackup({
      vault,
      backupRoot:
        arg("--destination") ??
        process.env.JUNE_BACKUP_ROOT ??
        "D:/June/Backups",
      openclawRoot: arg("--openclaw-root") ?? null,
      engineRoot: path.resolve(import.meta.dirname, ".."),
    });
  } else if (command === "verify-backup") {
    result = await verifyBackup(arg("--backup"));
  } else if (command === "restore-test") {
    result = await restoreVault({
      backupPath: arg("--backup"),
      target: arg("--target"),
    });
  } else if (command === "inventory") {
    const files = [];
    async function scan(rel = "") {
      const dir = inside(vault.root, rel);
      await assertNoLinks(dir);
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".june-memory-lock")) continue;
        if (e.isSymbolicLink()) throw Error("Link found");
        const r = path.join(rel, e.name);
        if (e.isDirectory()) await scan(r);
        else {
          const bytes = await fs.readFile(inside(vault.root, r));
          files.push({
            path: r.replaceAll("\\", "/"),
            bytes: bytes.length,
            sha256: sha256(bytes),
            action: "preserve; no automatic import",
          });
        }
      }
    }
    await scan();
    result = { dryRun: true, vault: vault.root, files };
  } else if (["health", "consolidate", "reminders"].includes(command)) {
    const jobs = new Jobs({
      vault,
      pipeline: new MemoryPipeline({
        vault,
        provider: new OllamaMemoryProvider(),
      }),
    });
    result =
      command === "health"
        ? await jobs.health()
        : command === "consolidate"
          ? await jobs.consolidate({
              date: arg("--date"),
              dryRun: !args.includes("--apply"),
            })
          : await jobs.reminders({
              leadHours: Number(arg("--lead-hours") ?? 24),
              dryRun: !args.includes("--apply"),
            });
  } else
    throw Error(
      "Commands: init, validate, status, inventory, search, pending, review, activate, promote, transition, contradict, supersede, process, consolidate, reminders, health, backup, verify-backup, restore-test.",
    );
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: e.code ?? "CLI_ERROR",
      message: e.code
        ? "Operation failed safely; check input and service status."
        : e.message,
    }),
  );
  process.exitCode = 1;
});
